import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createApiProfile,
  createDefaultRouterSettings,
  defaultRouterSettingsPath,
  loadRouterSettings,
  readRouterSettingsSnapshot,
  resolveApiCredential,
  saveRouterSettings,
  validateRouterSettings,
} from "../scripts/native-api-settings.mjs";

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function ok(actual, message) { assert.ok(actual, message); checks += 1; }
function throws(fn, pattern, message) { assert.throws(fn, pattern, message); checks += 1; }

const apiDefinition = {
  protocol: "responses",
  baseUrl: "https://api.mimo.example/v1",
  model: "mimo-v2-pro",
  reasoning: { supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort" },
  credential: { type: "env", name: "MIMO_API_KEY" },
};

const empty = createDefaultRouterSettings();
equal(empty.schemaVersion, 1, "default settings use schema v1");
equal(empty.mode, "auto", "default mode preserves automatic routing");
equal(empty.schedule.peak, "luna", "default peak remains Luna");
equal(empty.schedule.valley, "deepseek", "default valley remains DeepSeek");
equal(defaultRouterSettingsPath({ LOCALAPPDATA: "C:/local" }), path.join("C:/local", "sol-luna-deepseek-router", "native-api", "router.json"), "settings stay outside Codex config");

const profile = createApiProfile(apiDefinition, { label: "MiMo", aliases: ["mimo"] });
equal(profile.profileId.length, 24, "profile id is a short stable SHA-256 prefix");
ok(/^[a-f0-9]{24}$/.test(profile.profileId), "profile id is lowercase hex");
equal(createApiProfile(apiDefinition).profileId, profile.profileId, "labels do not affect the profile identity");
equal(createApiProfile({ ...apiDefinition, model: "mimo-v2-lite" }).profileId === profile.profileId, false, "wire model changes create a new profile identity");
const explicitWindow = createApiProfile({ ...apiDefinition, contextWindow: 2_048 });
equal(explicitWindow.contextWindow, 2_048, "an explicit context budget is preserved");
equal(explicitWindow.profileId === profile.profileId, false, "an explicit context budget participates in the canonical profile id");
equal(validateRouterSettings({ schemaVersion: 1, mode: "auto", fixedExecutor: null, profiles: { [profile.profileId]: profile } }).profiles[profile.profileId].contextWindow, undefined,
  "profiles without contextWindow keep their existing definition and id");
throws(() => createApiProfile({ ...apiDefinition, contextWindow: 1_023 }), /1024/, "context budgets below the locked range are rejected");
throws(() => createApiProfile({ ...apiDefinition, contextWindow: 2_000_001 }), /2000000/, "context budgets above the locked range are rejected");

const fixed = {
  schemaVersion: 1,
  mode: "fixed",
  fixedExecutor: profile.profileId,
  profiles: { [profile.profileId]: profile },
};
equal(validateRouterSettings(fixed).fixedExecutor, profile.profileId, "fixed mode accepts one configured API profile");
throws(() => validateRouterSettings({ ...fixed, fixedExecutor: "missing-profile" }), /unknown executor profile/, "fixed mode rejects unknown profiles");
throws(() => validateRouterSettings({ ...fixed, mode: "mystery" }), /mode/, "unknown routing modes fail closed");

const mixed = {
  schemaVersion: 1,
  mode: "scheduled",
  fixedExecutor: null,
  schedule: { peak: profile.profileId, valley: "deepseek" },
  profiles: { [profile.profileId]: profile },
};
equal(validateRouterSettings(mixed).schedule.peak, profile.profileId, "explicit mixed schedule accepts API peak");
equal(validateRouterSettings(mixed).schedule.valley, "deepseek", "explicit mixed schedule keeps DeepSeek valley");
throws(() => validateRouterSettings({ ...mixed, schedule: { peak: profile.profileId } }), /valley/, "scheduled mode requires both slots");
equal(validateRouterSettings({ ...empty, schedule: { peak: "missing-profile", valley: "missing-profile" } }).schedule.peak,
  "luna", "auto mode ignores inactive schedule slots and preserves its built-in defaults");
equal(validateRouterSettings({ ...fixed, schedule: { peak: "missing-profile", valley: "missing-profile" } }).fixedExecutor,
  profile.profileId, "fixed mode ignores inactive schedule slots");

const wrongId = { ...profile, profileId: "0".repeat(24) };
throws(() => validateRouterSettings({ ...fixed, profiles: { [wrongId.profileId]: wrongId }, fixedExecutor: wrongId.profileId }), /profileId does not match canonical definition/, "profile IDs cannot be forged or stale");
const duplicateDefinition = { ...apiDefinition, model: "different-model" };
const colliding = { ...profile, ...duplicateDefinition, profileId: profile.profileId };
throws(() => validateRouterSettings({ ...fixed, profiles: { [profile.profileId]: colliding } }), /profileId does not match canonical definition/, "a mismatched canonical profile is rejected");
const aliasCollision = createApiProfile({ ...apiDefinition, model: "other-model" }, { aliases: ["mimo"] });
throws(() => validateRouterSettings({ ...fixed, profiles: { [profile.profileId]: profile, [aliasCollision.profileId]: aliasCollision } }), /ambiguous profile alias/, "duplicate aliases fail closed instead of choosing a profile");

throws(() => createApiProfile({ ...apiDefinition, protocol: "grpc" }), /protocol/, "unsupported protocols are rejected");
throws(() => createApiProfile({ ...apiDefinition, reasoning: { ...apiDefinition.reasoning, default: "high" } }), /reasoning.default/, "default reasoning must be supported");
const noReasoning = createApiProfile({ ...apiDefinition, reasoning: { supported: ["none"], default: "none", parameter: "none" } });
equal(noReasoning.reasoning.default, "none", "non-reasoning API models may use none");
throws(() => createApiProfile({ ...apiDefinition, credential: { type: "env", name: "value=do-not-store" } }), /credential.name/, "credential refs accept names rather than values");

const accountProfile = createApiProfile({
  ...apiDefinition,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  reasoning: { supported: ["none", "low", "high", "max"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "dsh_account" },
});
ok(accountProfile.profileId, "official DeepSeek account-backed profile can be identified");
throws(() => createApiProfile({
  ...apiDefinition,
  baseUrl: "https://api.deepseek.com",
  reasoning: { supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort" },
  credential: { type: "dsh_account" },
}), /none, low, high, and max/, "official account profiles use the known DeepSeek effort levels");
throws(() => createApiProfile({
  ...apiDefinition,
  baseUrl: "https://api.deepseek.com",
  reasoning: { supported: ["high", "xhigh"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "dsh_account" },
}), /xhigh is normalized to high/, "xhigh is not advertised as a DeepSeek account effort");
const versionedAccount = createApiProfile({
  ...apiDefinition,
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  reasoning: { supported: ["none", "low", "high", "max"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "dsh_account" },
});
ok(versionedAccount.profileId, "legacy account profiles with /v1 remain loadable; endpoint availability is not claimed");
const manualDeepSeek = createApiProfile({
  ...apiDefinition,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  reasoning: { supported: ["none", "low", "high", "max"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "env", name: "DEEPSEEK_API_KEY" },
});
ok(manualDeepSeek.profileId, "manual official DeepSeek API profiles share the known effort levels");
throws(() => createApiProfile({
  ...manualDeepSeek,
  reasoning: { supported: ["high", "xhigh"], default: "high", parameter: "reasoning_effort" },
}), /xhigh is normalized to high/, "manual DeepSeek profiles do not advertise xhigh");
throws(() => createApiProfile({ ...apiDefinition, credential: { type: "dsh_account" } }), /official DeepSeek origin/, "DSH account grants cannot be sent to third-party providers");

const proEnv = createApiProfile({
  ...manualDeepSeek,
  model: "deepseek-v4-pro",
});
ok(proEnv.profileId, "manual official DeepSeek v4-pro env profiles use the known effort levels");
const proFile = createApiProfile({
  ...proEnv,
  credential: { type: "file", path: path.join(os.tmpdir(), "deepseek-pro-key") },
});
ok(proFile.profileId, "manual official DeepSeek v4-pro file profiles use the known effort levels");
const proAccount = createApiProfile({
  ...proEnv,
  credential: { type: "dsh_account" },
});
ok(proAccount.profileId, "official DeepSeek v4-pro account-backed Responses profiles remain allowed");
throws(() => createApiProfile({
  ...proEnv,
  reasoning: { supported: ["high", "xhigh"], default: "high", parameter: "reasoning_effort" },
}), /xhigh is normalized to high/, "v4-pro profiles do not advertise xhigh");
const proElsewhere = createApiProfile({
  ...proEnv,
  baseUrl: "https://api.example.com/v1",
  reasoning: { supported: ["high", "xhigh"], default: "high", parameter: "reasoning_effort" },
});
ok(proElsewhere.profileId, "a non-official origin keeps declared efforts for a pro-named model");
const unrecognizedDeepSeekName = createApiProfile({
  ...proEnv,
  model: "deepseek-chat",
  reasoning: { supported: ["high", "xhigh"], default: "high", parameter: "reasoning_effort" },
});
ok(unrecognizedDeepSeekName.profileId, "an unknown DeepSeek model name is not guessed as official");

const root = await mkdtemp(path.join(os.tmpdir(), "native-api-settings-"));
try {
  const settingsFile = path.join(root, "native-api", "router.json");
  equal((await readRouterSettingsSnapshot(path.join(root, "absent", "router.json"))).sha256, null,
    "an absent settings file has no revision token");
  const saved = await saveRouterSettings(settingsFile, fixed);
  const snapshot = await readRouterSettingsSnapshot(settingsFile);
  const bytes = await readFile(settingsFile);
  equal(snapshot.sha256, createHash("sha256").update(bytes).digest("hex"), "settings and revision come from the same byte snapshot");
  equal(saved.sha256, snapshot.sha256, "save returns the exact committed revision token");
  equal(snapshot.settings.mode, "fixed", "snapshot returns validated settings with its revision");
  const loaded = await loadRouterSettings(settingsFile);
  equal(loaded.mode, "fixed", "settings round-trip through the plugin-owned JSON file");
  equal(loaded.profiles[profile.profileId].model, profile.model, "profile round-trip preserves exact wire model");
  ok((await stat(settingsFile)).isFile(), "settings are written as a regular file");
  const serialized = await readFile(settingsFile, "utf8");
  assert.doesNotMatch(serialized, /secret-value|Bearer\s|sk-[A-Za-z0-9]/i, "settings contain no credential value");
  checks += 1;

  const envAuth = await resolveApiCredential(profile, {
    env: { MIMO_API_KEY: "secret-value-never-serialize" },
  });
  equal(envAuth.headers.authorization, "Bearer secret-value-never-serialize", "env credential is resolved in memory for request auth");
  equal(JSON.stringify(profile).includes("secret-value-never-serialize"), false, "resolved credential is absent from profile settings");

  const currentHash = createHash("sha256").update(serialized).digest("hex");
  await assert.rejects(() => saveRouterSettings(settingsFile, { ...fixed, mode: "auto", fixedExecutor: null, profiles: {} }, { expectedSha256: currentHash }), /profiles are immutable and cannot be removed/);
  checks += 1;
  await assert.rejects(() => saveRouterSettings(settingsFile, { ...fixed, mode: "fixed" }), /expectedSha256 is required/);
  checks += 1;
  const competingA = { ...fixed, profiles: { [profile.profileId]: { ...profile, label: "MiMo A" } } };
  const competingB = { ...fixed, profiles: { [profile.profileId]: { ...profile, label: "MiMo B" } } };
  const concurrent = await Promise.allSettled([
    saveRouterSettings(settingsFile, competingA, { expectedSha256: currentHash }),
    saveRouterSettings(settingsFile, competingB, { expectedSha256: currentHash }),
  ]);
  equal(concurrent.filter((result) => result.status === "fulfilled").length, 1, "concurrent settings edits use compare-and-swap under the file lock");
  equal(concurrent.filter((result) => result.status === "rejected").length, 1, "a stale concurrent edit cannot overwrite a winner");
  const afterRace = await loadRouterSettings(settingsFile);
  equal(afterRace.profiles[profile.profileId].model, profile.model, "concurrent updates preserve the immutable profile definition");

  const fileProfile = createApiProfile({
    ...apiDefinition,
    credential: { type: "file", path: path.join(root, "api.key") },
  });
  let fileReads = 0;
  const fileAuth = await resolveApiCredential(fileProfile, {
    readSecretFile: async (file) => { fileReads += 1; equal(file, fileProfile.credential.path, "file resolver reads only the configured key file"); return "file-secret"; },
  });
  equal(fileReads, 1, "key file is read once at request resolution");
  equal(fileAuth.headers.authorization, "Bearer file-secret", "file credential is held only in the returned auth headers");

  let accountReads = 0;
  const accountAuth = await resolveApiCredential(accountProfile, {
    resolveDeepSeekAuth: () => { accountReads += 1; return { mode: "account", headers: { "x-dsh-auth-token": "account-token" } }; },
  });
  equal(accountReads, 1, "account-backed profile uses the existing DSH auth resolver");
  equal(accountAuth.headers["x-dsh-auth-token"], "account-token", "account grant stays on the official DeepSeek profile");
  await assert.rejects(() => resolveApiCredential(profile, { env: {} }), /credential is unavailable/);
  checks += 1;
  await assert.rejects(() => resolveApiCredential(accountProfile, {
    resolveDeepSeekAuth: () => ({ mode: "api-key", headers: { authorization: "Bearer unrelated" } }),
  }), /account grant is unavailable/);
  checks += 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS native API settings assertions: ${checks}`);
