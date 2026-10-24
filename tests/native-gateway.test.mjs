import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createNativeGateway } from "../scripts/native-gateway.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };

const dir = await mkdtemp(path.join(os.tmpdir(), "native-gateway-"));
const logPath = path.join(dir, "gateway.jsonl");
const calls = [];

function sse(usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 }) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

function relaySse(payload, usage = { input_tokens: 7, output_tokens: 11, total_tokens: 18 }) {
  const args = JSON.stringify({ payload });
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", name: "relay_external_agent_payload", id: "fc_1", call_id: "call_1" } })}`,
    "",
    `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: args })}`,
    "",
    `data: ${JSON.stringify({ type: "response.completed", response: { usage } })}`,
    "",
  ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const fakeFetch = async (url, options) => {
  const rawBody = Buffer.isBuffer(options.body) ? Buffer.from(options.body) : Buffer.from(String(options.body || ""));
  const body = rawBody.toString("utf8");
  const headers = new Headers(options.headers);
  calls.push({ url, headers, body, rawBody });
  if (url.startsWith("https://native.test")) {
    if (body.includes("relay_external_agent_payload")) return relaySse("RELAYED PLAINTEXT");
    return sse({ input_tokens: 20, output_tokens: 4, total_tokens: 24 });
  }
  if (url.startsWith("https://deepseek.test")) return sse({ input_tokens: 30, output_tokens: 6, total_tokens: 36 });
  throw new Error(`unexpected URL ${url}`);
};

const token = "test-token";
const gateway = createNativeGateway({
  deepSeekKey: "ds-test-key", logPath, token, fetchImpl: fakeFetch,
  nativeBase: "https://native.test", deepSeekBase: "https://deepseek.test",
});
const port = await gateway.start();
const base = `http://127.0.0.1:${port}/${token}/v1/responses`;

try {
  const health = await fetch(`http://127.0.0.1:${port}/${token}/_health`);
  const healthBody = await health.json();
  equal(healthBody.pid, process.pid, "health identifies the real gateway process PID");

  const chatgptBody = JSON.stringify({ model: "gpt-6.1-sol", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "main" }] }] });
  const gpt = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer chatgpt-test", "chatgpt-account-id": "acct", "x-codex-parent-thread-id": "parent-1", "thread-id": "parent-1" },
    body: chatgptBody,
  });
  equal(gpt.status, 200, "GPT request succeeds");
  const gptCall = calls.find((call) => call.url.startsWith("https://native.test") && !call.body.includes("relay_external_agent_payload"));
  equal(gptCall.body, chatgptBody, "unrecognized model body is raw-transparent");
  equal(gptCall.headers.get("authorization"), "Bearer chatgpt-test", "GPT authorization is relayed");
  equal(gptCall.headers.get("chatgpt-account-id"), "acct", "GPT account header is relayed");

  const gzipBody = gzipSync(Buffer.from(chatgptBody));
  const gz = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: "Bearer chatgpt-test" },
    body: gzipBody,
  });
  equal(gz.status, 200, "gzip GPT request succeeds");
  const gzipCall = calls.find((call) => call.headers.get("content-encoding") === "gzip");
  ok(gzipCall, "compressed GPT request is forwarded as raw gzip");
  equal(Buffer.compare(gzipCall.rawBody, gzipBody), 0, "compressed GPT bytes remain transparent");

  const dsBody = JSON.stringify({
    model: "deepseek/deepseek-flash",
    input: [{
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "already plaintext" },
      ],
    }],
  });
  const ds = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer chatgpt-test", "chatgpt-account-id": "acct", "thread-id": "child-A", "x-codex-parent-thread-id": "parent-1" },
    body: dsBody,
  });
  equal(ds.status, 200, "DeepSeek plaintext request succeeds");
  const dsCall = calls.find((call) => call.url.startsWith("https://deepseek.test") && call.body.includes("already plaintext"));
  ok(dsCall, "DeepSeek request reaches the DeepSeek base");
  equal(dsCall.headers.get("authorization"), "Bearer ds-test-key", "DeepSeek uses only its own credential");
  equal(dsCall.headers.get("chatgpt-account-id"), null, "ChatGPT account header is not sent to DeepSeek");
  equal(dsCall.headers.get("x-codex-parent-thread-id"), null, "Codex parent header is not sent to DeepSeek");
  ok(dsCall.body.includes("deepseek-flash"), "DeepSeek wire model is used");
  ok(!dsCall.body.includes("use_responses_lite"), "ResponsesLite is not sent");
  equal(gateway.stats.child_thread_ids.includes("child-A"), true, "child thread id is observed");

  const relayBody = JSON.stringify({
    model: "deepseek/deepseek-flash",
    input: [{
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAAnative-opaque" },
      ],
    }],
  });
  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-test", "chatgpt-account-id": "acct", "thread-id": "child-B", "x-codex-parent-thread-id": "parent-1" },
      body: relayBody,
    });
    equal(response.status, 200, `native relay request ${i + 1} succeeds`);
  }
  equal(gateway.stats.relay_calls, 1, "same account+ciphertext relays once");
  equal(gateway.stats.relay_cache_hits, 1, "second relay is a cache hit");
  const relayed = calls.find((call) => call.url.startsWith("https://deepseek.test") && call.body.includes("RELAYED PLAINTEXT"));
  ok(relayed, "relayed plaintext reaches DeepSeek");
  ok(!relayed.body.includes("gAAAAAnative-opaque"), "opaque ciphertext never reaches DeepSeek");

  await new Promise((resolve) => setTimeout(resolve, 100));
  equal(gateway.stats.openai_requests, 2, "two GPT requests observed");
  equal(gateway.stats.openai_usages.length, 2, "one main GPT usage slot per GPT request");
  deepEqual(gateway.stats.openai_usages[0], { input_tokens: 20, output_tokens: 4, total_tokens: 24 }, "GPT usage is captured");
  ok(gateway.stats.deepseek_usages.length >= 3, "DeepSeek usage is captured per request");
  deepEqual(gateway.stats.deepseek_usages[0], { input_tokens: 30, output_tokens: 6, total_tokens: 36 }, "DeepSeek usage is captured");
  equal(gateway.stats.relay_usages.length, 1, "relay usage is captured once");
  equal(gateway.stats.relay_usages[0].total_tokens, 18, "relay usage value");
} finally {
  await gateway.close();
  await rm(dir, { recursive: true, force: true });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeOwnedServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function deepSeekRequest(gateway, signal) {
  const url = `http://127.0.0.1:${gateway.port}/${gateway.token}/v1/responses`;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-flash", input: [] }),
    signal,
  });
}

