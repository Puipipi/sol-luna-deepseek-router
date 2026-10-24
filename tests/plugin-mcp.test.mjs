import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPluginMcp, trustedThreadId} from '../scripts/plugin-mcp.mjs';
import {NativeTasks} from '../scripts/native-state.mjs';
import {createTraceService} from '../scripts/plugin-trace.mjs';
import {canonicalWorkspace, hashThread, workspaceKey, writeJsonAtomic} from '../scripts/plugin-state.mjs';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
const match = (value, pattern, message) => { assert.match(value, pattern, message); checks += 1; };

function request(url, {method = 'GET', headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, {method, headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers}));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function detailHrefFor(body, eventId) {
  return body.match(new RegExp(`href="([^"]*\\/trace\\/view\\/[^"]+\\/event\\/${eventId}\\?[^"]+)"`))?.[1] ?? null;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'sol-plugin-mcp-'));
const priorCodexHome = process.env.CODEX_HOME;
const priorLocalAppData = process.env.LOCALAPPDATA;
process.env.CODEX_HOME = path.join(root, 'codex-home');
process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
process.on('exit', () => {
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodexHome;
  if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = priorLocalAppData;
});
const workspace = path.join(root, 'workspace');
const workspace2 = path.join(root, 'workspace-2');
for (const name of ['workspace', 'workspace-2', 'workspace-8', 'workspace-9', 'workspace-parallel', 'workspace-start-fail', 'workspace-start-uncertain', 'workspace-no-id', 'workspace-taken', 'workspace-dead', 'workspace-unavailable', 'workspace-reservation', 'workspace-followup']) {
  await mkdir(path.join(root, name), {recursive: true});
}
const agents = new Map();
let nextAgent = 1;
let startFailedOnce = false;
let startUncertainOnce = false;
let followupFails = false;
let eventDetailReads = 0;
const showFailsFor = new Set();

function textResult(payload) {
  return {result: {content: [{type: 'text', text: JSON.stringify(payload)}]}};
}

const calls = [];
async function fakeRun(request) {
  calls.push(request);
  const args = request.args;
  switch (request.action) {
    case 'start': {
      if (args.cwd.includes('start-fail') && !startFailedOnce) {
        startFailedOnce = true;
        throw new Error('backend exploded with sk-test-NOTAREALKEY000000');
      }
      if (args.cwd.includes('start-uncertain') && !startUncertainOnce) {
        startUncertainOnce = true;
        throw new Error('MCP process exited (1); outcome may be unknown.');
      }
      if (args.cwd.includes('no-id')) return textResult({ok: true});
      const id = args.cwd.includes('taken') ? 'A-taken' : `A${nextAgent++}`;
      const agent = {agent_id: id, id, status: 'starting', name: args.name ?? id, cwd: args.cwd, permission: args.permission};
      agents.set(id, agent);
      if (args.cwd.includes('parallel')) await new Promise(resolve => setTimeout(resolve, 40));
      return textResult(agent);
    }
    case 'show': {
      if (showFailsFor.has(args.agent_id)) throw new Error('DSH service unavailable');
      const agent = agents.get(args.agent_id) ?? {agent_id: args.agent_id, status: 'unknown'};
      return textResult(agent);
    }
    case 'wait': {
      const agent = agents.get(args.agent_id) ?? {agent_id: args.agent_id};
      agent.status = args.agent_id === 'A1' ? 'completed' : 'idle';
      return textResult({agent_id: args.agent_id, status: agent.status, answer: 'done'});
    }
    case 'followup': {
      if (followupFails) throw new Error('MCP process exited (1); outcome may be unknown.');
      const agent = agents.get(args.agent_id);
      if (agent) agent.status = 'running';
      return textResult({agent_id: args.agent_id, status: 'running'});
    }
    case 'interrupt': {
      const agent = agents.get(args.agent_id);
      if (agent) agent.status = 'interrupted';
      return textResult({agent_id: args.agent_id, status: 'interrupted'});
    }
    case 'close': {
      const agent = agents.get(args.agent_id);
      if (agent) agent.status = 'closed';
      return textResult({agent_id: args.agent_id, status: 'closed'});
    }
    case 'rename': {
      const agent = agents.get(args.agent_id);
      if (agent) agent.name = args.name;
      return textResult({agent_id: args.agent_id, status: agent?.status ?? 'idle', name: args.name});
    }
    case 'list': {
      const items = [...agents.values()].map(agent => ({...agent}));
      return textResult({count: items.length, total: items.length, items});
    }
    case 'events': {
      if (args.event_id !== undefined && ++eventDetailReads > 1) {
        return textResult({
          len: 'detail',
          events: [{
            event_id: args.event_id,
            seq: 2,
            type: 'tool/call',
            scope: 'root',
            summary: {
              tool: 'shell',
              command: 'npm test -- --runInBand',
              args: {cwd: '<repo>&mcp', api_key: 'mcp-json-secret'},
            },
            result: {output: '<em>passed</em> sk-test-NOTAREALTRACE00000', exit_code: 0},
          }],
        });
      }
      return textResult({
        len: '264 chars',
        events: [
          {event_id: 1, seq: 1, type: 'assistant/final', text: '<script>alert("trace")</script> & "quoted"'},
          {event_id: 2, seq: 2, type: 'tool/call', summary: {command: 'curl -H "Authorization: Bearer sk-test-NOTAREALTRACE00000"', path: '<repo>/a&b'}},
        ],
        has_more: true,
        next_cursor: 1328,
      });
    }
    default:
      throw new Error(`fake backend does not handle ${request.action}`);
  }
}

