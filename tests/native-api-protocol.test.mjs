import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  chatCompletionToResponse,
  chatSseToResponses,
  normalizeOfficialDeepSeekResponsesRequest,
  responsesRequestToChat,
} from "../scripts/native-api-protocol.mjs";
import { createNativeApiGateway } from "../scripts/native-api-gateway.mjs";

const PROFILE_ID = "a1b2c3d4e5f60718293a4b5c";
const profile = {
  profileId: PROFILE_ID,
  protocol: "chat_completions",
  baseUrl: "http://127.0.0.1:0/v1",
  model: "mimo-model",
  reasoning: { supported: ["low", "medium", "high"], default: "medium", parameter: "reasoning_effort" },
  credential: { type: "env", name: "MIMO_API_KEY" },
};

const deepseekChatProfile = {
  profileId: PROFILE_ID,
  protocol: "chat_completions",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  reasoning: { supported: ["none", "low", "high", "max"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "env", name: "DEEPSEEK_API_KEY" },
};

const deepseekResponsesProfile = {
  ...deepseekChatProfile,
  protocol: "responses",
};

const deepseekProChatProfile = {
  ...deepseekChatProfile,
  model: "deepseek-v4-pro",
};

const deepseekProResponsesProfile = {
  ...deepseekResponsesProfile,
  model: "deepseek-v4-pro",
};

const mimoChatProfile = {
  profileId: PROFILE_ID,
  protocol: "chat_completions",
  baseUrl: "https://api.xiaomimimo.com/v1",
  model: "mimo-v2.5",
  reasoning: { supported: ["none"], default: "none", parameter: "none" },
  credential: { type: "env", name: "MIMO_API_KEY" },
};

const commandTools = [
  { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
];

function reasoningItem(vendor, id, text) {
  return { id: `rs_${vendor}_${id}`, type: "reasoning", summary: [], content: [{ type: "reasoning_text", text }] };
}

function chatTool(name, args) {
  return { id: args.id, type: "function", function: { name, arguments: args.arguments } };
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

async function* chunksOf(text, sizes) {
  let offset = 0;
  let index = 0;
  while (offset < text.length) {
    const size = sizes[index++ % sizes.length];
    yield Buffer.from(text.slice(offset, offset + size));
    offset += size;
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("Responses input becomes ordered Chat messages and tool history round-trips by call_id", () => {
  const body = {
    model: "mimo-model",
    instructions: "Be concise",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "reasoning", content: [] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "prior thought" }] },
      { type: "function_call", id: "fc-old", call_id: "call-fn", name: "lookup", arguments: "{\"q\":1}" },
      { type: "function_call_output", call_id: "call-fn", output: "found" },
      { type: "custom_tool_call", id: "ctc-old", call_id: "call-exec", name: "exec", namespace: "local", input: "echo ok" },
      { type: "custom_tool_call_output", call_id: "call-exec", output: "ok" },
    ],
    tools: [
      { type: "function", name: "lookup", description: "lookup", parameters: { type: "object", properties: { q: { type: "number" } } } },
      { type: "namespace", name: "local", tools: [{ type: "custom", name: "exec", description: "run a command", format: { type: "text" } }] },
    ],
  };

  const { body: chat, toolMap } = responsesRequestToChat(body, profile);
  assert.equal(chat.model, "mimo-model");
  assert.equal(chat.messages[0].role, "system");
  assert.deepEqual(chat.messages.slice(1).map(({ role }) => role), ["user", "assistant", "assistant", "tool", "assistant", "tool"]);
  assert.equal(chat.messages[2].content, "prior thought");
  assert.equal(chat.messages[3].tool_calls[0].id, "call-fn");
  assert.equal(chat.messages[4].tool_call_id, "call-fn");
  assert.equal(chat.messages[5].tool_calls[0].id, "call-exec");
  assert.equal(chat.messages[6].tool_call_id, "call-exec");
  assert.equal(toolMap.get(chat.messages[5].tool_calls[0].function.name).kind, "custom");
});

test("Responses request rejects model overrides and unsupported input explicitly", () => {
  assert.throws(() => responsesRequestToChat({ model: "other", input: "hi" }, profile), /model/i);
  assert.throws(() => responsesRequestToChat({ model: "mimo-model", input: [{ type: "computer_call_output", call_id: "x", output: [] }] }, profile), /unsupported/i);
  assert.throws(() => responsesRequestToChat({ model: "mimo-model", input: [{ type: "reasoning", encrypted_content: "opaque" }] }, profile), /encrypted reasoning/i);
});

test("preserves Chat's boolean parallel_tool_calls and only accepts explicitly supported request options", () => {
  const tools = [{ type: "function", name: "one", parameters: { type: "object" } }, { type: "function", name: "two", parameters: { type: "object" } }];
  assert.equal(responsesRequestToChat({ model: "mimo-model", input: "x", tools, parallel_tool_calls: false }, profile).body.parallel_tool_calls, false);
  assert.equal(responsesRequestToChat({ model: "mimo-model", input: "x", tools, parallel_tool_calls: true }, profile).body.parallel_tool_calls, true);
});

test("ignores Codex's optional encrypted-reasoning include, but rejects other non-portable include requests", () => {
  assert.deepEqual(responsesRequestToChat({ model: "mimo-model", input: "x", include: [] }, profile).body.messages, [{ role: "user", content: "x" }]);
  const converted = responsesRequestToChat({ model: "mimo-model", input: "x", include: ["reasoning.encrypted_content"] }, profile);
  assert.equal("include" in converted.body, false);
  assert.throws(() => responsesRequestToChat({ model: "mimo-model", input: "x", include: ["web_search_call.action.sources"] }, profile), /include/);
});

test("a none-parameter profile accepts Codex's empty reasoning object but rejects meaningful reasoning", () => {
  const noReasoningProfile = {
    ...profile,
    reasoning: { supported: ["none"], default: "none", parameter: "none" },
  };
  const empty = responsesRequestToChat({
    model: "mimo-model",
    input: "x",
    reasoning: {},
  }, noReasoningProfile);
  assert.equal(empty.body.reasoning_effort, undefined);
  assert.equal(empty.body.reasoning, undefined);

  const nullValue = responsesRequestToChat({
    model: "mimo-model",
    input: "x",
    reasoning: null,
  }, noReasoningProfile);
  assert.equal(nullValue.body.reasoning_effort, undefined);
  const explicitNone = responsesRequestToChat({
    model: "mimo-model",
    input: "x",
    reasoning: { effort: "none" },
  }, noReasoningProfile);
  assert.equal(explicitNone.body.reasoning_effort, undefined, "an explicit disabled effort has no Chat reasoning parameter");

  assert.throws(() => responsesRequestToChat({
    model: "mimo-model",
    input: "x",
    reasoning: { effort: "high" },
  }, noReasoningProfile), /does not accept reasoning/);
  assert.throws(() => responsesRequestToChat({
    model: "mimo-model",
    input: "x",
    reasoning: { summary: "auto" },
  }, noReasoningProfile), /does not accept reasoning/);
});

test("DeepSeek account effort normalization is local to the API adapter", () => {
  const deepseek = {
    ...profile,
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    reasoning: { supported: ["none", "low", "high", "max"], default: "high", parameter: "reasoning_effort" },
    credential: { type: "dsh_account" },
  };
  const request = effort => responsesRequestToChat({
    model: "deepseek-flash",
    input: "x",
    reasoning: { effort },
  }, deepseek).body;
  assert.equal(request("xhigh").reasoning_effort, "high");
  assert.equal(request("max").reasoning_effort, "max");
  assert.equal(request("none").reasoning_effort, "none");
  assert.equal(request("low").reasoning_effort, "low");
  assert.throws(() => request("medium"), /not supported/);

  const manualDeepSeek = {
    ...deepseek,
    credential: { type: "env", name: "DEEPSEEK_API_KEY" },
  };
  assert.equal(responsesRequestToChat({
    model: "deepseek-flash",
    input: "x",
    reasoning: { effort: "xhigh" },
  }, manualDeepSeek).body.reasoning_effort, "high", "manual official DeepSeek keeps the same local normalization");

  const generic = {
    ...profile,
    reasoning: { supported: ["medium", "xhigh"], default: "medium", parameter: "reasoning_effort" },
  };
  assert.equal(responsesRequestToChat({
    model: "mimo-model",
    input: "x",
    reasoning: { effort: "xhigh" },
  }, generic).body.reasoning_effort, "xhigh", "non-DeepSeek API profiles keep their declared effort");
});

test("official DeepSeek Chat preserves reasoning_content for tool and final turns", () => {
  const { body: request, toolMap } = responsesRequestToChat({
    model: "deepseek-flash",
    input: "run it",
    tools: commandTools,
  }, deepseekChatProfile);
  const toolName = request.tools[0].function.name;
  const first = chatCompletionToResponse({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "tool reasoning",
        tool_calls: [chatTool(toolName, { id: "call-ds", arguments: "{\"cmd\":\"echo hi\"}" })],
      },
      finish_reason: "tool_calls",
    }],
  }, { model: "deepseek-flash", toolMap, profile: deepseekChatProfile });

  assert.deepEqual(first.output.map(({ type }) => type), ["reasoning", "function_call"]);
  assert.match(first.output[0].id, /^rs_deepseek_/);
  assert.deepEqual(first.output[0].content, [{ type: "reasoning_text", text: "tool reasoning" }]);

  const followUp = responsesRequestToChat({
    model: "deepseek-flash",
    input: [
      { type: "message", role: "user", content: "run it" },
      first.output[0],
      first.output[1],
      { type: "function_call_output", call_id: "call-ds", output: "hi" },
      reasoningItem("deepseek", "final", "final reasoning"),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { type: "message", role: "user", content: "next" },
    ],
    tools: commandTools,
  }, deepseekChatProfile);

  const toolTurn = followUp.body.messages.find(({ tool_calls: calls }) => calls);
  assert.equal(toolTurn.content, null);
  assert.equal(toolTurn.reasoning_content, "tool reasoning");
  assert.equal(toolTurn.tool_calls[0].id, "call-ds");
  assert.equal(followUp.body.messages.find(({ role }) => role === "tool").content, "hi");
  const finalTurn = followUp.body.messages.find(({ role, content }) => role === "assistant" && content === "done");
  assert.equal(finalTurn.reasoning_content, "final reasoning");
});

