import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareGatewayDispatch, resolveNativeAgent } from "../scripts/native-agent.mjs";
import { NativeTasks } from "../scripts/native-state.mjs";
import { mergeCatalog } from "../scripts/native-catalog.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "native-agent.mjs");

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const dispatchRoot = await mkdtemp(path.join(os.tmpdir(), "native-agent-gateway-dispatch-"));
try {
  const tasks = new NativeTasks({stateDir: dispatchRoot});
  const order = [];
  const prepared = await prepareGatewayDispatch({
    result: {executor: "api", profile_id: "abcdefabcdefabcdefabcdef", resolved_model: "mock-api-model"},
    executor: "api", profileId: "abcdefabcdefabcdefabcdef", taskNonce: "dispatch-preflight-001", parentThreadId: "parent-chat",
    tasks,
    assertEnabled: async () => { order.push("enabled"); },
    ensureReady: async () => { order.push("ready"); },
  });
  equal(order.join(","), "enabled,ready,enabled", "gateway dispatch checks enablement before and after setup");
  equal(prepared.dispatch_reservation.task_nonce, "dispatch-preflight-001", "spawn result carries its pending dispatch identity");
  equal(await tasks.hasActiveGatewayExecutions(), true, "pending gateway dispatch protects the gateway before child bind");
  let announceGate;
  let releaseGate;
  const gateEntered = new Promise(resolve => { announceGate = resolve; });
  const gateHeld = new Promise(resolve => { releaseGate = resolve; });
  const firstGate = prepareGatewayDispatch({
    result: {executor: "api", resolved_model: "mock-api-model"}, executor: "api", profileId: "abcdefabcdefabcdefabcdef",
    taskNonce: "dispatch-concurrent-001", parentThreadId: "parent-chat", tasks: new NativeTasks({stateDir: path.join(dispatchRoot, "concurrent")}),
    ensureReady: async () => { announceGate(); await gateHeld; },
  });
  await gateEntered;
  const duplicateGate = await Promise.allSettled([prepareGatewayDispatch({
    result: {executor: "api", resolved_model: "mock-api-model"}, executor: "api", profileId: "abcdefabcdefabcdefabcdef",
    taskNonce: "dispatch-concurrent-001", parentThreadId: "parent-chat", tasks: new NativeTasks({stateDir: path.join(dispatchRoot, "concurrent")}),
  })]);
  equal(duplicateGate[0].status, "rejected", "a concurrent gate cannot share the first gate's pending nonce");
  releaseGate();
  await firstGate;
  await tasks.begin({parentThreadId: "parent-chat", childThreadId: "api-child", taskNonce: "dispatch-preflight-001", model: "mock-api-model", binding: {
    executor: "api", profileId: "abcdefabcdefabcdefabcdef", model: "mock-api-model",
    role: "native_api_abcdefabcdefabcdefabcdef", providerId: "api-native-abcdefabcdefabcdefabcdef",
  }});
  const reuse = await prepareGatewayDispatch({
    result: {executor: "api", resolved_model: "mock-api-model"}, executor: "api", profileId: "abcdefabcdefabcdefabcdef",
    taskNonce: "dispatch-preflight-001", reuseChildThreadId: "api-child", parentThreadId: "parent-chat", tasks,
  });
  equal(reuse.reuse_child, true, "a follow-up gate marks the existing child for reuse rather than spawn");
  equal(reuse.child_thread_id, "api-child", "follow-up gate identifies the exact existing child");
  equal(reuse.spawn, false, "follow-up gate explicitly suppresses a new child spawn");
  equal(Object.hasOwn(reuse, "agent_type"), false, "follow-up result omits new-child spawn metadata");
  await tasks.cancelDispatch({parentThreadId: "parent-chat", taskNonce: "dispatch-preflight-001"});
  equal((await tasks.assertOwner("api-child", "parent-chat")).status, "running", "cancelling a follow-up intent preserves the real active child status");
  await prepareGatewayDispatch({
    result: {executor: "api", resolved_model: "mock-api-model"}, executor: "api", profileId: "abcdefabcdefabcdefabcdef",
    taskNonce: "dispatch-preflight-001", reuseChildThreadId: "api-child", parentThreadId: "parent-chat", tasks,
  });
  await tasks.begin({parentThreadId: "parent-chat", childThreadId: "api-child", taskNonce: "dispatch-preflight-001", model: "mock-api-model", binding: {
    executor: "api", profileId: "abcdefabcdefabcdefabcdef", model: "mock-api-model",
    role: "native_api_abcdefabcdefabcdefabcdef", providerId: "api-native-abcdefabcdefabcdefabcdef",
  }});
  equal(await tasks.hasActiveGatewayExecutions(), true, "binding atomically replaces the dispatch intent with the active child");
  const failedTasks = new NativeTasks({stateDir: path.join(dispatchRoot, "cancelled")});
  let finalizationCount = 0;
  await assert.rejects(prepareGatewayDispatch({
    result: {resolved_model: "mock-api-model"}, executor: "api", profileId: "abcdefabcdefabcdefabcdef",
    taskNonce: "dispatch-preflight-002", parentThreadId: "parent-chat", tasks: failedTasks,
    assertEnabled: async () => {}, ensureReady: async () => { throw new Error("mock setup failed"); },
    onCancelled: async () => { finalizationCount += 1; },
  }), /mock setup failed/);
  checks += 1;
  equal(await failedTasks.hasActiveGatewayExecutions(), false, "confirmed setup failure cancels its pending intent");
  const disabledTasks = new NativeTasks({stateDir: path.join(dispatchRoot, "disabled")});
  await assert.rejects(prepareGatewayDispatch({
    result: {resolved_model: "mock-api-model"}, executor: "api", profileId: "abcdefabcdefabcdefabcdef",
    taskNonce: "dispatch-preflight-003", parentThreadId: "parent-chat", tasks: disabledTasks,
    assertEnabled: async () => { throw new Error("disabled during setup"); },
    onCancelled: async () => { finalizationCount += 1; },
  }), /disabled during setup/);
  checks += 1;
  equal(await disabledTasks.hasActiveGatewayExecutions(), false, "disabled preflight cancels only its unbound gateway intent");
  equal(finalizationCount, 2, "cancelled preflight requests pending-disable finalization");
} finally {
  await rm(dispatchRoot, {recursive: true, force: true});
}