async function withOwnedGateway(options, callback) {
  const ownedDir = await mkdtemp(path.join(os.tmpdir(), "native-gateway-timeout-"));
  const gateway = createNativeGateway({
    deepSeekKey: "test-only",
    logPath: path.join(ownedDir, "gateway.jsonl"),
    deepSeekTimeoutMs: 200,
    ...options,
  });
  const port = await gateway.start();
  try {
    await callback({ gateway, port, token: gateway.token, logPath: path.join(ownedDir, "gateway.jsonl") });
  } finally {
    await gateway.close();
    await rm(ownedDir, { recursive: true, force: true });
  }
}

assert.throws(
  () => createNativeGateway({ logPath: "unused-test-path", deepSeekTimeoutMs: 0 }),
  RangeError,
  "DeepSeek timeout configuration must be positive and bounded",
);

{
  const upstreamReceived = deferred();
  const upstreamClosed = deferred();
  let upstreamRequests = 0;
  const upstream = createServer((_req, res) => {
    upstreamRequests += 1;
    upstreamReceived.resolve();
    res.on("close", () => upstreamClosed.resolve());
  });
  const upstreamPort = await listen(upstream);
  try {
    await withOwnedGateway({ deepSeekBase: `http://127.0.0.1:${upstreamPort}` }, async ({ gateway, port, token }) => {
      const response = await deepSeekRequest({ port, token }, AbortSignal.timeout(1_000));
      assert.equal(response.status, 504, "DeepSeek header timeout returns an explicit 504");
      deepEqual(await response.json(), { error: { message: "DeepSeek request timed out" } }, "header timeout has a stable error body");
      await bounded(upstreamReceived.promise, "upstream request arrival");
      await bounded(upstreamClosed.promise, "timed-out upstream cancellation");
      assert.equal(upstreamRequests, 1, "a timed-out DeepSeek request is not retried");
      const health = await fetch(`http://127.0.0.1:${port}/${token}/_health`);
      assert.equal(health.status, 200, "gateway remains healthy after DeepSeek timeout");
    });
  } finally {
    await closeOwnedServer(upstream);
  }
}

