#!/usr/bin/env node
// Codex MCP wrapper for the published DSH 0.7 bridge. It adds per-chat
// ownership, filtered listings, same-workspace writer leases, and a read-only
// local browser trace. It does not implement an agent loop: all agent work is
// delegated to dsh-subagent-mcp@0.7.0 through the existing runClient.
import {existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {runClient} from './dsh-mcp-client.mjs';
import {createTraceService} from './plugin-trace.mjs';
import {
  applyApiConfiguration as applyNativeApiConfiguration,
  getExecutorStatus as getNativeApiExecutorStatus,
} from './native-api-install.mjs';
import {effectiveRouterEnabled} from './native-api-settings.mjs';
import {finalizePendingDisable} from './native-execution-lifecycle.mjs';
import {
  ROUTER_SETTINGS_TOOL_NAMES,
  ROUTER_SETTINGS_TOOLS,
  createRouterSettingsService,
} from './router-settings-mcp.mjs';
import {
  OwnershipStore, WorkspaceLeases, TERMINAL_STATUSES, canonicalWorkspace, hashThread, normalizeWorkspace, resolveStateDir, workspaceKey,
} from './plugin-state.mjs';

const VERSION = '0.12.3';
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const PASSIVE_STATUSES = new Set([...TERMINAL_STATUSES]);
const LIST_STATUSES = new Set(['starting', 'running', 'interrupting', 'idle', 'completed', 'interrupted', 'error', 'context_exhausted', 'closed']);
const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const IDENTITY_ARGUMENTS = new Set(['_meta', 'thread_id', 'threadId', 'owner', 'owner_thread_id', 'chat_id']);
const isReservationLease = lease => lease?.bound === false || !lease?.agent_id || String(lease.agent_id).startsWith('reservation:');
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_HARD_LIMIT = 200;
const DEFAULT_HARD_MAX_CHARS = 100000;

const string = (description, extra = {}) => ({type: 'string', minLength: 1, description, ...extra});
const boolean = description => ({type: 'boolean', description});
const integer = (description, minimum, maximum) => ({type: 'integer', minimum, maximum, description});
const agentId = string('DSH agent id returned by dsh_start or dsh_followup.');

const DSH_TOOLS = [
  {
    name: 'dsh_start',
    description: 'Start an independent DSH 0.7 agent asynchronously. The trusted Codex request _meta.threadId becomes the sole owner of the returned agent id. Write-capable starts hold a same-workspace plugin-writer lease until the agent reaches a terminal state. Requires an absolute cwd. After start, retain the agent id and use dsh_wait; never start a duplicate because a wait timed out.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        task: string('Self-contained task brief and acceptance checks.'),
        cwd: string('Absolute workspace path.'),
        name: string('Short title shown in DSH Web.', {maxLength: 120}),
        model: string('DeepSeek model name; defaults to deepseek-flash.'),
        provider: string('Only deepseek-official is accepted; defaults to it.'),
        effort: string('DSH reasoning effort.'),
        preset: string('DSH preset, for example standard or minimal.'),
        permission: {type: 'string', enum: [...PERMISSIONS], description: 'DSH permission preset; defaults to workspace-write.'},
      },
      required: ['task', 'cwd'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'dsh_status',
    description: 'Read compact lifecycle status for an agent owned by this chat.',
    inputSchema: {type: 'object', additionalProperties: false, properties: {agent_id: agentId, legacy: boolean('Return the complete historical state.')}, required: ['agent_id']},
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'dsh_wait',
    description: 'Wait for an agent owned by this chat. Omit seconds for an unbounded wait. A timeout means pending work, never completion. This is the reliable completion path when a native Codex callback is unavailable.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        agent_id: agentId,
        seconds: {type: 'number', minimum: 0, maximum: 2147483.647, description: 'Explicit observation window; omit for an unbounded wait.'},
        legacy: boolean('Return the complete historical state.'),
      },
      required: ['agent_id'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'dsh_followup',
    description: 'Continue an idle DSH agent owned by this chat, preserving its conversation. Busy or context-exhausted agents reject follow-ups. A write-capable agent reacquires its same-workspace lease before dispatch.',
    inputSchema: {type: 'object', additionalProperties: false, properties: {agent_id: agentId, task: string('Follow-up task or repair brief.'), legacy: boolean('Return the complete historical state.')}, required: ['agent_id', 'task']},
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'dsh_list',
    description: 'List only agents owned by this chat, newest first. Rows from other chats are removed before filtering, paging, and character budgeting. Narrow with status, cwd, or match.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        limit: integer('Maximum rows to show.', 1, DEFAULT_HARD_LIMIT),
        status: {type: 'string', enum: [...LIST_STATUSES], description: 'Lifecycle filter.'},
        cwd: string('Workspace or workspace subtree filter.'),
        match: string('Substring of name or cwd, or an agent id prefix.'),
        max_chars: integer('Response character budget.', 256, DEFAULT_HARD_MAX_CHARS),
        legacy: boolean('Return complete per-agent records.'),
      },
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'dsh_interrupt',
    description: 'Cancel current execution and queued input for an agent owned by this chat. The ownership record remains so a later follow-up can resume; the writer lease is released after DSH reports idle.',
    inputSchema: {type: 'object', additionalProperties: false, properties: {agent_id: agentId, legacy: boolean('Return the complete historical state.')}, required: ['agent_id']},
    annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: true},
  },
  {
    name: 'dsh_close',
    description: 'Close an agent owned by this chat and release its writer lease and trace tickets. History is retained by DSH.',
    inputSchema: {type: 'object', additionalProperties: false, properties: {agent_id: agentId, legacy: boolean('Return the complete historical state.')}, required: ['agent_id']},
    annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: true},
  },
  {
    name: 'dsh_rename',
    description: 'Rename an agent owned by this chat and its DSH Web session title.',
    inputSchema: {type: 'object', additionalProperties: false, properties: {agent_id: agentId, name: string('New title.', {maxLength: 120}), legacy: boolean('Return the complete historical state.')}, required: ['agent_id', 'name']},
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'dsh_events',
    description: 'Read real DSH events for an agent owned by this chat. Defaults to completed root-turn answers; request progress, descendants, and tool summaries only when needed. This is the source used by dsh_trace.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        agent_id: agentId,
        after: {type: ['integer', 'string'], minimum: 0, minLength: 1, description: 'Cursor or continuation cursor.'},
        limit: integer('Maximum events.', 1, 100),
        max_chars: integer('Response character budget.', 256, DEFAULT_HARD_MAX_CHARS),
        include_progress: boolean('Include intermediate assistant text.'),
        include_descendants: boolean('Include child-agent progress and tools.'),
        include_tool_events: boolean('Include tool event summaries.'),
        event_id: integer('Read one tool event in full.', 1, 2147483647),
      },
      required: ['agent_id'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'dsh_trace',
    description: 'Return a clickable, read-only, loopback-only browser snapshot of real DSH events for an agent owned by this chat. The exchange URL carries a single-use ticket, never a credential; the browser exchanges it for a short-lived HttpOnly SameSite cookie scoped to a per-view /trace/view/<view-id>/ path with no ticket in the URL. Each view also uses its own cookie name, so trace tabs for different agents coexist without overwriting each other. Browser labels, help, and errors are Simplified Chinese. Returns has_more/next_cursor truthfully. Pass after to page and event_id to request one selected event detail. External DSH agents cannot appear as native Codex children, so this trace is the truthful external view.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        agent_id: agentId,
        after: {type: ['integer', 'string'], minimum: 0, minLength: 1, description: 'Continue after this DSH event cursor.'},
        event_id: integer('Read one selected tool event in full.', 1, 2147483647),
      },
      required: ['agent_id'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
  },
];

