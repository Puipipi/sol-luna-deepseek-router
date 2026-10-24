import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_TARGET, NATIVE_RUNTIME_VERSION } from "../scripts/native-runtime.mjs";
import { gatewayPaths, readGatewayIdentity } from "../scripts/native-gateway-manager.mjs";
import { stageGatewaySource } from "../scripts/native-gateway-source.mjs";
import { autostartFile, autostartScript } from "../scripts/native-autostart.mjs";
import * as installModule from "../scripts/native-isolated-install.mjs";
import * as oldTaskClient0103 from "./fixtures/native-gateway-task-0.10.3.mjs";
import { migrateActiveGatewaySource } from "../scripts/native-gateway-source-migrate.mjs";
const { activate, decodeJournal, encodeJournal, ensureNativeDeepseekDispatch, inspectNativeDeepseekDispatchState, prepare, rollback, status } = installModule;

let checks = 0;
const equal = (a, b, m) => { assert.equal(a, b, m); checks += 1; };
const ok = (v, m) => { assert.ok(v, m); checks += 1; };
const rejects = async (f, p, m) => { await assert.rejects(f, p, m); checks += 1; };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-isolated-install-test-")));

async function fixture(label) {
  const dir = path.join(root, label);
  const versionDir = path.join(dir, "runtime", "versions", "approved");
  const codexHome = path.join(dir, "codex-home");
  const gatewayDir = path.join(dir, "isolated-gateway");
  const startupDir = path.join(dir, "startup");
  const journalPath = path.join(dir, "journal", "install.json");
  await mkdir(versionDir, { recursive: true });
  await mkdir(path.join(codexHome, "agents"), { recursive: true });
  await mkdir(startupDir, { recursive: true });
  const files = {
    "codex.exe": Buffer.from("staged fixture bytes"),
    "provenance.json": Buffer.from(JSON.stringify({ source_commit: NATIVE_RUNTIME_SOURCE_COMMIT, patch_sha256: NATIVE_RUNTIME_PATCH_SHA256, target: NATIVE_RUNTIME_TARGET }) + "\n"),
    "codex-code-mode-host.exe": Buffer.from("host"),
    "codex-command-runner.exe": Buffer.from("runner"),
    "codex-windows-sandbox-setup.exe": Buffer.from("sandbox"),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(versionDir, name), bytes);
  await writeFile(path.join(versionDir, "runtime-manifest.json"), `${JSON.stringify({
    version: NATIVE_RUNTIME_VERSION, source_commit: NATIVE_RUNTIME_SOURCE_COMMIT,
    patch_sha256: NATIVE_RUNTIME_PATCH_SHA256, target: NATIVE_RUNTIME_TARGET,
    stock_cli_version: NATIVE_RUNTIME_VERSION, binary_sha256: sha(files["codex.exe"]),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
  }, null, 2)}\n`);
  await writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-current", visibility: "list", context_window: 1000 }] }));
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-current"\n');
  const environment = new Map([["CODEX_CLI_PATH", { present: false, value: null }], ["SOL_LUNA_NATIVE_PLAINTEXT_V2", { present: false, value: null }], ["SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: false, value: null }], ["PATH", { present: true, value: "keep" }]]);
  const envAdapter = {
    async get(key) { return structuredClone(environment.get(key) ?? { present: false, value: null }); },
    async set(key, value) { environment.set(key, structuredClone(value)); },
  };
  const startup = new Map([[autostartFile(startupDir), Buffer.from(autostartScript({ gatewayDir }), "utf8")]]);
  const autostartAdapter = {
    async get(file) { const bytes = startup.get(file); return bytes ? Buffer.from(bytes) : null; },
    async set(file, bytes) { if (bytes === null) startup.delete(file); else startup.set(file, Buffer.from(bytes)); },
  };
  const state = { pid: 12345 };
  const ensureCalls = [];
  const taskCalls = [];
  let taskState = { exists: false, owned: false, specMatches: false, enabled: false, state: "Missing", lastTaskResult: null };
  const taskAdapter = {
    async status(plan) { taskCalls.push(["status", plan.name]); return { ...taskState }; },
    async register(plan) { taskCalls.push(["register", plan.name]); taskState = { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready", lastTaskResult: 0 }; },
    async start(plan) { taskCalls.push(["start", plan.name]); if (!taskState.exists || !taskState.owned) throw new Error("missing owned task"); taskState.state = "Running"; return { started: true }; },
    async unregister(plan) { taskCalls.push(["unregister", plan.name]); if (!taskState.owned) throw new Error("missing owned task"); taskState = { exists: false, owned: false, specMatches: false, enabled: false, state: "Missing", lastTaskResult: null }; return { removed: true }; },
  };
  const ensureGateway = async ({ paths, launchImpl }) => {
    ensureCalls.push(paths);
    const identity = await readGatewayIdentity(paths);
    await launchImpl({ paths, identity });
    const launchedState = { pid: state.pid, port: identity.port, token: identity.token };
    await writeFile(paths.state, JSON.stringify(launchedState));
    return { state: launchedState, started: true };
  };
  const stopCalls = [];
  const stopGateway = async ({ paths }) => { const current = JSON.parse(await readFile(paths.state, "utf8").catch(() => "null")); stopCalls.push({ paths, pid: current?.pid ?? null }); await rm(paths.state, { force: true }); return { stopped: Boolean(current), pid: current?.pid ?? null }; };
  const smokeCheck = async ({ preparedHome, exePath, expectedMainModel, expectedMainProvider, expectedRootBaseUrl }) => {
    equal(exePath, path.join(versionDir, "codex.exe"), "smoke receives verified staged executable");
    equal(expectedMainModel, "gpt-current", "smoke receives explicitly selected main model");
    equal(expectedMainProvider, null, "smoke receives an explicit unset provider");
    equal(expectedRootBaseUrl, null, "smoke explicitly verifies the root URL remains unset");
    ok(await readFile(path.join(preparedHome, "agents/native_deepseek.toml"), "utf8"), "smoke fixture contains the generated role file");
    const fixtureConfig = await readFile(path.join(preparedHome, "config.toml"), "utf8");
    ok(fixtureConfig.includes(JSON.stringify(path.join(preparedHome, "models_cache.json"))), "smoke root catalog points at the temporary full model cache");
    return { status: "passed", checks: ["fixture" ] };
  };
  const gatewayScriptPath = fileURLToPath(new URL("../scripts/native-gateway.mjs", import.meta.url));
  const common = { versionDir, codexHome, gatewayDir, startupDir, journalPath, gatewayScriptPath, expectedMainModel: "gpt-current", expectedMainProvider: null, expectedRootBaseUrl: null, envAdapter, autostartAdapter, taskAdapter, ensureGateway, stopGateway, smokeCheck };
  const activateFixture = (options = {}, dependencies = {}) => activate({ journalPath, envAdapter, autostartAdapter, taskAdapter, ...options }, { ensureGateway, gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }), stopGateway, ...dependencies });
  const rollbackFixture = (options = {}, dependencies = {}) => rollback({ journalPath, envAdapter, autostartAdapter, taskAdapter, ...options }, {
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }), stopGateway,
    readGatewayIdentity, readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8").catch(() => "null")),
    isGatewayProcessAlive: async () => false,
    ...dependencies,
  });
  return { dir, versionDir, codexHome, gatewayDir, startupDir, journalPath, environment, envAdapter, startup, autostartAdapter, taskAdapter, state, ensureCalls, taskCalls, stopCalls, common, activateFixture, rollbackFixture };
}

async function activeMigrationFixture(label) {
  const value = await fixture(label);
  await prepare(value.common);
  await value.activateFixture();
  const pluginRoot = path.join(value.dir, "plugin-cache");
  await mkdir(path.join(pluginRoot, "scripts"), { recursive: true });
  for (const name of ["native-credentials.mjs", "native-gateway.mjs", "native-relay.mjs", "native-routing.mjs", "native-usage.mjs"]) {
    await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", name), path.join(pluginRoot, "scripts", name));
  }
  return { ...value, pluginRoot };
}

try {
  const roleUpgrade = await fixture("bounded-retry-role-upgrade");
  const upgradeConfigPath = path.join(roleUpgrade.codexHome, "config.toml");
  const upgradeConfigBytes = Buffer.from([
    'model = "gpt-current"',
    '# user-owned root configuration comment',
    "",
    "[features]",
    "multi_agent = true",
    "unbounded_connection_retries = true",
    "",
  ].join("\n"));
  const historicalRoleBytes = Buffer.from([
    'name = "native_deepseek"',
    'description = "DeepSeek Flash native collaboration child"',
    'model = "deepseek/deepseek-flash"',
    'model_reasoning_effort = "high"',
    'developer_instructions = """',
    "你是原生 DeepSeek 子代理。使用简体中文汇报进度与结果；遵守主任务明确的文件范围、权限和验证要求。只执行被分配的工作，不扩大范围；遇到缺少权限或信息时如实说明。",
    '"""',
    "",
  ].join("\n"));
  const upgradeRolePath = path.join(roleUpgrade.codexHome, "agents", "native_deepseek.toml");
  const roleLegacyManifestPath = path.join(roleUpgrade.dir, "legacy-role-manifest.json");
  await writeFile(upgradeConfigPath, upgradeConfigBytes);
  await writeFile(upgradeRolePath, historicalRoleBytes);
  await writeFile(roleLegacyManifestPath, JSON.stringify({ agent: upgradeRolePath }));
  let smokeRoleBytes;
  let smokeRootConfigBytes;
  await prepare({ ...roleUpgrade.common, legacyManifestPath: roleLegacyManifestPath }, {
    smokeCheck: async ({ preparedHome }) => {
      smokeRoleBytes = await readFile(path.join(preparedHome, "agents", "native_deepseek.toml"));
      smokeRootConfigBytes = await readFile(path.join(preparedHome, "config.toml"));
      return { status: "passed", checks: { role_config: true } };
    },
  });
  const smokeRole = smokeRoleBytes.toString("utf8");
  ok(smokeRole.includes("[features]\nunbounded_connection_retries = false"), "prepare smoke uses a role that disables unbounded connection retries");
  ok(smokeRootConfigBytes.toString("utf8").includes("unbounded_connection_retries = true"), "prepare smoke preserves the root retry feature");
  await roleUpgrade.activateFixture();
  const roleUpgradeActivatedConfig = await readFile(upgradeConfigPath, "utf8");
  const roleUpgradeActivatedRole = await readFile(upgradeRolePath, "utf8");
  ok(roleUpgradeActivatedRole.includes("[features]\nunbounded_connection_retries = false"), "activate writes the bounded retry feature to the dedicated role");
  ok(roleUpgradeActivatedConfig.includes("# user-owned root configuration comment"), "activate preserves user root config comments");
  ok(roleUpgradeActivatedConfig.includes("unbounded_connection_retries = true"), "activate preserves the root retry feature");
  await roleUpgrade.rollbackFixture();
  equal((await readFile(upgradeConfigPath)).equals(upgradeConfigBytes), true, "rollback restores the exact user config bytes");
  equal((await readFile(upgradeRolePath)).equals(historicalRoleBytes), true, "rollback restores the independent historical role bytes");

  const activeRoleUpgrade = await fixture("active-bounded-retry-role-upgrade");
  const activeConfigPath = path.join(activeRoleUpgrade.codexHome, "config.toml");
  const activeConfigPrior = Buffer.from('model = "gpt-current"\n[features]\nunbounded_connection_retries = true\n');
  const activeRolePath = path.join(activeRoleUpgrade.codexHome, "agents", "native_deepseek.toml");
  const activeLegacyManifestPath = path.join(activeRoleUpgrade.dir, "legacy-active-manifest.json");
  await writeFile(activeConfigPath, activeConfigPrior);
  await writeFile(activeRolePath, historicalRoleBytes);
  await writeFile(activeLegacyManifestPath, JSON.stringify({ agent: activeRolePath }));
  await prepare({ ...activeRoleUpgrade.common, legacyManifestPath: activeLegacyManifestPath });
  await activeRoleUpgrade.activateFixture();
  await writeFile(activeRolePath, historicalRoleBytes);
  const activeJournal = decodeJournal(await readFile(activeRoleUpgrade.journalPath, "utf8"));
  activeJournal.files.files["agents/native_deepseek.toml"].next = historicalRoleBytes.toString("utf8");
  await writeFile(activeRoleUpgrade.journalPath, encodeJournal(activeJournal));

  const upgradedRuntimeDir = path.join(activeRoleUpgrade.dir, "runtime", "versions", "approved-upgrade");
  await cp(activeRoleUpgrade.versionDir, upgradedRuntimeDir, { recursive: true });
  const upgradedJournalPath = path.join(activeRoleUpgrade.dir, "journal", "upgrade.json");
  const activeGatewayPaths = gatewayPaths(activeRoleUpgrade.gatewayDir);
  const activeStatePrior = await readFile(activeGatewayPaths.state);
  const activeIdentityPrior = await readFile(activeGatewayPaths.identity);
  const activeEnvironmentPrior = structuredClone([...activeRoleUpgrade.environment]);
  const activeConfigBeforePrepare = await readFile(activeConfigPath);
  const activeRoleBeforePrepare = await readFile(activeRolePath);
  const upgradedLegacyManifestPath = path.join(activeRoleUpgrade.dir, "legacy-upgrade-manifest.json");
  await writeFile(upgradedLegacyManifestPath, JSON.stringify({ agent: activeRolePath }));
  await prepare({
    ...activeRoleUpgrade.common,
    versionDir: upgradedRuntimeDir,
    journalPath: upgradedJournalPath,
    legacyManifestPath: upgradedLegacyManifestPath,
  }, {
    prepareGatewayIdentity: async ({ paths }) => readGatewayIdentity(paths),
    smokeCheck: async ({ preparedHome }) => {
      const preparedRole = await readFile(path.join(preparedHome, "agents", "native_deepseek.toml"), "utf8");
      const preparedConfig = await readFile(path.join(preparedHome, "config.toml"), "utf8");
      return {
        status: preparedRole.includes("unbounded_connection_retries = false")
          && preparedConfig.includes("unbounded_connection_retries = true") ? "passed" : "failed",
        checks: { role_config: true, root_config: true },
      };
    },
  });
  equal((await readFile(activeGatewayPaths.state)).equals(activeStatePrior), true, "upgrade prepare leaves the existing gateway PID state untouched");
  equal((await readFile(activeGatewayPaths.identity)).equals(activeIdentityPrior), true, "upgrade prepare reuses the existing gateway identity");
  equal(JSON.stringify([...activeRoleUpgrade.environment]), JSON.stringify(activeEnvironmentPrior), "upgrade prepare leaves managed environment values untouched");
  equal((await readFile(activeConfigPath)).equals(activeConfigBeforePrepare), true, "upgrade prepare leaves the active root config untouched");
  equal((await readFile(activeRolePath)).equals(activeRoleBeforePrepare), true, "upgrade prepare leaves the active historical role untouched");
  const activeTaskBeforePrepare = await activeRoleUpgrade.taskAdapter.status({ name: "fixture" });
  equal(activeTaskBeforePrepare.state, "Running", "upgrade prepare preserves the existing owned Task state");
  await activeRoleUpgrade.activateFixture({ journalPath: upgradedJournalPath }, {
    ensureGateway: async ({ paths }) => ({ state: JSON.parse(await readFile(paths.state, "utf8")), started: false }),
  });
  const upgradedRole = await readFile(activeRolePath, "utf8");
  ok(upgradedRole.includes("[features]\nunbounded_connection_retries = false"), "active upgrade installs the bounded retry role");
  ok((await readFile(activeGatewayPaths.state)).equals(activeStatePrior), "active upgrade retains the preexisting gateway PID");
  await activeRoleUpgrade.rollbackFixture({ journalPath: upgradedJournalPath });
  equal((await readFile(activeRolePath)).equals(historicalRoleBytes), true, "active upgrade rollback restores the historical role bytes");
  equal((await readFile(activeConfigPath)).equals(activeConfigBeforePrepare), true, "active upgrade rollback restores the previous root config");
  equal((await readFile(activeGatewayPaths.state)).equals(activeStatePrior), true, "active upgrade rollback retains the preexisting gateway PID");
  equal((await readFile(activeGatewayPaths.identity)).equals(activeIdentityPrior), true, "active upgrade rollback retains the prior gateway identity");
  equal(JSON.stringify([...activeRoleUpgrade.environment]), JSON.stringify(activeEnvironmentPrior), "active upgrade rollback restores the previous managed environment");
  equal((await activeRoleUpgrade.taskAdapter.status({ name: "fixture" })).state, "Running", "active upgrade rollback restores the previous owned Task state");

  const bytes = Buffer.from([0, 255, 1, 2, 128]);
  const encoded = encodeJournal({ sample: bytes, absent: null });
  const decoded = decodeJournal(encoded);
  equal(decoded.sample.toString("base64"), bytes.toString("base64"), "journal preserves arbitrary Buffer bytes through base64");
  equal(decoded.absent, null, "journal preserves absent snapshot values");

  const missingSmoke = await fixture("missing-smoke");
  let forbiddenEnsureCalls = 0;
  await rejects(() => prepare({ ...missingSmoke.common, smokeCheck: undefined }, { ensureGateway: async () => { forbiddenEnsureCalls += 1; } }), /smoke.*required/i, "prepare rejects when real smoke is not configured");
  equal(forbiddenEnsureCalls, 0, "missing smoke is rejected before starting any gateway");
  await rejects(() => prepare({ ...missingSmoke.common, gatewayScriptPath: "scripts/native-gateway.mjs" }), /must be absolute/i, "prepare rejects relative gateway script paths");
  if (process.platform === "win32") {
    const upperDefault = gatewayPaths().dir.toUpperCase();
    await rejects(() => prepare({ ...missingSmoke.common, gatewayDir: upperDefault, smokeCheck: () => ({ status: "passed" }) }), /separate from the legacy\/default gateway directory/i, "Windows case-only path alias cannot target the old gateway directory");
  }

  const durableSource = await fixture("durable-gateway-source");
  const pluginRoot = path.join(durableSource.dir, "plugin-cache");
  const nonstandardVersionDir = path.join(durableSource.dir, "custom-layout", "nested", "versions", "approved");
  await mkdir(path.join(pluginRoot, "scripts"), { recursive: true });
  await mkdir(path.dirname(nonstandardVersionDir), { recursive: true });
  await cp(durableSource.versionDir, nonstandardVersionDir, { recursive: true });
  const gatewayModules = ["native-credentials.mjs", "native-gateway.mjs", "native-relay.mjs", "native-routing.mjs", "native-usage.mjs"];
  for (const name of gatewayModules) await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", name), path.join(pluginRoot, "scripts", name));
  await prepare({
    ...durableSource.common,
    versionDir: nonstandardVersionDir,
    gatewayScriptPath: undefined,
    pluginRoot,
    smokeCheck: async ({ preparedHome, exePath, expectedMainModel, expectedMainProvider, expectedRootBaseUrl }) => {
      equal(exePath, path.join(nonstandardVersionDir, "codex.exe"), "nonstandard runtime layout is used for the verified smoke executable");
      equal(expectedMainModel, "gpt-current", "smoke receives explicitly selected main model");
      equal(expectedMainProvider, null, "smoke receives an explicit unset provider");
      equal(expectedRootBaseUrl, null, "smoke explicitly verifies the root URL remains unset");
      ok(await readFile(path.join(preparedHome, "agents/native_deepseek.toml"), "utf8"), "smoke fixture contains generated role file");
      const fixtureConfig = await readFile(path.join(preparedHome, "config.toml"), "utf8");
      ok(fixtureConfig.includes(JSON.stringify(path.join(preparedHome, "models_cache.json"))), "smoke root catalog points at temporary model cache");
      return { status: "passed", checks: ["fixture"] };
    },
  });
  const durableJournal = decodeJournal(await readFile(durableSource.journalPath, "utf8"));
  equal(durableJournal.gateway.sourceBundle.files.length, 5, "plugin-root prepare journals the fixed five-module source manifest");
  equal(durableJournal.paths.gatewaySourceRoot, path.dirname(durableSource.gatewayDir), "journal records the managed gateway source root");
  equal(durableJournal.paths.gatewayScript, path.join(durableSource.gatewayDir, "..", durableJournal.gateway.sourceBundle.relativeDirectory, "scripts", "native-gateway.mjs"), "Task script resolves inside the immutable bundle");
  const bundleDirectory = path.resolve(durableJournal.paths.gatewaySourceRoot, ...durableJournal.gateway.sourceBundle.relativeDirectory.split("/"));
  const bundleEntry = path.join(bundleDirectory, "scripts", "native-gateway.mjs");
  const originalBundleEntry = await readFile(bundleEntry);
  await rm(pluginRoot, { recursive: true });
  await import(`${pathToFileURL(bundleEntry).href}?integration=${Date.now()}`);
  equal(await readFile(bundleEntry).then((bytes) => bytes.equals(originalBundleEntry)), true, "real gateway entry imports with its relative modules after plugin cache removal");

  await writeFile(bundleEntry, "tampered\n");
  const taskCallsBeforeTamperedActivation = durableSource.taskCalls.length;
  await rejects(() => durableSource.activateFixture(), /gateway source module hash changed/i, "activate verifies the immutable bundle before side effects");
  equal(durableSource.taskCalls.length, taskCallsBeforeTamperedActivation, "tampered bundle is rejected before Task operations");
  await writeFile(bundleEntry, originalBundleEntry);
  await durableSource.activateFixture();
  const ensureBeforeTamperedDispatch = durableSource.ensureCalls.length;
  await writeFile(bundleEntry, "tampered again\n");
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: durableSource.journalPath, envAdapter: durableSource.envAdapter, taskAdapter: durableSource.taskAdapter }), /gateway source module hash changed/i, "dispatch verifies the bundle and does not migrate or stage it");
  equal(durableSource.ensureCalls.length, ensureBeforeTamperedDispatch, "tampered dispatch bundle is rejected before gateway checks");
  await writeFile(bundleEntry, originalBundleEntry);
  await durableSource.rollbackFixture();
  equal(await readFile(bundleEntry).then((bytes) => bytes.equals(originalBundleEntry)), true, "rollback leaves the completed immutable bundle intact");

  const f = await fixture("startup-failure");
  const prepared = await prepare(f.common);
  const explicitJournal = decodeJournal(await readFile(f.journalPath, "utf8"));
  equal(Object.hasOwn(explicitJournal.gateway, "sourceBundle"), false, "explicit gateway-script mode does not copy or claim a source bundle");
  equal(f.ensureCalls.length, 0, "prepare does not start a gateway process");
  const preparedText = JSON.stringify(prepared);
  equal(preparedText.includes(f.state.token), false, "prepare output does not expose gateway token");
  equal(preparedText.includes("model_provider"), false, "prepare output does not expose full config content");
  if (process.platform !== "win32") equal((await lstat(f.journalPath)).mode & 0o777, 0o600, "journal is created with private permissions");
  const before = await status({ journalPath: f.journalPath });
  equal(before.phase, "prepared", "status reports prepared before activation");
  equal(before.configured, false, "prepared journal is not reported configured");
  equal(before.runtimeObserved, false, "prepared journal makes no runtime observation");
  const callStart = f.taskCalls.length;
  const failingAutostart = { ...f.autostartAdapter, async set() { throw new Error("startup write failed"); } };
  await rejects(() => f.activateFixture({ autostartAdapter: failingAutostart }), /startup write failed/i, "startup failure is surfaced after owned task and gateway startup");
  equal(await readFile(path.join(f.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "startup failure rolls back files");
  equal(f.environment.get("CODEX_CLI_PATH").present, false, "startup failure rolls back environment");
  equal((await status({ journalPath: f.journalPath })).configured, false, "failed activation is not reported configured");
  const activationCalls = f.taskCalls.slice(callStart).map(([operation]) => operation);
  ok(activationCalls.indexOf("register") >= 0 && activationCalls.indexOf("start") > activationCalls.indexOf("register"), "activation registers the owned task before asking it to start the gateway");

  const envFailure = await fixture("environment-failure");
  await prepare(envFailure.common);
  const failingEnv = {
    ...envFailure.envAdapter,
    failedJournalSet: false,
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_INSTALL_JOURNAL" && !this.failedJournalSet) {
        this.failedJournalSet = true;
        await envFailure.envAdapter.set(key, value);
        throw new Error("journal environment setter failed after mutation");
      }
      return envFailure.envAdapter.set(key, value);
    },
  };
  await rejects(() => envFailure.activateFixture({ envAdapter: failingEnv }), /journal environment setter failed after mutation/i, "third-key environment failure is surfaced");
  equal(await readFile(path.join(envFailure.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "environment failure rolls back previously applied files");
  equal(envFailure.environment.get("CODEX_CLI_PATH").present, false, "environment failure restores the first environment key");
  equal(envFailure.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").present, false, "third-key environment failure restores journal path after mutation");

  const uncertainEnv = await fixture("environment-recovery-failure");
  await prepare(uncertainEnv.common);
  let setterCall = 0;
  const indeterminateEnv = {
    ...uncertainEnv.envAdapter,
    async set(key, value) {
      setterCall += 1;
      if (setterCall === 2) {
        await uncertainEnv.envAdapter.set(key, value);
        throw new Error("primary environment mutation failure");
      }
      if (setterCall === 3) throw new Error("environment restore failure");
      return uncertainEnv.envAdapter.set(key, value);
    },
  };
  await rejects(() => uncertainEnv.activateFixture({ envAdapter: indeterminateEnv }), (error) => {
    const messages = [];
    const collect = (item) => { messages.push(item?.message ?? String(item)); for (const nested of item?.errors ?? []) collect(nested); };
    collect(error);
    const details = messages.join(" | ");
    return /primary environment mutation failure/i.test(details) && /environment restore failure/i.test(details);
  }, "failed internal environment recovery is reported with both errors");
  const uncertainStatus = await status({ journalPath: uncertainEnv.journalPath });
  equal(uncertainStatus.phase, "activation_recovery_failed", "internal recovery failure is not mislabeled clean failure");
  equal(uncertainStatus.indeterminateStages.includes("environment"), true, "status names the stage whose state is uncertain");
  await rejects(() => uncertainEnv.rollbackFixture(), /indeterminate stages requiring manual recovery/i, "rollback refuses to guess at an indeterminate stage");

  const failedSmoke = await fixture("failed-smoke");
  await rejects(() => prepare({ ...failedSmoke.common, smokeCheck: async () => ({ status: "failed", checks: [] }) }), /status=passed/i, "failed smoke prevents a journal and activation");
  equal(failedSmoke.ensureCalls.length, 0, "failed prepare smoke never starts a gateway process");
  equal(await readFile(failedSmoke.journalPath).catch(() => null), null, "failed smoke leaves no install journal");

  const failedSmokeDetails = await fixture("failed-smoke-details");
  let smokeFailure;
  await assert.rejects(() => prepare({
    ...failedSmokeDetails.common,
    smokeCheck: async () => ({ status: "failed", stage: "model_list", failure: { stage: "model_list", code: -32602 }, checks: { app_server_closed: false } }),
  }, {
    removeSmokeFixture: async (fixtureHome, options) => {
      equal(options.maxRetries, 10, "smoke fixture removal has ten bounded retries");
      equal(options.retryDelay, 350, "smoke fixture removal uses the bounded retry delay");
      await rm(fixtureHome, { recursive: true, force: true });
    },
  }), (error) => {
    smokeFailure = error;
    return error.code === "ISOLATED_CONFIG_SMOKE_FAILED";
  }, "failed smoke preserves its structured safe diagnostic after successful cleanup");
  equal(smokeFailure.smoke.status, "failed", "failed smoke status is preserved");
  equal(smokeFailure.smoke.stage, "model_list", "failed smoke stage is preserved");
  equal(smokeFailure.smoke.failureStage, "model_list", "underlying smoke failure stage is preserved");
  equal(smokeFailure.smoke.failureCode, -32602, "underlying smoke failure code is preserved");
  equal(smokeFailure.smoke.appServerClosed, false, "critical app-server close check is preserved");
  equal(await readFile(failedSmokeDetails.journalPath).catch(() => null), null, "failed smoke with successful cleanup leaves no journal");

  const failedSmokeAndCleanup = await fixture("failed-smoke-cleanup-failure");
  let combinedSmokeFailure;
  await assert.rejects(() => prepare({
    ...failedSmokeAndCleanup.common,
    smokeCheck: async () => ({ status: "failed", stage: "config_read", failure: { stage: "config_read", code: "RPC_TIMEOUT" }, checks: { app_server_closed: false } }),
  }, {
    removeSmokeFixture: async () => { throw Object.assign(new Error("private capability must not leak"), { code: "EBUSY" }); },
  }), (error) => {
    combinedSmokeFailure = error;
    return error.code === "ISOLATED_CONFIG_PREPARE_FAILED";
  }, "smoke failure remains primary when temporary cleanup also fails");
  equal(combinedSmokeFailure.smoke.status, "failed", "cleanup failure retains smoke status");
  equal(combinedSmokeFailure.smoke.stage, "config_read", "cleanup failure retains smoke stage");
  equal(combinedSmokeFailure.smoke.failureCode, "RPC_TIMEOUT", "cleanup failure retains original smoke code");
  equal(combinedSmokeFailure.smoke.appServerClosed, false, "cleanup failure retains app-server close check");
  equal(combinedSmokeFailure.cleanupCode, "EBUSY", "cleanup error is reduced to its safe code");
  equal(combinedSmokeFailure.message.includes("private capability"), false, "cleanup diagnostic does not leak raw error text");
  equal(await readFile(failedSmokeAndCleanup.journalPath).catch(() => null), null, "smoke and cleanup failure leave no journal");
  equal(typeof installModule.formatInstallError, "function", "CLI catch exposes the same safe diagnostic formatter for testing");
  const formattedSmokeFailure = installModule.formatInstallError(combinedSmokeFailure);
  equal(formattedSmokeFailure.includes('"status":"failed"'), true, "CLI diagnostic includes smoke status");
  equal(formattedSmokeFailure.includes('"stage":"config_read"'), true, "CLI diagnostic includes smoke stage");
  equal(formattedSmokeFailure.includes('"failureCode":"RPC_TIMEOUT"'), true, "CLI diagnostic includes safe smoke failure code");
  equal(formattedSmokeFailure.includes('"appServerClosed":false'), true, "CLI diagnostic includes app-server close check");
  equal(formattedSmokeFailure.includes('"cleanupCode":"EBUSY"'), true, "CLI diagnostic includes safe cleanup code");
  equal(formattedSmokeFailure.includes("private capability"), false, "CLI diagnostic omits raw errors and secrets");
  const unsafeDiagnostic = installModule.formatInstallError(Object.assign(new Error("https://private.invalid/token SECRET"), {
    code: "ISOLATED_CONFIG_PREPARE_FAILED",
    primaryCode: "Bearer SECRET",
    cleanupCode: "https://private.invalid/token",
    smoke: { status: "failed", stage: "https://private.invalid/token", failureStage: "Authorization: SECRET", failureCode: "Bearer SECRET", appServerClosed: false },
  }));
  equal(unsafeDiagnostic.includes("private.invalid"), false, "CLI formatter omits URL values from diagnostic fields");
  equal(unsafeDiagnostic.includes("SECRET"), false, "CLI formatter omits token and header values from diagnostic fields");
  equal(unsafeDiagnostic.includes('"stage":"unknown"'), true, "CLI formatter constrains unknown stages to the fixed enum");
  equal(unsafeDiagnostic.includes('"failureCode":"UNKNOWN"'), true, "CLI formatter constrains unknown codes to safe values");
  equal(installModule.formatInstallError(new Error("legacy CLI error text")), "legacy CLI error text", "ordinary CLI errors retain their existing message output");

  const passedSmokeAndCleanup = await fixture("passed-smoke-cleanup-failure");
  let cleanupFailure;
  await assert.rejects(() => prepare({
    ...passedSmokeAndCleanup.common,
    smokeCheck: async () => ({ status: "passed", stage: "complete", checks: { app_server_closed: true } }),
  }, {
    removeSmokeFixture: async () => { throw Object.assign(new Error("private capability must not leak"), { code: "EBUSY" }); },
  }), (error) => {
    cleanupFailure = error;
    return error.code === "TEMP_SMOKE_CLEANUP_FAILED";
  }, "cleanup failure prevents prepare even when smoke passed");
  equal(cleanupFailure.cleanupCode, "EBUSY", "cleanup-only failure reports a safe error code");
  equal(cleanupFailure.smoke.status, "passed", "cleanup-only failure preserves successful smoke status");
  equal(cleanupFailure.smoke.stage, "complete", "cleanup-only failure preserves successful smoke stage");
  equal(cleanupFailure.smoke.appServerClosed, true, "cleanup-only failure preserves successful app-server close check");
  const formattedCleanupFailure = installModule.formatInstallError(cleanupFailure);
  equal(formattedCleanupFailure.includes('"status":"passed"'), true, "CLI diagnostic reports passed smoke before cleanup failure");
  equal(formattedCleanupFailure.includes('"appServerClosed":true'), true, "CLI diagnostic preserves successful close check");
  equal(cleanupFailure.message.includes("private capability"), false, "cleanup-only diagnostic does not leak raw error text");
  equal(await readFile(passedSmokeAndCleanup.journalPath).catch(() => null), null, "passed smoke with cleanup failure leaves no journal");

  if (process.platform === "win32") {
    const lockedFixture = await fixture("locked-smoke-cleanup");
    let lockChild;
    let lockChildExit;
    let lockedHome;
    try {
      const preparedWithLock = await prepare({
        ...lockedFixture.common,
        smokeCheck: async ({ preparedHome }) => {
          lockedHome = preparedHome;
          lockChild = spawn(process.execPath, [
            "-e",
            'process.chdir(process.argv[1]);process.stdout.write("ready\\n");setTimeout(()=>process.exit(0),1500)',
            preparedHome,
          ], { cwd: preparedHome, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
          lockChildExit = new Promise((resolve, reject) => {
            lockChild.once("error", reject);
            lockChild.once("exit", (code, signal) => resolve({ code, signal }));
          });
          await new Promise((resolve, reject) => {
            let output = "";
            lockChild.stdout.setEncoding("utf8");
            lockChild.stdout.on("data", (chunk) => {
              output += chunk;
              if (output.includes("ready\n")) resolve();
            });
            lockChild.once("error", reject);
            lockChild.once("exit", (code) => reject(new Error(`cwd lock child exited before ready (${code})`)));
          });
          return { status: "passed", stage: "complete", checks: { app_server_closed: true } };
        },
      });
      equal(preparedWithLock.phase, "prepared", "prepare waits for an owned Windows cwd lock to release before writing its journal");
      equal((await status({ journalPath: lockedFixture.journalPath })).phase, "prepared", "Windows cwd lock regression leaves a prepared journal");
      equal(await lstat(lockedHome).then(() => true, () => false), false, "Windows cwd lock fixture is removed after the child exits");
    } finally {
      if (lockChild) {
        const exit = await lockChildExit;
        equal(exit.code, 0, "owned Windows cwd lock child exits successfully");
      }
    }
  }

  const setupAndCleanupFailure = await fixture("setup-cleanup-failure");
  const setupFailureTaskAdapter = {
    ...setupAndCleanupFailure.taskAdapter,
    async status(plan) {
      const result = await setupAndCleanupFailure.taskAdapter.status(plan);
      await rm(path.join(setupAndCleanupFailure.codexHome, "models_cache.json"), { force: true });
      return result;
    },
  };
  let combinedSetupFailure;
  await assert.rejects(() => prepare({ ...setupAndCleanupFailure.common, taskAdapter: setupFailureTaskAdapter }, {
    removeSmokeFixture: async () => { throw Object.assign(new Error("private capability must not leak"), { code: "EBUSY" }); },
  }), (error) => {
    combinedSetupFailure = error;
    return error.code === "ISOLATED_CONFIG_PREPARE_FAILED";
  }, "cleanup failure retains an earlier setup error code");
  equal(combinedSetupFailure.primaryCode, "ENOENT", "cleanup failure retains safe pre-smoke error code");
  equal(combinedSetupFailure.cleanupCode, "EBUSY", "cleanup failure also retains cleanup code");
  equal(combinedSetupFailure.smoke, null, "pre-smoke failure does not fabricate smoke evidence");
  const formattedSetupFailure = installModule.formatInstallError(combinedSetupFailure);
  equal(formattedSetupFailure.includes('"primaryCode":"ENOENT"'), true, "CLI diagnostic includes safe pre-smoke code");
  equal(formattedSetupFailure.includes('"cleanupCode":"EBUSY"'), true, "CLI diagnostic includes cleanup code with pre-smoke error");
  equal(formattedSetupFailure.includes("private capability"), false, "CLI diagnostic omits raw pre-smoke and cleanup errors");
  equal(await readFile(setupAndCleanupFailure.journalPath).catch(() => null), null, "pre-smoke and cleanup failure leave no journal");

  const residualLegacy = await fixture("residual-legacy-without-marker");
  const residualConfigPath = path.join(residualLegacy.codexHome, "config.toml");
  const residualConfigBytes = Buffer.from('model = "gpt-current"\nmodel_provider = "openai"\n');
  await writeFile(residualConfigPath, residualConfigBytes);
  const residualAgent = path.join(residualLegacy.codexHome, "agents/native_deepseek.toml");
  const residualCatalog = path.join(residualLegacy.codexHome, "sol-luna-native-models.json");
  const residualAgentBytes = Buffer.from("legacy role bytes\n");
  const residualCatalogBytes = Buffer.from('{"legacy":true}\n');
  await writeFile(residualAgent, residualAgentBytes);
  await writeFile(residualCatalog, residualCatalogBytes);
  const residualManifestPath = path.join(residualLegacy.dir, "legacy-manifest.json");
  await writeFile(residualManifestPath, JSON.stringify({
    agent: residualAgent,
    catalog: residualCatalog,
    prior_root: { openai_base_url: null, model_catalog_json: null },
  }));
  await prepare({ ...residualLegacy.common, legacyManifestPath: residualManifestPath });
  const residualJournal = decodeJournal(await readFile(residualLegacy.journalPath, "utf8"));
  equal(residualJournal.files.legacyMigration, false, "residual old role/catalog without a config marker is not a config migration");
  await residualLegacy.activateFixture();
  const residualActiveConfig = await readFile(residualConfigPath, "utf8");
  equal(residualActiveConfig.includes('model = "gpt-current"'), true, "activation preserves the root main model");
  equal(/^openai_base_url\s*=/m.test(residualActiveConfig), false, "activation leaves no root base URL");
  equal(/^model_catalog_json\s*=/m.test(residualActiveConfig), false, "activation leaves no root catalog setting");
  await residualLegacy.rollbackFixture();
  equal((await readFile(residualConfigPath)).equals(residualConfigBytes), true, "rollback restores exact root config bytes");
  equal(residualLegacy.startup.size, 0, "successful rollback does not resurrect old managed Startup without a config marker");
  equal((await readFile(residualAgent)).equals(residualAgentBytes), true, "rollback restores manifest-owned legacy role bytes");
  equal((await readFile(residualCatalog)).equals(residualCatalogBytes), true, "rollback restores manifest-owned legacy catalog bytes");

  const noStartup = await fixture("no-prior-startup");
  noStartup.startup.clear();
  await prepare(noStartup.common);
  const noStartupJournal = decodeJournal(await readFile(noStartup.journalPath, "utf8"));
  equal(noStartupJournal.autostart.retiredLegacy, false, "absent Startup is not classified as a retired legacy file");
  await noStartup.activateFixture();
  await noStartup.rollbackFixture();
  equal(noStartup.startup.size, 0, "rollback does not create a Startup file when none existed");

  const unknownStartup = await fixture("unknown-prior-startup");
  const unknownStartupBytes = Buffer.from("user startup bytes\n");
  unknownStartup.startup.set(autostartFile(unknownStartup.startupDir), unknownStartupBytes);
  await rejects(() => prepare(unknownStartup.common), /unowned Startup VBS exists/i, "prepare refuses an unknown Startup file");
  equal(await readFile(unknownStartup.journalPath).catch(() => null), null, "unknown Startup refusal writes no journal");
  equal(unknownStartup.startup.get(autostartFile(unknownStartup.startupDir)).equals(unknownStartupBytes), true, "unknown Startup refusal preserves user bytes");

  const legacy = await fixture("legacy-migration");
  const legacyText = [
    '# sol-luna-native-gateway begin',
    'openai_base_url = "http://127.0.0.1:43127/secret/v1"',
    'model_catalog_json = "old-shared-catalog.json"',
    '# sol-luna-native-gateway end',
    'model = "gpt-current"',
    'model_provider = "openai"',
    '',
  ].join("\n");
  await writeFile(path.join(legacy.codexHome, "config.toml"), legacyText);
  const legacyManifestPath = path.join(legacy.dir, "legacy-manifest.json");
  await writeFile(legacyManifestPath, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  let smokeSawMigrated = false;
  await prepare({ ...legacy.common, legacyManifestPath }, { smokeCheck: async ({ preparedHome }) => {
    const text = await readFile(path.join(preparedHome, "config.toml"), "utf8");
    smokeSawMigrated = !text.includes("sol-luna-native-gateway begin") && text.includes('openai_base_url = "https://api.openai.com/v1"')
      && text.includes(JSON.stringify(path.join(preparedHome, "models_cache.json")));
    return { status: smokeSawMigrated ? "passed" : "failed" };
  } });
  equal(smokeSawMigrated, true, "legacy smoke fixture migrates prior root settings and uses a temporary local main catalog");

  const migratedRollback = await fixture("legacy-active-rollback");
  await writeFile(path.join(migratedRollback.codexHome, "config.toml"), legacyText);
  const migratedManifestPath = path.join(migratedRollback.dir, "legacy-manifest.json");
  await writeFile(migratedManifestPath, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  await prepare({ ...migratedRollback.common, legacyManifestPath: migratedManifestPath });
  const migratedJournalBeforeActivation = decodeJournal(await readFile(migratedRollback.journalPath, "utf8"));
  ok(migratedJournalBeforeActivation.files.files["config.toml"].uninstallPrior?.exists, "journal serializes the distinct migrated uninstall target");
  equal(migratedJournalBeforeActivation.files.files["config.toml"].prior.bytes.toString("utf8"), legacyText, "journal retains exact legacy bytes for activation-failure recovery");
  equal(decodeJournal(encodeJournal(migratedJournalBeforeActivation)).files.files["config.toml"].uninstallPrior.bytes.toString("utf8").includes("sol-luna-native-gateway begin"), false,
    "journal roundtrip preserves the clean uninstall target without the retired gateway block");
  const oldJournalPath = path.join(migratedRollback.dir, "journal", "old-format.json");
  const oldJournal = { ...migratedJournalBeforeActivation, files: { ...migratedJournalBeforeActivation.files, files: { ...migratedJournalBeforeActivation.files.files } } };
  oldJournal.files.files["config.toml"] = { ...oldJournal.files.files["config.toml"] };
  delete oldJournal.files.files["config.toml"].uninstallPrior;
  delete oldJournal.files.legacyMigration;
  await mkdir(path.dirname(oldJournalPath), { recursive: true });
  await writeFile(oldJournalPath, encodeJournal(oldJournal));
  await rejects(() => rollback({ journalPath: oldJournalPath, envAdapter: migratedRollback.envAdapter, autostartAdapter: migratedRollback.autostartAdapter, taskAdapter: migratedRollback.taskAdapter }),
    /legacy migration uninstall target is missing/i, "an old migration journal without a clean uninstall target is refused before mutation");
  equal(migratedRollback.startup.size, 1, "old migration journal refusal leaves the managed Startup snapshot unchanged");
  await migratedRollback.activateFixture();
  await migratedRollback.rollbackFixture();
  const migratedAfterRollback = await readFile(path.join(migratedRollback.codexHome, "config.toml"), "utf8");
  equal(migratedAfterRollback.includes("sol-luna-native-gateway begin"), false, "active migration rollback does not revive the retired localhost block");
  equal(migratedAfterRollback.includes('openai_base_url = "https://api.openai.com/v1"'), true, "active migration rollback restores the manifest prior root");
  equal(migratedRollback.startup.size, 0, "active migration rollback does not restore retired managed Startup VBS");

  const migratedActivationFailure = await fixture("legacy-activation-failure");
  await writeFile(path.join(migratedActivationFailure.codexHome, "config.toml"), legacyText);
  const failedMigrationManifest = path.join(migratedActivationFailure.dir, "legacy-manifest.json");
  await writeFile(failedMigrationManifest, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  await prepare({ ...migratedActivationFailure.common, legacyManifestPath: failedMigrationManifest });
  const failingMigrationEnv = {
    ...migratedActivationFailure.envAdapter,
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_PLAINTEXT_V2") throw new Error("migration activation environment failure");
      return migratedActivationFailure.envAdapter.set(key, value);
    },
  };
  await rejects(() => migratedActivationFailure.activateFixture({ envAdapter: failingMigrationEnv }), /migration activation environment failure/i,
    "migration activation failure is surfaced after files and Startup were changed");
  equal(await readFile(path.join(migratedActivationFailure.codexHome, "config.toml"), "utf8"), legacyText,
    "failed migration activation restores the exact legacy config because the old gateway remains available");
  equal(migratedActivationFailure.startup.size, 1, "failed migration activation restores the previous managed Startup VBS");

  const migratedLaterEdit = await fixture("legacy-later-edit");
  await writeFile(path.join(migratedLaterEdit.codexHome, "config.toml"), legacyText);
  const laterEditManifest = path.join(migratedLaterEdit.dir, "legacy-manifest.json");
  await writeFile(laterEditManifest, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  await prepare({ ...migratedLaterEdit.common, legacyManifestPath: laterEditManifest });
  await migratedLaterEdit.activateFixture();
  await writeFile(path.join(migratedLaterEdit.codexHome, "config.toml"), "later user edit\n");
  await rejects(() => migratedLaterEdit.rollbackFixture(), /file changed since activation/i, "migrated uninstall refuses to overwrite a later config edit");
  equal(migratedLaterEdit.environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2").value, "1", "migrated uninstall refusal preserves other active stages");

  const legacyUserLocalhost = await fixture("legacy-user-localhost-prior");
  await writeFile(path.join(legacyUserLocalhost.codexHome, "config.toml"), legacyText);
  const userLocalhostManifest = path.join(legacyUserLocalhost.dir, "legacy-manifest.json");
  const userLocalhostUrl = "http://127.0.0.1:59999/user-owned/v1";
  await writeFile(userLocalhostManifest, JSON.stringify({ prior_root: { openai_base_url: userLocalhostUrl, model_catalog_json: null } }));
  await prepare({ ...legacyUserLocalhost.common, legacyManifestPath: userLocalhostManifest });
  await legacyUserLocalhost.activateFixture();
  await legacyUserLocalhost.rollbackFixture();
  equal((await readFile(path.join(legacyUserLocalhost.codexHome, "config.toml"), "utf8")).includes(userLocalhostUrl), true,
    "active migration rollback preserves a user localhost URL already present in prior_root");

  const startFailure = await fixture("task-start-failure");
  await prepare(startFailure.common);
  await rejects(() => startFailure.activateFixture({}, {
    ensureGateway: async (request) => {
      await startFailure.common.ensureGateway(request);
      throw new Error("gateway health failure after task start");
    },
  }), /gateway health failure after task start/i, "Task Scheduler gateway failure is surfaced without fallback");
  equal(startFailure.stopCalls.length, 1, "failed activation stops only the matching gateway started in this transaction");
  equal(startFailure.taskCalls.some(([operation]) => operation === "unregister"), true, "failed activation unregisters only its newly owned task");
  equal((await status({ journalPath: startFailure.journalPath })).phase, "activation_failed", "successfully recovered task startup failure is recorded as clean activation failure");

  const taskReject = await fixture("task-reject");
  await prepare(taskReject.common);
  const rejectedTaskAdapter = { ...taskReject.taskAdapter, async start() { throw new Error("Task Scheduler rejected start"); } };
  await rejects(() => taskReject.activateFixture({ taskAdapter: rejectedTaskAdapter }), /Task Scheduler rejected start/i, "a definite Task Scheduler start rejection is surfaced");
  equal((await status({ journalPath: taskReject.journalPath })).phase, "activation_failed", "a rejected start with no process state is a cleanly recovered failure");
  equal(taskReject.taskCalls.some(([operation]) => operation === "unregister"), true, "a definite start rejection removes only the newly owned task");

  const uncertainStart = await fixture("uncertain-task-start");
  await prepare(uncertainStart.common);
  await rejects(() => uncertainStart.activateFixture({}, { gatewayHealth: async () => ({ reachable: false, pid: null }) }), (error) => {
    const messages = [];
    const collect = (item) => { messages.push(item?.message ?? String(item)); for (const nested of item?.errors ?? []) collect(nested); };
    collect(error);
    return messages.some((message) => /health PID could not be verified/i.test(message));
  }, "an unhealthy post-start gateway is surfaced");
  const uncertainStartStatus = await status({ journalPath: uncertainStart.journalPath });
  equal(uncertainStartStatus.phase, "activation_recovery_failed", "an accepted but unverified task start is not called a clean rollback");
  equal(uncertainStartStatus.indeterminateStages.includes("gateway"), true, "uncertain gateway startup is explicitly recorded");
  equal(uncertainStart.taskCalls.some(([operation]) => operation === "unregister"), false, "uncertain gateway startup retains its task for manual recovery");
  ok(await readFile(path.join(uncertainStart.gatewayDir, "gateway-task.vbs")).catch(() => null), "uncertain gateway startup retains its launcher");
  equal(await readFile(path.join(uncertainStart.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "uncertain gateway startup does not alter the user's config files");
  equal(uncertainStart.startup.size, 1, "uncertain gateway startup preserves the previous Startup entry");

  const nonStrictActivation = await fixture("non-strict-activation");
  await prepare(nonStrictActivation.common);
  await rejects(() => nonStrictActivation.activateFixture({}, {
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: false, relay_allowed: true }),
  }), /does not enforce DeepSeek-only routing/i, "activation refuses a healthy gateway that permits GPT relay");
  equal((await status({ journalPath: nonStrictActivation.journalPath })).phase, "activation_failed", "a mismatched strict health response is recorded as failed activation");

  const readyActivation = await fixture("ready-task-activation");
  await prepare(readyActivation.common);
  const readyAdapter = {
    ...readyActivation.taskAdapter,
    async status(plan) { const result = await readyActivation.taskAdapter.status(plan); return { ...result, state: "Ready" }; },
  };
  await rejects(() => readyActivation.activateFixture({ taskAdapter: readyAdapter }), /Task Scheduler gateway task is not Running/i,
    "activation refuses a healthy gateway while the owned Task is only Ready");

  const success = await fixture("success");
  const preparedSuccess = await prepare(success.common);
  const preparedJournal = decodeJournal(await readFile(success.journalPath, "utf8"));
  equal(preparedJournal.environment.next.SOL_LUNA_NATIVE_INSTALL_JOURNAL?.value, path.resolve(success.journalPath), "prepare plans the exact resolved journal path");
  const activated = await success.activateFixture();
  equal(activated.phase, "active", "activation reports completion only after all stages");
  equal(activated.restartNeeded, true, "configuration requires a desktop restart before runtime use can be observed");
  equal(activated.desktopAccepted, false, "configuration does not claim desktop acceptance");
  equal(success.environment.get("PATH").value, "keep", "activation preserves unrelated environment values");
  equal(success.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").value, path.resolve(success.journalPath), "activation publishes journal path for future chats");
  equal(success.startup.size, 0, "activation removes the older managed Startup VBS after gateway health");
  const taskCallsBeforeReadOnlyInspection = success.taskCalls.length;
  const ensureCallsBeforeReadOnlyInspection = success.ensureCalls.length;
  const inspected = await inspectNativeDeepseekDispatchState({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter, requireRunning: true }, {
    readGatewayIdentity,
    readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
  });
  equal(inspected.ready, true, "read-only readiness verifier accepts an active, strict, healthy, Running Task");
  equal(success.ensureCalls.length, ensureCallsBeforeReadOnlyInspection, "read-only readiness verifier never ensures or starts the gateway");
  equal(success.taskCalls.slice(taskCallsBeforeReadOnlyInspection).some(([operation]) => ["register", "start", "unregister"].includes(operation)), false, "read-only readiness verifier never mutates the Task");

  const migration = await fixture("gateway-source-migration");
  await prepare(migration.common);
  await migration.activateFixture();
  const migrationPluginRoot = path.join(migration.dir, "plugin-cache");
  await mkdir(path.join(migrationPluginRoot, "scripts"), { recursive: true });
  for (const name of ["native-credentials.mjs", "native-gateway.mjs", "native-relay.mjs", "native-routing.mjs", "native-usage.mjs"]) {
    await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", name), path.join(migrationPluginRoot, "scripts", name));
  }
  const migrationJournalBefore = decodeJournal(await readFile(migration.journalPath, "utf8"));
  for (const [key, expected] of Object.entries(migrationJournalBefore.environment.next)) {
    const current = migration.environment.get(key);
    equal(current?.present === expected?.present && (!current?.present || current.value === expected.value), true, `migration fixture begins with the active ${key} snapshot`);
  }
  const oldScript = migrationJournalBefore.paths.gatewayScript;
  const oldLauncherBytes = await readFile(migrationJournalBefore.gateway.launcher.path);
  const migrationTaskCalls = migration.taskCalls.length;
  const migrationEnsureCalls = migration.ensureCalls.length;
  let migrationReadinessCalls = 0;
  const migrated = await migrateActiveGatewaySource({ journalPath: migration.journalPath, pluginRoot: migrationPluginRoot, envAdapter: migration.envAdapter, taskAdapter: migration.taskAdapter }, {
    readinessVerifier: async (...args) => { migrationReadinessCalls += 1; return inspectNativeDeepseekDispatchState(...args); },
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
  });
  const migrationJournalAfter = decodeJournal(await readFile(migration.journalPath, "utf8"));
  equal(migrated.status, "migrated", "active gateway migration reports a completed next-launch rebind");
  equal(migrationReadinessCalls, 3, "migration performs a final strict Running/health verification after writing both files");
  equal(migrationJournalAfter.phase, "active", "migration returns the journal to active after launcher and journal updates");
  equal(encodeJournal(migrationJournalAfter.files), encodeJournal(migrationJournalBefore.files), "migration preserves every file prior/next snapshot including Buffer bytes");
  equal(encodeJournal(migrationJournalAfter.environment), encodeJournal(migrationJournalBefore.environment), "migration preserves the original environment plan");
  equal(encodeJournal(migrationJournalAfter.environmentSnapshot), encodeJournal(migrationJournalBefore.environmentSnapshot), "migration preserves the applied environment rollback snapshot");
  equal(encodeJournal(migrationJournalAfter.autostart), encodeJournal(migrationJournalBefore.autostart), "migration preserves the autostart rollback snapshot");
  equal(encodeJournal(migrationJournalAfter.completed), encodeJournal(migrationJournalBefore.completed), "migration preserves all completed-stage bits");
  equal(encodeJournal(migrationJournalAfter.gateway.launcher.prior), encodeJournal(migrationJournalBefore.gateway.launcher.prior), "migration preserves launcher prior bytes exactly");
  equal(migrationJournalAfter.paths.gatewayScript === oldScript, false, "migration points future Task launch at the durable source bundle");
  equal(migrationJournalAfter.gateway.sourceBundle.files.length, 5, "migration journals the verified five-file bundle");
  equal(migrationJournalAfter.gateway.taskPlan.action.execute, migrationJournalBefore.gateway.taskPlan.action.execute, "migration leaves the Task action executable unchanged");
  equal(migrationJournalAfter.gateway.taskPlan.action.arguments, migrationJournalBefore.gateway.taskPlan.action.arguments, "migration leaves the Task action arguments unchanged");
  equal(migrationJournalAfter.gateway.taskPlan.name, migrationJournalBefore.gateway.taskPlan.name, "migration leaves the Task name unchanged");
  equal(migrationJournalAfter.gateway.taskPlan.marker, migrationJournalBefore.gateway.taskPlan.marker, "migration leaves Task ownership marker unchanged");
  equal(migrationJournalAfter.gateway.taskPlan.directory, migrationJournalBefore.gateway.taskPlan.directory, "migration leaves Task working directory unchanged");
  equal(JSON.stringify(migrationJournalAfter.gateway.taskPlan.restartPolicy), JSON.stringify(migrationJournalBefore.gateway.taskPlan.restartPolicy), "migration leaves Task restart policy unchanged");
  equal(migrationJournalAfter.gateway.taskSnapshot.priorExists, migrationJournalBefore.gateway.taskSnapshot.priorExists, "migration preserves the Task snapshot priorExists bit");
  equal(migrationJournalAfter.gateway.taskSnapshot.priorOwned, migrationJournalBefore.gateway.taskSnapshot.priorOwned, "migration preserves the Task snapshot priorOwned bit");
  equal((await readFile(migrationJournalAfter.gateway.launcher.path)).equals(oldLauncherBytes), false, "migration replaces only the future-launch script path in the launcher");
  const migrationBackupPath = migrationJournalAfter.gateway.sourceMigration.backupPath;
  const migrationBackupBytes = await readFile(migrationBackupPath);
  equal(sha(migrationBackupBytes), migrationJournalAfter.gateway.sourceMigration.backupSha256, "migration keeps an exact private raw-journal backup and digest");
  equal(migrationBackupBytes.equals(Buffer.from(encodeJournal(migrationJournalBefore))), true, "migration backup contains the original version 1 journal bytes");
  equal(migration.taskCalls.slice(migrationTaskCalls).some(([operation]) => ["register", "start", "unregister"].includes(operation)), false, "migration does not register, start, or unregister the Task");
  equal(migration.ensureCalls.length, migrationEnsureCalls, "migration never ensures or starts the gateway process");
  equal(migration.stopCalls.length, 0, "migration never stops the existing gateway process");
  const migratedBytesBeforeRepeat = await readFile(migration.journalPath);
  const migratedLauncherBeforeRepeat = await readFile(migrationJournalAfter.gateway.launcher.path);
  const idempotentMigration = await migrateActiveGatewaySource({ journalPath: migration.journalPath, envAdapter: migration.envAdapter, taskAdapter: migration.taskAdapter }, {
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
  });
  equal(idempotentMigration.status, "already_migrated", "repeat migration verifies and reuses the active bundle without plugin cache access");
  equal((await readFile(migration.journalPath)).equals(migratedBytesBeforeRepeat), true, "idempotent migration leaves journal bytes unchanged");
  equal((await readFile(migrationJournalAfter.gateway.launcher.path)).equals(migratedLauncherBeforeRepeat), true, "idempotent migration leaves launcher bytes unchanged");
  // Immutable task-helper fixture from release 0.10.3, commit aab89090305c7ec21cc27107c0a51d615ed49361.
  // Git blob: a835e514e385cedf47b5dc8fb909b254cfb20b02; raw SHA-256: a7067c8bf5baa496ece83b253a97e710683c89e7176e870c0e576ca448768d09.
  const oldTaskFixtureBytes = await readFile(fileURLToPath(new URL("./fixtures/native-gateway-task-0.10.3.mjs", import.meta.url)));
  equal(sha(oldTaskFixtureBytes), "a7067c8bf5baa496ece83b253a97e710683c89e7176e870c0e576ca448768d09", "the pinned 0.10.3 task module fixture matches its published raw hash");
  let oldClientMutations = 0;
  const oldClientRestore = await oldTaskClient0103.restoreGatewayTask(migrationJournalAfter.gateway.taskSnapshot, migrationJournalAfter.gateway.taskPlan, {
    async status() { return { exists: false, owned: false, specMatches: false, enabled: false }; },
    async unregister() { oldClientMutations += 1; return { removed: true }; },
  });
  equal(oldClientRestore.restored, true, "pre-migration task client validates and reads the rebased version 1 snapshot");
  equal(oldClientRestore.removed, false, "old-client restore leaves an absent prior task absent");
  equal(oldClientMutations, 0, "old-client compatibility check does not mutate a Task");
  const priorOwnedPlan = await oldTaskClient0103.snapshotGatewayTask(migrationJournalAfter.gateway.taskPlan, {
    async status() { return { exists: true, owned: true, specMatches: true, enabled: true }; },
  });
  equal(priorOwnedPlan.priorExists, true, "0.10.3 snapshot helper still reads a previously owned Task");
  equal(priorOwnedPlan.priorOwned, true, "0.10.3 snapshot helper preserves prior ownership semantics");
  const priorOwnedRestore = await oldTaskClient0103.restoreGatewayTask(priorOwnedPlan, migrationJournalAfter.gateway.taskPlan, {
    async status() { return { exists: true, owned: true, specMatches: true, enabled: true }; },
    async unregister() { oldClientMutations += 1; return { removed: true }; },
  });
  equal(priorOwnedRestore.preserved, true, "0.10.3 restore preserves a previously owned matching Task");
  equal(oldClientMutations, 0, "prior-owned compatibility check does not mutate a Task");
  const migrationConfigPrior = Object.values(migrationJournalBefore.files.files).find((item) => path.basename(item.path).toLowerCase() === "config.toml").prior.bytes;
  const migrationEnvironmentPrior = migrationJournalBefore.environmentSnapshot.prior;
  const migrationRollback = await migration.rollbackFixture();
  equal(migrationRollback.phase, "rolled_back", "normal installer rollback succeeds after gateway-source migration");
  equal((await readFile(path.join(migration.codexHome, "config.toml"))).equals(migrationConfigPrior), true, "rollback restores exact original config bytes after migration");
  for (const [key, expected] of Object.entries(migrationEnvironmentPrior)) {
    equal(JSON.stringify(migration.environment.get(key)), JSON.stringify(expected), `rollback restores the exact pre-activation ${key} state after migration`);
  }

  const stageFailure = await fixture("migration-stage-failure");
  await prepare(stageFailure.common);
  await stageFailure.activateFixture();
  const stageFailureJournal = await readFile(stageFailure.journalPath);
  const stageFailureState = decodeJournal(stageFailureJournal.toString("utf8"));
  const stageFailureLauncher = await readFile(stageFailureState.gateway.launcher.path);
  const stageFailurePluginRoot = path.join(stageFailure.dir, "plugin-cache");
  await mkdir(path.join(stageFailurePluginRoot, "scripts"), { recursive: true });
  for (const name of ["native-credentials.mjs", "native-gateway.mjs", "native-relay.mjs", "native-routing.mjs", "native-usage.mjs"]) {
    await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", name), path.join(stageFailurePluginRoot, "scripts", name));
  }
  await rejects(() => migrateActiveGatewaySource({ journalPath: stageFailure.journalPath, pluginRoot: stageFailurePluginRoot, envAdapter: stageFailure.envAdapter, taskAdapter: stageFailure.taskAdapter }, {
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
    stageSource: async () => { throw new Error("controlled source stage failure"); },
  }), /controlled source stage failure/, "stage failure retains its original diagnostic without touching active files");
  equal((await readFile(stageFailure.journalPath)).equals(stageFailureJournal), true, "stage failure leaves the active journal byte-for-byte unchanged");
  equal((await readFile(stageFailureState.gateway.launcher.path)).equals(stageFailureLauncher), true, "stage failure leaves the future-launch launcher byte-for-byte unchanged");

  const sourceDrift = await activeMigrationFixture("migration-source-drift");
  await writeFile(path.join(sourceDrift.pluginRoot, "scripts", "native-usage.mjs"), "changed source\n");
  const sourceDriftJournal = await readFile(sourceDrift.journalPath);
  const sourceDriftState = decodeJournal(sourceDriftJournal.toString("utf8"));
  const sourceDriftLauncher = await readFile(sourceDriftState.gateway.launcher.path);
  await rejects(() => migrateActiveGatewaySource({ journalPath: sourceDrift.journalPath, pluginRoot: sourceDrift.pluginRoot, envAdapter: sourceDrift.envAdapter, taskAdapter: sourceDrift.taskAdapter }, {
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
  }), /differs from the active source/, "migration rejects plugin source bytes that differ from the currently active five-module closure");
  equal((await readFile(sourceDrift.journalPath)).equals(sourceDriftJournal), true, "source drift leaves the active journal untouched");
  equal((await readFile(sourceDriftState.gateway.launcher.path)).equals(sourceDriftLauncher), true, "source drift leaves the launcher untouched");

  const stagedSourceDrift = await activeMigrationFixture("migration-staged-source-drift");
  const stagedSourceDriftJournal = decodeJournal(await readFile(stagedSourceDrift.journalPath, "utf8"));
  const stagedSourceDriftLauncher = await readFile(stagedSourceDriftJournal.gateway.launcher.path);
  const alternatePluginRoot = path.join(stagedSourceDrift.dir, "alternate-plugin-cache");
  await mkdir(path.join(alternatePluginRoot, "scripts"), { recursive: true });
  for (const name of ["native-credentials.mjs", "native-gateway.mjs", "native-relay.mjs", "native-routing.mjs", "native-usage.mjs"]) {
    await cp(path.join(stagedSourceDrift.pluginRoot, "scripts", name), path.join(alternatePluginRoot, "scripts", name));
  }
  await writeFile(path.join(alternatePluginRoot, "scripts", "native-usage.mjs"), "different but self-consistent staged source\n");
  await rejects(() => migrateActiveGatewaySource({ journalPath: stagedSourceDrift.journalPath, pluginRoot: stagedSourceDrift.pluginRoot, envAdapter: stagedSourceDrift.envAdapter, taskAdapter: stagedSourceDrift.taskAdapter }, {
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
    stageSource: (options) => stageGatewaySource({ pluginRoot: alternatePluginRoot, runtimeRoot: options.runtimeRoot }),
  }), /staged gateway source differs from the active source/, "migration rejects a valid self-consistent bundle whose bytes differ from active source");
  equal(decodeJournal((await readFile(stagedSourceDrift.journalPath, "utf8")).toString("utf8")).phase, "active", "staged source drift leaves the original journal active");
  equal((await readFile(stagedSourceDriftJournal.gateway.launcher.path)).equals(stagedSourceDriftLauncher), true, "staged source drift leaves the original launcher unchanged");

  const notRunningMigration = await activeMigrationFixture("migration-task-not-running");
  const notRunningJournal = await readFile(notRunningMigration.journalPath);
  const notRunningTaskAdapter = {
    ...notRunningMigration.taskAdapter,
    async status(plan) { return { ...(await notRunningMigration.taskAdapter.status(plan)), state: "Ready" }; },
  };
  await rejects(() => migrateActiveGatewaySource({ journalPath: notRunningMigration.journalPath, pluginRoot: notRunningMigration.pluginRoot, envAdapter: notRunningMigration.envAdapter, taskAdapter: notRunningTaskAdapter }, {
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
  }), /Task Scheduler task is not Running/i, "migration requires an already Running owned Task and never starts it");
  equal((await readFile(notRunningMigration.journalPath)).equals(notRunningJournal), true, "non-running Task preflight leaves the active journal untouched");

  const lockedMigration = await activeMigrationFixture("migration-lock-conflict");
  const migrationLockPath = `${lockedMigration.journalPath}.gateway-source-migration.lock`;
  const preexistingLockBytes = Buffer.from("unowned lock fixture\n");
  await writeFile(migrationLockPath, preexistingLockBytes, { flag: "wx" });
  const lockedJournalBefore = await readFile(lockedMigration.journalPath);
  await rejects(() => migrateActiveGatewaySource({ journalPath: lockedMigration.journalPath, pluginRoot: lockedMigration.pluginRoot, envAdapter: lockedMigration.envAdapter, taskAdapter: lockedMigration.taskAdapter }, {
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
  }), /EEXIST/, "migration refuses a pre-existing independently-owned lock");
  equal((await readFile(migrationLockPath)).equals(preexistingLockBytes), true, "migration never removes an unowned lock file");
  equal((await readFile(lockedMigration.journalPath)).equals(lockedJournalBefore), true, "lock conflict leaves the active journal untouched");

  for (const failAt of [1, 2, 3]) {
    const failedWrite = await activeMigrationFixture(`migration-write-failure-${failAt}`);
    const journalBeforeFailure = await readFile(failedWrite.journalPath);
    const stateBeforeFailure = decodeJournal(journalBeforeFailure.toString("utf8"));
    const launcherBeforeFailure = await readFile(stateBeforeFailure.gateway.launcher.path);
    let writes = 0;
    await rejects(() => migrateActiveGatewaySource({ journalPath: failedWrite.journalPath, pluginRoot: failedWrite.pluginRoot, envAdapter: failedWrite.envAdapter, taskAdapter: failedWrite.taskAdapter }, {
      gatewayAdapter: {
        readGatewayIdentity,
        readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
        gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
      },
      atomicWrite: async (file, bytes) => {
        writes += 1;
        if (writes === failAt) throw Object.assign(new Error("injected atomic write failure"), { code: "INJECTED_WRITE_FAILURE" });
        await writeFile(file, bytes);
      },
    }), /injected atomic write failure/, `write failure ${failAt} preserves its originating error`);
    equal((await readFile(failedWrite.journalPath)).equals(journalBeforeFailure), true, `write failure ${failAt} restores the original journal bytes`);
    equal((await readFile(stateBeforeFailure.gateway.launcher.path)).equals(launcherBeforeFailure), true, `write failure ${failAt} restores the original launcher bytes`);
    equal(writes, failAt * 2 - 1, `write failure ${failAt} performs only the necessary owned rollback writes`);
  }

  const postwriteFailure = await activeMigrationFixture("migration-postwrite-verification-failure");
  const postwriteJournalBefore = await readFile(postwriteFailure.journalPath);
  const postwriteStateBefore = decodeJournal(postwriteJournalBefore.toString("utf8"));
  const postwriteLauncherBefore = await readFile(postwriteStateBefore.gateway.launcher.path);
  let postwriteReadinessChecks = 0;
  await rejects(() => migrateActiveGatewaySource({ journalPath: postwriteFailure.journalPath, pluginRoot: postwriteFailure.pluginRoot, envAdapter: postwriteFailure.envAdapter, taskAdapter: postwriteFailure.taskAdapter }, {
    readinessVerifier: async (...args) => {
      postwriteReadinessChecks += 1;
      if (postwriteReadinessChecks === 3) throw new Error("postwrite readiness verification failed");
      return inspectNativeDeepseekDispatchState(...args);
    },
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
  }), /postwrite readiness verification failed/, "failed final readiness verification does not report migration success");
  equal(postwriteReadinessChecks, 3, "postwrite failure is observed only after the final file writes");
  equal((await readFile(postwriteFailure.journalPath)).equals(postwriteJournalBefore), true, "postwrite failure restores the original journal snapshot");
  equal((await readFile(postwriteStateBefore.gateway.launcher.path)).equals(postwriteLauncherBefore), true, "postwrite failure restores the original future-launch launcher");

  const thirdPartyDuringWrite = await activeMigrationFixture("migration-third-party-drift");
  const thirdPartyJournal = await readFile(thirdPartyDuringWrite.journalPath);
  const thirdPartyState = decodeJournal(thirdPartyJournal.toString("utf8"));
  const thirdPartyBytes = Buffer.from("third-party launcher update\n");
  let thirdPartyWrites = 0;
  await rejects(() => migrateActiveGatewaySource({ journalPath: thirdPartyDuringWrite.journalPath, pluginRoot: thirdPartyDuringWrite.pluginRoot, envAdapter: thirdPartyDuringWrite.envAdapter, taskAdapter: thirdPartyDuringWrite.taskAdapter }, {
    gatewayAdapter: {
      readGatewayIdentity,
      readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
      gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
    },
    atomicWrite: async (file, bytes) => {
      thirdPartyWrites += 1;
      if (thirdPartyWrites === 2) {
        await writeFile(file, thirdPartyBytes);
        throw Object.assign(new Error("third-party launcher appeared during migration"), { code: "INJECTED_THIRD_PARTY_DRIFT" });
      }
      await writeFile(file, bytes);
    },
  }), /requires recovery/, "migration refuses to overwrite third-party launcher bytes after a partial write");
  equal((await readFile(thirdPartyState.gateway.launcher.path)).equals(thirdPartyBytes), true, "third-party launcher bytes survive a partial-migration recovery");
  equal(decodeJournal((await readFile(thirdPartyDuringWrite.journalPath)).toString("utf8")).phase, "gateway_source_migration_recovery_failed", "partial migration is left fail-closed when third-party launcher bytes prevent safe restoration");
  const configPath = path.join(success.codexHome, "config.toml");
  const activatedConfig = await readFile(configPath);
  const changedMainConfig = activatedConfig.toString("utf8").replace('model = "gpt-current"', 'model = "new-sol-model"');
  await writeFile(configPath, changedMainConfig);
  const foreignSkills = [
    "[[skills.config]]",
    'path = "fixture-skill-one"',
    "enabled = true",
    "",
    "[[skills.config]]",
    'path = "fixture-skill-two"',
    "enabled = false",
  ].join("\n");
  const configWithForeignSkills = changedMainConfig.toString("utf8").replace(
    "# sol-luna-native-isolated end",
    `${foreignSkills}\n# sol-luna-native-isolated end`,
  );
  await writeFile(configPath, configWithForeignSkills);
  const dispatch = await ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: success.common.ensureGateway,
    readGatewayIdentity,
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
  });
  equal(dispatch.ready, true, "DeepSeek dispatch gate accepts foreign skill array tables in the owned marker");
  equal((await readFile(configPath, "utf8")).includes(foreignSkills), true, "dispatch preserves foreign skill array table bytes");
  equal((await readFile(configPath, "utf8")).includes('model = "new-sol-model"'), true, "dispatch permits a later user-selected main model without freezing the parent catalog");
  success.environment.set("SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: true, value: "later-user-journal.json" });
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {}), /environment changed.*SOL_LUNA_NATIVE_INSTALL_JOURNAL/i, "dispatch rejects journal environment drift");
  success.environment.set("SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: true, value: path.resolve(success.journalPath) });
  const stopsBeforeNonStrict = success.stopCalls.length;
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: async () => ({ state: { ...success.state, port: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).port, token: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).token }, started: false }),
    readGatewayIdentity,
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: false, relay_allowed: true }),
  }), /does not enforce DeepSeek-only routing/i, "a healthy legacy/direct gateway is refused for native dispatch");
  equal(success.stopCalls.length, stopsBeforeNonStrict, "dispatch refuses a non-strict gateway without stopping its PID");
  const readyTaskAdapter = { ...success.taskAdapter, async status() { return { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready" }; } };
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: readyTaskAdapter }, {
    ensureGateway: async () => ({ state: { ...success.state, port: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).port, token: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).token }, started: false }),
    readGatewayIdentity,
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
  }), /Task Scheduler task is not Running/i, "a Ready task with an external healthy server is refused");
  const editedProviderConfig = changedMainConfig.replace('wire_api = "responses"', 'wire_api = "chat_completions"');
  await writeFile(configPath, editedProviderConfig);
  const ensureBeforeMissingTask = success.ensureCalls.length;
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: success.common.ensureGateway, readGatewayIdentity, gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
  }), /provider or role block changed/i, "dispatch rejects edits to the isolated provider wiring");
  equal(success.ensureCalls.length, ensureBeforeMissingTask, "edited provider wiring is rejected before task launch");
  await writeFile(configPath, activatedConfig);
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: { ...success.taskAdapter, async status() { return { exists: false, owned: false, specMatches: false, enabled: false }; } } }, {
    ensureGateway: success.common.ensureGateway, readGatewayIdentity, gatewayHealth: async () => ({ reachable: true, deepseek_only: true, relay_allowed: false }),
  }), /task is missing, changed, or disabled/i, "dispatch gate fails closed without registering or falling back when task is missing");
  equal(success.ensureCalls.length, ensureBeforeMissingTask, "missing task is rejected before any direct gateway launch or health request");
  await writeFile(configPath, activatedConfig.toString("utf8").replace(
    "# sol-luna-native-isolated end",
    `${foreignSkills}\n# sol-luna-native-isolated end`,
  ));
  const foreignRollback = await success.rollbackFixture();
  equal(foreignRollback.phase, "rolled_back", "rollback removes the owned isolated tables after a foreign skill-table addition");
  const rolledBackConfig = await readFile(configPath, "utf8");
  equal(rolledBackConfig.includes(foreignSkills), true, "rollback preserves foreign skill array tables");
  equal(rolledBackConfig.includes('model = "gpt-current"'), true, "rollback restores the original root model alongside foreign tables");
  equal(rolledBackConfig.includes("sol-luna-native-isolated begin"), false, "rollback removes the isolated marker");
  equal(success.environment.get("CODEX_CLI_PATH").present, false, "rollback restores original environment state");
  equal(success.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").present, false, "rollback restores original journal environment state");
  equal(success.startup.size, 0, "successful rollback does not restore the retired managed Startup VBS");
  equal(success.stopCalls.length, 1, "rollback stops only the gateway started by this transaction after identity health verification");

  const restartedGateway = await fixture("rollback-after-scheduler-restart");
  await prepare(restartedGateway.common);
  await restartedGateway.activateFixture();
  const restartedIdentity = await readGatewayIdentity(gatewayPaths(restartedGateway.gatewayDir));
  restartedGateway.state.pid = 23456;
  await writeFile(gatewayPaths(restartedGateway.gatewayDir).state, JSON.stringify({ pid: 23456, token: restartedIdentity.token, port: restartedIdentity.port }));
  const restartedRollback = await restartedGateway.rollbackFixture();
  equal(restartedRollback.phase, "rolled_back", "rollback cleans up the current owned gateway after its Task Scheduler PID changed");
  equal(restartedGateway.stopCalls.at(-1)?.pid, 23456, "rollback shuts down the current PID rather than the initial journal PID");
  equal(restartedGateway.taskCalls.some(([action]) => action === "unregister"), true, "rollback restores the Task only after the current child is confirmed exited");

  for (const [label, stopResult, alive] of [
    ["shutdown-false", { stopped: false, pid: 12345 }, false],
    ["child-still-alive", { stopped: true, pid: 12345 }, true],
  ]) {
    const blocked = await fixture(`rollback-${label}`);
    await prepare(blocked.common);
    await blocked.activateFixture();
    const beforeConfig = await readFile(path.join(blocked.codexHome, "config.toml"));
    const beforeLauncher = await readFile(path.join(blocked.gatewayDir, "gateway-task.vbs"));
    const beforeEnvironment = structuredClone(blocked.environment.get("CODEX_CLI_PATH"));
    const beforeStartupSize = blocked.startup.size;
    await rejects(() => blocked.rollbackFixture({}, {
      stopGateway: async () => stopResult,
      isGatewayProcessAlive: async () => alive,
      gatewayExitTimeoutMs: 5,
    }), /shutdown|process exit/i, `${label} prevents rollback from claiming gateway cleanup`);
    equal((await readFile(path.join(blocked.codexHome, "config.toml"))).equals(beforeConfig), true, `${label} leaves config untouched`);
    equal((await readFile(path.join(blocked.gatewayDir, "gateway-task.vbs"))).equals(beforeLauncher), true, `${label} leaves launcher untouched`);
    assert.deepEqual(blocked.environment.get("CODEX_CLI_PATH"), beforeEnvironment, `${label} leaves environment untouched`); checks += 1;
    equal(blocked.taskCalls.some(([action]) => action === "unregister"), false, `${label} does not unregister the Task`);
    equal(blocked.startup.size, beforeStartupSize, `${label} leaves autostart state untouched`);
    equal((await status({ journalPath: blocked.journalPath })).phase, "active", `${label} leaves the journal available for a safe retry`);
  }

  const throwShutdown = await fixture("rollback-shutdown-throws");
  await prepare(throwShutdown.common);
  await throwShutdown.activateFixture();
  const throwConfigBefore = await readFile(path.join(throwShutdown.codexHome, "config.toml"));
  const throwLauncherBefore = await readFile(path.join(throwShutdown.gatewayDir, "gateway-task.vbs"));
  const throwEnvironmentBefore = structuredClone(throwShutdown.environment.get("CODEX_CLI_PATH"));
  await rejects(() => throwShutdown.rollbackFixture({}, {
    stopGateway: async () => { throw new Error("fixture shutdown failure"); },
  }), /shutdown/i, "shutdown exceptions stop rollback before restoring owned state");
  equal(throwShutdown.taskCalls.some(([action]) => action === "unregister"), false, "shutdown exception does not unregister the Task");
  equal((await readFile(path.join(throwShutdown.codexHome, "config.toml"))).equals(throwConfigBefore), true, "shutdown exception leaves config untouched");
  equal((await readFile(path.join(throwShutdown.gatewayDir, "gateway-task.vbs"))).equals(throwLauncherBefore), true, "shutdown exception leaves launcher untouched");
  assert.deepEqual(throwShutdown.environment.get("CODEX_CLI_PATH"), throwEnvironmentBefore, "shutdown exception leaves environment untouched"); checks += 1;
  equal((await status({ journalPath: throwShutdown.journalPath })).phase, "active", "shutdown exception leaves the journal available for a safe retry");

  const readyChildAlive = await fixture("rollback-task-ready-child-alive");
  await prepare(readyChildAlive.common);
  await readyChildAlive.activateFixture();
  const readyButAliveAdapter = {
    ...readyChildAlive.taskAdapter,
    async status(plan) {
      const current = await readyChildAlive.taskAdapter.status(plan);
      return current.state === "Ready" ? current : { ...current, state: "Ready" };
    },
  };
  await rejects(() => readyChildAlive.rollbackFixture({ taskAdapter: readyButAliveAdapter }, {
    stopGateway: async () => ({ stopped: true, pid: 12345 }),
    isGatewayProcessAlive: async () => true,
    gatewayExitTimeoutMs: 5,
  }), /process exit/i, "Task Ready does not substitute for confirming the owned child exited");
  equal(readyChildAlive.taskCalls.some(([action]) => action === "unregister"), false, "Task Ready with a live child is not unregistered");
  equal(readyChildAlive.environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2").value, "1", "Task Ready with a live child preserves managed environment");
  equal((await status({ journalPath: readyChildAlive.journalPath })).phase, "active", "Task Ready with a live child leaves the journal recoverable");

  const priorOwnedGateway = await fixture("rollback-preserves-prior-owned-gateway");
  await prepare(priorOwnedGateway.common);
  await priorOwnedGateway.activateFixture();
  const priorOwnedJournal = decodeJournal(await readFile(priorOwnedGateway.journalPath, "utf8"));
  priorOwnedJournal.gateway.startedByTransaction = false;
  priorOwnedJournal.gateway.preexistingPid = priorOwnedJournal.gateway.pid;
  priorOwnedJournal.gateway.taskSnapshot.priorExists = true;
  priorOwnedJournal.gateway.taskSnapshot.priorOwned = true;
  await writeFile(priorOwnedGateway.journalPath, encodeJournal(priorOwnedJournal));
  await priorOwnedGateway.rollbackFixture();
  equal(priorOwnedGateway.stopCalls.length, 0, "rollback preserves a gateway marked as preexisting and not started by this transaction");
  equal(priorOwnedGateway.taskCalls.some(([action]) => action === "unregister"), false, "rollback preserves a prior-owned Task snapshot");

  const samePreexistingPid = await fixture("rollback-started-flag-but-preexisting-pid");
  await prepare(samePreexistingPid.common);
  await samePreexistingPid.activateFixture();
  const samePreexistingJournal = decodeJournal(await readFile(samePreexistingPid.journalPath, "utf8"));
  samePreexistingJournal.gateway.preexistingPid = samePreexistingJournal.gateway.pid;
  await writeFile(samePreexistingPid.journalPath, encodeJournal(samePreexistingJournal));
  let protectedPidShutdownCalls = 0;
  await samePreexistingPid.rollbackFixture({}, { stopGateway: async ({ paths }) => {
    protectedPidShutdownCalls += 1;
    await rm(paths.state, { force: true });
    return { stopped: true, pid: 12345 };
  } });
  equal(protectedPidShutdownCalls, 0, "preexisting PID is protected even when startedByTransaction is true");

  const missingStateNoBinding = await fixture("rollback-missing-state-no-cleanup-binding");
  await prepare(missingStateNoBinding.common);
  await missingStateNoBinding.activateFixture();
  await rm(gatewayPaths(missingStateNoBinding.gatewayDir).state, { force: true });
  await rejects(() => missingStateNoBinding.rollbackFixture({}, { isGatewayProcessAlive: async () => false }), /cleanup PID|identity binding|verified cleanup/i,
    "missing current state cannot fall back to the original journal PID");
  equal((await missingStateNoBinding.taskAdapter.status({ name: "disposable" })).state, "Running", "missing state fixture still has a Running Task when rollback is refused");
  equal(missingStateNoBinding.taskCalls.some(([action]) => action === "unregister"), false, "missing state without cleanup binding does not unregister the Task");
  equal((await status({ journalPath: missingStateNoBinding.journalPath })).phase, "active", "missing state without cleanup binding leaves the journal active");

  const retryAfterMissingState = await fixture("rollback-retry-keeps-verified-current-pid");
  await prepare(retryAfterMissingState.common);
  await retryAfterMissingState.activateFixture();
  const retryIdentity = await readGatewayIdentity(gatewayPaths(retryAfterMissingState.gatewayDir));
  retryAfterMissingState.state.pid = 23456;
  await writeFile(gatewayPaths(retryAfterMissingState.gatewayDir).state, JSON.stringify({ pid: 23456, token: retryIdentity.token, port: retryIdentity.port }));
  let retryChildAlive = true;
  let retryStopCalls = 0;
  const retryDependencies = {
    stopGateway: async ({ paths }) => {
      retryStopCalls += 1;
      await rm(paths.state, { force: true });
      return { stopped: true, pid: 23456 };
    },
    isGatewayProcessAlive: async (pid) => { equal(pid, 23456, "retry liveness checks the last verified current PID"); return retryChildAlive; },
    gatewayExitTimeoutMs: 0,
  };
  await rejects(() => retryAfterMissingState.rollbackFixture({}, retryDependencies), /process exit/i,
    "a graceful shutdown with an unobserved child exit remains retryable");
  const cleanupBinding = decodeJournal(await readFile(retryAfterMissingState.journalPath, "utf8")).gateway.cleanupProcess;
  equal(cleanupBinding?.pid, 23456, "journal records the verified current PID before graceful shutdown");
  const retryJournal = decodeJournal(await readFile(retryAfterMissingState.journalPath, "utf8"));
  equal(retryJournal.gateway.pid, 12345, "rollback preserves the original activation PID");
  equal(cleanupBinding?.identitySha256, retryJournal.gateway.identitySha256,
    "cleanup PID binding is tied to the journal identity hash");
  await rejects(() => retryAfterMissingState.rollbackFixture({}, retryDependencies), /process exit/i,
    "retry after state removal still waits for the recorded current PID");
  equal(retryStopCalls, 1, "retry does not repeat graceful shutdown when state is absent");
  retryChildAlive = false;
  await retryAfterMissingState.rollbackFixture({}, retryDependencies);
  equal((await status({ journalPath: retryAfterMissingState.journalPath })).phase, "rolled_back", "retry completes only after the recorded current PID exits");

  const postInstallConfig = await fixture("rollback-preserves-post-install-config");
  await prepare(postInstallConfig.common);
  await postInstallConfig.activateFixture();
  const postConfigPath = path.join(postInstallConfig.codexHome, "config.toml");
  const postOwned = (await readFile(postConfigPath, "utf8"))
    .replace('model = "gpt-current"', 'model = "gpt-user-selected"')
    .replace("# sol-luna-native-isolated end", [
      "# added after install",
      "[mcp_servers.user_server]",
      'command = "user-mcp"',
      "[[plugins]]",
      'id = "user-plugin"',
      "[[skills.config]]",
      'path = "user-skill"',
      "enabled = true",
      "# sol-luna-native-isolated end",
    ].join("\n"));
  await writeFile(postConfigPath, postOwned);
  await postInstallConfig.rollbackFixture();
  const preservedPostConfig = await readFile(postConfigPath, "utf8");
  for (const text of ['model = "gpt-user-selected"', "# added after install", "[mcp_servers.user_server]", 'id = "user-plugin"', 'path = "user-skill"']) {
    equal(preservedPostConfig.includes(text), true, `rollback preserves later config text: ${text}`);
  }
  equal(preservedPostConfig.includes("sol-luna-native-isolated begin"), false, "rollback removes only the owned isolated provider tables");

  const rootDependsOnPlugin = await fixture("rollback-root-depends-on-plugin");
  await prepare(rootDependsOnPlugin.common);
  await rootDependsOnPlugin.activateFixture();
  const dependentConfigPath = path.join(rootDependsOnPlugin.codexHome, "config.toml");
  const dependentConfig = (await readFile(dependentConfigPath, "utf8"))
    .replace('model = "gpt-current"', 'model = "gpt-current"\nmodel_provider = "deepseek-native"');
  await writeFile(dependentConfigPath, dependentConfig);
  await rejects(() => rootDependsOnPlugin.rollbackFixture(), /root.*depends|main.*depends/i, "rollback refuses to remove a provider selected by root config");
  equal(rootDependsOnPlugin.stopCalls.length, 0, "root provider dependency is rejected before gateway shutdown");

  const rootDependsOnGateway = await fixture("rollback-root-depends-on-private-url");
  await prepare(rootDependsOnGateway.common);
  await rootDependsOnGateway.activateFixture();
  const gatewayIdentity = await readGatewayIdentity(gatewayPaths(rootDependsOnGateway.gatewayDir));
  const rootGatewayConfigPath = path.join(rootDependsOnGateway.codexHome, "config.toml");
  const rootGatewayConfig = (await readFile(rootGatewayConfigPath, "utf8"))
    .replace('model = "gpt-current"', `model = "gpt-current"\nopenai_base_url = "http://127.0.0.1:${gatewayIdentity.port}/${gatewayIdentity.token}/v1"`);
  await writeFile(rootGatewayConfigPath, rootGatewayConfig);
  await rejects(() => rootDependsOnGateway.rollbackFixture(), /root.*depends|main.*depends/i, "rollback refuses to remove a private gateway selected by the root URL");
  equal(rootDependsOnGateway.stopCalls.length, 0, "root private URL dependency is rejected before gateway shutdown");

  const preexistingRootProvider = await fixture("rollback-preexisting-root-provider-dependency");
  const preexistingProviderConfigPath = path.join(preexistingRootProvider.codexHome, "config.toml");
  await writeFile(preexistingProviderConfigPath, 'model = "gpt-current"\nmodel_provider = "deepseek-native"\n');
  await prepare(preexistingRootProvider.common);
  await preexistingRootProvider.activateFixture();
  await rejects(() => preexistingRootProvider.rollbackFixture(), /root.*depends|main.*depends/i, "rollback checks root dependencies even when config bytes still match the install snapshot");
  equal(preexistingRootProvider.stopCalls.length, 0, "preexisting root provider dependency is rejected before gateway shutdown");

  const absentConfigWithForeignSkill = await fixture("absent-config-with-foreign-skill");
  await rm(path.join(absentConfigWithForeignSkill.codexHome, "config.toml"));
  await prepare(absentConfigWithForeignSkill.common);
  await absentConfigWithForeignSkill.activateFixture();
  const absentActiveConfigPath = path.join(absentConfigWithForeignSkill.codexHome, "config.toml");
  const absentForeignConfig = (await readFile(absentActiveConfigPath, "utf8")).replace(
    "# sol-luna-native-isolated end",
    '[[skills.config]]\npath = "fixture-only-survivor"\nenabled = true\n# sol-luna-native-isolated end',
  );
  await writeFile(absentActiveConfigPath, absentForeignConfig);
  const absentConfigRollback = await absentConfigWithForeignSkill.rollbackFixture();
  equal(absentConfigRollback.phase, "rolled_back", "rollback completes when an originally absent config gains a foreign skill table");
  const preservedAbsentConfig = await readFile(absentActiveConfigPath, "utf8");
  equal(preservedAbsentConfig.includes("fixture-only-survivor"), true, "rollback keeps a nonempty config created by a foreign skill table");
  equal(preservedAbsentConfig.includes("sol-luna-native-isolated begin"), false, "rollback removes the isolated marker from an originally absent config");

  const ownedDriftRollback = await fixture("owned-drift-with-foreign-skill");
  await prepare(ownedDriftRollback.common);
  await ownedDriftRollback.activateFixture();
  const driftConfigPath = path.join(ownedDriftRollback.codexHome, "config.toml");
  const driftConfigWithForeign = (await readFile(driftConfigPath, "utf8"))
    .replace('wire_api = "responses"', 'wire_api = "chat_completions"')
    .replace("# sol-luna-native-isolated end", '[[skills.config]]\npath = "fixture-skill"\nenabled = true\n# sol-luna-native-isolated end');
  await writeFile(driftConfigPath, driftConfigWithForeign);
  await rejects(() => ownedDriftRollback.rollbackFixture(), /file changed since activation/i, "rollback refuses owned provider drift even with a foreign skill table");
  equal(await readFile(driftConfigPath, "utf8"), driftConfigWithForeign, "owned drift rollback refusal preserves the later config");
  equal(ownedDriftRollback.stopCalls.length, 0, "owned drift is rejected before stopping the gateway");

  const oldEnvironmentJournal = await fixture("old-two-key-environment-journal");
  oldEnvironmentJournal.environment.set("SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: true, value: "user-owned-journal.json" });
  await prepare(oldEnvironmentJournal.common);
  const oldEnvironmentJournalData = decodeJournal(await readFile(oldEnvironmentJournal.journalPath, "utf8"));
  delete oldEnvironmentJournalData.environment.prior.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  delete oldEnvironmentJournalData.environment.next.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  await writeFile(oldEnvironmentJournal.journalPath, encodeJournal(oldEnvironmentJournalData));
  let oldJournalKeyReads = 0;
  let oldJournalKeyWrites = 0;
  const oldTwoKeyAdapter = {
    async get(key) {
      if (key === "SOL_LUNA_NATIVE_INSTALL_JOURNAL") oldJournalKeyReads += 1;
      return oldEnvironmentJournal.envAdapter.get(key);
    },
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_INSTALL_JOURNAL") oldJournalKeyWrites += 1;
      return oldEnvironmentJournal.envAdapter.set(key, value);
    },
  };
  oldJournalKeyReads = 0;
  await oldEnvironmentJournal.activateFixture({ envAdapter: oldTwoKeyAdapter });
  equal(oldJournalKeyReads, 0, "activating an old two-key journal never reads the new journal environment key");
  equal(oldJournalKeyWrites, 0, "activating an old two-key journal never writes the new journal environment key");
  equal(oldEnvironmentJournal.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").value, "user-owned-journal.json", "old journal activation preserves the unrelated user journal value");
  oldJournalKeyReads = 0;
  oldJournalKeyWrites = 0;
  await oldEnvironmentJournal.rollbackFixture({ envAdapter: oldTwoKeyAdapter });
  equal(oldJournalKeyReads, 0, "rolling back an old two-key journal never reads the new journal environment key");
  equal(oldJournalKeyWrites, 0, "rolling back an old two-key journal never writes the new journal environment key");
  equal(oldEnvironmentJournal.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").value, "user-owned-journal.json", "old journal rollback preserves the unrelated user journal value");
  equal(await readFile(path.join(oldEnvironmentJournal.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "unchanged config rollback restores exact prior bytes");

  const changedAfterActivation = await fixture("later-edit");
  await prepare(changedAfterActivation.common);
  await changedAfterActivation.activateFixture();
  await writeFile(path.join(changedAfterActivation.codexHome, "config.toml"), "later user config\n");
  await rejects(() => changedAfterActivation.rollbackFixture(), /file changed since activation/i, "rollback refuses later file edits before changing other owned state");
  equal(changedAfterActivation.environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2").value, "1", "rollback preflight preserves environment when a file changed later");

  const stale = await fixture("stale");
  await prepare(stale.common);
  await writeFile(path.join(stale.codexHome, "config.toml"), "user later edit\n");
  await rejects(() => stale.activateFixture(), /file changed since plan/i, "activation rejects a changed managed file");
  equal(await readFile(path.join(stale.codexHome, "config.toml"), "utf8"), "user later edit\n", "stale activation preserves user file edit");

  const envStale = await fixture("env-stale");
  await prepare(envStale.common);
  envStale.environment.set("CODEX_CLI_PATH", { present: true, value: "user-new.exe" });
  await rejects(() => envStale.activateFixture(), /environment changed since plan/i, "activation rejects an environment edit after prepare");
  equal(envStale.environment.get("CODEX_CLI_PATH").value, "user-new.exe", "stale activation preserves user's environment edit");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native isolated installer assertions`);
