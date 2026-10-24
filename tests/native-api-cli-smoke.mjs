#!/usr/bin/env node
/*
 * Opt-in adapter smoke for a user-supplied Codex CLI and the generic native API
 * gateway. It makes no real model request: every upstream is a loopback mock.
 *
 * Usage:
 *   node tests/native-api-cli-smoke.mjs --binary C:\path\to\codex.exe --sha256 <64-hex>
 *     [--scenario all|chat-reasoning|mimo-none|ds-responses]
 *
 * The binary may also be supplied with SOL_LUNA_NATIVE_API_SMOKE_BINARY and
 * SOL_LUNA_NATIVE_API_SMOKE_SHA256. Both values are required: a missing or
 * mismatched SHA-256 fails before any CLI or server starts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createNativeApiGateway } from "../scripts/native-api-gateway.mjs";

const PROFILE_ID = "a1b2c3d4e5f60718293a4b5c";
const TOKEN = "native-api-cli-smoke-local-token";
const DS_MODEL = "deepseek-flash";
const MIMO_MODEL = "mimo-v2.5";
const TOOL_PROOF = "native-api-cli-proof";
const CLI_TIMEOUT_MS = 60_000;
const SCENARIOS = new Set(["chat-reasoning", "mimo-none", "ds-responses"]);

function option(name) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
}

function usage() {
  return [
    "Usage: node tests/native-api-cli-smoke.mjs --binary PATH --sha256 HASH [--scenario NAME]",
    "",
    "The SHA-256 is required. A missing or mismatched hash fails before any",
    "CLI or loopback server starts.",
    "",
    "Scenarios:",
    "  all             run chat-reasoning, mimo-none, and ds-responses",
    "  chat-reasoning  official DeepSeek Chat tool round with reasoning replay",
    "  mimo-none       official MiMo Chat with parameter=none plus cold resume",
    "  ds-responses    official DeepSeek Responses compatibility normalization",
    "",
    "Environment fallbacks:",
    "  SOL_LUNA_NATIVE_API_SMOKE_BINARY",
    "  SOL_LUNA_NATIVE_API_SMOKE_SHA256",
  ].join("\n");
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const binary = option("binary") || process.env.SOL_LUNA_NATIVE_API_SMOKE_BINARY;
const expectedHash = option("sha256") || process.env.SOL_LUNA_NATIVE_API_SMOKE_SHA256;
if (!binary) throw new Error(`--binary is required (or set SOL_LUNA_NATIVE_API_SMOKE_BINARY)\n\n${usage()}`);
if (!expectedHash) throw new Error(`--sha256 is required (or set SOL_LUNA_NATIVE_API_SMOKE_SHA256)\n\n${usage()}`);
if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error(`--sha256 must be 64 hexadecimal characters, got ${expectedHash}`);
const binaryPath = path.resolve(binary);
const binaryHash = createHash("sha256").update(await fs.readFile(binaryPath)).digest("hex");
if (expectedHash.toLowerCase() !== binaryHash) {
  throw new Error(`CLI SHA-256 mismatch: expected ${expectedHash}, got ${binaryHash}`);
}

const requestedScenario = process.argv.includes("--none-profile") ? "mimo-none" : (option("scenario") || "all");
const selectedScenarios = requestedScenario === "all"
  ? ["chat-reasoning", "mimo-none", "ds-responses"]
  : [requestedScenario];
for (const scenario of selectedScenarios) {
  if (!SCENARIOS.has(scenario)) throw new Error(`Unknown scenario ${scenario}; expected all, ${[...SCENARIOS].join(", ")}`);
}

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.close();
  await once(server, "close");
}

function jsonResponse(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function chatSse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
  res.end("data: [DONE]\r\n\r\n");
}

function responsesSse(res, items, { model }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = (status, output, usage = null) => ({
    id: `resp_${Math.random().toString(36).slice(2)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage,
    error: null,
    incomplete_details: null,
  });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "response.created", sequence_number: 0, response: base("in_progress", []) });
  send({ type: "response.in_progress", sequence_number: 1, response: base("in_progress", []) });
  let sequence = 2;
  for (let index = 0; index < items.length; index += 1) {
    send({ type: "response.output_item.done", sequence_number: sequence++, output_index: index, item: items[index] });
  }
  send({
    type: "response.completed",
    sequence_number: sequence,
    response: base("completed", items, { input_tokens: 11, output_tokens: 5, total_tokens: 16 }),
  });
  res.end();
}

function safeEnvironment(codexHome, proxyBase) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CODEX_HOME = codexHome;
  env.HOME = codexHome;
  env.OPENAI_API_KEY = "loopback-smoke-key-never-sent";
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = env.NO_PROXY;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[key] = proxyBase;
  return env;
}

async function runCli(args, { codexHome, workspace, proxyBase }) {
  const child = spawn(binaryPath, args, {
    cwd: workspace,
    env: safeEnvironment(codexHome, proxyBase),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let timeout;
  const exitCode = await Promise.race([
    once(child, "exit").then(([code]) => code),
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI smoke timed out after ${CLI_TIMEOUT_MS / 1000} seconds`));
      }, CLI_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timeout));
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  return { exitCode, stdout, stderr };
}

async function listFiles(root) {
  const files = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else files.push(target);
    }
  }
  return files;
}

async function withScenario(name, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `native-api-cli-smoke-${name}-`));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  let mockServer;
  let proxyServer;
  let gateway;
  try {
    return await fn({
      root,
      codexHome,
      workspace,
      setMock: (server) => { mockServer = server; },
      setProxy: (server) => { proxyServer = server; },
      setGateway: (value) => { gateway = value; },
    });
  } finally {
    await gateway?.close();
    await closeServer(proxyServer);
    await closeServer(mockServer);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

async function prepareLoopback(context) {
  const calls = [];
  const requestedHosts = new Set();
  const gatewayHosts = new Set();
  const interceptedOrigins = new Set();
  const blockedProxyAttempts = [];
  let upstreamPort;

  const proxyServer = http.createServer((req, res) => {
    blockedProxyAttempts.push(req.url);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("The opt-in smoke blocks every proxy request.");
  });
  proxyServer.on("connect", (req, socket) => {
    blockedProxyAttempts.push(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  context.setProxy(proxyServer);
  const proxyPort = await listen(proxyServer);
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  return {
    calls,
    requestedHosts,
    gatewayHosts,
    interceptedOrigins,
    blockedProxyAttempts,
    proxyBase,
    async startMock(handler) {
      const mockServer = http.createServer(async (req, res) => {
        requestedHosts.add(req.headers.host);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { jsonResponse(res, 400, { error: { message: "invalid JSON body" } }); return; }
        calls.push(body);
        try {
          await handler(body, res, calls.length);
        } catch (error) {
          jsonResponse(res, 400, { error: { message: error?.message || String(error) } });
        }
      });
      context.setMock(mockServer);
      upstreamPort = await listen(mockServer);
      return upstreamPort;
    },
    createGateway({ profile, redirectPath }) {
      const gateway = createNativeApiGateway({
        resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? profile : null,
        resolveAuth: async () => ({ headers: { authorization: "Bearer loopback-smoke-only" } }),
        fetchImpl: async (url, init) => {
          const target = new URL(url);
          interceptedOrigins.add(target.origin);
          return fetch(`http://127.0.0.1:${upstreamPort}${redirectPath}`, init);
        },
        token: TOKEN,
        timeoutMs: 10_000,
        logger: { info() {} },
      });
      gateway.server.on("request", (req) => gatewayHosts.add(req.headers.host));
      context.setGateway(gateway);
      return gateway;
    },
  };
}

async function writeConfig({ codexHome, workspace, model, providerBase, effort, noneProfile }) {
  const configLines = [
    `model = "${model}"`,
    'model_provider = "local_smoke"',
    ...(noneProfile
      ? ['model_reasoning_effort = "none"', 'model_reasoning_summary = "none"']
      : [`model_reasoning_effort = "${effort}"`]),
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    "",
    "[model_providers.local_smoke]",
    'name = "Native API loopback smoke"',
    `base_url = "${providerBase}"`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'supports_websockets = false',
    "",
  ];
  await fs.writeFile(path.join(codexHome, "config.toml"), configLines.join("\n"), "utf8");
  await fs.mkdir(workspace, { recursive: true });
}

function commandTool(body, format) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return format === "responses"
    ? tools.find((tool) => tool?.type === "function" && tool?.parameters?.properties?.cmd)
    : tools.find((tool) => tool?.function?.parameters?.properties?.cmd);
}

function toolCommand(workspace) {
  return JSON.stringify({
    cmd: `node -e "require('fs').writeFileSync('smoke-output.txt','${TOOL_PROOF}'); console.log('${TOOL_PROOF}')"`,
    workdir: workspace,
    yield_time_ms: 1000,
    max_output_tokens: 200,
  });
}

function chatToolChunks({ model, toolName, callId, reasoning, workspace }) {
  return [
    { id: `chatcmpl-${callId}`, model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning }, finish_reason: null }] },
    {
      id: `chatcmpl-${callId}`,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: callId,
            type: "function",
            function: { name: toolName, arguments: toolCommand(workspace) },
          }],
        },
        finish_reason: null,
      }],
    },
    { id: `chatcmpl-${callId}`, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: `chatcmpl-${callId}`, model, choices: [], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } },
  ];
}

function chatFinalChunks({ model, reasoning }) {
  return [
    { id: "chatcmpl-final", model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning }, finish_reason: null }] },
    { id: "chatcmpl-final", model, choices: [{ index: 0, delta: { content: "Native API CLI smoke succeeded." }, finish_reason: null }] },
    { id: "chatcmpl-final", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "chatcmpl-final", model, choices: [], usage: { prompt_tokens: 31, completion_tokens: 6, total_tokens: 37 } },
  ];
}

function finalizeResult(run, loopback, fields) {
  assert.equal([...loopback.requestedHosts].every((host) => /^(127\.0\.0\.1|localhost):\d+$/.test(host)), true, "upstream host must be loopback");
  assert.equal([...loopback.gatewayHosts].every((host) => /^(127\.0\.0\.1|localhost):\d+$/.test(host)), true, "gateway host must be loopback");
  assert.equal(loopback.interceptedOrigins.size, 1, "the gateway must target exactly one official vendor origin");
  return {
    status: "passed",
    binary: binaryPath,
    binarySha256: binaryHash,
    cliExitCode: run.exitCode,
    chatRequests: loopback.calls.length,
    gatewayTargetOrigin: [...loopback.interceptedOrigins][0],
    toolResultReturnedToUpstream: loopback.calls.length >= 2,
    workspaceFileCreatedByCliTool: true,
    stdoutTail: run.stdout.slice(-600),
    stderrTail: run.stderr.slice(-600),
    proxyAttemptsBlocked: loopback.blockedProxyAttempts.length,
    ...fields,
  };
}

async function runScenarioChatReasoning() {
  return withScenario("chat-reasoning", async (context) => {
    const loopback = await prepareLoopback(context);
    const toolReasoning = "deepseek tool reasoning";
    const finalReasoning = "deepseek final reasoning";
    const callId = "call_deepseek_smoke";
    await loopback.startMock(async (body, res, count) => {
      if (count === 1) {
        assert.equal(body.model, DS_MODEL);
        assert.equal(body.reasoning_effort, "high");
        const tool = commandTool(body, "chat");
        assert.ok(tool);
        chatSse(res, chatToolChunks({ model: DS_MODEL, toolName: tool.function.name, callId, reasoning: toolReasoning, workspace: context.workspace }));
        return;
      }
      const toolMessage = body.messages.find((message) => message.role === "tool" && message.tool_call_id === callId);
      assert.match(toolMessage.content, new RegExp(TOOL_PROOF));
      assert.equal(body.messages.find((message) => message.tool_calls).reasoning_content, toolReasoning);
      chatSse(res, chatFinalChunks({ model: DS_MODEL, reasoning: finalReasoning }));
    });
    const gateway = loopback.createGateway({
      profile: {
        profileId: PROFILE_ID,
        protocol: "chat_completions",
        baseUrl: "https://api.deepseek.com",
        model: DS_MODEL,
        reasoning: { supported: ["low", "medium", "high"], default: "low", parameter: "reasoning_effort" },
        credential: { type: "env", name: "OPENAI_API_KEY" },
      },
      redirectPath: "/v1/chat/completions",
    });
    const { baseUrl } = await gateway.start(0);
    await writeConfig({
      codexHome: context.codexHome,
      workspace: context.workspace,
      model: DS_MODEL,
      providerBase: `${baseUrl}/profiles/${PROFILE_ID}/v1`,
      effort: "high",
    });
    const run = await runCli([
      "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--strict-config",
      "-c", 'model_provider="local_smoke"', "--model", DS_MODEL, "-C", context.workspace,
      "Use exec_command exactly once to create smoke-output.txt in the current workspace with the text native-api-cli-proof, then confirm.",
    ], { codexHome: context.codexHome, workspace: context.workspace, proxyBase: loopback.proxyBase });
    assert.equal(run.exitCode, 0, `DeepSeek Chat CLI exited ${run.exitCode}; stderr tail: ${run.stderr.slice(-1500)}`);
    assert.equal(loopback.calls.length, 2);
    assert.equal((await fs.readFile(path.join(context.workspace, "smoke-output.txt"), "utf8")).trim(), TOOL_PROOF);
    return finalizeResult(run, loopback, {
      scenario: "chat-reasoning",
      model: DS_MODEL,
      reasoningReplayed: true,
      noneProfile: false,
      coldResume: false,
    });
  });
}

async function runScenarioMimoNone() {
  return withScenario("mimo-none", async (context) => {
    const loopback = await prepareLoopback(context);
    const toolReasoning = "mimo default thinking tool reasoning";
    const finalReasoning = "mimo default thinking final reasoning";
    const callId = "call_mimo_smoke";
    await loopback.startMock(async (body, res, count) => {
      if (count === 1) {
        assert.equal(body.model, MIMO_MODEL);
        assert.equal(body.reasoning_effort, undefined);
        assert.equal(body.reasoning, undefined);
        assert.equal(body.thinking, undefined);
        const tool = commandTool(body, "chat");
        assert.ok(tool);
        chatSse(res, chatToolChunks({ model: MIMO_MODEL, toolName: tool.function.name, callId, reasoning: toolReasoning, workspace: context.workspace }));
        return;
      }
      const toolMessage = body.messages.find((message) => message.role === "tool" && message.tool_call_id === callId);
      assert.match(toolMessage.content, new RegExp(TOOL_PROOF));
      assert.equal(body.messages.find((message) => message.tool_calls).reasoning_content, toolReasoning);
      if (count === 3) {
        const assistants = body.messages.filter((message) => message.role === "assistant");
        assert.equal(assistants.find((message) => message.tool_calls)?.reasoning_content, toolReasoning);
        assert.equal(
          assistants.find((message) => typeof message.content === "string" && message.content.includes("Native API CLI smoke succeeded"))?.reasoning_content,
          finalReasoning,
          "cold resume must replay the previous no-tool turn reasoning",
        );
      }
      chatSse(res, chatFinalChunks({ model: MIMO_MODEL, reasoning: finalReasoning }));
    });
    const gateway = loopback.createGateway({
      profile: {
        profileId: PROFILE_ID,
        protocol: "chat_completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: MIMO_MODEL,
        reasoning: { supported: ["none"], default: "none", parameter: "none" },
        credential: { type: "env", name: "OPENAI_API_KEY" },
      },
      redirectPath: "/v1/chat/completions",
    });
    const { baseUrl } = await gateway.start(0);
    await writeConfig({
      codexHome: context.codexHome,
      workspace: context.workspace,
      model: MIMO_MODEL,
      providerBase: `${baseUrl}/profiles/${PROFILE_ID}/v1`,
      noneProfile: true,
    });
    const first = await runCli([
      "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--strict-config",
      "-c", 'model_provider="local_smoke"', "--model", MIMO_MODEL, "-C", context.workspace,
      "Use exec_command exactly once to create smoke-output.txt in the current workspace with the text native-api-cli-proof, then confirm.",
    ], { codexHome: context.codexHome, workspace: context.workspace, proxyBase: loopback.proxyBase });
    assert.equal(first.exitCode, 0, `MiMo Chat CLI exited ${first.exitCode}; stderr tail: ${first.stderr.slice(-1500)}`);
    assert.equal(loopback.calls.length, 2);
    const rolloutFiles = await listFiles(path.join(context.codexHome, "sessions"));
    const rolloutText = (await Promise.all(rolloutFiles.map((file) => fs.readFile(file, "utf8").catch(() => "")))).join("\n");
    assert.match(rolloutText, /rs_mimo_/, "the persisted rollout must contain the MiMo reasoning source marker");
    assert.match(rolloutText, /mimo default thinking tool reasoning/);
    const resumed = await runCli([
      "exec", "resume", "--last", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--strict-config",
      "-c", 'model_provider="local_smoke"', "--model", MIMO_MODEL, "Continue and confirm briefly.",
    ], { codexHome: context.codexHome, workspace: context.workspace, proxyBase: loopback.proxyBase });
    assert.equal(resumed.exitCode, 0, `MiMo cold resume exited ${resumed.exitCode}; stderr tail: ${resumed.stderr.slice(-1500)}`);
    assert.equal(loopback.calls.length, 3);
    return finalizeResult(resumed, loopback, {
      scenario: "mimo-none",
      model: MIMO_MODEL,
      reasoningReplayed: true,
      noneProfile: true,
      coldResume: true,
      firstCliExitCode: first.exitCode,
      rolloutReasoningPersisted: true,
    });
  });
}

async function runScenarioDsResponses() {
  return withScenario("ds-responses", async (context) => {
    const loopback = await prepareLoopback(context);
    const toolReasoning = "responses reasoning";
    const callId = "call_responses_smoke";
    const forbidden = ["store", "include", "metadata", "client_metadata", "prompt_cache_key", "service_tier", "stream_options", "access_programs"];
    await loopback.startMock(async (body, res, count) => {
      assert.equal(body.model, DS_MODEL);
      for (const key of forbidden) assert.equal(key in body, false, `${key} must be normalized away before the official DeepSeek endpoint`);
      assert.deepEqual(body.reasoning, { effort: "high" });
      if (count === 1) {
        const tool = commandTool(body, "responses");
        assert.ok(tool);
        responsesSse(res, [
          { id: "rs_responses_1", type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: toolReasoning }] },
          {
            id: "fc_responses_1",
            type: "function_call",
            status: "completed",
            call_id: callId,
            name: tool.name,
            arguments: toolCommand(context.workspace),
          },
        ], { model: DS_MODEL });
        return;
      }
      const input = Array.isArray(body.input) ? body.input : [];
      const reasoning = input.find((item) => item?.type === "reasoning");
      assert.equal(reasoning?.content?.find((part) => part?.type === "reasoning_text")?.text, toolReasoning);
      const toolOutput = input.find((item) => item?.type === "function_call_output" && item?.call_id === callId);
      assert.match(String(toolOutput?.output), new RegExp(TOOL_PROOF));
      responsesSse(res, [{
        id: "msg_responses_final",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Native API CLI smoke succeeded.", annotations: [] }],
      }], { model: DS_MODEL });
    });
    const gateway = loopback.createGateway({
      profile: {
        profileId: PROFILE_ID,
        protocol: "responses",
        baseUrl: "https://api.deepseek.com",
        model: DS_MODEL,
        reasoning: { supported: ["none", "low", "high", "max"], default: "high", parameter: "reasoning_effort" },
        credential: { type: "env", name: "OPENAI_API_KEY" },
      },
      redirectPath: "/v1/responses",
    });
    const { baseUrl } = await gateway.start(0);
    await writeConfig({
      codexHome: context.codexHome,
      workspace: context.workspace,
      model: DS_MODEL,
      providerBase: `${baseUrl}/profiles/${PROFILE_ID}/v1`,
      effort: "high",
    });
    const run = await runCli([
      "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--strict-config",
      "-c", 'model_provider="local_smoke"', "--model", DS_MODEL, "-C", context.workspace,
      "Use exec_command exactly once to create smoke-output.txt in the current workspace with the text native-api-cli-proof, then confirm.",
    ], { codexHome: context.codexHome, workspace: context.workspace, proxyBase: loopback.proxyBase });
    assert.equal(run.exitCode, 0, `DeepSeek Responses CLI exited ${run.exitCode}; stderr tail: ${run.stderr.slice(-1500)}`);
    assert.equal(loopback.calls.length, 2);
    assert.equal((await fs.readFile(path.join(context.workspace, "smoke-output.txt"), "utf8")).trim(), TOOL_PROOF);
    return finalizeResult(run, loopback, {
      scenario: "ds-responses",
      model: DS_MODEL,
      responsesNormalized: true,
      reasoningReplayed: true,
      coldResume: false,
    });
  });
}

const runners = {
  "chat-reasoning": runScenarioChatReasoning,
  "mimo-none": runScenarioMimoNone,
  "ds-responses": runScenarioDsResponses,
};

const results = [];
for (const scenario of selectedScenarios) {
  results.push(await runners[scenario]());
}

console.log(JSON.stringify({
  status: "passed",
  binary: binaryPath,
  binarySha256: binaryHash,
  scenarios: results,
}, null, 2));