export const TOOLS = [...DSH_TOOLS, ...ROUTER_SETTINGS_TOOLS];
const TOOL_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

export function sanitizeError(message) {
  return String(message || 'Plugin request failed')
    .replace(/(api[_-]?key|authorization|bearer|token|secret)(\s*[:=]\s*)\S+/ig, '$1$2<REDACTED>')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '<REDACTED_KEY>')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '<REDACTED_TOKEN>')
    .replace(/AKIA[0-9A-Z]{16}/g, '<REDACTED_KEY>');
}

export function trustedThreadId(params) {
  const meta = params?._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('Missing trusted request _meta.threadId; this plugin refuses to act without chat ownership identity.');
  }
  const threadId = meta.threadId;
  if (typeof threadId !== 'string' || threadId.trim() === '') {
    throw new Error('Missing trusted request _meta.threadId; this plugin refuses to act without chat ownership identity.');
  }
  if (threadId.length > 512) throw new Error('The trusted request _meta.threadId is too long.');
  return threadId.trim();
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateArguments(tool, args) {
  if (!plainObject(args)) throw new Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) {
    if (IDENTITY_ARGUMENTS.has(key)) throw new Error('Chat identity must come only from the trusted request _meta.threadId, never from tool arguments.');
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`Unsupported option for ${tool.name}: ${key}`);
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) throw new Error(`${tool.name} requires ${key}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.inputSchema.properties[key];
    if (value === undefined) continue;
    if (spec.type === 'string') {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} must be a non-empty string.`);
      if (spec.maxLength !== undefined && value.length > spec.maxLength) throw new Error(`${key} is too long.`);
      if (spec.enum && !spec.enum.includes(value)) throw new Error(`${key} must be one of: ${spec.enum.join(', ')}.`);
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
    } else if (spec.type === 'integer') {
      if (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum) throw new Error(`${key} is outside the supported range.`);
    } else if (spec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.minimum || value > spec.maximum) throw new Error(`${key} is outside the supported range.`);
    } else if (Array.isArray(spec.type)) {
      if (spec.type.includes('integer') && Number.isInteger(value) && value >= (spec.minimum ?? 0)) continue;
      if (spec.type.includes('string') && typeof value === 'string' && value.trim() !== '') continue;
      throw new Error(`${key} must be a non-negative integer or a non-empty continuation cursor.`);
    }
    if (key === 'cwd' && !path.isAbsolute(value)) throw new Error('cwd must be an absolute path.');
  }
  if (args.permission !== undefined && !PERMISSIONS.has(args.permission)) throw new Error('permission is not supported.');
  return args;
}