test("official DeepSeek Chat drops reasoning when the request no longer carries tools", () => {
  const converted = responsesRequestToChat({
    model: "deepseek-flash",
    input: [
      { type: "message", role: "user", content: "hello" },
      reasoningItem("deepseek", "one", "plain thought"),
      { type: "message", role: "assistant", content: "hi" },
    ],
  }, deepseekChatProfile);
  assert.deepEqual(converted.body.messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
});

test("official DeepSeek v4-pro uses the same effort, Responses, and Chat replay rules", () => {
  for (const effort of ["none", "low", "high", "max"]) {
    assert.equal(responsesRequestToChat({
      model: "deepseek-v4-pro",
      input: "x",
      reasoning: { effort },
    }, deepseekProChatProfile).body.reasoning_effort, effort);
  }
  assert.equal(responsesRequestToChat({
    model: "deepseek-v4-pro",
    input: "x",
    reasoning: { effort: "xhigh" },
  }, deepseekProChatProfile).body.reasoning_effort, "high");
  assert.throws(() => responsesRequestToChat({
    model: "deepseek-v4-pro",
    input: "x",
    reasoning: { effort: "medium" },
  }, deepseekProChatProfile), /not supported/);

  const { body: request, toolMap } = responsesRequestToChat({
    model: "deepseek-v4-pro",
    input: "run",
    tools: commandTools,
  }, deepseekProChatProfile);
  const result = chatCompletionToResponse({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "pro reasoning",
        tool_calls: [chatTool(request.tools[0].function.name, { id: "call-pro", arguments: "{\"cmd\":\"echo pro\"}" })],
      },
      finish_reason: "tool_calls",
    }],
  }, { model: "deepseek-v4-pro", toolMap, profile: deepseekProChatProfile });
  assert.match(result.output[0].id, /^rs_deepseek_/);
  assert.equal(result.output[0].content[0].text, "pro reasoning");
  const followUp = responsesRequestToChat({
    model: "deepseek-v4-pro",
    input: [
      { type: "message", role: "user", content: "run" },
      ...result.output,
      { type: "function_call_output", call_id: "call-pro", output: "pro result" },
    ],
    tools: commandTools,
  }, deepseekProChatProfile);
  assert.equal(followUp.body.messages.find(({ tool_calls: calls }) => calls).reasoning_content, "pro reasoning");

  const normalized = normalizeOfficialDeepSeekResponsesRequest({
    model: "deepseek-v4-pro",
    input: "hi",
    store: false,
    include: ["reasoning.encrypted_content"],
    client_metadata: { local: true },
    metadata: {},
    prompt_cache_key: "pro-key",
    reasoning: { effort: "xhigh", summary: "auto" },
  }, deepseekProResponsesProfile);
  assert.equal(normalized.model, "deepseek-v4-pro");
  assert.deepEqual(normalized.reasoning, { effort: "high" });
  for (const key of ["store", "include", "client_metadata", "metadata", "prompt_cache_key"]) {
    assert.equal(key in normalized, false);
  }
});