{
  let upstreamRequests = 0;
  const upstream = createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { total_tokens: 1 } } })}\n\n`);
  });
  const upstreamPort = await listen(upstream);
  try {
    await withOwnedGateway({ deepSeekBase: `http://127.0.0.1:${upstreamPort}`, deepSeekTimeoutMs: 150 }, async ({ port, token, logPath }) => {
      const response = await deepSeekRequest({ port, token }, AbortSignal.timeout(1_000));
      assert.equal(response.status, 200, "a completed DeepSeek stream succeeds before its deadline");
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(upstreamRequests, 1, "a completed request is not retried");
      const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(records.some((record) => record.kind === "deepseek_timeout"), false, "completed requests clear their timeout timer");
      assert.equal((await fetch(`http://127.0.0.1:${port}/${token}/_health`)).status, 200, "gateway remains healthy after normal completion");
    });
  } finally {
    await closeOwnedServer(upstream);
  }
}

{
  const upstreamReceived = deferred();
  const upstreamClosed = deferred();
  let upstreamRequests = 0;
  const upstream = createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {\"type\":\"response.created\"}\n\n");
    upstreamReceived.resolve();
    res.on("close", () => upstreamClosed.resolve());
  });
  const upstreamPort = await listen(upstream);
  try {
    await withOwnedGateway({ deepSeekBase: `http://127.0.0.1:${upstreamPort}` }, async ({ gateway, port, token, logPath }) => {
      const response = await deepSeekRequest({ port, token }, AbortSignal.timeout(1_000));
      assert.equal(response.status, 200, "DeepSeek stream headers arrive before the body timeout");
      await bounded(upstreamReceived.promise, "streaming upstream request arrival");
      await assert.rejects(response.text(), "the client stream terminates when the DeepSeek body stalls");
      await bounded(upstreamClosed.promise, "timed-out streaming upstream cancellation");
      assert.equal(upstreamRequests, 1, "a timed-out stream is not retried");
      const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(records.some((record) => record.kind === "deepseek_timeout" && record.stream_started === true));
      const health = await fetch(`http://127.0.0.1:${port}/${token}/_health`);
      assert.equal(health.status, 200, "gateway remains healthy after stream timeout");
    });
  } finally {
    await closeOwnedServer(upstream);
  }
}

{
  const upstreamReceived = deferred();
  const upstreamClosed = deferred();
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {\"type\":\"response.created\"}\n\n");
    upstreamReceived.resolve();
    res.on("close", () => upstreamClosed.resolve());
  });
  const upstreamPort = await listen(upstream);
  try {
    await withOwnedGateway({ deepSeekBase: `http://127.0.0.1:${upstreamPort}`, deepSeekTimeoutMs: 5_000 }, async ({ port, token, logPath }) => {
      const clientAbort = new AbortController();
      const request = deepSeekRequest({ port, token }, clientAbort.signal);
      await bounded(upstreamReceived.promise, "disconnect upstream request arrival");
      const response = await request;
      assert.equal(response.status, 200, "client receives DeepSeek stream headers before disconnecting");
      const reader = response.body.getReader();
      await bounded(reader.read(), "first streamed DeepSeek chunk");
      clientAbort.abort();
      await assert.rejects(reader.read(), "the caller observes stream cancellation");
      await bounded(upstreamClosed.promise, "disconnected upstream cancellation");
      const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(records.some((record) => record.kind === "deepseek_client_disconnect" && record.stream_started === true));
      const health = await fetch(`http://127.0.0.1:${port}/${token}/_health`);
      assert.equal(health.status, 200, "gateway remains healthy after client disconnect");
    });
  } finally {
    await closeOwnedServer(upstream);
  }
}

console.log("PASS DeepSeek loopback timeout and disconnect assertions");
console.log(`PASS ${checks} native gateway assertions`);