const cache = {
  models: [
    { slug: "gpt-6.1-sol", visibility: "list", display_name: "GPT-6.1-Sol" },
    { slug: "gpt-6-luna", visibility: "list", display_name: "GPT-6-Luna" },
    { slug: "gpt-5.6-luna", visibility: "list", display_name: "GPT-5.6-Luna" },
  ],
};
const models = cache.models.map((model) => model.slug);
const luna = resolveNativeAgent({ executor: "luna", mainModel: "gpt-6.1-sol", models });
equal(luna.model, "gpt-6-luna", "new Sol maps to its catalog-supported Luna");
equal(luna.fork_turns, "none", "Luna child has no inherited turns");
const older = resolveNativeAgent({ executor: "luna", mainModel: "gpt-5.6-sol", models });
equal(older.model, "gpt-5.6-luna", "older Sol maps to its supported Luna");
const fallback = resolveNativeAgent({ executor: "luna", mainModel: "new-sol-model", models });
equal(fallback.model, "gpt-6-luna", "new unknown Sol prefers an available supported Luna without changing main");
const deepseek = resolveNativeAgent({ executor: "deepseek", mainModel: "gpt-6.1-sol", models });
equal(deepseek.agent_type, "native_deepseek", "DeepSeek selects the dedicated native role");
equal(deepseek.model, undefined, "DeepSeek does not send an explicit model override");
equal(Object.hasOwn(deepseek, "model"), false, "DeepSeek result omits the model property entirely");
equal(deepseek.resolved_model, "deepseek/deepseek-flash", "role metadata identifies the fixed DeepSeek slug informationally");
equal(deepseek.fork_turns, "none", "DeepSeek child has no inherited turns");
assert.throws(() => resolveNativeAgent({ executor: "luna", mainModel: "x", models: ["gpt-6.1-sol"] }), /No supported native Luna/);
checks += 1;
assert.throws(() => resolveNativeAgent({}), /executor must be luna, deepseek, or a configured API profile/);
checks += 1;