test("unknown Chat vendors never receive guessed reasoning_content fields", () => {
  const { body: request, toolMap } = responsesRequestToChat({
    model: "mimo-model",
    input: "hello",
    tools: commandTools,
  }, profile);
  const result = chatCompletionToResponse({
    choices: [{ message: { role: "assistant", content: "answer", reasoning_content: "unknown vendor thought" } }],
  }, { model: "mimo-model", toolMap, profile });
  assert.deepEqual(result.output.map(({ type }) => type), ["message"]);
  assert.equal(result.output[0].content[0].text, "answer");
  assert.equal("reasoning_content" in result.output[0], false);
});

test("vendor Chat rejects opaque encrypted reasoning and does not translate unrelated reasoning", () => {
  assert.throws(() => responsesRequestToChat({
    model: "deepseek-flash",
    input: [{ type: "reasoning", encrypted_content: "opaque-ciphertext", summary: [] }],
    tools: commandTools,
  }, deepseekChatProfile), /encrypted reasoning/i);

  const converted = responsesRequestToChat({
    model: "deepseek-flash",
    input: [
      { type: "message", role: "user", content: "hello" },
      {
        id: "rs_openai_foreign",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "foreign summary" }],
        content: [{ type: "reasoning_text", text: "foreign raw reasoning" }],
      },
      { type: "message", role: "assistant", content: "answer" },
    ],
    tools: commandTools,
  }, deepseekChatProfile);
  assert.equal(converted.body.messages.at(-1).reasoning_content, undefined);
  assert.equal(converted.body.messages.length, 2);
});