// Formal Task mode must route only to DeepSeek and must never bridge encrypted
// collaboration input through the signed-in OpenAI account.
{
  const strictDir = await mkdtemp(path.join(os.tmpdir(), "native-gateway-strict-"));
  const strictCalls = [];
  const strictGateway = createNativeGateway({
    deepSeekKey: "test-only", logPath: path.join(strictDir, "gateway.jsonl"),
    deepSeekOnly: true, maxRelayCalls: Infinity,
    nativeBase: "https://strict-openai.test", deepSeekBase: "https://strict-deepseek.test",
    fetchImpl: async (url, options) => {
      strictCalls.push({ url, options });
      if (url.startsWith("https://strict-deepseek.test")) return sse();
      throw new Error("strict mode attempted an OpenAI request");
    },
  });
  const strictPort = await strictGateway.start();
  const strictBase = `http://127.0.0.1:${strictPort}/${strictGateway.token}`;
  const requestModel = async (model, input = []) => fetch(`${strictBase}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer chatgpt-present" },
    body: JSON.stringify({ model, input }),
  });
  try {
    const strictHealth = await (await fetch(`${strictBase}/_health`)).json();
    equal(strictHealth.deepseek_only, true, "health reports strict DeepSeek-only mode");
    equal(strictHealth.relay_allowed, false, "health reports that GPT relay is disabled");
    equal(strictHealth.relay_calls, 0, "strict mode starts with no relay calls despite an infinite configured cap");

    const direct = await requestModel("deepseek/deepseek-flash");
    equal(direct.status, 200, "strict DeepSeek request succeeds");
    equal(strictCalls.length, 1, "strict DeepSeek request performs exactly one upstream call");
    ok(strictCalls[0].url.startsWith("https://strict-deepseek.test"), "strict DeepSeek request reaches only DeepSeek");
    equal(new Headers(strictCalls[0].options.headers).get("authorization"), "Bearer test-only", "DeepSeek uses its configured credential, not the incoming ChatGPT credential");
    equal(new Headers(strictCalls[0].options.headers).get("chatgpt-account-id"), null, "ChatGPT account identity is not sent upstream");

    for (const model of ["gpt-6.1-sol", "unknown/custom-model"]) {
      const rejected = await requestModel(model);
      equal(rejected.status, 403, `${model} is rejected in strict mode`);
      await rejected.arrayBuffer();
    }
    equal(strictCalls.length, 1, "GPT and unknown models cause no upstream calls");
    equal(strictGateway.stats.openai_requests, 0, "strict rejection never increments the OpenAI upstream request count");

    const legacyAgentMessage = "Message Type: NEW_TASK\nPayload:\nfixture task";
    const legacyChild = await requestModel("deepseek/deepseek-flash", [{
      type: "agent_message",
      content: [{ type: "input_text", text: legacyAgentMessage }],
    }]);
    equal(legacyChild.status, 200, "legacy gateway accepts plain agent_message input");
    equal(strictCalls.length, 2, "legacy child uses exactly one DeepSeek upstream call");
    const legacyBody = JSON.parse(strictCalls[1].options.body);
    equal(legacyBody.input.length, 1, "legacy agent_message becomes one standard Responses item");
    equal(legacyBody.input[0].type, "message", "legacy agent_message is normalized to a message");
    equal(legacyBody.input[0].role, "user", "legacy agent_message is routed as user content");
    equal(legacyBody.input[0].content[0].text, legacyAgentMessage, "legacy child task text is preserved");
    equal(strictGateway.stats.relay_calls, 0, "legacy child does not use the signed-in OpenAI relay");

    const encrypted = await requestModel("deepseek/deepseek-flash", [{
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAAnative-opaque" },
      ],
    }]);
    equal(encrypted.status, 403, "encrypted collaboration input is refused even when ChatGPT auth is present");
    await encrypted.arrayBuffer();
    equal(strictCalls.length, 2, "strict encrypted input performs no relay or DeepSeek upstream call");
    equal(strictGateway.stats.relay_calls, 0, "strict relay cap remains zero");
  } finally {
    await strictGateway.close();
    await rm(strictDir, { recursive: true, force: true });
  }
}
