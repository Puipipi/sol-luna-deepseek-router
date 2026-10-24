import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApiProfile, defaultRouterSettingsPath, readRouterSettingsSnapshot, saveRouterSettings } from "../scripts/native-api-settings.mjs";
import { apiGatewayBaseUrl, composeApiConfig } from "../scripts/native-api-artifacts.mjs";
import {
  activate,
  applyApiConfiguration,
  getExecutorStatus,
  inspectNativeApiDispatchState,
  nativeApiPaths,
  prepare,
  rollback,
  status,
} from "../scripts/native-api-install.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const rejects = async (fn, pattern, message) => { await assert.rejects(fn, pattern, message); checks += 1; };

function fakeTaskAdapter() {
  let record = { exists: false, owned: false, specMatches: true, enabled: false, state: "Missing" };
  let starts = 0;
  let registers = 0;
  return {
    get starts() { return starts; },
    get registers() { return registers; },
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

const definitionA = {
  protocol: "responses",
  baseUrl: "https://api.example.invalid/v1",
  model: "exact/model-a",
  reasoning: { supported: ["low", "high"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "env", name: "API_A_KEY" },
};
const definitionB = {
  protocol: "chat_completions",
  baseUrl: "https://api.example.invalid/v1",
  model: "exact/model-b",
  reasoning: { supported: ["medium"], default: "medium", parameter: "reasoning_effort" },
  credential: { type: "env", name: "API_B_KEY" },
  contextWindow: 8_192,
};

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-api-install-")));
try {
  const apiDir = path.join(root, "native-api");
  const codexHome = path.join(root, "codex-home");
  const paths = nativeApiPaths(apiDir);
  const settings = {
    schemaVersion: 1,
    mode: "fixed",
    fixedExecutor: null,
    profiles: {},
  };
  const profileA = createApiProfile(definitionA, { label: "A" });
  const profileB = createApiProfile(definitionB, { label: "B" });
  settings.profiles[profileA.profileId] = profileA;
  settings.profiles[profileB.profileId] = profileB;
  settings.fixedExecutor = profileA.profileId;
  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(codexHome, "agents"), { recursive: true });
  await writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "fixture-native-model",
    visibility: "list",
    model_messages: { instructions_template: "You are Codex, an AI coding assistant working in the shared workspace." },
  }] }), "utf8");
  await saveRouterSettings(paths.settings, settings);
  const priorConfig = [
    'model = "gpt-6.1-sol"',
    'model_provider = "openai"',
    "",
    "[model_providers.deepseek-native]",
    'base_url = "http://127.0.0.1:1/token/v1"',
    "",
    "[foreign]",
    'value = "preserve"',
    "",
  ].join("\n");
  await writeFile(path.join(codexHome, "config.toml"), priorConfig, "utf8");
  const gatewayScript = path.join(root, "native-api-serve.mjs");
  await writeFile(gatewayScript, "// fixture\n", "utf8");
  const tasks = fakeTaskAdapter();
  const identity = { version: 1, token: "test-token-1234567890", port: 46_123 };
  const dependencies = {
    verifyRuntimeVersion: async () => ({ exePath: path.join(root, "codex.exe") }),
    discoverApplyCompatibleRuntime: async () => ({versionDir: path.join(root, "runtime"), exePath: path.join(root, "codex.exe"), error: null}),
    armOrReuseApiBootstrap: async ({runtimeDir}) => ({state: "armed", restartRequired: true, ready: false, reused: true, runtimeVersionDir: runtimeDir}),
    prepareGatewayIdentity: async ({ paths: servicePaths }) => {
      await mkdir(servicePaths.dir, { recursive: true });
      await writeFile(servicePaths.identity, `${JSON.stringify(identity)}\n`, "utf8");
      return identity;
    },
    resolveApiCredential: async () => ({ headers: { authorization: "Bearer in-memory-only" } }),
    taskAdapter: tasks,
  };
  const journalA = paths.journal(profileA.profileId);
  const preparedA = await prepare({
    profileId: profileA.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalA,
    gatewayScriptPath: gatewayScript,
  }, dependencies);
  equal(preparedA.prepared, true, "prepare writes a transaction journal");
  const preparedJournal = JSON.parse(await readFile(journalA, "utf8"));
  assert.match(preparedJournal.gateway.taskPlan.launcher.content, /--settings/);
  assert.match(preparedJournal.gateway.taskPlan.launcher.content, new RegExp(paths.settings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  checks += 1;
  equal(preparedJournal.paths.settingsPath, paths.settings, "custom API settings path stays unchanged in the journal");
  equal((await readFile(path.join(codexHome, "config.toml"), "utf8")), priorConfig, "prepare does not change config");
  if (process.platform === "win32") {
    const msixLocal = path.join(root, "AppData", "Local");
    const canonicalApiDir = path.join(msixLocal, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Local", "sol-luna-deepseek-router", "native-api");
    const nominalApiDir = path.join(msixLocal, "sol-luna-deepseek-router", "native-api");
    const canonicalSettingsPath = path.join(canonicalApiDir, "router.json");
    const nominalSettingsPath = defaultRouterSettingsPath({ LOCALAPPDATA: msixLocal });
    const msixSettings = { ...settings, profiles: { [profileA.profileId]: profileA }, fixedExecutor: profileA.profileId };
    await mkdir(canonicalApiDir, { recursive: true });
    await mkdir(path.dirname(nominalApiDir), { recursive: true });
    const msixCodexHome = path.join(root, "msix-codex-home");
    await mkdir(msixCodexHome, { recursive: true });
    await writeFile(path.join(msixCodexHome, "models_cache.json"), JSON.stringify({ models: [{
      slug: "fixture-native-model",
      visibility: "list",
      model_messages: { instructions_template: "You are Codex, an AI coding assistant working in the shared workspace." },
    }] }), "utf8");
    await symlink(canonicalApiDir, nominalApiDir, "junction");
    await saveRouterSettings(nominalSettingsPath, msixSettings);
    const revisionBefore = await readRouterSettingsSnapshot(canonicalSettingsPath);
    const msixJournalPath = nativeApiPaths(canonicalApiDir).journal(profileA.profileId);
    await prepare({
      profileId: profileA.profileId,
      settingsPath: nominalSettingsPath,
      apiDir: canonicalApiDir,
      codexHome: msixCodexHome,
      versionDir: path.join(root, "runtime"),
      journalPath: msixJournalPath,
      gatewayScriptPath: gatewayScript,
    }, {
      ...dependencies,
      taskAdapter: fakeTaskAdapter(),
      env: { LOCALAPPDATA: msixLocal },
      defaultNativeApiDir: () => canonicalApiDir,
    });
    const msixJournal = JSON.parse(await readFile(msixJournalPath, "utf8"));
    equal(msixJournal.paths.settingsPath, canonicalSettingsPath,
      "a confirmed default MSIX alias binds the canonical settings path in the journal");
    ok(msixJournal.gateway.taskPlan.launcher.content.includes(canonicalSettingsPath),
      "the API Task launcher uses the canonical settings path");
    equal(msixJournal.gateway.taskPlan.launcher.content.includes(nominalSettingsPath), false,
      "the API Task launcher does not retain the nominal alias path");
    equal((await readRouterSettingsSnapshot(nominalSettingsPath)).sha256, revisionBefore.sha256,
      "binding the canonical Task settings path leaves the shared settings revision unchanged");

    async function rejectUnverifiedBinding(label, overrides, expectedError) {
      const fixtureRoot = path.join(root, `msix-negative-${label}`);
      const fixtureLocal = path.join(fixtureRoot, "AppData", "Local");
      const fixtureCanonicalApiDir = path.join(fixtureLocal, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Local", "sol-luna-deepseek-router", "native-api");
      const fixtureNominalApiDir = path.join(fixtureLocal, "sol-luna-deepseek-router", "native-api");
      const fixtureNominalSettings = defaultRouterSettingsPath({ LOCALAPPDATA: fixtureLocal });
      const fixtureCanonicalSettings = path.join(fixtureCanonicalApiDir, "router.json");
      const fixtureSettings = { ...settings, profiles: { [profileA.profileId]: profileA }, fixedExecutor: profileA.profileId };
      await mkdir(fixtureCanonicalApiDir, { recursive: true });
      await mkdir(path.dirname(fixtureNominalApiDir), { recursive: true });
      await symlink(fixtureCanonicalApiDir, fixtureNominalApiDir, "junction");
      await saveRouterSettings(fixtureNominalSettings, fixtureSettings);

      const fixturePaths = nativeApiPaths(fixtureCanonicalApiDir);
      const fixtureCodexHome = path.join(fixtureRoot, "codex-home");
      const fixtureJournal = fixturePaths.journal(profileA.profileId);
      let identityWrites = 0;
      const fixtureTasks = fakeTaskAdapter();
      const taskAdapter = {
        ...fixtureTasks,
        async status(...args) { return fixtureTasks.status(...args); },
      };
      await rejects(() => prepare({
        profileId: profileA.profileId,
        settingsPath: fixtureNominalSettings,
        apiDir: fixtureCanonicalApiDir,
        codexHome: fixtureCodexHome,
        versionDir: path.join(root, "runtime"),
        journalPath: fixtureJournal,
        gatewayScriptPath: gatewayScript,
      }, {
        ...dependencies,
        env: { LOCALAPPDATA: fixtureLocal },
        defaultNativeApiDir: () => fixtureCanonicalApiDir,
        taskAdapter,
        prepareGatewayIdentity: async (...args) => {
          identityWrites += 1;
          return dependencies.prepareGatewayIdentity(...args);
        },
        ...overrides({ fixtureNominalSettings, fixtureCanonicalSettings }),
      }), expectedError, `${label}: unverified default settings binding is rejected`);
      equal(identityWrites, 0, `${label}: rejection happens before identity creation`);
      equal(fixtureTasks.registers, 0, `${label}: rejection happens before Task registration`);
      await rejectMissing(fixtureJournal, `${label}: rejection happens before journal creation`);
      await rejectMissing(fixturePaths.service.identity, `${label}: rejection happens before service identity creation`);
      await rejectMissing(path.join(fixturePaths.service.dir, "api-task.vbs"),
        `${label}: rejection happens before Task launcher creation`);
      await rejectMissing(fixturePaths.registry, `${label}: rejection happens before registry creation`);
      await rejectMissing(path.join(fixtureCodexHome, "agents", `native_api_${profileA.profileId}.toml`),
        `${label}: rejection happens before role creation`);
    }

    await rejectUnverifiedBinding("realpath-mismatch", ({ fixtureNominalSettings }) => ({
      realpathSync: (file) => file === fixtureNominalSettings
        ? path.join(root, "unrelated-router.json")
        : realpathSync.native(file),
    }), /does not identify the canonical settings file/);

    await rejectUnverifiedBinding("file-id-mismatch", ({ fixtureNominalSettings }) => ({
      statSync: (file, options) => {
        const info = statSync(file, options);
        if (file !== fixtureNominalSettings) return info;
        return { isFile: () => info.isFile(), dev: info.dev, ino: info.ino + 1n };
      },
    }), /does not identify the canonical settings file/);

    await rejectUnverifiedBinding("revision-mismatch", ({ fixtureCanonicalSettings }) => ({
      readRouterSettingsSnapshot: async (file) => {
        const snapshot = await readRouterSettingsSnapshot(file);
        return file === fixtureCanonicalSettings ? { ...snapshot, sha256: "0".repeat(64) } : snapshot;
      },
    }), /revision changed while binding the canonical file/);
  }
  await rejects(() => prepare({
    profileId: profileA.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalA,
    gatewayScriptPath: gatewayScript,
  }, dependencies), /journal already exists/);

  const activatedA = await activate({ journalPath: journalA }, dependencies);
  equal(activatedA.activated, true, "activate commits the profile artifacts");
  equal(activatedA.restartNeeded, true, "new role installation requires a full restart");
  equal(tasks.registers, 1, "activation registers one owned API task");
  equal(tasks.starts, 0, "activation does not start an unused API service");
  const launcherPath = path.join(paths.service.dir, "api-task.vbs");
  const launcherBytes = await readFile(launcherPath);
  equal(launcherBytes[0], 0xff, "API launcher starts with the UTF-16LE BOM high byte");
  equal(launcherBytes[1], 0xfe, "API launcher starts with the UTF-16LE BOM low byte");
  const launcherText = launcherBytes.toString("utf16le", 2);
  assert.match(launcherText, /--api-only/);
  assert.match(launcherText, /sol-luna-native-api-task:v1:/);
  checks += 3;
  const configA = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configA, new RegExp(`\\[model_providers\\.api-native-${profileA.profileId}\\]`));
  assert.match(configA, /\[foreign\]/);
  assert.match(configA, /\[model_providers\.deepseek-native\]/);
  const roleA = await readFile(path.join(codexHome, "agents", `native_api_${profileA.profileId}.toml`), "utf8");
  assert.match(roleA, /unbounded_connection_retries = false/);
  assert.doesNotMatch(roleA, /API_A_KEY|in-memory-only/);
  checks += 1;
  const catalogA = JSON.parse(await readFile(path.join(codexHome, `sol-luna-native-models-${profileA.profileId}.json`), "utf8"));
  equal(catalogA.models.length, 1, "installed catalog contains exactly one model");
  equal(catalogA.models[0].slug, profileA.model, "installed catalog uses the exact model");
  equal((await status({ journalPath: journalA })).phase, "active", "status reports the activated phase");
  equal((await status({ journalPath: journalA })).restartNeeded, "unknown", "status does not claim restart adoption");

  const inspected = await inspectNativeApiDispatchState({
    profileId: profileA.profileId,
    apiDir,
    settingsPath: paths.settings,
    taskAdapter: tasks,
  }, dependencies);
  equal(inspected.ready, true, "static dispatch gate accepts complete owned artifacts");

  // A failed activation must restore the existing launcher and role/config.
  const profileC = createApiProfile({ ...definitionA, model: "exact/model-c" });
  settings.profiles[profileC.profileId] = profileC;
  const settingsSnapshot = await readRouterSettingsSnapshot(paths.settings);
  await saveRouterSettings(paths.settings, settings, { expectedSha256: settingsSnapshot.sha256 });
  const failingTasks = fakeTaskAdapter();
  failingTasks.register = async () => { throw new Error("simulated task registration failure"); };
  const journalC = paths.journal(profileC.profileId);
  await prepare({
    profileId: profileC.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalC,
    gatewayScriptPath: gatewayScript,
  }, { ...dependencies, taskAdapter: failingTasks });
  const launcherBeforeFailure = await readFile(launcherPath);
  const beforeFailure = await readFile(path.join(codexHome, "config.toml"), "utf8");
  await rejects(() => activate({ journalPath: journalC }, { ...dependencies, taskAdapter: failingTasks }), /simulated task registration failure/);
  equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), beforeFailure, "failed activation restores config");
  equal((await readFile(launcherPath)).equals(launcherBeforeFailure), true, "failed activation restores the existing launcher");
  await rejectMissing(path.join(codexHome, "agents", `native_api_${profileC.profileId}.toml`), "failed activation removes the new role");

  const journalB = paths.journal(profileB.profileId);
  await prepare({
    profileId: profileB.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalB,
    gatewayScriptPath: gatewayScript,
  }, dependencies);
  await activate({ journalPath: journalB }, dependencies);
  const configAB = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configAB, new RegExp(`api-native-${profileB.profileId}`));
  equal(tasks.registers, 1, "adding a second profile reuses the owned API task");
  delete settings.profiles[profileC.profileId];
  await writeFile(paths.settings, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const catalogAPath = path.join(codexHome, `sol-luna-native-models-${profileA.profileId}.json`);
  const catalogBPath = path.join(codexHome, `sol-luna-native-models-${profileB.profileId}.json`);
  const catalogBBeforeRepair = await readFile(catalogBPath);
  const oldCatalogA = JSON.parse(await readFile(catalogAPath, "utf8"));
  delete oldCatalogA.models[0].model_messages;
  const oldCatalogABytes = Buffer.from(`${JSON.stringify(oldCatalogA, null, 2)}\n`);
  const oldJournalA = JSON.parse(await readFile(journalA, "utf8"));
  oldJournalA.files.catalog.next = { $buffer: oldCatalogABytes.toString("base64") };
  await writeFile(journalA, `${JSON.stringify(oldJournalA, null, 2)}\n`, "utf8");
  await writeFile(catalogAPath, oldCatalogABytes);
  const oldCatalogStatus = await getExecutorStatus({ settings, profileId: profileA.profileId }, {
    ...dependencies,
    apiDir,
    settingsPath: paths.settings,
    codexHome,
    env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(root, "runtime") },
  });
  equal(oldCatalogStatus.installed, false, "status rejects an owned catalog without instructions");
  await rejects(() => inspectNativeApiDispatchState({
    profileId: profileA.profileId,
    apiDir,
    settingsPath: paths.settings,
    taskAdapter: tasks,
  }, dependencies), /missing model instructions/);
  const catalogRepair = await applyApiConfiguration({ settings }, {
    ...dependencies,
    apiDir,
    settingsPath: paths.settings,
    codexHome,
    env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(root, "runtime") },
  });
  equal(catalogRepair.applied, true, "explicit Apply refreshes an owned legacy API catalog");
  equal(catalogRepair.appliedProfiles.includes(profileA.profileId), true, "Apply reports the repaired catalog profile");
  const repairedCatalogA = JSON.parse(await readFile(catalogAPath, "utf8"));
  equal(repairedCatalogA.models[0].model_messages.instructions_template,
    "You are Codex, an AI coding assistant working in the shared workspace.",
  "Apply restores the native instructions template");
  equal((await readFile(catalogBPath)).equals(catalogBBeforeRepair), true, "repair preserves other profile catalogs");
  const oldCatalogB = JSON.parse(catalogBBeforeRepair.toString("utf8"));
  delete oldCatalogB.models[0].model_messages;
  const oldCatalogBBytes = Buffer.from(`${JSON.stringify(oldCatalogB, null, 2)}\n`);
  const oldJournalB = JSON.parse(await readFile(journalB, "utf8"));
  oldJournalB.files.catalog.next = { $buffer: oldCatalogBBytes.toString("base64") };
  await writeFile(journalB, `${JSON.stringify(oldJournalB, null, 2)}\n`, "utf8");
  await writeFile(catalogBPath, oldCatalogBBytes);
  await writeFile(catalogBPath, catalogBBeforeRepair);
  const interruptedRepair = await applyApiConfiguration({ settings }, {
    ...dependencies,
    apiDir,
    settingsPath: paths.settings,
    codexHome,
    env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(root, "runtime") },
  });
  equal(interruptedRepair.appliedProfiles.includes(profileB.profileId), true,
    "Apply completes a catalog write interrupted before its journal update");
  equal((await inspectNativeApiDispatchState({
    profileId: profileB.profileId,
    apiDir,
    settingsPath: paths.settings,
    taskAdapter: tasks,
  }, dependencies)).ready, true, "interrupted catalog repair restores ready state");
  const providerOnlyLegacyConfig = composeApiConfig(configAB, {
    profileIds: [profileA.profileId, profileB.profileId],
    gatewayBaseUrl: apiGatewayBaseUrl(identity),
    registerAgentRoles: false,
  });
  await writeFile(path.join(codexHome, "config.toml"), providerOnlyLegacyConfig, "utf8");
  await writeFile(paths.settings, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const applyDependencies = {
    ...dependencies,
    apiDir,
    settingsPath: paths.settings,
    codexHome,
    env: { SOL_LUNA_NATIVE_API_VERSION_DIR: path.join(root, "runtime") },
  };
  const legacyStatus = await getExecutorStatus({ settings, profileId: profileA.profileId }, applyDependencies);
  equal(legacyStatus.installed, false, "status rejects the previously active provider-only profile config");
  const repaired = await applyApiConfiguration({ settings }, applyDependencies);
  equal(repaired.applied, true, "explicit Apply repairs active legacy profiles");
  equal(repaired.appliedProfiles.includes(profileA.profileId), true, "Apply records the repaired profile");
  equal(repaired.alreadyInstalled.includes(profileB.profileId), true, "Apply recognizes the second repaired profile as installed");
  const repairedConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(repairedConfig, new RegExp(`\\[agents\\.native_api_${profileA.profileId}\\]`));
  assert.match(repairedConfig, new RegExp(`\\[agents\\.native_api_${profileB.profileId}\\]`));
  assert.match(repairedConfig, /^model = "gpt-6\.1-sol"/m);
  assert.match(repairedConfig, /\[model_providers\.deepseek-native\]/);
  checks += 1;
  await writeFile(path.join(codexHome, "config.toml"), providerOnlyLegacyConfig, "utf8");
  let injectedExternalEdit = false;
  const racingTasks = {
    ...tasks,
    async status() {
      const result = await tasks.status();
      if (!injectedExternalEdit) {
        injectedExternalEdit = true;
        await writeFile(path.join(codexHome, "config.toml"), `${providerOnlyLegacyConfig}\n# user edit during repair\n`, "utf8");
      }
      return result;
    },
  };
  await rejects(() => applyApiConfiguration({ settings }, { ...applyDependencies, taskAdapter: racingTasks }), /config or catalog changed during repair/);
  assert.match(await readFile(path.join(codexHome, "config.toml"), "utf8"), /# user edit during repair/);
  await writeFile(path.join(codexHome, "config.toml"), repairedConfig, "utf8");
  settings.profiles[profileC.profileId] = profileC;
  await writeFile(paths.settings, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const inspectedAWithB = await inspectNativeApiDispatchState({
    profileId: profileA.profileId,
    apiDir,
    settingsPath: paths.settings,
    taskAdapter: tasks,
  }, dependencies);
  equal(inspectedAWithB.ready, true, "a shared registry with a second profile keeps A ready");
  const registryFile = paths.registry;
  const registryBytes = await readFile(registryFile);
  const registryValue = JSON.parse(registryBytes.toString("utf8"));
  delete registryValue.profiles[profileA.profileId];
  await writeFile(registryFile, `${JSON.stringify(registryValue, null, 2)}\n`);
  await rejects(() => inspectNativeApiDispatchState({
    profileId: profileA.profileId,
    apiDir,
    settingsPath: paths.settings,
    taskAdapter: tasks,
  }, dependencies), /registry has no entry/);
  await writeFile(registryFile, registryBytes);

  const rolledBackAWithB = await rollback({ journalPath: journalA }, dependencies);
  equal(rolledBackAWithB.remainingProfiles.includes(profileB.profileId), true, "rolling back A while B remains preserves B");
  await rejectMissing(path.join(codexHome, "agents", `native_api_${profileA.profileId}.toml`), "A role is removed first");
  ok((await readFile(path.join(codexHome, "agents", `native_api_${profileB.profileId}.toml`), "utf8")).includes("unbounded_connection_retries"), "B role remains after A rollback");
  const configAfterRollbackA = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configAfterRollbackA, new RegExp(`api-native-${profileB.profileId}`));
  assert.match(configAfterRollbackA, new RegExp(`\\[agents\\.native_api_${profileB.profileId}\\]`));
  assert.doesNotMatch(configAfterRollbackA, new RegExp(`\\[agents\\.native_api_${profileA.profileId}\\]`));
  equal((await tasks.status()).exists, true, "A rollback preserves the shared B task");
  equal((await readFile(launcherPath)).length > 0, true, "A rollback preserves the shared B launcher");
  equal((await status({ journalPath: journalA })).phase, "rolled_back", "A journal is terminal after its rollback");

  const rolledBackB = await rollback({ journalPath: journalB }, dependencies);
  equal(rolledBackB.remainingProfiles.length, 0, "rolling back B last leaves no API selection");
  const finalConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.doesNotMatch(finalConfig, /sol-luna-native-api/);
  assert.match(finalConfig, /\[foreign\]/);
  assert.match(finalConfig, /\[model_providers\.deepseek-native\]/);
  equal((await tasks.status()).exists, false, "rolling back the last profile unregisters the owned task");
  await rejectMissing(launcherPath, "rolling back the last profile removes the owned launcher");
  await rejectMissing(paths.gatewayOrigin, "rolling back the last profile removes the shared origin receipt");
  checks += 1;

  // Reapply the same rolled-back profile without manually deleting its journal.
  const reapplied = await prepare({
    profileId: profileA.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalA,
    gatewayScriptPath: gatewayScript,
  }, dependencies);
  equal(reapplied.prepared, true, "a rolled-back profile journal can be prepared again");
  const journalDir = path.dirname(journalA);
  const receipts = (await readdir(journalDir)).filter((name) => name.includes(".receipt-"));
  equal(receipts.length > 0, true, "reprepare preserves the old rolled-back journal as a receipt");

  const foreignHome = path.join(root, "foreign-home");
  await mkdir(path.join(foreignHome, "agents"), { recursive: true });
  await writeFile(path.join(foreignHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "fixture-native-model",
    visibility: "list",
    model_messages: { instructions_template: "You are Codex, an AI coding assistant working in the shared workspace." },
  }] }), "utf8");
  await writeFile(path.join(foreignHome, "config.toml"), priorConfig, "utf8");
  await writeFile(path.join(foreignHome, "agents", `native_api_${profileC.profileId}.toml`), "user-owned role\n", "utf8");
  await rejects(() => prepare({
    profileId: profileC.profileId,
    settingsPath: paths.settings,
    apiDir: path.join(root, "foreign-api"),
    codexHome: foreignHome,
    versionDir: path.join(root, "runtime"),
    journalPath: path.join(root, "foreign-api", "journal.json"),
    gatewayScriptPath: gatewayScript,
  }, dependencies), /unowned native API role/);

  console.log(`PASS ${checks} native API install assertions`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function rejectMissing(file, message) {
  await assert.rejects(readFile(file, "utf8"), /ENOENT/, message);
  checks += 1;
}