test("official MiMo Chat replays reasoning_content with parameter=none", () => {
  const { body: request, toolMap } = responsesRequestToChat({
    model: "mimo-v2.5",
    input: "run it",
    reasoning: {},
    tools: commandTools,
  }, mimoChatProfile);
  assert.equal(request.reasoning_effort, undefined);
  assert.equal(request.reasoning, undefined);
  assert.equal(request.thinking, undefined);
  const toolName = request.tools[0].function.name;
  const result = chatCompletionToResponse({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "mimo default thinking",
        tool_calls: [chatTool(toolName, { id: "call-mimo", arguments: "{\"cmd\":\"echo mimo\"}" })],
      },
      finish_reason: "tool_calls",
    }],
  }, { model: "mimo-v2.5", toolMap, profile: mimoChatProfile });
  assert.match(result.output[0].id, /^rs_mimo_/);
  assert.equal(result.output[0].content[0].text, "mimo default thinking");

  const followUp = responsesRequestToChat({
    model: "mimo-v2.5",
    input: [
      { type: "message", role: "user", content: "run it" },
      ...result.output,
      { type: "function_call_output", call_id: "call-mimo", output: "mimo result" },
      { type: "message", role: "user", content: "next" },
    ],
    tools: commandTools,
  }, mimoChatProfile);
  const toolTurn = followUp.body.messages.find(({ tool_calls: calls }) => calls);
  assert.equal(toolTurn.reasoning_content, "mimo default thinking");
  assert.equal(followUp.body.messages.find(({ role }) => role === "tool").content, "mimo result");
});

test("streaming DeepSeek Chat emits and replays reasoning before tool calls with arbitrary chunks", async () => {
  const { body: request, toolMap } = responsesRequestToChat({
    model: "deepseek-flash",
    input: "run it",
    tools: commandTools,
  }, deepseekChatProfile);
  const toolName = request.tools[0].function.name;
  const chunks = [
    { id: "chatcmpl-ds", model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "tool " }, finish_reason: null }] },
    { id: "chatcmpl-ds", choices: [{ index: 0, delta: { reasoning_content: "reasoning" }, finish_reason: null }] },
    { id: "chatcmpl-ds", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-stream", type: "function", function: { name: toolName, arguments: "{\"cmd\":" } }] }, finish_reason: null }] },
    { id: "chatcmpl-ds", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"echo hi\"}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-ds", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const events = [];
  for await (const event of chatSseToResponses(
    chunksOf(chunks.map(sseFrame).join("") + "data: [DONE]\r\n\r\n", [1, 3, 2, 7, 4]),
    { model: "deepseek-flash", toolMap, profile: deepseekChatProfile },
  )) events.push(event);

  const done = events.filter(({ type }) => type === "response.output_item.done").map(({ item }) => item);
  assert.deepEqual(done.map(({ type }) => type), ["reasoning", "function_call"]);
  assert.match(done[0].id, /^rs_deepseek_/);
  assert.equal(done[0].content[0].text, "tool reasoning");
  assert.equal(events.some(({ type }) => type === "response.reasoning_text.delta"), true);

  const followUp = responsesRequestToChat({
    model: "deepseek-flash",
    input: [
      { type: "message", role: "user", content: "run it" },
      done[0],
      done[1],
      { type: "function_call_output", call_id: "call-stream", output: "hi" },
    ],
    tools: commandTools,
  }, deepseekChatProfile);
  assert.equal(followUp.body.messages.find(({ tool_calls: calls }) => calls).reasoning_content, "tool reasoning");
});

test("streaming DeepSeek Chat preserves a no-tool turn for the next tools request", async () => {
  const chunks = [
    { id: "chatcmpl-ds2", model: "deepseek-flash", choices: [{ index: 0, delta: { reasoning_content: "no-tool " }, finish_reason: null }] },
    { id: "chatcmpl-ds2", choices: [{ index: 0, delta: { reasoning_content: "reasoning" }, finish_reason: null }] },
    { id: "chatcmpl-ds2", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] },
    { id: "chatcmpl-ds2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const events = [];
  for await (const event of chatSseToResponses(
    chunksOf(chunks.map(sseFrame).join("") + "data: [DONE]\r\n\r\n", [2, 9, 1]),
    { model: "deepseek-flash", toolMap: new Map(), profile: deepseekChatProfile },
  )) events.push(event);
  const done = events.filter(({ type }) => type === "response.output_item.done").map(({ item }) => item);
  assert.deepEqual(done.map(({ type }) => type), ["reasoning", "message"]);
  assert.equal(done[1].content[0].text, "answer");

  const followUp = responsesRequestToChat({
    model: "deepseek-flash",
    input: [
      { type: "message", role: "user", content: "hello" },
      done[0],
      done[1],
      { type: "message", role: "user", content: "next" },
    ],
    tools: commandTools,
  }, deepseekChatProfile);
  const assistant = followUp.body.messages.find(({ role }) => role === "assistant");
  assert.equal(assistant.content, "answer");
  assert.equal(assistant.reasoning_content, "no-tool reasoning");
});

test("official DeepSeek Responses normalization follows the documented field support", () => {
  const base = {
    model: "deepseek-flash",
    input: "hello",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    client_metadata: { session: "local-only" },
    metadata: {},
    prompt_cache_key: "local-cache-key",
    service_tier: null,
    stream_options: null,
    access_programs: null,
    reasoning: { effort: "xhigh", summary: "auto" },
  };
  const normalized = normalizeOfficialDeepSeekResponsesRequest(base, deepseekResponsesProfile);
  assert.equal(normalized.model, "deepseek-flash");
  assert.deepEqual(normalized.reasoning, { effort: "high" });
  for (const key of ["store", "include", "client_metadata", "metadata", "prompt_cache_key", "service_tier", "stream_options", "access_programs"]) {
    assert.equal(key in normalized, false, `${key} must be removed`);
  }
  for (const effort of ["none", "low", "high", "max"]) {
    assert.equal(normalizeOfficialDeepSeekResponsesRequest({ ...base, reasoning: { effort } }, deepseekResponsesProfile).reasoning.effort, effort);
  }
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({ ...base, reasoning: { effort: "medium" } }, deepseekResponsesProfile), /not supported/);
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({ ...base, store: true }, deepseekResponsesProfile), /stateless/i);
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({ ...base, metadata: { team: "api" } }, deepseekResponsesProfile), /metadata/i);
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({ ...base, previous_response_id: "resp_previous" }, deepseekResponsesProfile), /stateless/i);
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({ ...base, include: ["web_search_call.action.sources"] }, deepseekResponsesProfile), /include/i);
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({
    ...base,
    input: [{ type: "reasoning", encrypted_content: "opaque", summary: [] }],
  }, deepseekResponsesProfile), /encrypted/i);
});