const catalog = mergeCatalog(cache);
equal(catalog.models.length, 4, "catalog preserves every native model and adds DeepSeek");
equal(catalog.models[0].slug, "gpt-6.1-sol", "native catalog order and fields are preserved");
equal(catalog.models.at(-1).slug, "deepseek/deepseek-flash", "DeepSeek is appended");
equal(catalog.models.at(-1).multi_agent_version, "v2", "DeepSeek is spawnable");
equal(catalog.models.at(-1).use_responses_lite, false, "DeepSeek disables ResponsesLite");
equal(catalog.models.filter((model) => model.slug === "deepseek/deepseek-flash").length, 1, "DeepSeek appears once");

function runCli(args, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-agent-cli-"));
  const out = path.join(dir, "out");
  const err = path.join(dir, "err");
  const outFd = openSync(out, "w");
  const errFd = openSync(err, "w");
  let result;
  try {
    const childEnv = { ...process.env };
    delete childEnv.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
    result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...childEnv, CODEX_THREAD_ID: "native-agent-test-parent", LOCALAPPDATA: path.join(dir, "local"), SOL_LUNA_PLUGIN_STATE: path.join(dir, "plugin-state"), ...env },
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(out, "utf8");
  const stderr = readFileSync(err, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout, stderr };
}

const misplacedReuse = runCli(["--executor", "luna", "--reuse-child", "existing-child"]);
equal(misplacedReuse.status, 2, "native-agent rejects reuse-child on a route that would otherwise spawn a new executor");
assert.match(misplacedReuse.stderr, /reuse-child is supported only for API or DeepSeek/);
checks += 1;
const missingReuseId = runCli(["--executor", "deepseek", "--task-nonce", "cli-gate-nonce-001", "--reuse-child"]);
equal(missingReuseId.status, 2, "native-agent rejects a reuse-child flag without a thread id");
assert.match(missingReuseId.stderr, /--reuse-child requires an existing child thread ID/);
checks += 1;