const trace = createTraceService({ttlMs: 60_000, maxUses: 5});
const server = createPluginMcp({runClient: fakeRun, stateDir: root, trace});
let nextId = 0;
function call(name, args, thread = 'chat-one') {
  return server.handle({jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: {name, arguments: args, _meta: {threadId: thread}}});
}
function payload(response) {
  return response.result?.structuredContent ?? JSON.parse(response.result.content[0].text);
}
function text(response) {
  return response.result?.content?.[0]?.text ?? '';
}
function isError(response) {
  return response.result?.isError === true;
}

try {
  const init = await server.handle({jsonrpc: '2.0', id: 0, method: 'initialize', params: {protocolVersion: '2025-06-18'}});
  equal(init.result.serverInfo.name, 'sol-luna-deepseek-router', 'initialize identifies the plugin server');
  equal(init.result.serverInfo.version, '0.12.3', 'initialize reports the integrated plugin version');
  equal(init.result.protocolVersion, '2025-06-18', 'initialize negotiates a supported protocol');
  match(init.result.instructions, /_meta\.threadId/, 'initialize documents the trusted identity requirement');
  match(init.result.instructions, /not native Codex children/, 'initialize states the native-child limitation');

  const listed = await server.handle({jsonrpc: '2.0', id: 1, method: 'tools/list'});
  const names = listed.result.tools.map(tool => tool.name);
  for (const name of ['dsh_start', 'dsh_status', 'dsh_wait', 'dsh_followup', 'dsh_list', 'dsh_interrupt', 'dsh_close', 'dsh_rename', 'dsh_events', 'dsh_trace']) {
    ok(names.includes(name), `tools/list includes ${name}`);
  }

  {
    let diagnosticCaller = null;
    const diagnosticChildren = new Map();
    const contextStateDir = path.join(root, 'model-context-state');
    const nativeTasks = new NativeTasks({stateDir: contextStateDir});
    for (const [parentThreadId, childThreadId, taskNonce, executor, model] of [
      ['chat-a', 'chat-a-api-child', 'diag-chat-a-001', 'api', 'mock-a'],
      ['chat-b', 'chat-b-deepseek-child', 'diag-chat-b-001', 'deepseek', 'deepseek/deepseek-flash'],
    ]) {
      const profileId = 'abcdefabcdefabcdefabcdef';
      await nativeTasks.reserveDispatch({parentThreadId, taskNonce, executor, profileId: executor === 'api' ? profileId : null, model});
      await nativeTasks.begin({parentThreadId, childThreadId, taskNonce, model, binding: executor === 'api'
        ? {executor, profileId, model, role: `native_api_${profileId}`, providerId: `api-native-${profileId}`}
        : {executor, model, role: 'native_deepseek'}});
    }
    const contextServer = createPluginMcp({
      stateDir: contextStateDir,
      settingsPath: path.join(root, 'model-context-router.json'),
      readNativeModels: async () => [],
      readCurrentModel: async ({threadId}) => ({model: threadId === 'chat-a' ? 'gpt-6.1-sol' : 'gpt-6-astra', provider: 'openai'}),
      guardStatus: async () => ({state: 'unmanaged'}),
      collectDiagnostics: async ({parentThreadId, registeredChildThreadIds}) => {
        diagnosticCaller = parentThreadId;
        diagnosticChildren.set(parentThreadId, registeredChildThreadIds);
        return {available: true, rootCause: 'uncertain', events: []};
      },
    });
    try {
      const readFor = async (threadId, id) => contextServer.handle({jsonrpc: '2.0', id, method: 'tools/call', params: {
        name: 'router_settings_snapshot', arguments: {}, _meta: {threadId},
      }});
      const a1 = payload(await readFor('chat-a', 21));
      const b = payload(await readFor('chat-b', 22));
      const a2 = payload(await readFor('chat-a', 23));
      equal(a1.currentMainModel.model, 'gpt-6.1-sol', 'snapshot resolves chat A from trusted per-request metadata');
      equal(b.currentMainModel.model, 'gpt-6-astra', 'same MCP server resolves chat B independently');
      equal(a2.currentMainModel.model, 'gpt-6.1-sol', 'interleaved requests do not retain the previous caller model');
      const diagnostic = payload(await contextServer.handle({jsonrpc: '2.0', id: 24, method: 'tools/call', params: {
        name: 'router_connection_diagnostics', arguments: {}, _meta: {threadId: 'chat-b'},
      }}));
      equal(diagnosticCaller, 'chat-b', 'explicit connection diagnostic uses the trusted MCP caller context');
      const diagnosticForA = payload(await contextServer.handle({jsonrpc: '2.0', id: 27, method: 'tools/call', params: {
        name: 'router_connection_diagnostics', arguments: {}, _meta: {threadId: 'chat-a'},
      }}));
      const diagnosticForUnknown = payload(await contextServer.handle({jsonrpc: '2.0', id: 28, method: 'tools/call', params: {
        name: 'router_connection_diagnostics', arguments: {}, _meta: {threadId: 'chat-unknown'},
      }}));
      deepEqual(diagnosticChildren.get('chat-a'), ['chat-a-api-child'], 'diagnostics correlate only children owned by chat A');
      deepEqual(diagnosticChildren.get('chat-b'), ['chat-b-deepseek-child'], 'diagnostics correlate only children owned by chat B');
      deepEqual(diagnosticChildren.get('chat-unknown'), [], 'unknown parent receives no guessed or cross-chat children');
      const forgedChildren = await contextServer.handle({jsonrpc: '2.0', id: 29, method: 'tools/call', params: {
        name: 'router_connection_diagnostics', arguments: {registeredChildThreadIds: ['chat-b-deepseek-child']}, _meta: {threadId: 'chat-a'},
      }});
      ok(isError(forgedChildren), 'MCP clients cannot inject diagnostic child identifiers');
      deepEqual(diagnosticChildren.get('chat-a'), ['chat-a-api-child'], 'rejected client IDs never enter diagnostic correlation');
      const missingDiagnosticContext = await contextServer.handle({jsonrpc: '2.0', id: 26, method: 'tools/call', params: {
        name: 'router_connection_diagnostics', arguments: {},
      }});
      ok(isError(missingDiagnosticContext), 'diagnostics refuse to collect without trusted caller metadata');
      equal(diagnosticCaller, 'chat-unknown', 'missing caller metadata does not trigger another local log read');
    } finally {
      await contextServer.close();
    }
  }

  {
    const disabledSettings = path.join(root, 'diagnostics-disabled-router.json');
    await writeFile(disabledSettings, JSON.stringify({schemaVersion: 1, enabled: false, mode: 'fixed', fixedExecutor: 'luna', schedule: {peak: 'luna', valley: 'deepseek'}, profiles: {}}));
    let diagnosticReads = 0;
    const diagnosticServer = createPluginMcp({
      stateDir: path.join(root, 'diagnostics-disabled-state'), settingsPath: disabledSettings,
      guardStatus: async () => ({state: 'unmanaged'}), readNativeModels: async () => [],
      collectDiagnostics: async () => { diagnosticReads += 1; return {available: true, rootCause: 'uncertain', events: []}; },
    });
    try {
      const disabledDiagnostic = payload(await diagnosticServer.handle({jsonrpc: '2.0', id: 25, method: 'tools/call', params: {
        name: 'router_connection_diagnostics', arguments: {}, _meta: {threadId: 'chat-a'},
      }}));
      equal(disabledDiagnostic.available, false, 'disabled routing returns unavailable without reading logs');
      equal(diagnosticReads, 0, 'disabled routing performs zero diagnostic collection I/O');
    } finally { await diagnosticServer.close(); }
  }

  assert.throws(() => trustedThreadId({_meta: {}}), /Missing trusted request _meta\.threadId/);
  checks += 1;
  assert.throws(() => trustedThreadId({arguments: {_meta: {threadId: 'forged'}}}), /Missing trusted request _meta\.threadId/);
  checks += 1;

  {
    const before = calls.length;
    const missing = await server.handle({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'dsh_start', arguments: {task: 'x', cwd: workspace}}});
    ok(isError(missing), 'missing identity is a tool error');
    match(text(missing), /Missing trusted request _meta\.threadId/, 'missing identity fails safely');
    equal(calls.length, before, 'missing identity never reaches DSH');
    const spoofArgs = await call('dsh_start', {task: 'x', cwd: workspace, thread_id: 'chat-two'}, 'chat-one');
    ok(isError(spoofArgs), 'identity in arguments is rejected');
    match(text(spoofArgs), /trusted request _meta\.threadId/, 'argument identity is named as untrusted');
    equal(calls.length, before, 'argument identity never reaches DSH');
    const spoofMeta = await call('dsh_start', {task: 'x', cwd: workspace, _meta: {threadId: 'chat-two'}}, 'chat-one');
    ok(isError(spoofMeta), 'nested meta in arguments is rejected');
    equal(calls.length, before, 'nested argument identity never reaches DSH');
  }

  const startOne = await call('dsh_start', {task: 'work', cwd: workspace, name: 'one'});
  const one = payload(startOne);
  equal(one.agent_id, 'A1', 'chat-one starts A1');
  equal(calls.at(-1).action, 'start', 'start is one DSH call');
  equal(calls.at(-1).meta.threadId, 'chat-one', 'trusted thread identity is forwarded to DSH');
  deepEqual({provider: calls.at(-1).args.provider, model: calls.at(-1).args.model, permission: calls.at(-1).args.permission},
    {provider: 'deepseek-official', model: 'deepseek-flash', permission: 'workspace-write'}, 'start applies the published DSH defaults');
  equal((await server.ownership.assertOwner('A1', 'chat-one')).agent_id, 'A1', 'start records durable ownership');
  equal((await server.leases.get(workspace)).agent_id, 'A1', 'a write start holds the workspace lease');

  {
    const before = calls.length;
    const conflict = await call('dsh_start', {task: 'other', cwd: workspace, name: 'two'}, 'chat-two');
    ok(isError(conflict), 'another chat cannot start a writer in the leased workspace');
    match(text(conflict), /Workspace is busy/, 'the lease conflict is explicit');
    ok(calls.slice(before).some(request => request.action === 'show' && request.args.agent_id === 'A1'),
      'the lease is reconciled against the real backend status');
    ok(!calls.slice(before).some(request => request.action === 'start'), 'the busy lease never dispatches another start');
  }

  const startTwo = await call('dsh_start', {task: 'read', cwd: workspace, permission: 'read-only', name: 'two'}, 'chat-two');
  const two = payload(startTwo);
  equal(two.agent_id, 'A2', 'chat-two can start a read-only agent in the same workspace');
  equal((await server.leases.get(workspace)).agent_id, 'A1', 'the read-only start does not take the writer lease');

  const startThree = await call('dsh_start', {task: 'read2', cwd: workspace2, permission: 'read-only', name: 'three'}, 'chat-one');
  equal(payload(startThree).agent_id, 'A3', 'chat-one starts A3 in another workspace');

  {
    const before = calls.length;
    const denied = await call('dsh_status', {agent_id: 'A2'}, 'chat-one');
    ok(isError(denied), 'chat-one cannot read chat-two status');
    match(text(denied), /not available to this chat/, 'cross-chat status is denied');
    equal(calls.length, before, 'cross-chat status never reaches DSH');
    const deniedWait = await call('dsh_wait', {agent_id: 'A2', seconds: 0}, 'chat-one');
    ok(isError(deniedWait), 'chat-one cannot wait on chat-two');
    equal(calls.length, before, 'cross-chat wait never reaches DSH');
    const deniedFollow = await call('dsh_followup', {agent_id: 'A2', task: 'x'}, 'chat-one');
    ok(isError(deniedFollow), 'chat-one cannot follow up chat-two');
    equal(calls.length, before, 'cross-chat follow-up never reaches DSH');
    const allowed = await call('dsh_status', {agent_id: 'A2'}, 'chat-two');
    ok(!isError(allowed), 'chat-two can read its own agent');
  }

  {
    const listedOne = await call('dsh_list', {}, 'chat-one');
    const rows = payload(listedOne);
    deepEqual(rows.items.map(row => row.agent_id).sort(), ['A1', 'A3'], 'list returns only chat-one agents');
    equal(rows.total, 2, 'list total counts only the caller-owned agents');
    ok(!JSON.stringify(rows).includes('A2'), 'list never leaks another chat agent');
    const filtered = payload(await call('dsh_list', {cwd: workspace2}, 'chat-one'));
    deepEqual(filtered.items.map(row => row.agent_id), ['A3'], 'cwd filters apply after ownership');
    equal(filtered.matched, 1, 'list reports the filtered owned count');
    const matched = payload(await call('dsh_list', {match: 'one'}, 'chat-one'));
    deepEqual(matched.items.map(row => row.agent_id), ['A1'], 'match filters apply after ownership');
    const empty = payload(await call('dsh_list', {status: 'completed'}, 'chat-one'));
    equal(empty.items.length, 0, 'status filters apply after ownership');
    const listedTwo = payload(await call('dsh_list', {}, 'chat-two'));
    deepEqual(listedTwo.items.map(row => row.agent_id), ['A2'], 'chat-two sees only its own agent');
  }

  let traceUrl;
  let traceViewUrl;
  let traceCookie;
  {
    const traceResult = await call('dsh_trace', {agent_id: 'A1', after: 1327, event_id: 2}, 'chat-one');
    const tracePayload = payload(traceResult);
    traceUrl = tracePayload.url;
    match(traceUrl, /^http:\/\/127\.0\.0\.1:\d+\/trace\/[A-Za-z0-9_-]{43}$/, 'trace returns a loopback exchange URL');
    equal(tracePayload.read_only, true, 'trace is marked read-only');
    equal(tracePayload.event_count, 2, 'trace reports the real DSH event count');
    equal(tracePayload.has_more, true, 'trace reports the real has_more flag');
    equal(tracePayload.next_cursor, 1328, 'trace reports the real next_cursor');
    equal(tracePayload.truncated, true, 'trace reports truncation from has_more');
    equal(tracePayload.selected_event_id, 2, 'trace reports the selected event id');
    match(tracePayload.view_path, /^\/trace\/view\/[A-Za-z0-9_-]{22}\/$/, 'trace returns a per-view scoped path');
    equal(calls.at(-1).args.after, 1327, 'after cursor is forwarded to dsh_events');
    equal(calls.at(-1).args.event_id, 2, 'selected event id is forwarded to dsh_events');
    ok(traceResult.result.content[0].text.includes(traceUrl), 'the exchange URL is clickable text in the tool result');
    const exchange = await request(traceUrl);
    equal(exchange.status, 303, 'the ticket is exchanged with a redirect');
    const setCookie = exchange.headers['set-cookie']?.[0] ?? '';
    match(setCookie, /HttpOnly/, 'the session cookie is HttpOnly');
    match(setCookie, /SameSite=Strict/, 'the session cookie is SameSite=Strict');
    match(setCookie, /Path=\/trace\/view\/[A-Za-z0-9_-]{22}\//, 'the session cookie is scoped to its own view path');
    equal(setCookie.split(';')[0].startsWith('dsh_trace_'), true, 'the cookie uses a per-view trace name');
    const exchangeTicket = traceUrl.split('/').pop();
    ok(!setCookie.split(';')[0].endsWith(exchangeTicket), 'the cookie value is not the URL ticket');
    ok(!/sk-test|Bearer|authorization/i.test(setCookie), 'the cookie contains no credential');
    equal(exchange.headers.location, tracePayload.view_path, 'the redirect target is ticket-free and view-scoped');
    ok(!exchange.headers.location.includes(exchangeTicket), 'the resulting URL removes the ticket');
    traceCookie = setCookie.split(';')[0];
    traceViewUrl = new URL(exchange.headers.location, traceUrl).href;
    const noCookie = await request(traceViewUrl);
    equal(noCookie.status, 401, 'the ticket-free view requires the HttpOnly cookie');
    const page = await request(traceViewUrl, {headers: {cookie: traceCookie}});
    equal(page.status, 200, 'the cookie renders the trace page');
    ok(page.body.includes('&lt;script&gt;alert'), 'trace escapes event content');
    ok(!page.body.includes('<script>alert'), 'trace never emits raw script markup');
    ok(!page.body.includes('sk-test-NOTAREALTRACE'), 'trace redacts credentials');
    ok(page.body.includes('只读 DSH Trace'), 'trace states the external-agent limitation in Chinese');
    ok(page.body.includes('下一个游标'), 'trace renders the truthful continuation cursor');
    ok(page.body.includes('已选择事件详情'), 'trace renders the selected event marker');
    const detailHref = detailHrefFor(page.body, 2);
    ok(detailHref, 'the authenticated snapshot exposes clickable event details');
    const detailUrl = new URL(detailHref, traceViewUrl).href;
    equal(new URL(detailUrl).pathname, `${tracePayload.view_path}event/2`, 'the detail URL uses the actual event id inside its view scope');
    ok(!detailUrl.includes('chat-one'), 'the detail URL contains no thread id');
    ok(!detailUrl.includes(exchangeTicket), 'the detail URL contains no exchange ticket');
    equal((await request(detailUrl)).status, 401, 'the detail endpoint requires the trace cookie');
    const detailPage = await request(detailUrl, {headers: {cookie: traceCookie}});
    equal(detailPage.status, 200, 'the cookie opens the event detail');
    match(detailPage.body, /事件 #2/, 'the detail identifies the selected event id in Chinese');
    match(detailPage.body, /npm test -- --runInBand/, 'the detail renders the tool command');
    match(detailPage.body, /&lt;repo&gt;&amp;mcp/, 'the detail escapes command arguments');
    match(detailPage.body, /&lt;em&gt;passed&lt;\/em&gt;/, 'the detail escapes result output');
    ok(!detailPage.body.includes('<em>passed</em>'), 'the detail never emits raw result markup');
    ok(!detailPage.body.includes('sk-test-NOTAREALTRACE00000'), 'the detail redacts credentials');
    ok(!detailPage.body.includes('mcp-json-secret'), 'the detail redacts JSON credential fields');
    ok(detailPage.body.includes(`href="${tracePayload.view_path}"`), 'the detail links back to its scoped snapshot');
    equal(calls.at(-1).action, 'events', 'event detail uses the trusted events backend');
    equal(calls.at(-1).args.agent_id, 'A1', 'event detail is scoped to the owned agent');
    equal(calls.at(-1).args.event_id, 2, 'event detail requests the clicked event id');
    equal(calls.at(-1).args.include_tool_events, true, 'event detail includes tool events');
    equal(calls.at(-1).args.include_progress, true, 'event detail includes progress');
    equal(calls.at(-1).args.include_descendants, true, 'event detail includes descendants');
    equal(calls.at(-1).meta.threadId, 'chat-one', 'event detail rechecks the trusted chat identity');

    const otherTrace = payload(await call('dsh_trace', {agent_id: 'A2'}, 'chat-two'));
    const otherExchange = await request(otherTrace.url);
    const otherCookie = (otherExchange.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const otherView = new URL(otherExchange.headers.location, otherTrace.url).href;
    const otherPage = await request(otherView, {headers: {cookie: otherCookie}});
    const otherDetail = new URL(detailHrefFor(otherPage.body, 1), otherView).href;
    equal((await request(otherDetail, {headers: {cookie: traceCookie}})).status, 401,
      'one trace view cookie cannot open another view detail link');
    equal((await request(detailUrl, {headers: {cookie: otherCookie}})).status, 401,
      'another trace view cookie cannot open the first view detail link');
    equal((await request(traceUrl)).status, 410, 'the exchange ticket is single-use');
    const deniedTrace = await call('dsh_trace', {agent_id: 'A1'}, 'chat-two');
    ok(isError(deniedTrace), 'another chat cannot open the trace');
    match(text(deniedTrace), /not available to this chat/, 'trace enforces ownership');
  }

  {
    const before = calls.length;
    const denied = await call('dsh_wait', {agent_id: 'A1'}, 'chat-two');
    ok(isError(denied), 'another chat cannot wait on the owned agent');
    equal(calls.length, before, 'cross-chat wait is rejected before DSH');
    const settled = await call('dsh_wait', {agent_id: 'A1'}, 'chat-one');
    equal(payload(settled).status, 'completed', 'the owner receives the completed result');
    equal(await server.leases.get(workspace), null, 'terminal wait releases the writer lease');
    equal((await server.ownership.assertOwner('A1', 'chat-one')).status, 'completed', 'terminal wait keeps durable ownership');
    equal((await request(traceViewUrl, {headers: {cookie: traceCookie}})).status, 401, 'terminal wait revokes the trace session');
  }

  {
    const nextWriter = await call('dsh_start', {task: 'after', cwd: workspace, name: 'four'}, 'chat-two');
    const writerId = payload(nextWriter).agent_id;
    ok(writerId, 'the released workspace can admit another chat writer');
    await call('dsh_close', {agent_id: writerId}, 'chat-two');
    equal(await server.leases.get(workspace), null, 'close releases the writer lease');
  }

  {
    const follow = await call('dsh_followup', {agent_id: 'A1', task: 'fix'}, 'chat-one');
    equal(payload(follow).status, 'running', 'the owner continues a completed agent');
    ok(await server.leases.get(workspace), 'follow-up reacquires the writer lease');
    const denied = await call('dsh_followup', {agent_id: 'A1', task: 'hijack'}, 'chat-two');
    ok(isError(denied), 'another chat cannot follow up');
    await call('dsh_interrupt', {agent_id: 'A1'}, 'chat-one');
    equal(await server.leases.get(workspace), null, 'interrupt releases the writer lease');
    equal((await server.ownership.assertOwner('A1', 'chat-one')).status, 'interrupted', 'interrupt records the passive status');
  }

  {
    const startEight = await call('dsh_start', {task: 'interrupt', cwd: path.join(root, 'workspace-8'), name: 'eight'});
    const eightId = payload(startEight).agent_id;
    ok(eightId, 'the interrupt-cleanup agent starts');
    await call('dsh_interrupt', {agent_id: eightId});
    equal(await server.leases.get(path.join(root, 'workspace-8')), null, 'interrupt cleanup releases the writer lease');
    const startNine = await call('dsh_start', {task: 'close', cwd: path.join(root, 'workspace-9'), name: 'nine'});
    const nineId = payload(startNine).agent_id;
    ok(nineId, 'the close-cleanup agent starts');
    await call('dsh_close', {agent_id: nineId});
    equal(await server.leases.get(path.join(root, 'workspace-9')), null, 'close cleanup releases the writer lease');
    equal((await server.ownership.assertOwner(nineId, 'chat-one')).status, 'closed', 'close records the terminal status');
  }

  {
    const parallelWorkspace = path.join(root, 'workspace-parallel');
    const results = await Promise.all([
      call('dsh_start', {task: 'parallel one', cwd: parallelWorkspace, name: 'p1'}, 'chat-one'),
      call('dsh_start', {task: 'parallel two', cwd: parallelWorkspace, name: 'p2'}, 'chat-two'),
    ]);
    equal(results.filter(result => !isError(result)).length, 1, 'one parallel same-workspace writer wins');
    equal(results.filter(result => isError(result)).length, 1, 'one parallel same-workspace writer is rejected');
    ok(results.some(result => /Workspace is busy/.test(text(result))), 'the loser receives the lease error');
    ok(await server.leases.get(parallelWorkspace), 'the winning parallel writer holds the lease');
  }

  {
    const failWorkspace = path.join(root, 'workspace-start-fail');
    const before = calls.length;
    const failed = await call('dsh_start', {task: 'fail', cwd: failWorkspace}, 'chat-two');
    ok(isError(failed), 'a backend start error becomes a tool error');
    ok(!text(failed).includes('SECRET123456789'), 'backend errors redact credentials');
    match(text(failed), /backend exploded/, 'the backend error is reported');
    ok(calls.length > before, 'the failing start did reach the backend once');
    equal(await server.leases.get(failWorkspace), null, 'a failed start releases its reservation');
    const retry = await call('dsh_start', {task: 'retry', cwd: failWorkspace}, 'chat-one');
    ok(!isError(retry), 'the workspace is usable after a failed start');
    await call('dsh_close', {agent_id: payload(retry).agent_id}, 'chat-one');

    const noIdWorkspace = path.join(root, 'workspace-no-id');
    const noId = await call('dsh_start', {task: 'no id', cwd: noIdWorkspace}, 'chat-two');
    ok(isError(noId), 'a missing agent id is an error');
    match(text(noId), /did not return an agent id/, 'the missing id is explicit');
    match(text(noId), /never expires automatically|deliberately remove/, 'the missing id reports the exact reservation limitation');
    ok(await server.leases.get(noIdWorkspace), 'a missing agent id keeps the reservation fail-safe');

    const uncertainWorkspace = path.join(root, 'workspace-start-uncertain');
    const uncertain = await call('dsh_start', {task: 'uncertain', cwd: uncertainWorkspace}, 'chat-two');
    ok(isError(uncertain), 'an uncertain start transport outcome is an error');
    match(text(uncertain), /never expires automatically|deliberately remove/, 'uncertain start reports the exact reservation limitation');
    const heldReservation = await server.leases.get(uncertainWorkspace);
    ok(heldReservation && heldReservation.bound === false, 'an uncertain start retains an unbound reservation');
    await server.leases.release({workspace: uncertainWorkspace, threadId: 'chat-two', agentId: heldReservation.agent_id});
  }

  {
    const takenWorkspace = path.join(root, 'workspace-taken');
    await server.ownership.claim('A-taken', 'chat-two', {workspace: takenWorkspace, write: true});
    const before = calls.length;
    const taken = await call('dsh_start', {task: 'taken', cwd: takenWorkspace}, 'chat-one');
    ok(isError(taken), 'a post-start ownership collision fails safely');
    match(text(taken), /not available to this chat/, 'the collision uses the ownership error');
    ok(await server.leases.get(takenWorkspace), 'the collision retains the lease until confirmed recovery');
    ok(!calls.slice(before).some(request => request.action === 'interrupt'), 'the plugin never interrupts another chat agent');
  }

  {
    const deadWorkspace = path.join(root, 'workspace-dead');
    const key = await workspaceKey(deadWorkspace);
    await writeJsonAtomic(path.join(server.stateDir, 'leases', `${key}.json`), {
      version: 2,
      workspace: await canonicalWorkspace(deadWorkspace),
      owner: hashThread('chat-one'),
      agent_id: 'A3',
      bound: true,
      pid: 999999,
      created_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z',
      expires_at: '2000-01-01T00:00:00.000Z',
    });
    agents.get('A3').status = 'running';
    const dead = await call('dsh_start', {task: 'dead plugin', cwd: deadWorkspace}, 'chat-two');
    ok(isError(dead), 'an active task after plugin death/expiry blocks the workspace');
    match(text(dead), /Workspace is busy.*running/, 'the real backend status is authoritative');
    equal((await server.leases.get(deadWorkspace)).agent_id, 'A3', 'the active lease is not stolen');
    agents.get('A3').status = 'completed';
    const recovered = await call('dsh_start', {task: 'recovered', cwd: deadWorkspace, name: 'recovered'}, 'chat-two');
    ok(!isError(recovered), 'confirmed completion permits replacement');
    const recoveredId = payload(recovered).agent_id;
    equal((await server.leases.get(deadWorkspace)).agent_id, recoveredId, 'the confirmed replacement owns the lease');
    await call('dsh_close', {agent_id: recoveredId}, 'chat-two');
  }

  {
    const unavailableWorkspace = path.join(root, 'workspace-unavailable');
    const key = await workspaceKey(unavailableWorkspace);
    showFailsFor.add('A-backend-down');
    await writeJsonAtomic(path.join(server.stateDir, 'leases', `${key}.json`), {
      version: 2,
      workspace: await canonicalWorkspace(unavailableWorkspace),
      owner: hashThread('chat-one'),
      agent_id: 'A-backend-down',
      bound: true,
      pid: 999999,
      created_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z',
    });
    const unavailable = await call('dsh_start', {task: 'backend down', cwd: unavailableWorkspace}, 'chat-two');
    ok(isError(unavailable), 'backend unavailable blocks replacement');
    match(text(unavailable), /backend is unavailable|lease is retained/, 'the exact backend limitation is reported');
    equal((await server.leases.get(unavailableWorkspace)).agent_id, 'A-backend-down', 'backend unavailable retains the lease');
    showFailsFor.delete('A-backend-down');
    await server.leases.release({workspace: unavailableWorkspace, threadId: 'chat-one', agentId: 'A-backend-down'});
  }

  {
    const reservationWorkspace = path.join(root, 'workspace-reservation');
    const key = await workspaceKey(reservationWorkspace);
    await writeJsonAtomic(path.join(server.stateDir, 'leases', `${key}.json`), {
      version: 2,
      workspace: await canonicalWorkspace(reservationWorkspace),
      owner: hashThread('chat-one'),
      agent_id: 'reservation:uncertain',
      bound: false,
      pid: 999999,
      created_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z',
      expires_at: '2000-01-01T00:00:00.000Z',
    });
    const reserved = await call('dsh_start', {task: 'reservation', cwd: reservationWorkspace}, 'chat-two');
    ok(isError(reserved), 'an uncertain start reservation blocks replacement');
    match(text(reserved), /uncertain start reservation|never expires/, 'the reservation limitation is exact');
    equal((await server.leases.get(reservationWorkspace)).agent_id, 'reservation:uncertain', 'the reservation never expires into a duplicate dispatch');
    await server.leases.release({workspace: reservationWorkspace, threadId: 'chat-one', agentId: 'reservation:uncertain'});
  }

  {
    const followupWorkspace = path.join(root, 'workspace-followup');
    const started = await call('dsh_start', {task: 'followup', cwd: followupWorkspace, name: 'followup'}, 'chat-one');
    const followupId = payload(started).agent_id;
    followupFails = true;
    const uncertain = await call('dsh_followup', {agent_id: followupId, task: 'more'}, 'chat-one');
    ok(isError(uncertain), 'an uncertain follow-up is an error');
    match(text(uncertain), /exited|unknown/i, 'the unknown follow-up outcome is reported');
    equal((await server.leases.get(followupWorkspace)).agent_id, followupId, 'an uncertain follow-up retains the writer lease');
    followupFails = false;
    await call('dsh_interrupt', {agent_id: followupId}, 'chat-one');
    equal(await server.leases.get(followupWorkspace), null, 'confirmed interrupt releases the retained lease');
  }

  {
    const before = calls.length;
    const deniedEvents = await call('dsh_events', {agent_id: 'A2'}, 'chat-one');
    ok(isError(deniedEvents), 'another chat cannot read events');
    equal(calls.length, before, 'cross-chat events never reach DSH');
    const events = await call('dsh_events', {agent_id: 'A3', include_progress: true}, 'chat-one');
    equal(payload(events).events.length, 2, 'the owner reads real DSH events from the events field');
    equal(payload(events).has_more, true, 'the real has_more field is preserved');
    equal(payload(events).next_cursor, 1328, 'the real next_cursor field is preserved');
    equal(calls.at(-1).action, 'events', 'events uses dsh_events');
    equal(calls.at(-1).args.include_progress, true, 'event options are forwarded');
    const unknown = await call('dsh_nope', {}, 'chat-one');
    ok(isError(unknown), 'unknown tools are rejected');
    match(text(unknown), /Unknown tool/, 'the unknown tool is explicit');
  }

  {
    const invalid = await call('dsh_list', {status: 'made-up'}, 'chat-one');
    ok(isError(invalid), 'invalid list filters are rejected');
    const invalidStart = await call('dsh_start', {task: 'x', cwd: 'relative/path'}, 'chat-one');
    ok(isError(invalidStart), 'relative cwd is rejected');
    match(text(invalidStart), /absolute path/, 'the cwd requirement is explicit');
  }

  {
    const settingsPath = path.join(root, 'router-off.json');
    await writeJsonAtomic(settingsPath, {
      schemaVersion: 1,
      enabled: false,
      mode: 'fixed',
      fixedExecutor: 'deepseek',
      schedule: {peak: 'luna', valley: 'deepseek'},
      profiles: {},
    });
    const offCalls = [];
    const offServer = createPluginMcp({
      settingsPath,
      stateDir: path.join(root, 'off-state'),
      runClient: async request => { offCalls.push(request); return textResult({agent_id: 'unexpected'}); },
    });
    const invokeOff = (name, args) => offServer.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name, arguments: args, _meta: {threadId: 'disabled-chat'},
    }});
    try {
      const offStart = await invokeOff('dsh_start', {task: 'must not start', cwd: workspace, model: 'deepseek-flash'});
      ok(offStart.result?.isError, 'disabled routing rejects new DSH starts');
      match(offStart.result.content[0].text, /分工已关闭/, 'disabled DSH response explains the setting');
      const offFollowup = await invokeOff('dsh_followup', {agent_id: 'existing-agent', task: 'must not continue'});
      ok(offFollowup.result?.isError, 'disabled routing rejects new DSH follow-ups');
      equal(offCalls.length, 0, 'disabled DSH start and follow-up never reach backend');
    } finally {
      await offServer.close();
    }
  }
} finally {
  await server.close();
  await rm(root, {recursive: true, force: true});
}

console.log(`PASS ${checks} plugin MCP assertions`);