test("official DeepSeek Responses maps native agent_message to a standard user message without losing content", () => {
  const content = [
    { type: "input_text", text: "local fixture task" },
    { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
  ];
  const originalHistory = [
    { type: "agent_message", id: "msg_local", content },
    { type: "message", role: "user", content: [{ type: "input_text", text: "follow-up" }] },
    { type: "function_call", call_id: "call_local", name: "exec", arguments: "{}" },
  ];
  const normalized = normalizeOfficialDeepSeekResponsesRequest({
    model: "deepseek-flash", input: originalHistory,
  }, deepseekResponsesProfile);
  assert.deepEqual(normalized.input[0], { type: "message", role: "user", content });
  assert.deepEqual(normalized.input.slice(1), originalHistory.slice(1));
  assert.deepEqual(originalHistory[0], { type: "agent_message", id: "msg_local", content });
  const chat = responsesRequestToChat({ model: "deepseek-flash", input: [{ type: "agent_message", content: "local fixture task" }] }, deepseekChatProfile);
  assert.deepEqual(chat.body.messages, [{ role: "user", content: "local fixture task" }]);
  assert.throws(() => responsesRequestToChat({
    model: "deepseek-flash", input: [{ type: "agent_message", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  }, deepseekChatProfile), /unsupported Responses message content type/i);
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({
    model: "deepseek-flash",
    input: [{ type: "agent_message", content: [{ type: "encrypted_content", data: "opaque" }] }],
  }, deepseekResponsesProfile), /encrypted agent messages/i);
  assert.throws(() => normalizeOfficialDeepSeekResponsesRequest({
    model: "deepseek-flash", input: [{ type: "agent_message" }],
  }, deepseekResponsesProfile), /content/i);
});

test("maps the standard Responses prompt_cache_key to the standard Chat field", () => {
  const converted = responsesRequestToChat({ model: "mimo-model", input: "x", prompt_cache_key: "test-only-key" }, profile);
  assert.equal(converted.body.prompt_cache_key, "test-only-key");
});

test("drops Codex-only client_metadata when converting to the standard Chat API", () => {
  const converted = responsesRequestToChat({ model: "mimo-model", input: "x", client_metadata: { client: "codex" } }, profile);
  assert.equal("client_metadata" in converted.body, false);
});

test("preserves namespaces on flat Responses function and custom definitions", () => {
  const { body: chat, toolMap } = responsesRequestToChat({
    model: "mimo-model", input: "x",
    tools: [
      { type: "function", name: "exec_command", namespace: "default", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      { type: "custom", name: "apply_patch", namespace: "codex", format: { type: "text" } },
    ],
  }, profile);
  assert.equal(toolMap.get(chat.tools[0].function.name).namespace, "default");
  assert.equal(toolMap.get(chat.tools[1].function.name).namespace, "codex");
  const result = chatCompletionToResponse({ choices: [{ message: { tool_calls: [
    chatTool(chat.tools[0].function.name, { id: "call-ns", arguments: JSON.stringify({ cmd: "node -v" }) }),
  ] }, finish_reason: "tool_calls" }] }, { model: "mimo-model", toolMap });
  assert.equal(result.output[0].namespace, "default");
});

test("realistic Codex tool params flatten custom apply_patch grammar without claiming Chat enforcement", () => {
  const grammar = { type: "grammar", syntax: "lark", definition: 'start: "*** Begin Patch" /[\\s\\S]*/ "*** End Patch"' };
  const { body: chat, toolMap } = responsesRequestToChat({
    model: "mimo-model",
    instructions: "Use the provided tools.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Keep changes focused." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "edit file" }] },
      { type: "reasoning", content: [] },
    ],
    stream: true,
    max_output_tokens: 2400,
    reasoning: { effort: "medium" },
    tool_choice: { type: "custom", name: "apply_patch" },
    tools: [
      { type: "custom", name: "apply_patch", description: "Apply a patch.", format: grammar },
      { type: "custom", name: "exec_command", description: "Run a shell command.", format: { type: "text" } },
    ],
  }, profile);
  assert.equal(chat.stream, true);
  assert.equal(chat.stream_options.include_usage, true);
  assert.equal(chat.max_tokens, 2400);
  assert.equal(chat.reasoning_effort, "medium");
  assert.equal(chat.tool_choice.type, "function");
  assert.equal(chat.tools[0].type, "function");
  assert.match(chat.tools[0].function.description, /Chat provider cannot enforce/);
  assert.match(chat.tools[0].function.description, /start:/);
  assert.equal(toolMap.get(chat.tools[0].function.name).format, grammar);
});

