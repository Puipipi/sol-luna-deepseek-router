import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeApiGateway } from "../scripts/native-api-gateway.mjs";
import { gatewayTaskPlan } from "../scripts/native-gateway-task.mjs";
import { apiTaskPlan } from "../scripts/native-api-manager.mjs";
import { createApiProfile, saveRouterSettings } from "../scripts/native-api-settings.mjs";
import {
  activate,
  applyApiConfiguration,
  ensureNativeApiDispatch,
  getExecutorStatus,
  inspectNativeApiDispatchState,
  NATIVE_API_SOURCE_ENTRY,
  NATIVE_API_SOURCE_FILES,
  nativeApiPaths,
  prepare,
} from "../scripts/native-api-install.mjs";
import { gatewaySourceEntry, stageGatewaySource, verifyGatewaySource } from "../scripts/native-gateway-source.mjs";
import { resolveNativeAgent } from "../scripts/native-agent.mjs";
import { NativeTasks } from "../scripts/native-state.mjs";
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT } from "../scripts/native-runtime.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const rejects = async (fn, pattern, message) => { await assert.rejects(fn, pattern, message); checks += 1; };
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runCli(args, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-api-cli-"));
  const out = path.join(dir, "out");
  const err = path.join(dir, "err");
  const outFd = openSync(out, "w");
  const errFd = openSync(err, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "native-agent.mjs"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_THREAD_ID: "native-api-test-parent", CODEX_HOME: path.join(dir, "codex-home"), LOCALAPPDATA: path.join(dir, "local"), SOL_LUNA_PLUGIN_STATE: path.join(dir, "plugin-state"), ...env },
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

function fakeTaskAdapter() {
  let record = { exists: false, owned: false, specMatches: true, enabled: false, state: "Missing" };
  let starts = 0;
  let registers = 0;
  return {
    get starts() { return starts; },
    get registers() { return registers; },
    setState(state) { record.state = state; },
    async status() { return { ...record }; },
    async register() {
      registers += 1;
      record = { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready" };
    },
    async start() { starts += 1; record.state = "Running"; return { started: true }; },
    async unregister() {
      record = { exists: false, owned: false, specMatches: true, enabled: false, state: "Missing" };
      return { removed: true };
    },
  };
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function startHealthServer(port, flags) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: process.pid, ...flags }));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-api-lifecycle-")));
try {
  const servicePaths = {
    dir: path.join(tempRoot, "gateway"),
    state: path.join(tempRoot, "gateway", "gateway.json"),
    identity: path.join(tempRoot, "gateway", "identity.json"),
    log: path.join(tempRoot, "gateway", "gateway.log"),
  };
  const dsPlan = gatewayTaskPlan({ paths: servicePaths, gatewayScriptPath: path.join(repoRoot, "scripts", "native-gateway.mjs") });
  const apiPlan = gatewayTaskPlan({ paths: servicePaths, gatewayScriptPath: path.join(repoRoot, "scripts", "native-api-serve.mjs"), service: "api" });
  const apiPlanWithSettings = apiTaskPlan({
    apiDir: path.join(tempRoot, "custom-api-plan"),
    gatewayScriptPath: path.join(repoRoot, "scripts", "native-api-serve.mjs"),
    settingsPath: path.join(tempRoot, "custom settings", "router.json"),
  });
  ok(dsPlan.name.startsWith("SolLunaNativeGateway-"), "default task keeps the DeepSeek namespace");
  ok(apiPlan.name.startsWith("SolLunaNativeApi-"), "API task uses an independent namespace");
  equal(dsPlan.autoStart, true, "DeepSeek task keeps the existing logon trigger");
  equal(apiPlan.autoStart, false, "API task is registered without an unused logon trigger");
  ok(apiPlan.marker.startsWith("sol-luna-native-api-task:v1:"), "API task ownership marker is independent");
  ok(dsPlan.launcher.path.endsWith("gateway-task.vbs"), "DeepSeek launcher path is unchanged");
  ok(apiPlan.launcher.path.endsWith("api-task.vbs"), "API launcher has its own hidden VBS");
  assert.match(dsPlan.launcher.content, /--deepseek-only/);
  assert.match(apiPlan.launcher.content, /--api-only/);
  assert.match(apiPlanWithSettings.launcher.content, /--settings/);
  assert.match(apiPlanWithSettings.launcher.content, /--settings ""[^"]*custom settings[^"]*router\.json""/);
  assert.match(apiPlan.launcher.content, /shell\.Run\(command, 0, True\)/);
  assert.doesNotMatch(apiPlan.launcher.content, /--deepseek-only/);
  checks += 1;

  const token = "lifecycle-token-1234567890";
  const flags = { api_only: true, relay_allowed: false };
  let shutdown = false;
  const gateway = createNativeApiGateway({
    token,
    health: flags,
    onShutdown: () => { shutdown = true; },
    resolveProfile: async () => null,
    resolveAuth: async () => ({ headers: {} }),
    logger: { info() {} },
  });
  const started = await gateway.start(0);
  const health = await (await fetch(`http://127.0.0.1:${started.port}/${token}/_health`)).json();
  equal(health.api_only, true, "API gateway advertises api_only=true");
  equal(health.relay_allowed, false, "API gateway advertises relay_allowed=false");
  const denied = await fetch(`http://127.0.0.1:${started.port}/${token}/_shutdown`, { method: "POST" });
  equal(denied.status, 403, "shutdown without the private token header is rejected");
  const accepted = await fetch(`http://127.0.0.1:${started.port}/${token}/_shutdown`, {
    method: "POST",
    headers: { "x-sol-luna-token": token },
  });
  equal(accepted.status, 200, "identity-bound shutdown is accepted");
  await new Promise((resolve) => setTimeout(resolve, 20));
  equal(shutdown, true, "shutdown callback runs after the response");
  await gateway.close();

  const apiDir = path.join(tempRoot, "native-api");
  const codexHome = path.join(tempRoot, "codex-home");
  const paths = nativeApiPaths(apiDir);
  const definition = {
    protocol: "responses",
    baseUrl: "https://api.example.invalid/v1",
    model: "exact/model",
    reasoning: { supported: ["low", "high"], default: "high", parameter: "reasoning_effort" },
    credential: { type: "env", name: "LIFECYCLE_KEY" },
  };
  const profile = createApiProfile(definition, { label: "Lifecycle" });
  const settings = {
    schemaVersion: 1,
    mode: "fixed",
    fixedExecutor: profile.profileId,
    profiles: { [profile.profileId]: profile },
  };
  await mkdir(path.join(codexHome, "agents"), { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n', "utf8");
  await writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "fixture-native-model",
    visibility: "list",
    model_messages: { instructions_template: "You are Codex, an AI coding assistant working in the shared workspace." },
  }] }), "utf8");
  await saveRouterSettings(paths.settings, settings);
  const gatewayScript = path.join(tempRoot, "native-api-serve.mjs");
  await writeFile(gatewayScript, "// fixture\n", "utf8");
  const port = await freePort();
  const identity = { version: 1, token: "native-api-fixture-token", port };
  const tasks = fakeTaskAdapter();
  const dependencies = {
    verifyRuntimeVersion: async () => ({ exePath: path.join(tempRoot, "codex.exe") }),
    discoverApplyCompatibleRuntime: async () => ({versionDir: path.join(tempRoot, "runtime"), exePath: path.join(tempRoot, "codex.exe"), error: null}),
    armOrReuseApiBootstrap: async ({runtimeDir}) => ({state: "armed", restartRequired: true, ready: false, reused: true, runtimeVersionDir: runtimeDir}),
    prepareGatewayIdentity: async ({ paths: service }) => {
      await mkdir(service.dir, { recursive: true });
      await writeFile(service.identity, `${JSON.stringify(identity)}\n`, "utf8");
      return identity;
    },
    resolveApiCredential: async () => ({ headers: { authorization: "Bearer memory-only" } }),
    taskAdapter: tasks,
  };
  const journalPath = paths.journal(profile.profileId);
  await prepare({
    profileId: profile.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(tempRoot, "runtime"),
    journalPath,
    gatewayScriptPath: gatewayScript,
  }, dependencies);
  await activate({ journalPath }, dependencies);
  const launcherPath = path.join(paths.service.dir, "api-task.vbs");
  const launcherBytes = await readFile(launcherPath);
  equal(launcherBytes[0], 0xff, "lifecycle fixture launcher has a BOM");
  assert.match(launcherBytes.toString("utf16le", 2), /--api-only/);
  checks += 1;
  await writeFile(apiServiceState(apiDir), `${JSON.stringify({
    version: 1,
    pid: process.pid,
    port,
    token: identity.token,
    api_only: true,
    relay_allowed: false,
  })}\n`, "utf8");
  const healthServer = await startHealthServer(port, flags);
  try {
    tasks.setState("Running");
    const ready = await inspectNativeApiDispatchState({
      profileId: profile.profileId,
      apiDir,
      settingsPath: paths.settings,
      taskAdapter: tasks,
      requireRunning: true,
    }, dependencies);
    equal(ready.ready, true, "gate accepts activated role/provider/catalog/task/health");

    const rootConfigPath = path.join(codexHome, "config.toml");
    const activeConfig = await readFile(rootConfigPath, "utf8");
    const roleRegistration = `[agents.native_api_${profile.profileId}]\ndescription = "Native API profile ${profile.profileId}"\nconfig_file = ${JSON.stringify(path.join(codexHome, "agents", `native_api_${profile.profileId}.toml`))}`;
    assert.ok(activeConfig.includes(roleRegistration), "activation registers the generated role file in root config");
    assert.match(activeConfig, /^model = "gpt-6\.1-sol"/m);
    checks += 1;
    const legacyConfig = activeConfig.replace(new RegExp(`\\n\\[agents\\.native_api_${profile.profileId}\\]\\n[^\\n]*\\n[^\\n]*`), "");
    assert.notEqual(legacyConfig, activeConfig, "fixture models the previously active provider-only config");
    await writeFile(rootConfigPath, legacyConfig, "utf8");
    await rejects(() => inspectNativeApiDispatchState({
      profileId: profile.profileId,
      apiDir,
      settingsPath: paths.settings,
      taskAdapter: tasks,
    }, dependencies), /provider config changed/);
    const applyDependencies = {
      ...dependencies,
      apiDir,
      settingsPath: paths.settings,
      codexHome,
      env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(tempRoot, "runtime") },
    };
    const legacyStatus = await getExecutorStatus({ settings, profileId: profile.profileId }, applyDependencies);
    equal(legacyStatus.installed, false, "status does not claim a provider-only legacy block is dispatch ready");
    equal(legacyStatus.apiVerified, false, "legacy status does not claim an API model request");
    const repaired = await applyApiConfiguration({ settings }, applyDependencies);
    equal(repaired.applied, true, "explicit Apply repairs a safe legacy role registration");
    equal(repaired.appliedProfiles.includes(profile.profileId), true, "Apply reports the repaired registration as applied");
    const repairedConfig = await readFile(rootConfigPath, "utf8");
    assert.ok(repairedConfig.includes(roleRegistration), "Apply restores the exact generated role file registration");
    assert.match(repairedConfig, /^model = "gpt-6\.1-sol"/m);
    checks += 1;
    const repairedDispatch = await inspectNativeApiDispatchState({
      profileId: profile.profileId,
      apiDir,
      settingsPath: paths.settings,
      taskAdapter: tasks,
      requireRunning: true,
    }, dependencies);
    equal(repairedDispatch.ready, true, "dispatch gate accepts the repaired legacy profile");

    await writeFile(launcherPath, "tampered");
    await rejects(() => inspectNativeApiDispatchState({
      profileId: profile.profileId,
      apiDir,
      settingsPath: paths.settings,
      taskAdapter: tasks,
    }, dependencies), /launcher changed/);
    await writeFile(launcherPath, launcherBytes);

    const rolePath = path.join(codexHome, "agents", `native_api_${profile.profileId}.toml`);
    const roleBytes = await readFile(rolePath);
    await writeFile(rolePath, "tampered\n");
    await rejects(() => inspectNativeApiDispatchState({ profileId: profile.profileId, apiDir, settingsPath: paths.settings, taskAdapter: tasks }, dependencies), /role changed/);
    await writeFile(rolePath, roleBytes);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const configPath = path.join(codexHome, "config.toml");
    const configBytes = await readFile(configPath);
    await writeFile(configPath, configBytes.toString("utf8").replace(`/profiles/${profile.profileId}/v1`, `/profiles/${"0".repeat(24)}/v1`));
    await rejects(() => inspectNativeApiDispatchState({ profileId: profile.profileId, apiDir, settingsPath: paths.settings, taskAdapter: tasks }, dependencies), /provider config changed/);
    await writeFile(configPath, configBytes);
    tasks.setState("Ready");
    await rejects(() => inspectNativeApiDispatchState({
      profileId: profile.profileId,
      apiDir,
      settingsPath: paths.settings,
      taskAdapter: tasks,
      requireRunning: true,
    }, dependencies), /not Running/);
    tasks.setState("Running");
    flags.api_only = false;
    await rejects(() => inspectNativeApiDispatchState({
      profileId: profile.profileId,
      apiDir,
      settingsPath: paths.settings,
      taskAdapter: tasks,
      requireRunning: true,
    }, dependencies), /api_only=true/);
    flags.api_only = true;

    const missingJournal = runCli(["--executor", profile.profileId, "--api-dir", path.join(tempRoot, "missing-api"), "--settings", paths.settings, "--main-model", "gpt-6.1-sol", "--task-nonce", "missing-api-task-01"]);
    equal(missingJournal.status, 2, "native-agent API dispatch fails closed without an install");
    assert.match(missingJournal.stderr, /API bootstrap is not armed/);
    assert.doesNotMatch(missingJournal.stderr, /native DeepSeek|isolated/i);
    checks += 1;

    tasks.setState("Ready");
    let startCalls = 0;
    const ensured = await ensureNativeApiDispatch({
      profileId: profile.profileId,
      apiDir,
      settingsPath: paths.settings,
      taskAdapter: tasks,
    }, {
      ...dependencies,
      ensureGateway: async ({ paths: service, launchImpl }) => {
        startCalls += 1;
        await launchImpl({ paths: service });
        return { state: { pid: process.pid, port, token: identity.token }, started: true };
      },
    });
    equal(ensured.ready, true, "ensure starts and re-verifies the selected API gateway");
    equal(startCalls, 1, "selected API profile starts the owned task once");
    equal(tasks.starts, 1, "Task start is invoked for the selected API only");
  } finally {
    healthServer.close();
    await once(healthServer, "close");
  }
  const statusHealthServer = await startHealthServer(port, flags);

  const retryAgain = await inspectNativeApiDispatchState({
    profileId: profile.profileId,
    apiDir,
    settingsPath: paths.settings,
    taskAdapter: tasks,
  }, dependencies);
  equal(retryAgain.ready, true, "static gate remains available after service start");
  const startsBeforeStatus = tasks.starts;
  const executorStatus = await getExecutorStatus({ settings, profileId: profile.profileId }, {
    apiDir,
    env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(tempRoot, "runtime") },
    verifyRuntimeVersion: dependencies.verifyRuntimeVersion,
    taskAdapter: tasks,
    resolveApiCredential: dependencies.resolveApiCredential,
  });
  equal(executorStatus.installed, true, "status reports installed artifacts");
  equal(executorStatus.runtimeCompatible, true, "status reports the approved runtime");
  equal(executorStatus.restartRequired, "unknown", "status cannot prove whether the running app adopted the role");
  assert.match(executorStatus.detail, /完整重启|无法自动确认/);
  checks += 1;
  equal(executorStatus.gatewayRunning, true, "status reads the running owned task");
  equal(executorStatus.localHealthy, true, "status reads api_only/relay_allowed health");
  equal(executorStatus.credentialAvailable, true, "status checks credential presence in memory");
  equal(executorStatus.apiVerified, false, "status never claims an API/model verification");
  equal(tasks.starts, startsBeforeStatus, "status is read-only and does not start the service");
  const registryPath = nativeApiPaths(apiDir).registry;
  const registryBytes = await readFile(registryPath);
  const registryData = JSON.parse(registryBytes.toString("utf8"));
  delete registryData.profiles[profile.profileId];
  await writeFile(registryPath, `${JSON.stringify(registryData, null, 2)}\n`);
  const missingRegistryStatus = await getExecutorStatus({ settings, profileId: profile.profileId }, {
    apiDir,
    env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(tempRoot, "runtime") },
    verifyRuntimeVersion: dependencies.verifyRuntimeVersion,
    taskAdapter: tasks,
    resolveApiCredential: dependencies.resolveApiCredential,
  });
  equal(missingRegistryStatus.installed, false, "status does not report ready when the registry entry is missing");
  await writeFile(registryPath, registryBytes);
  const incompatibleStatus = await getExecutorStatus({ settings, profileId: profile.profileId }, {
    apiDir,
    verifyRuntimeVersion: async () => { throw new Error("old runtime patch"); },
    taskAdapter: tasks,
    resolveApiCredential: dependencies.resolveApiCredential,
  });
  equal(incompatibleStatus.installed, true, "status still reports installed files for an old runtime");
  equal(incompatibleStatus.runtimeCompatible, false, "status rejects the old runtime instead of claiming ready");
  assert.match(incompatibleStatus.detail, /不兼容|runtime/);
  checks += 1;

  const sourceRoot = path.join(tempRoot, "source-root");
  await mkdir(sourceRoot, { recursive: true });
  equal(await realpath(sourceRoot), path.resolve(sourceRoot), "fixture root is canonical before source staging");
  const sourceA = await stageGatewaySource({
    pluginRoot: repoRoot,
    runtimeRoot: sourceRoot,
    sourceFiles: NATIVE_API_SOURCE_FILES,
    entry: NATIVE_API_SOURCE_ENTRY,
  });
  const sourceB = await stageGatewaySource({
    pluginRoot: repoRoot,
    runtimeRoot: sourceRoot,
    sourceFiles: NATIVE_API_SOURCE_FILES,
    entry: NATIVE_API_SOURCE_ENTRY,
  });
  equal(sourceA.contentDigest, sourceB.contentDigest, "API source bundle is content-addressed and stable");
  equal(await verifyGatewaySource(sourceA, { runtimeRoot: sourceRoot }), true, "API source bundle verifies after staging");
  equal(path.basename(gatewaySourceEntry(sourceA, sourceRoot)), "native-api-serve.mjs", "API task entry resolves inside the stable bundle");

  const applyApiDir = path.join(tempRoot, "apply-api");
  const applyHome = path.join(tempRoot, "apply-home");
  const applyPaths = nativeApiPaths(applyApiDir);
  const applyProfile = createApiProfile({ ...definition, model: "exact/apply-model" });
  const applySettings = {
    schemaVersion: 1,
    mode: "fixed",
    fixedExecutor: applyProfile.profileId,
    profiles: { [applyProfile.profileId]: applyProfile },
  };
  await mkdir(path.join(applyHome, "agents"), { recursive: true });
  await writeFile(path.join(applyHome, "config.toml"), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n', "utf8");
  await writeFile(path.join(applyHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "fixture-native-model",
    visibility: "list",
    model_messages: { instructions_template: "You are Codex, an AI coding assistant working in the shared workspace." },
  }] }), "utf8");
  await saveRouterSettings(applyPaths.settings, applySettings);
  const applySnapshot = await import("../scripts/native-api-settings.mjs").then(({ readRouterSettingsSnapshot }) => readRouterSettingsSnapshot(applyPaths.settings));
  const applyTasks = fakeTaskAdapter();
  const applyDeps = {
    ...dependencies,
    apiDir: applyApiDir,
    settingsPath: applyPaths.settings,
    codexHome: applyHome,
    pluginRoot: repoRoot,
    env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(tempRoot, "runtime") },
    taskAdapter: applyTasks,
  };
  const armFailureProfile = createApiProfile({...definition, model: "exact/arm-failure-model"});
  const armFailureSettings = {schemaVersion: 1, mode: "fixed", fixedExecutor: armFailureProfile.profileId,
    profiles: {[armFailureProfile.profileId]: armFailureProfile}};
  const armFailureSettingsPath = path.join(tempRoot, "arm-failure-router.json");
  await saveRouterSettings(armFailureSettingsPath, armFailureSettings);
  const noEnvironmentWrites = {get: async () => ({present: false, value: null}), set: async () => {throw new Error("Apply must not write on failed arm");}};
  const armFailureTasks = fakeTaskAdapter();
  const failedArm = await applyApiConfiguration({settings: armFailureSettings}, {
    ...applyDeps,
    settingsPath: armFailureSettingsPath,
    taskAdapter: armFailureTasks,
    bootstrapEnvironmentAdapter: noEnvironmentWrites,
    armOrReuseApiBootstrap: async () => {throw new Error("approved patch allowlist is empty");},
  });
  equal(failedArm.applied, false, "Apply refuses when persistent bootstrap arming fails");
  assert.match(failedArm.detail, /allowlist is empty/);
  checks += 1;
  await assert.rejects(readFile(applyPaths.journal(armFailureProfile.profileId)), {code: "ENOENT"});
  equal(armFailureTasks.registers, 0, "failed bootstrap arm leaves no API profile task activation");
  const notInstalled = await getExecutorStatus({ settings: applySettings, profileId: applyProfile.profileId }, applyDeps);
  equal(notInstalled.installed, false, "status does not treat saved JSON as installed");
  equal(notInstalled.runtimeCompatible, true, "status reports a compatible staged runtime without installing");
  equal(notInstalled.apiVerified, false, "status keeps apiVerified false before any real probe");
  const applied = await applyApiConfiguration({ settings: applySettings, expectedSha256: applySnapshot.sha256 }, applyDeps);
  equal(applied.applied, true, "explicit Apply reports success");
  equal(applied.appliedProfiles.length, 1, "explicit Apply installs the saved API profile");
  equal(applied.restartRequired, true, "Apply reports the restart requirement");
  equal(applyTasks.registers, 1, "Apply registers the owned API task");
  equal(applyTasks.starts, 0, "Apply never starts a gateway or model request");
  const applyJournalPath = applyPaths.journal(applyProfile.profileId);
  const applyJournalBytes = await readFile(applyJournalPath);
  const applyJournal = JSON.parse(applyJournalBytes.toString("utf8"));
  applyJournal.paths.versionDir = path.join(tempRoot, "other-runtime");
  await writeFile(applyJournalPath, `${JSON.stringify(applyJournal, null, 2)}\n`);
  await rejects(() => applyApiConfiguration({ settings: applySettings, expectedSha256: applySnapshot.sha256 }, applyDeps),
    /different runtime|rollback|reinstall/i);
  await writeFile(applyJournalPath, applyJournalBytes);
  const applyRolePath = path.join(applyHome, "agents", `native_api_${applyProfile.profileId}.toml`);
  const applyRoleBytes = await readFile(applyRolePath);
  await writeFile(applyRolePath, "tampered active role\n");
  await rejects(() => applyApiConfiguration({ settings: applySettings, expectedSha256: applySnapshot.sha256 }, applyDeps),
    /incomplete|rollback|reinstall/i);
  await writeFile(applyRolePath, applyRoleBytes);
  const secondApply = await applyApiConfiguration({ settings: applySettings, expectedSha256: applySnapshot.sha256 }, applyDeps);
  equal(secondApply.alreadyInstalled.length, 1, "repeated Apply is idempotent");
  equal(secondApply.restartRequired, true, "reused owned bootstrap continues to require host restart even when every profile is already installed");
  equal(applyTasks.registers, 1, "repeated Apply does not duplicate the task");
  await rejects(() => applyApiConfiguration({ settings: applySettings, expectedSha256: "0".repeat(64) }, applyDeps), /changed since/);
  const unsupported = await applyApiConfiguration({ settings: applySettings }, {
    ...applyDeps,
    apiDir: path.join(tempRoot, "unsupported-api"),
    settingsPath: applyPaths.settings,
    discoverApplyCompatibleRuntime: async () => ({versionDir: null, exePath: null, error: "runtime patch mismatch"}),
  });
  equal(unsupported.applied, false, "Apply fails closed without a compatible runtime");
  equal(unsupported.supported, false, "Apply reports unsupported instead of claiming ready");
  assert.match(unsupported.detail, /未支持|unsupported/);
  checks += 1;
  let offArmCalls = 0;
  let offPrepareCalls = 0;
  const offSettingsPath = path.join(tempRoot, "disabled-router.json");
  const offSettings = {...applySettings, enabled: false};
  await saveRouterSettings(offSettingsPath, offSettings);
  const disabledApply = await applyApiConfiguration({settings: offSettings}, {
    ...applyDeps,
    settingsPath: offSettingsPath,
    armOrReuseApiBootstrap: async () => { offArmCalls += 1; throw new Error("must not arm while disabled"); },
    verifyRuntimeVersion: async () => { offPrepareCalls += 1; throw new Error("must not inspect runtime while disabled"); },
  });
  equal(disabledApply.applied, false, "explicit Apply while router is off leaves API configuration unapplied");
  assert.match(disabledApply.detail, /已关闭/);
  checks += 1;
  equal(offArmCalls, 0, "off Apply never arms a global bootstrap");
  equal(offPrepareCalls, 0, "off Apply does not inspect or activate a runtime");
  statusHealthServer.close();
  await once(statusHealthServer, "close");

  const binding = {
    executor: "api",
    profileId: profile.profileId,
    model: profile.model,
    role: `native_api_${profile.profileId}`,
    providerId: `api-native-${profile.profileId}`,
  };
  const stateDir = path.join(tempRoot, "state");
  const stateTasks = new NativeTasks({ stateDir });
  await stateTasks.reserveDispatch({parentThreadId: "parent-api", taskNonce: "api-lifecycle-gate-01", executor: "api", profileId: profile.profileId, model: profile.model});
  const boundTask = await stateTasks.begin({
    parentThreadId: "parent-api",
    childThreadId: "child-api",
    taskNonce: "api-lifecycle-gate-01",
    model: profile.model,
    binding,
  });
  equal(boundTask.binding.profileId, profile.profileId, "state stores the exact API profile binding");
  const other = createApiProfile({ ...definition, model: "exact/other" });
  await rejects(() => stateTasks.begin({
    parentThreadId: "parent-api",
    childThreadId: "child-api",
    model: other.model,
    binding: { ...binding, profileId: other.profileId, role: `native_api_${other.profileId}`, providerId: `api-native-${other.profileId}` },
  }), /immutable/);
  await rejects(() => stateTasks.begin({
    parentThreadId: "parent-api",
    childThreadId: "child-api",
    model: other.model,
    binding,
  }), /immutable/);
  equal((await stateTasks.binding({ parentThreadId: "parent-api", childThreadId: "child-api" })).model, profile.model, "follow-up keeps the original profile/model");
  await rejects(() => stateTasks.binding({ parentThreadId: "parent-other", childThreadId: "child-api" }), /another parent chat/);

  const pure = resolveNativeAgent({ executor: profile.profileId, mainModel: "gpt-6.1-sol", apiProfiles: settings.profiles });
  equal(pure.agent_type, `native_api_${profile.profileId}`, "pure resolver selects the generated role");
  equal(pure.fork_turns, "none", "API child does not inherit parent turns");
  equal(pure.resolved_model, profile.model, "API child keeps the exact model");
  equal(Object.hasOwn(pure, "model"), false, "API spawn result has no conflicting model override");

  const patchBytes = await readFile(path.join(repoRoot, "patches", "native-isolated-cli.patch"));
  equal(NATIVE_RUNTIME_PATCH_SHA256, createHash("sha256").update(patchBytes).digest("hex"), "runtime approval hash tracks the tracked patch");
  equal(NATIVE_RUNTIME_PATCH_SHA256, "d0cb44027e64296045dfa26dbc79ed878ee8b5feee325267640c6337b9c8e76e", "runtime approval hash matches the current integration patch");
  const nativeBuildWorkflow = await readFile(path.join(repoRoot, ".github", "workflows", "native-isolated-cli.yml"), "utf8");
  ok(nativeBuildWorkflow.includes(`STABLE_GIT_COMMIT: ${NATIVE_RUNTIME_SOURCE_COMMIT}`), "Windows workflow pins the runtime-approved source commit");
  ok(nativeBuildWorkflow.includes(`EXPECTED_PATCH_SHA256: ${NATIVE_RUNTIME_PATCH_SHA256}`), "Windows workflow checks the runtime-approved patch digest");

  console.log(`PASS ${checks} native API lifecycle assertions`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function apiServiceState(apiDir) {
  return path.join(apiDir, "gateway", "gateway.json");
}