function parseToolPayload(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.find(item => item?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('DSH returned an unexpected tool result.');
  try {
    return JSON.parse(text);
  } catch {
    return {text};
  }
}

function agentIdOf(payload) {
  const value = payload?.agent_id ?? payload?.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function workspaceMatches(rowWorkspace, filter) {
  if (!filter) return true;
  try {
    const left = normalizeWorkspace(String(rowWorkspace ?? ''));
    const right = normalizeWorkspace(filter);
    const prefix = right.endsWith(path.sep) ? right : `${right}${path.sep}`;
    return left === right || left.startsWith(prefix);
  } catch {
    return String(rowWorkspace ?? '').toLowerCase().includes(String(filter).toLowerCase());
  }
}

function matchesFilter(row, {status, cwd, match}) {
  if (status && row.status !== status) return false;
  if (cwd && !workspaceMatches(row.cwd, cwd)) return false;
  if (match) {
    const needle = match.toLowerCase();
    const haystack = `${row.name ?? ''} ${row.cwd ?? ''}`.toLowerCase();
    if (!haystack.includes(needle) && !String(row.agent_id ?? '').startsWith(match)) return false;
  }
  return true;
}

export function locateNpxCli() {
  const candidates = [];
  if (process.env.SOL_LUNA_NPX_CLI) candidates.push(process.env.SOL_LUNA_NPX_CLI);
  if (process.env.npm_execpath && /npx-cli\.js$/i.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
  const nodeDirectory = path.dirname(process.execPath);
  candidates.push(path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch { /* Keep looking for a usable npm installation. */ }
  }
  throw new Error('Cannot locate npm npx-cli.js. Install Node.js 24+ with npm, or set SOL_LUNA_NPX_CLI to the npx-cli.js path.');
}

let cachedNpxCli;
export async function defaultRunClient(request) {
  cachedNpxCli ??= locateNpxCli();
  const callTimeoutMs = request.action === 'start' ? 600000 : ['followup', 'events', 'trace'].includes(request.action) ? 120000 : 30000;
  return runClient({...request, npxCli: cachedNpxCli}, {callTimeoutMs});
}

function toolResult(payload, text) {
  return {content: [{type: 'text', text: text ?? JSON.stringify(payload)}], structuredContent: payload};
}

function errorResult(message) {
  return {isError: true, content: [{type: 'text', text: sanitizeError(message)}]};
}

function settingsToolResult(payload, text) {
  return {content: text ? [{type: 'text', text}] : [], structuredContent: payload};
}

function jsonRpcError(id, code, message) {
  return {jsonrpc: '2.0', id: id ?? null, error: {code, message: sanitizeError(message)}};
}

export function createPluginMcp({
  runClient: run = defaultRunClient,
  stateDir,
  trace: traceOverride,
  now = Date.now,
  ownership,
  leases,
  settingsPath,
  getExecutorStatus,
  applyApiConfiguration,
  guardStatus,
  stopOwnedIdleExecutions,
  readCurrentModel,
  readNativeModels,
  collectDiagnostics,
} = {}) {
  const resolvedStateDir = resolveStateDir(stateDir);
  const ownershipStore = ownership ?? new OwnershipStore({stateDir: resolvedStateDir, now});
  const leaseStore = leases ?? new WorkspaceLeases({stateDir: resolvedStateDir, now});
  const traceService = traceOverride ?? createTraceService({now});
  const routerSettings = createRouterSettingsService({
    settingsPath,
    getExecutorStatus,
    applyApiConfiguration,
    guardStatus,
    onRoutingDisabled: stopOwnedIdleExecutions,
    readCurrentModel,
    readNativeModels,
    collectDiagnostics,
    stateDir: resolvedStateDir,
  });

  async function assertAutomaticDispatchEnabled() {
    const snapshot = (await routerSettings.callTool('router_settings_snapshot', {})).payload;
    if (!effectiveRouterEnabled(snapshot.settings, snapshot.capabilities?.guardStatus)) {
      throw new Error('自动子代理分工已关闭；已拒绝新的 DSH 子任务派发。');
    }
  }

  async function backend(action, args, threadId) {
    const response = await run({action, args, meta: {threadId}});
    return parseToolPayload(response?.result);
  }

  async function reconcileLease(lease) {
    if (!lease || isReservationLease(lease)) throw new Error('the lease has no verified DSH agent id');
    const response = await run({action: 'show', args: {agent_id: lease.agent_id}});
    const payload = parseToolPayload(response?.result);
    if (typeof payload?.status !== 'string' || payload.status.trim() === '') {
      throw new Error('the DSH status response did not include a status');
    }
    return payload.status;
  }

  async function releaseLease(record, threadId, agentId) {
    if (!record?.workspace) return;
    await leaseStore.release({workspace: record.workspace, threadId, agentId});
  }

  async function observeStatus(record, threadId, status) {
    const warnings = [];
    if (typeof status !== 'string' || !PASSIVE_STATUSES.has(status)) return warnings;
    try {
      await ownershipStore.markStatus(record.agent_id, threadId, status);
    } catch (error) {
      warnings.push(sanitizeError(`Could not update ownership status: ${error.message}`));
    }
    if (record.workspace) {
      try {
        await releaseLease(record, threadId, record.agent_id);
      } catch (error) {
        warnings.push(sanitizeError(`Could not release workspace writer lease: ${error.message}`));
      }
    }
      if (TERMINAL_STATUSES.has(status)) {
        const cleanup = await finalizePendingDisable({settingsPath: routerSettings.settingsPath, stateDir: resolvedStateDir});
        if (cleanup.stopped === false && cleanup.skipped !== true && cleanup.deferred !== true) {
          warnings.push(cleanup.message || '自动分工已关闭，但后台执行器停止状态无法确认；可在设置中重试。');
        }
      }
    if (TERMINAL_STATUSES.has(status)) traceService.revokeAgent(record.agent_id);
    return warnings;
  }

  function withWarnings(payload, warnings) {
    if (warnings.length) return {...payload, plugin_warnings: warnings};
    return payload;
  }

  async function start(args, threadId) {
    await assertAutomaticDispatchEnabled();
    const permission = args.permission ?? 'workspace-write';
    const provider = args.provider ?? 'deepseek-official';
    const model = args.model ?? 'deepseek-flash';
    if (provider !== 'deepseek-official') throw new Error('The plugin accepts only the official DeepSeek provider deepseek-official.');
    if (!/deepseek/i.test(model)) throw new Error('The plugin accepts only a DeepSeek model name.');
    const workspace = await canonicalWorkspace(args.cwd);
    const cwd = path.resolve(args.cwd);
    const write = permission !== 'read-only';
    const upstream = {task: args.task, cwd, permission, provider, model};
    for (const key of ['name', 'effort', 'preset']) if (args[key] !== undefined) upstream[key] = args[key];
    const reservation = `reservation:${randomBytes(10).toString('hex')}`;
    const reservationFile = write ? path.join(leaseStore.directory, `${await workspaceKey(workspace)}.json`) : null;
    if (write) await leaseStore.acquire({workspace, threadId, agentId: reservation, bound: false, reconcile: reconcileLease});
    let payload;
    try {
      payload = await backend('start', upstream, threadId);
    } catch (error) {
      const uncertain = /call timed out|process exited|outcome may be unknown|EPIPE|stdin|stdout|stderr/i.test(String(error.message));
      if (write && !uncertain) await leaseStore.release({workspace, threadId, agentId: reservation}).catch(() => {});
      if (write && uncertain) {
        throw new Error(`${error.message} The unbound reservation is retained at ${reservationFile} and never expires automatically. Verify that no DSH task is running, then deliberately remove that lease file before retrying; do not start a duplicate.`);
      }
      throw error;
    }
    const created = agentIdOf(payload);
    if (!created) {
      if (write) {
        throw new Error(`DSH did not return an agent id; refusing to leave an unowned writer. The unbound reservation is retained at ${reservationFile} and never expires automatically. Verify that no DSH task is running, then deliberately remove that lease file before retrying.`);
      }
      throw new Error('DSH did not return an agent id; refusing to report an unowned agent.');
    }
    try {
      if (write) await leaseStore.bind({workspace, threadId, reservationId: reservation, agentId: created});
      await ownershipStore.claim(created, threadId, {workspace, write, status: 'active'});
    } catch (error) {
      // A bound lease is never released merely because the plugin failed to
      // claim the agent. Interrupt only an agent that is not owned by another
      // chat, then keep the lease for deliberate recovery.
      if (!/not available to this chat/.test(error.message)) {
        await backend('interrupt', {agent_id: created}, threadId).catch(() => {});
      }
      const leaseNote = write
        ? ` The workspace writer lease is retained at ${reservationFile} because a confirmed idle/terminal state was not established; inspect DSH before deliberate recovery.`
        : '';
      throw new Error(`${error.message}${leaseNote}`);
    }
    return payload;
  }

  async function followup(args, threadId) {
    await assertAutomaticDispatchEnabled();
    const record = await ownershipStore.assertOwner(args.agent_id, threadId);
    const upstream = {agent_id: args.agent_id, task: args.task};
    if (args.legacy !== undefined) upstream.legacy = args.legacy;
    if (record.write) {
      if (!record.workspace) throw new Error('This write-capable agent has no recorded workspace; refusing to continue without a writer lease.');
      await leaseStore.acquire({workspace: record.workspace, threadId, agentId: record.agent_id, bound: true, reconcile: reconcileLease});
    }
    try {
      const payload = await backend('followup', upstream, threadId);
      const warnings = [];
      try {
        await ownershipStore.markStatus(record.agent_id, threadId, 'active');
      } catch (error) {
        warnings.push(sanitizeError(`Could not update ownership status: ${error.message}`));
      }
      return withWarnings(payload, warnings);
    } catch (error) {
      // A rejected follow-up can mean the agent is still busy. Keep the lease:
      // releasing it here would let another chat write while the agent runs.
      throw error;
    }
  }

  async function wait(args, threadId) {
    const record = await ownershipStore.assertOwner(args.agent_id, threadId);
    const upstream = {agent_id: args.agent_id};
    if (args.seconds !== undefined) upstream.seconds = args.seconds;
    if (args.legacy !== undefined) upstream.legacy = args.legacy;
    const payload = await backend('wait', upstream, threadId);
    const warnings = await observeStatus(record, threadId, payload.status);
    return withWarnings(payload, warnings);
  }

  async function status(args, threadId) {
    const record = await ownershipStore.assertOwner(args.agent_id, threadId);
    const upstream = {agent_id: args.agent_id};
    if (args.legacy !== undefined) upstream.legacy = args.legacy;
    const payload = await backend('show', upstream, threadId);
    const warnings = await observeStatus(record, threadId, payload.status);
    return withWarnings(payload, warnings);
  }

  async function list(args, threadId) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
    const ownedRecords = await ownershipStore.owned(threadId);
    const payload = await backend('list', {limit: DEFAULT_HARD_LIMIT, max_chars: DEFAULT_HARD_MAX_CHARS, legacy: Boolean(args.legacy)}, threadId);
    const source = Array.isArray(payload?.items) ? payload.items : [];
    const records = new Map(ownedRecords.map(record => [record.agent_id, record]));
    const ownedIds = new Set(records.keys());
    const filtered = source
      .filter(row => ownedIds.has(String(row?.agent_id ?? row?.id ?? '')))
      .filter(row => matchesFilter(row, {status: args.status, cwd: args.cwd, match: args.match}));
    const warnings = [];
    for (const row of filtered) {
      if (!PASSIVE_STATUSES.has(row.status)) continue;
      const record = records.get(String(row.agent_id ?? row.id));
      if (record) warnings.push(...await observeStatus(record, threadId, row.status));
    }
    const rows = filtered.slice(0, limit);
    const droppedByRows = filtered.length - rows.length;
    const output = {
      count: rows.length,
      ...(args.status || args.cwd || args.match ? {matched: filtered.length} : {}),
      total: ownedIds.size,
      ownership: 'this_chat',
    };
    if (warnings.length) output.plugin_warnings = warnings;
    if (droppedByRows > 0) output.omitted = `${droppedByRows} more rows not shown (row limit); raise limit or narrow with status/cwd/match`;
    output.items = rows;
    while (rows.length > 1 && JSON.stringify(output).length > maxChars) {
      rows.pop();
      output.count = rows.length;
      output.omitted = `${filtered.length - rows.length} more rows not shown (size budget); raise max_chars or narrow with status/cwd/match`;
    }
    return output;
  }

  async function interrupt(args, threadId) {
    const record = await ownershipStore.assertOwner(args.agent_id, threadId);
    const upstream = {agent_id: args.agent_id};
    if (args.legacy !== undefined) upstream.legacy = args.legacy;
    const payload = await backend('interrupt', upstream, threadId);
    const warnings = await observeStatus(record, threadId, payload.status ?? 'interrupted');
    return withWarnings(payload, warnings);
  }

  async function closeAgent(args, threadId) {
    const record = await ownershipStore.assertOwner(args.agent_id, threadId);
    const upstream = {agent_id: args.agent_id};
    if (args.legacy !== undefined) upstream.legacy = args.legacy;
    const payload = await backend('close', upstream, threadId);
    const warnings = await observeStatus(record, threadId, payload.status ?? 'closed');
    return withWarnings(payload, warnings);
  }

  async function rename(args, threadId) {
    await ownershipStore.assertOwner(args.agent_id, threadId);
    const upstream = {agent_id: args.agent_id, name: args.name};
    if (args.legacy !== undefined) upstream.legacy = args.legacy;
    return backend('rename', upstream, threadId);
  }

  async function events(args, threadId) {
    await ownershipStore.assertOwner(args.agent_id, threadId);
    return backend('events', {...args}, threadId);
  }

  async function traceAgent(args, threadId) {
    const record = await ownershipStore.assertOwner(args.agent_id, threadId);
    let statusPayload = null;
    try {
      statusPayload = await backend('show', {agent_id: args.agent_id}, threadId);
    } catch { /* A trace can still show the events already persisted. */ }
    const warnings = statusPayload ? await observeStatus(record, threadId, statusPayload.status) : [];
    const eventsArgs = {
      agent_id: args.agent_id,
      limit: 100,
      max_chars: DEFAULT_HARD_MAX_CHARS,
      include_progress: true,
      include_descendants: true,
      include_tool_events: true,
    };
    if (args.after !== undefined) eventsArgs.after = args.after;
    if (args.event_id !== undefined) eventsArgs.event_id = args.event_id;
    const payload = await backend('events', eventsArgs, threadId);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const hasMore = payload?.has_more === true;
    const nextCursor = payload?.next_cursor ?? null;
    // The detail link runs the same ownership check and the same trusted
    // backend call as the snapshot. The agent id and thread id stay out of the
    // browser URL; the trace service binds this closure to one per-view cookie
    // session, so another agent's tab cannot read it and two tabs coexist.
    const loadEvent = async eventId => {
      await ownershipStore.assertOwner(args.agent_id, threadId);
      return backend('events', {
        agent_id: args.agent_id,
        event_id: eventId,
        include_progress: true,
        include_descendants: true,
        include_tool_events: true,
      }, threadId);
    };
    traceService.revokeAgent(args.agent_id);
    const opened = await traceService.open({
      agentId: args.agent_id,
      owner: hashThread(threadId),
      title: statusPayload?.name ?? args.agent_id,
      status: statusPayload?.status ?? record.status ?? 'unknown',
      events,
      hasMore,
      nextCursor,
      selectedEventId: args.event_id ?? null,
      loadEvent,
    });
    const result = {
      agent_id: args.agent_id,
      status: statusPayload?.status ?? record.status ?? 'unknown',
      event_count: events.length,
      has_more: hasMore,
      next_cursor: nextCursor,
      truncated: hasMore,
      ...(args.event_id !== undefined ? {selected_event_id: args.event_id} : {}),
      ...opened,
      ...(warnings.length ? {plugin_warnings: warnings} : {}),
      limitation: 'External DSH agents are not native Codex children. This read-only browser trace is the external DSH view, not a Codex subagent panel.',
    };
    return {payload: result, text: `Read-only local DSH trace (per-view scoped, short-lived access ticket, not a credential):\n${opened.url}\n${JSON.stringify(result)}`};
  }

  async function dispatch(name, args, threadId) {
    switch (name) {
      case 'dsh_start': return {payload: await start(args, threadId)};
      case 'dsh_status': return {payload: await status(args, threadId)};
      case 'dsh_wait': return {payload: await wait(args, threadId)};
      case 'dsh_followup': return {payload: await followup(args, threadId)};
      case 'dsh_list': return {payload: await list(args, threadId)};
      case 'dsh_interrupt': return {payload: await interrupt(args, threadId)};
      case 'dsh_close': return {payload: await closeAgent(args, threadId)};
      case 'dsh_rename': return {payload: await rename(args, threadId)};
      case 'dsh_events': return {payload: await events(args, threadId)};
      case 'dsh_trace': return traceAgent(args, threadId);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  async function handle(message) {
    if (!plainObject(message) || message.jsonrpc !== '2.0') return jsonRpcError(message?.id, -32600, 'Invalid JSON-RPC request.');
    const {id, method, params = {}} = message;
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : '2025-11-25',
          capabilities: {
            tools: {listChanged: false},
            resources: {subscribe: false, listChanged: false},
            experimental: {
              'openai/settings': {
                readTool: 'router_settings_read',
                updateTool: 'router_settings_update',
              },
            },
          },
          serverInfo: {name: 'sol-luna-deepseek-router', version: VERSION, title: 'Sol Luna DeepSeek Router'},
          instructions: 'Every DSH tools/call must carry the trusted Codex request _meta.threadId; this server refuses to act without it. Router settings tools are direct, app-visible configuration calls and do not require a model turn. One chat owns each DSH agent and dsh_list is filtered to that chat. Retain agent ids and use dsh_wait; do not duplicate a start after a timeout. dsh_trace returns a read-only loopback URL with a short-lived access ticket, never a credential. External DSH agents are not native Codex children; the trace is the truthful external event view. Turning routing off rejects new automatic and DSH dispatch, disables verified plugin-owned scheduled tasks, stops idle gateways after active work finishes, and clears CODEX_CLI_PATH only when it still exactly matches this plugin’s install record; a custom user path is preserved. Current Codex does not hot-switch and may need a restart to use the official path. API profile Apply, full restart, and live provider verification remain separate actions.',
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return {jsonrpc: '2.0', id, result: {}};
    if (method === 'tools/list') return {jsonrpc: '2.0', id, result: {tools: TOOLS}};
    if (method === 'resources/list') return {jsonrpc: '2.0', id, result: {resources: routerSettings.listResources()}};
    if (method === 'resources/read') {
      try {
        return {jsonrpc: '2.0', id, result: {contents: await routerSettings.readResource(params?.uri)}};
      } catch (error) {
        return jsonRpcError(id, -32002, error.message);
      }
    }
    if (method !== 'tools/call') return method?.startsWith('notifications/') ? null : jsonRpcError(id, -32601, `Unsupported method: ${method}`);
    try {
      if (typeof params.name !== 'string' || params.name.trim() === '') throw new Error('tools/call requires a tool name.');
      const tool = TOOL_BY_NAME.get(params.name);
      if (!tool) throw new Error(`Unknown tool: ${params.name}`);
      const args = params.arguments ?? {};
      if (ROUTER_SETTINGS_TOOL_NAMES.has(tool.name)) {
        let context = {};
        try { context = {threadId: trustedThreadId(params)}; } catch { /* Settings remain usable without current-chat metadata. */ }
        const {payload, text} = await routerSettings.callTool(tool.name, args, context);
        return {jsonrpc: '2.0', id, result: settingsToolResult(payload, text)};
      }
      const threadId = trustedThreadId(params);
      validateArguments(tool, args);
      const {payload, text} = await dispatch(tool.name, args, threadId);
      return {jsonrpc: '2.0', id, result: toolResult(payload, text)};
    } catch (error) {
      return {jsonrpc: '2.0', id, result: errorResult(error.message)};
    }
  }

  async function close() {
    await traceService.close();
  }

  return {
    handle,
    close,
    ownership: ownershipStore,
    leases: leaseStore,
    trace: traceService,
    stateDir: resolvedStateDir,
    routerSettings,
  };
}

async function main() {
  const server = createPluginMcp({
    getExecutorStatus: getNativeApiExecutorStatus,
    applyApiConfiguration: applyNativeApiConfiguration,
  });
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const lines = createInterface({input: process.stdin});
  let pending = 0;
  let closing = false;
  const closeWhenIdle = async () => {
    if (closing) return;
    closing = true;
    while (pending > 0) await new Promise(resolve => setTimeout(resolve, 10));
    await server.close();
  };
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    pending += 1;
    server.handle(message).then(response => {
      if (response) write(response);
    }).catch(error => {
      if (message?.id !== undefined) write(jsonRpcError(message.id, -32603, error.message));
    }).finally(() => {
      pending -= 1;
    });
  });
  lines.on('close', () => {
    closeWhenIdle().catch(error => { process.stderr.write(`${sanitizeError(error.message)}\n`); });
    // A disconnected client must not leave an unbounded wait or trace server
    // holding the plugin process open forever.
    setTimeout(() => process.exit(0), 5000).unref();
  });
  const shutdown = signal => {
    process.stderr.write(`Received ${signal}; closing the read-only trace service.\n`);
    server.close().catch(error => { process.stderr.write(`${sanitizeError(error.message)}\n`); }).finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${sanitizeError(error.message || 'Plugin MCP failed')}\n`);
    process.exitCode = 1;
  });
}