test("non-streaming Chat tool calls become native function and custom Responses items", () => {
  const { body: request, toolMap } = responsesRequestToChat({
    model: "mimo-model",
    input: "start",
    tools: [
      { type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } },
      { type: "custom", name: "exec", format: { type: "text" } },
    ],
  }, profile);
  const names = [...toolMap.keys()];
  const result = chatCompletionToResponse({
    id: "chatcmpl-1",
    model: "mimo-model",
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
      chatTool(names[0], { id: "call-a", arguments: "{\"q\":\"x\"}" }),
      chatTool(names[1], { id: "call-b", arguments: "{\"input\":\"echo x\"}" }),
    ] }, finish_reason: "tool_calls" }],
  }, { requestId: "req-1", model: "mimo-model", toolMap });

  assert.equal(result.object, "response");
  assert.deepEqual(result.output.map(({ type }) => type), ["function_call", "custom_tool_call"]);
  assert.equal(result.output[0].id.startsWith("fc_"), true);
  assert.equal(result.output[0].call_id, "call-a");
  assert.equal(result.output[0].name, "lookup");
  assert.equal(result.output[1].call_id, "call-b");
  assert.equal(result.output[1].name, "exec");
  assert.equal(result.output[1].input, "echo x");
  assert.equal(result.usage, null);
});

test("streaming Chat deltas preserve interleaved call indexes, namespace, and standard custom events", async () => {
  const customName = "codex_custom_exec";
  const toolMap = new Map([["lookup", { kind: "function", name: "lookup" }], [customName, { kind: "custom", name: "exec", namespace: "local" }]]);
  const chunks = [
    { id: "chatcmpl-2", model: "mimo-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call-c", type: "function", function: { name: customName, arguments: "" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-f", type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "{\"input\":" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"q\":" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "\"echo\"}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chatcmpl-2", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
  ];
  const source = chunks.map(sseFrame).join("") + "data: [DONE]\r\n\r\n";
  const events = [];
  for await (const event of chatSseToResponses(chunksOf(source, [1, 2, 7, 3]), { requestId: "req-2", model: "mimo-model", toolMap })) events.push(event);

  const types = events.map(({ type }) => type);
  assert.equal(types[0], "response.created");
  assert.equal(types.includes("response.function_call_arguments.delta"), true);
  assert.equal(types.includes("response.custom_tool_call_input.delta"), true);
  assert.equal(types.includes("response.output_tool_call.delta"), false);
  assert.equal(types.at(-1), "response.completed");
  const doneItems = events.filter(({ type }) => type === "response.output_item.done").map(({ item }) => item);
  assert.deepEqual(doneItems.map(({ type }) => type), ["function_call", "custom_tool_call"]);
  assert.equal(doneItems[0].call_id, "call-f");
  assert.equal(doneItems[0].arguments, "{\"q\":\"x\"}");
  assert.equal(doneItems[1].call_id, "call-c");
  assert.equal(doneItems[1].input, "echo");
  assert.equal(doneItems[1].namespace, "local");
  const addedById = new Map(events.filter(({ type }) => type === "response.output_item.added").map(({ item, output_index }) => [item.id, output_index]));
  const doneById = new Map(events.filter(({ type }) => type === "response.output_item.done").map(({ item, output_index }) => [item.id, output_index]));
  events.at(-1).response.output.forEach((item, outputIndex) => {
    assert.equal(addedById.get(item.id), outputIndex);
    assert.equal(doneById.get(item.id), outputIndex);
    assert.equal("output_index" in item, false);
  });
  assert.deepEqual(events.at(-1).response.usage, {
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10,
  });
});

test("streaming tool names may arrive in valid fragmented prefixes", async () => {
  const toolMap = new Map([["lookup", { kind: "function", name: "lookup" }]]);
  const frames = [
    { id: "chatcmpl-frag", model: "mimo-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-frag", type: "function", function: { name: "look", arguments: "" } }] }, finish_reason: null }] },
    { id: "chatcmpl-frag", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "up", arguments: "{}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-frag", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const events = [];
  for await (const event of chatSseToResponses(chunksOf(frames.map(sseFrame).join("") + "data: [DONE]\r\n\r\n", [2, 4]), { model: "mimo-model", toolMap })) events.push(event);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].name, "lookup");
  assert.equal(events.at(-1).response.output[0].arguments, "{}");
});