const root = await mkdtemp(path.join(os.tmpdir(), "native-agent-homes-"));
try {
  const home = path.join(root, "codex-home");
  const emptyHome = path.join(root, "empty-home");
  await mkdir(home, { recursive: true });
  await mkdir(emptyHome, { recursive: true });
  await writeFile(path.join(home, "models_cache.json"), JSON.stringify(cache), "utf8");
  const disabledSettings = path.join(root, "router-disabled.json");
  await writeFile(disabledSettings, JSON.stringify({
    schemaVersion: 1, enabled: false, mode: "fixed", fixedExecutor: "same",
    schedule: {peak: "luna", valley: "deepseek"}, profiles: {},
  }), "utf8");
  const disabledDispatch = runCli(["--executor", "same", "--main-model", "gpt-6.1-sol", "--settings", disabledSettings], {CODEX_HOME: home});
  equal(disabledDispatch.status, 2, "native-agent refuses a child dispatch while router delegation is disabled");
  assert.match(disabledDispatch.stderr, /Automatic child dispatch is disabled/);
  checks += 1;
  const lunaCli = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol"], { CODEX_HOME: home });
  equal(lunaCli.status, 0, "Luna CLI reads the actual CODEX_HOME cache by default");
  equal(JSON.parse(lunaCli.stdout).model, "gpt-6-luna", "Luna CLI resolves the real catalog model");
  const dsCli = runCli(["--executor", "deepseek"], { CODEX_HOME: emptyHome });
  equal(dsCli.status, 2, "DeepSeek CLI fails closed without an activated isolated install journal");
  assert.match(dsCli.stderr, /installed isolation journal path is required/);
  checks += 1;
  const inheritedHostJournal = path.join(root, "host-install-journal-must-not-leak.json");
  const priorHostJournal = process.env.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  process.env.SOL_LUNA_NATIVE_INSTALL_JOURNAL = inheritedHostJournal;
  let isolatedDefault;
  try { isolatedDefault = runCli(["--executor", "deepseek"], { CODEX_HOME: emptyHome }); }
  finally {
    if (priorHostJournal === undefined) delete process.env.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
    else process.env.SOL_LUNA_NATIVE_INSTALL_JOURNAL = priorHostJournal;
  }
  equal(isolatedDefault.status, 2, "default test subprocess has no host journal and fails closed");
  assert.match(isolatedDefault.stderr, /installed isolation journal path is required/);
  equal(isolatedDefault.stderr.includes(inheritedHostJournal), false, "default test subprocess cannot inherit a host journal path");
  checks += 2;
  const envJournal = path.join(root, "env-only-journal.json");
  const envOnly = runCli(["--executor", "deepseek", "--task-nonce", "env-ds-task-0001"], { CODEX_HOME: emptyHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: envJournal });
  equal(envOnly.status, 2, "env-only journal proceeds to the unchanged activation gate");
  assert.match(envOnly.stderr, /DeepSeek install journal is missing/);
  equal(envOnly.stderr.includes(envJournal), false, "failed gate does not echo a private journal path");
  checks += 1;
  const explicitJournal = path.join(root, "explicit-journal.json");
  const ignoredEnvJournal = path.join(root, "ignored-env-journal.json");
  const explicitWins = runCli(["--executor", "deepseek", "--install-journal", explicitJournal, "--task-nonce", "explicit-ds-task-1"], { CODEX_HOME: emptyHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: ignoredEnvJournal });
  equal(explicitWins.status, 2, "explicit journal proceeds to the unchanged activation gate");
  assert.match(explicitWins.stderr, /DeepSeek install journal is missing/);
  equal(explicitWins.stderr.includes(explicitJournal), false, "explicit journal failure does not echo its private path");
  equal(explicitWins.stderr.includes(ignoredEnvJournal), false, "explicit journal takes precedence over environment fallback");
  checks += 2;
  const emptyExplicit = runCli(["--executor", "deepseek", "--install-journal", ""], { CODEX_HOME: emptyHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: envJournal });
  equal(emptyExplicit.status, 2, "an explicitly empty journal fails closed");
  assert.match(emptyExplicit.stderr, /must not be empty|empty install-journal/i);
  equal(emptyExplicit.stderr.includes(envJournal), false, "empty explicit journal does not silently fall back to environment");
  checks += 2;
  const missingExplicit = runCli(["--executor", "deepseek", "--install-journal"], { CODEX_HOME: emptyHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: envJournal });
  equal(missingExplicit.status, 2, "an explicit journal flag without a following value fails closed");
  assert.match(missingExplicit.stderr, /must not be empty/);
  equal(missingExplicit.stderr.includes(envJournal), false, "missing explicit value never falls back to environment");
  checks += 2;
  const missing = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol"], { CODEX_HOME: emptyHome });
  equal(missing.status, 2, "Luna CLI fails closed when the default cache is missing");
  assert.match(missing.stderr, /models_cache\.json is missing/);
  checks += 1;
  const overrideCache = path.join(root, "override-cache.json");
  await writeFile(overrideCache, JSON.stringify(cache), "utf8");
  const override = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol", "--models-cache", overrideCache], { CODEX_HOME: emptyHome });
  equal(override.status, 0, "--models-cache overrides the default cache path");
  equal(JSON.parse(override.stdout).model, "gpt-6-luna", "override cache resolves the model");
  await writeFile(path.join(emptyHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }), "utf8");
  const noLuna = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol"], { CODEX_HOME: emptyHome });
  equal(noLuna.status, 2, "Luna CLI fails instead of substituting when no Luna is listed");
  assert.match(noLuna.stderr, /No supported native Luna/);
  checks += 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native agent/catalog assertions`);