test("stream ending without [DONE] or a terminal chunk never fabricates completed or zero usage", async () => {
  const text = sseFrame({ id: "chatcmpl-cut", model: "mimo-model", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] });
  const events = [];
  for await (const event of chatSseToResponses(chunksOf(text, [3, 5]), { requestId: "req-cut", model: "mimo-model", toolMap: new Map() })) events.push(event);
  assert.equal(events.some(({ type }) => type === "response.completed"), false);
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.usage, null);
});

test("gateway binds immutable profile path, injects only resolved credentials, and preserves Responses passthrough", async (t) => {
  let observed;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp-upstream", object: "response", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, profileId, protocol: "responses", baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: { authorization: "Bearer injected-secret" } }),
    token: "local-token",
    logger: { info() {} },
  });
  const { port, baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer attacker-token", cookie: "caller-cookie=secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "hello" }),
  });
  assert.equal(port > 0, true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp-upstream");
  assert.equal(observed.url, "/v1/responses");
  assert.equal(observed.headers.authorization, "Bearer injected-secret");
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.body.input, "hello");
});

test("gateway normalizes official DeepSeek Responses requests and fails closed on lost state", async (t) => {
  const observed = [];
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID
      ? { ...deepseekResponsesProfile, profileId }
      : null,
    resolveAuth: async () => ({ headers: { authorization: "Bearer injected-test" } }),
    fetchImpl: async (url, init) => {
      observed.push({ url: String(url), body: JSON.parse(Buffer.from(init.body).toString("utf8")) });
      return new Response(JSON.stringify({ id: "resp-normalized", object: "response", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const url = `${baseUrl}/profiles/${PROFILE_ID}/v1/responses`;
  const request = (body) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const response = await request({
    model: "deepseek-flash",
    input: "hello",
    store: false,
    include: ["reasoning.encrypted_content"],
    client_metadata: { local: true },
    metadata: {},
    prompt_cache_key: "local-key",
    reasoning: { effort: "xhigh", summary: "auto" },
  });
  assert.equal(response.status, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].url, "https://api.deepseek.com/responses");
  assert.equal(observed[0].body.model, "deepseek-flash");
  assert.deepEqual(observed[0].body.reasoning, { effort: "high" });
  for (const key of ["store", "include", "client_metadata", "metadata", "prompt_cache_key"]) {
    assert.equal(key in observed[0].body, false, `${key} must not reach the official DeepSeek endpoint`);
  }

  const stored = await request({ model: "deepseek-flash", input: "hello", store: true });
  assert.equal(stored.status, 400);
  assert.match((await stored.json()).error.message, /stateless/i);
  assert.equal(observed.length, 1, "a rejected stateful request must not reach upstream");
});

test("gateway sends native agent_message as a standard Responses user message and preserves upstream progress/tool/usage", async (t) => {
  let observed;
  const taskText = "fixture parent task body";
  const content = [{ type: "input_text", text: taskText }];
  const upstreamResponse = {
    id: "resp-agent-message",
    object: "response",
    status: "completed",
    output: [{ type: "function_call", call_id: "call-fixture", name: "exec", arguments: "{}" }],
    usage: { input_tokens: 17, output_tokens: 5, total_tokens: 22 },
  };
  const progressFrames = [
    { type: "response.output_text.delta", delta: "working" },
    { type: "response.output_item.done", item: upstreamResponse.output[0] },
    { type: "response.completed", response: upstreamResponse },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...deepseekResponsesProfile, profileId } : null,
    resolveAuth: async () => ({ headers: {} }),
    fetchImpl: async (url, init) => {
      observed = { url: String(url), body: JSON.parse(Buffer.from(init.body).toString("utf8")) };
      return init.body && JSON.parse(Buffer.from(init.body).toString("utf8")).stream === true
        ? new Response(progressFrames, { status: 200, headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify(upstreamResponse), { status: 200, headers: { "content-type": "application/json" } });
    },
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", input: [{ type: "agent_message", content }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.url, "https://api.deepseek.com/responses");
  assert.deepEqual(observed.body.input, [{ type: "message", role: "user", content }]);
  const result = await response.json();
  assert.deepEqual(result.output, upstreamResponse.output);
  assert.deepEqual(result.usage, upstreamResponse.usage);

  const progress = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", input: [{ type: "agent_message", content }], stream: true }),
  });
  assert.equal(progress.status, 200);
  const events = await progress.text();
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /response\.output_item\.done/);
  assert.match(events, /response\.completed/);
  assert.match(events, /"total_tokens":22/);
});

test("gateway normalizes native agent_message for generic Responses profiles without changing other input items", async (t) => {
  let observed;
  const genericResponsesProfile = { ...profile, protocol: "responses", baseUrl: "http://127.0.0.1:0/v1" };
  const content = [{ type: "input_text", text: "generic fixture task" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }];
  const ordinaryItem = { type: "provider_specific_future_item", value: "preserve" };
  const providerReasoning = { type: "reasoning", encrypted_content: "provider-owned-opaque-value" };
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? genericResponsesProfile : null,
    resolveAuth: async () => ({ headers: {} }),
    fetchImpl: async (url, init) => {
      observed = { url: String(url), body: JSON.parse(Buffer.from(init.body).toString("utf8")) };
      return new Response(JSON.stringify({ id: "generic-response", object: "response", output: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: [ordinaryItem, providerReasoning, { type: "agent_message", content }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.url, "http://127.0.0.1:0/v1/responses");
  assert.deepEqual(observed.body.input, [ordinaryItem, providerReasoning, { type: "message", role: "user", content }]);
});

test("gateway routes the official DeepSeek v4-pro Responses profile through normalization", async (t) => {
  let observed;
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID
      ? { ...deepseekProResponsesProfile, profileId }
      : null,
    resolveAuth: async () => ({ headers: {} }),
    fetchImpl: async (url, init) => {
      observed = { url: String(url), body: JSON.parse(Buffer.from(init.body).toString("utf8")) };
      return new Response(JSON.stringify({ id: "resp-pro", object: "response", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      input: "hello",
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "xhigh", summary: "auto" },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.url, "https://api.deepseek.com/responses");
  assert.equal(observed.body.model, "deepseek-v4-pro");
  assert.deepEqual(observed.body.reasoning, { effort: "high" });
  assert.equal("store" in observed.body, false);
  assert.equal("include" in observed.body, false);
});

test("gateway leaves unknown Responses vendors unchanged", async (t) => {
  let observed;
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, profileId, protocol: "responses" } : null,
    resolveAuth: async () => ({ headers: {} }),
    fetchImpl: async (_url, init) => {
      observed = JSON.parse(Buffer.from(init.body).toString("utf8"));
      return new Response(JSON.stringify({ id: "resp-unknown", object: "response", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const body = {
    model: "mimo-model",
    input: "hello",
    store: false,
    include: ["reasoning.encrypted_content"],
    metadata: { team: "unknown-vendor" },
    reasoning: { effort: "xhigh", summary: "auto" },
  };
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(observed, body);
});

test("gateway rejects unknown profile, mismatched model, and disallowed routes before upstream", async (t) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => { upstreamCalls += 1; res.end("unexpected"); });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }),
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const unknown = await fetch(`${baseUrl}/profiles/b1b2c3d4e5f60718293a4b5c/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-model", input: "x" }) });
  const mismatch = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "other", input: "x" }) });
  const badPath = await fetch(`${baseUrl}/v1/responses`, { method: "POST", body: "{}" });
  assert.equal(unknown.status, 404);
  assert.equal(mismatch.status, 400);
  assert.equal(badPath.status, 404);
  assert.equal(upstreamCalls, 0);
});

test("gateway converts auth resolver failures into credential_unavailable without exposing resolver text", async (t) => {
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? profile : null,
    resolveAuth: async () => { throw new Error("secret-bearing resolver diagnostic must not escape"); },
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "hello" }),
  });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /credential_unavailable/);
  assert.doesNotMatch(text, /secret-bearing/);
});

test("gateway maps a Chat JSON tool call to Responses JSON without executing the tool", async (t) => {
  let observed;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const toolName = observed.tools[0].function.name;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-json", model: "mimo-model", choices: [{ index: 0, message: { role: "assistant", tool_calls: [
        { id: "call-real", type: "function", function: { name: toolName, arguments: "{\"input\":\"echo hello\"}" } },
      ] }, finish_reason: "tool_calls" }],
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }),
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "run", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] }),
  });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(observed.model, "mimo-model");
  assert.equal(json.output[0].type, "custom_tool_call");
  assert.equal(json.output[0].call_id, "call-real");
  assert.equal(json.output[0].input, "echo hello");
  assert.equal("output" in json.output[0], false);
});

test("gateway ends a timed out Chat SSE response with response.failed, never response.completed", async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseFrame({ id: "chatcmpl-timeout", model: "mimo-model", choices: [{ index: 0, delta: { content: "started" }, finish_reason: null }] }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }),
    token: "local-token",
    timeoutMs: 100,
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "hello", stream: true }),
  });
  const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice(6)));
  assert.equal(response.status, 200);
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "timeout");
  assert.equal(events.some(({ type }) => type === "response.completed"), false);
});

test("gateway preserves upstream auth failures and returns bounded timeout before response headers", async (t) => {
  let calls = 0;
  const upstream = http.createServer(async (_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"message":"test unauthorized"}}');
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: { authorization: "Bearer test-only" } }),
    token: "local-token",
    timeoutMs: 100,
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const url = `${baseUrl}/profiles/${PROFILE_ID}/v1/responses`;
  const request = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-model", input: "hello" }) });
  const unauthorized = await request();
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: { message: "test unauthorized" } });
  const timeout = await request();
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json()).error.code, "timeout");
});

test("gateway cancels the upstream request when the local CLI disconnects", async (t) => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseFrame({ id: "chatcmpl-disconnect", model: "mimo-model", choices: [{ index: 0, delta: { content: "connected" }, finish_reason: null }] }));
    res.on("close", upstreamClosedResolve);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }), token: "local-token", timeoutMs: 1000, logger: { info() {} },
  });
  const { port, baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const client = http.request(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" } });
  client.on("response", (res) => { res.once("data", () => client.destroy()); });
  client.end(JSON.stringify({ model: "mimo-model", input: "hello", stream: true }));
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream did not observe client disconnect")), 1000))]);
});

