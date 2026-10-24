import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_CONFIG_BEGIN,
  API_CONFIG_END,
  apiGatewayBaseUrl,
  apiIdentifiers,
  apiProfileBaseUrl,
  composeApiConfig,
  effectiveContextWindow,
  hasModelInstructions,
  readRegularOrAbsent,
  renderApiArtifacts,
  resolveApiModelInstructions,
} from "./native-api-artifacts.mjs";
import { defaultNativeApiDir, apiServicePaths, verifyApiHealth } from "./native-api-manager.mjs";
import {
  ensureGateway,
  gatewayHealth,
  prepareGatewayIdentity,
  readGatewayIdentity,
  readGatewayState,
  stopGateway,
} from "./native-gateway-manager.mjs";
import {
  createOwnedGatewayTaskLauncher,
  createWindowsTaskSchedulerAdapter,
  gatewayTaskPlan,
  registerOwnedGatewayTask,
  restoreGatewayTask,
  snapshotGatewayTask,
  statusOwnedGatewayTask,
} from "./native-gateway-task.mjs";
import { gatewaySourceEntry, stageGatewaySource, verifyGatewaySource } from "./native-gateway-source.mjs";
import { verifyRuntimeVersion } from "./native-runtime.mjs";
import { defaultRouterSettingsPath, readRouterSettingsSnapshot, resolveApiCredential, validateRouterSettings } from "./native-api-settings.mjs";
import { withFileLock } from "./plugin-state.mjs";
import { armOrReuseApiBootstrap, disarmApiBootstrap } from "./native-api-bootstrap-gate.mjs";
import { withRouterMaintenanceLock } from "./native-router-maintenance-lock.mjs";

const JOURNAL_VERSION = 1;
const REGISTRY_VERSION = 1;
export const NATIVE_API_SOURCE_FILES = Object.freeze([
  "native-api-gateway.mjs",
  "native-api-protocol.mjs",
  "native-api-serve.mjs",
  "native-api-settings.mjs",
  "native-credentials.mjs",
  "plugin-state.mjs",
]);
export const NATIVE_API_SOURCE_ENTRY = "scripts/native-api-serve.mjs";
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function sameBytes(actual, expected) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return actual === expected || (actual == null && expected == null);
  }
  return Buffer.from(actual).equals(Buffer.from(expected));
}

function bufferOrNull(value) {
  return value === null || value === undefined ? null : Buffer.from(value);
}

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function encodeValue(value) {
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
  }
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$buffer === "string") return Buffer.from(value.$buffer, "base64");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item)]));
  }
  return value;
}

function encodeJournal(value) {
  return `${JSON.stringify(encodeValue(value), null, 2)}\n`;
}

function decodeJournal(value) {
  return decodeValue(JSON.parse(value));
}

export function nativeApiPaths(apiDir = defaultNativeApiDir()) {
  const root = path.resolve(apiDir);
  return {
    root,
    settings: path.join(root, "router.json"),
    registry: path.join(root, "installed-profiles.json"),
    gatewayOrigin: path.join(root, "gateway-origin.json"),
    gatewayOriginLock: path.join(root, "gateway-origin.lock"),
    profiles: path.join(root, "profiles"),
    service: apiServicePaths(root),
    journal(profileId) {
      apiIdentifiers(profileId);
      return path.join(root, "profiles", profileId, "journal.json");
    },
  };
}

async function readJsonOrNull(file, label) {
  const bytes = await readRegularOrAbsent(file, label);
  if (bytes === null) return { bytes: null, value: null };
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} is not valid JSON: ${file}`);
  }
}

async function readRegistry(file) {
  const { bytes, value } = await readJsonOrNull(file, "native API registry");
  if (value === null) return { bytes: null, value: { version: REGISTRY_VERSION, profiles: {} } };
  if (value?.version !== REGISTRY_VERSION || !value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles)) {
    throw new Error("native API registry is invalid; refusing to modify installed profiles");
  }
  for (const id of Object.keys(value.profiles)) apiIdentifiers(id);
  return { bytes, value };
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function nativeApiRolePath(codexHome, profileId) {
  return path.join(codexHome, ...apiIdentifiers(profileId).roleFile.split("/"));
}

function catalogHasInstructions(bytes) {
  if (!bytes) return false;
  try {
    const catalog = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return Array.isArray(catalog.models) && catalog.models.length === 1 && hasModelInstructions(catalog.models[0]);
  } catch { return false; }
}

async function nativeApiModelInstructions(codexHome) {
  let cache;
  try { cache = JSON.parse(await readFile(path.join(codexHome, "models_cache.json"), "utf8")); }
  catch { throw new Error(`native models_cache.json is missing or invalid at ${path.join(codexHome, "models_cache.json")}`); }
  return resolveApiModelInstructions(cache);
}

function assertRegistryEntry(registry, journal, profileId) {
  const entry = registry?.value?.profiles?.[profileId];
  if (!entry) throw new Error(`native API registry has no entry for profile ${profileId}`);
  if (!samePath(entry.rolePath, journal.files.role.path) || !samePath(entry.catalogPath, journal.files.catalog.path)) {
    throw new Error(`native API registry entry for ${profileId} points at different artifacts`);
  }
}

async function readGatewayOrigin(file) {
  const bytes = await readRegularOrAbsent(file, "native API gateway origin");
  if (bytes === null) return null;
  let value;
  try { value = decodeJournal(bytes.toString("utf8")); }
  catch { throw new Error("native API gateway origin is not valid JSON"); }
  if (value?.version !== 1 || !value.taskPlan || !value.taskSnapshot || !value.launcher?.path || !value.launcher?.prior) {
    throw new Error("native API gateway origin is incomplete");
  }
  return { bytes, value, sha256: sha256(bytes) };
}

async function ensureGatewayOrigin({ paths, existingIds, taskPlan, taskSnapshot, launcherCurrent }) {
  return withFileLock(paths.gatewayOriginLock, async () => {
    const current = await readGatewayOrigin(paths.gatewayOrigin);
    if (current) {
      if (JSON.stringify(current.value.taskPlan) !== JSON.stringify(taskPlan)) {
        throw new Error("native API task plan differs from the shared gateway origin; rollback or reinstall all API profiles");
      }
      return current;
    }
    if (existingIds.length > 0) {
      throw new Error("native API install has profiles but no shared gateway origin; rollback or reinstall all API profiles");
    }
    const value = {
      version: 1,
      created_at: new Date().toISOString(),
      taskPlan,
      taskSnapshot,
      launcher: {
        path: taskPlan.launcher.path,
        prior: { path: taskPlan.launcher.path, exists: launcherCurrent !== null, bytes: launcherCurrent },
      },
    };
    const bytes = Buffer.from(`${JSON.stringify(encodeValue(value), null, 2)}\n`);
    await atomicWrite(paths.gatewayOrigin, bytes);
    return { bytes, value: decodeJournal(bytes.toString("utf8")), sha256: sha256(bytes) };
  }, { timeoutMs: 30_000 });
}

function registryNext(registry, profileId, artifacts) {
  const profiles = { ...registry.profiles };
  profiles[profileId] = {
    rolePath: artifacts.rolePath,
    catalogPath: artifacts.catalogPath,
    installedAt: profiles[profileId]?.installedAt || new Date().toISOString(),
  };
  return { version: REGISTRY_VERSION, profiles };
}

function registryWithout(registry, profileId) {
  const profiles = { ...registry.profiles };
  delete profiles[profileId];
  return { version: REGISTRY_VERSION, profiles };
}

async function readJournal(journalPath) {
  const file = path.resolve(journalPath);
  const bytes = await readRegularOrAbsent(file, "native API install journal");
  if (bytes === null) throw new Error(`native API install journal is missing: ${file}`);
  const journal = decodeJournal(bytes.toString("utf8"));
  if (journal?.version !== JOURNAL_VERSION || !journal.paths || !journal.files || !journal.gateway || !journal.config) {
    throw new Error("native API install journal has an unsupported or incomplete format");
  }
  return { file, journal };
}

async function writeJournal(file, journal) {
  await atomicWrite(file, Buffer.from(encodeJournal(journal), "utf8"));
}

function configHasApiBlock(content) {
  return content.replace(/\r\n/g, "\n").split("\n").some((line) => line.trim() === API_CONFIG_BEGIN)
    || content.replace(/\r\n/g, "\n").split("\n").some((line) => line.trim() === API_CONFIG_END);
}

function rootApiReference(content, gatewayBaseUrl) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const visible = line.replace(/\s+#.*$/, "").trim();
    if (!visible) continue;
    if (/^\[/.test(visible)) break;
    const match = /^(model_provider|openai_base_url)\s*=\s*(.+)$/.exec(visible);
    if (!match) continue;
    let parsed;
    try { parsed = JSON.parse(match[2]); } catch { parsed = match[2].replace(/^"|"$/g, ""); }
    if ((match[1] === "model_provider" && /^api-native-[a-f0-9]{24}$/.test(parsed))
        || (match[1] === "openai_base_url" && parsed.startsWith(`${gatewayBaseUrl}/profiles/`))) {
      return true;
    }
  }
  return false;
}

function assertAbsolute(name, value) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

async function snapshotFile(file, label) {
  const bytes = await readRegularOrAbsent(file, label);
  return { path: file, exists: bytes !== null, bytes };
}

async function currentMatches(snapshot) {
  return sameBytes(await readRegularOrAbsent(snapshot.path, "managed file"), snapshot.exists ? snapshot.bytes : null);
}

async function restoreSnapshot(snapshot) {
  if (snapshot.exists) await atomicWrite(snapshot.path, snapshot.bytes);
  else {
    const current = await readRegularOrAbsent(snapshot.path, "managed file");
    if (current !== null) await rm(snapshot.path, { force: true });
  }
}

function journalFile(pathname, nextBytes) {
  return { path: pathname, next: Buffer.from(nextBytes) };
}

function apiTaskLauncherBytes(plan) {
  if (typeof plan?.launcher?.content !== "string" || !plan.launcher.path) throw new Error("native API task plan has no launcher");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan.launcher.content, "utf16le")]);
}

function isOwnedLauncher(bytes, marker) {
  if (bytes === null || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xfe) return false;
  return bytes.toString("utf16le", 2).startsWith(`' ${marker}\r\n`);
}

function sameAbsolutePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function canonicalDefaultTaskSettingsPath({ apiDir, settingsPath, settingsSnapshot, dependencies }) {
  const env = dependencies.env || process.env;
  const getDefaultApiDir = dependencies.defaultNativeApiDir || defaultNativeApiDir;
  const getDefaultSettingsPath = dependencies.defaultRouterSettingsPath || defaultRouterSettingsPath;
  if (!sameAbsolutePath(apiDir, getDefaultApiDir(env))
      || !sameAbsolutePath(settingsPath, getDefaultSettingsPath(env))) return settingsPath;

  const canonicalPath = path.join(apiDir, "router.json");
  const resolveNative = dependencies.realpathSync || realpathSync.native;
  const statNative = dependencies.statSync || statSync;
  let nominalRealPath;
  let canonicalRealPath;
  let nominalFile;
  let canonicalFile;
  try {
    nominalRealPath = resolveNative(settingsPath);
    canonicalRealPath = resolveNative(canonicalPath);
    nominalFile = statNative(settingsPath, { bigint: true });
    canonicalFile = statNative(canonicalPath, { bigint: true });
  } catch {
    throw new Error("default API router settings alias could not be verified against its canonical file");
  }
  if (!sameAbsolutePath(nominalRealPath, canonicalRealPath)
      || !sameAbsolutePath(canonicalRealPath, canonicalPath)) {
    throw new Error("default API router settings alias does not identify the canonical settings file (native realpath mismatch)");
  }
  if (!nominalFile.isFile() || !canonicalFile.isFile()
      || nominalFile.dev !== canonicalFile.dev || nominalFile.ino === 0n || nominalFile.ino !== canonicalFile.ino) {
    throw new Error("default API router settings alias does not identify the canonical settings file (file identity mismatch)");
  }
  const readSnapshot = dependencies.readRouterSettingsSnapshot || readRouterSettingsSnapshot;
  const canonicalSnapshot = await readSnapshot(canonicalPath);
  if (!settingsSnapshot.sha256 || canonicalSnapshot.sha256 !== settingsSnapshot.sha256) {
    throw new Error("default API router settings revision changed while binding the canonical file");
  }
  return canonicalPath;
}

async function restoreLauncherIfNext(launcher) {
  const current = await readRegularOrAbsent(launcher.path, "native API task launcher");
  if (!sameBytes(current, launcher.next)) throw new Error("native API task launcher changed after activation; preserving the later change");
  await restoreSnapshot(launcher.prior);
}

export async function prepare(options = {}, dependencies = {}) {
  const apiDir = assertAbsolute("apiDir", options.apiDir || defaultNativeApiDir());
  const paths = nativeApiPaths(apiDir);
  const codexHome = assertAbsolute("codexHome", options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const versionDir = assertAbsolute("versionDir", options.versionDir);
  const settingsPath = assertAbsolute("settingsPath", options.settingsPath || paths.settings);
  const journalPath = assertAbsolute("journalPath", options.journalPath || "");
  const checkCredential = dependencies.resolveApiCredential || resolveApiCredential;
  const verifyRuntime = dependencies.verifyRuntimeVersion || verifyRuntimeVersion;
  const prepareIdentity = dependencies.prepareGatewayIdentity || prepareGatewayIdentity;
  const stageSource = dependencies.stageGatewaySource || stageGatewaySource;
  const tasks = dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const pluginRoot = options.pluginRoot ? assertAbsolute("pluginRoot", options.pluginRoot) : undefined;
  const gatewayScriptPath = options.gatewayScriptPath ? assertAbsolute("gatewayScriptPath", options.gatewayScriptPath) : undefined;
  if (Boolean(pluginRoot) === Boolean(gatewayScriptPath)) throw new Error("provide exactly one of pluginRoot or gatewayScriptPath explicitly");

  const readSnapshot = dependencies.readRouterSettingsSnapshot || readRouterSettingsSnapshot;
  const settingsSnapshot = await readSnapshot(settingsPath);
  const { settings } = settingsSnapshot;
  const profileId = options.profileId;
  const profile = settings.profiles[profileId];
  if (!profile) throw new Error("the requested API profile is not present in router settings");
  if (profile.profileId !== profileId) throw new Error("the requested API profile id does not match its definition");
  if (dependencies.requireCredential !== false) await checkCredential(profile);
  const taskSettingsPath = await canonicalDefaultTaskSettingsPath({
    apiDir,
    settingsPath,
    settingsSnapshot,
    dependencies,
  });

  await verifyRuntime(versionDir);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const existingJournalBytes = await readRegularOrAbsent(journalPath, "native API install journal");
  let replacesReceipt = null;
  if (existingJournalBytes !== null) {
    let existing;
    try { existing = decodeJournal(existingJournalBytes.toString("utf8")); }
    catch { throw new Error(`native API install journal is not valid JSON: ${journalPath}`); }
    if (existing?.version !== JOURNAL_VERSION || existing.phase !== "rolled_back" || existing.indeterminateStages?.length) {
      throw new Error(`native API install journal already exists in phase ${existing?.phase ?? "unknown"}; only a fully rolled-back journal may be prepared again`);
    }
    replacesReceipt = `${journalPath}.receipt-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    await atomicWrite(replacesReceipt, existingJournalBytes);
  }
  const identity = await prepareIdentity({ paths: paths.service });
  const gatewayBaseUrl = apiGatewayBaseUrl(identity);
  const source = gatewayScriptPath
    ? { entry: gatewayScriptPath, direct: true }
    : await stageSource({
      pluginRoot,
      runtimeRoot: paths.root,
      sourceFiles: NATIVE_API_SOURCE_FILES,
      entry: NATIVE_API_SOURCE_ENTRY,
    });
  const gatewayScript = source.direct ? gatewayScriptPath : gatewaySourceEntry(source, paths.root);

  const modelInstructions = await nativeApiModelInstructions(codexHome);
  const artifacts = renderApiArtifacts(profile, {
    codexHome,
    baseUrl: apiProfileBaseUrl(gatewayBaseUrl, profileId),
    modelInstructions,
  });
  const registrySnapshot = await readRegistry(paths.registry);
  const existingIds = Object.keys(registrySnapshot.value.profiles);
  if (existingIds.length) {
    const configSnapshot = await snapshotFile(path.join(codexHome, "config.toml"), "Codex config");
    const current = configSnapshot.exists ? configSnapshot.bytes.toString("utf8") : "";
    if (composeApiConfig(current, { profileIds: existingIds, gatewayBaseUrl, codexHome }) !== current) {
      throw new Error("installed native API providers changed outside their owned config block");
    }
  }
  const roleSnapshot = await snapshotFile(artifacts.rolePath, "native API role");
  const catalogSnapshot = await snapshotFile(artifacts.catalogPath, "native API catalog");
  if (roleSnapshot.exists && !roleSnapshot.bytes.equals(artifacts.roleBytes)) {
    throw new Error("an unowned native API role file already exists; refusing to overwrite it");
  }
  if (catalogSnapshot.exists && !catalogSnapshot.bytes.equals(artifacts.catalogBytes)) {
    throw new Error("an unowned native API catalog already exists; refusing to overwrite it");
  }
  if (registrySnapshot.value.profiles[profileId]) {
    throw new Error("this API profile is already installed");
  }
  const configSnapshot = await snapshotFile(path.join(codexHome, "config.toml"), "Codex config");
  const priorConfig = configSnapshot.exists ? configSnapshot.bytes.toString("utf8") : "";
  if (configHasApiBlock(priorConfig) && existingIds.length === 0) {
    throw new Error("native API config block exists without an owned registry; refusing to adopt it");
  }
  const nextIds = [...existingIds, profileId];
  const nextConfig = composeApiConfig(priorConfig, { profileIds: nextIds, gatewayBaseUrl, codexHome });
  const nextRegistry = registryNext(registrySnapshot.value, profileId, artifacts);
  const taskPlan = gatewayTaskPlan({ paths: paths.service, gatewayScriptPath: gatewayScript, service: "api", settingsPath: taskSettingsPath });
  const taskSnapshot = await snapshotGatewayTask(taskPlan, tasks);
  const launcherNext = apiTaskLauncherBytes(taskPlan);
  const launcherCurrent = await readRegularOrAbsent(taskPlan.launcher.path, "native API task launcher");
  if (launcherCurrent !== null && !sameBytes(launcherCurrent, launcherNext) && !isOwnedLauncher(launcherCurrent, taskPlan.marker)) {
    throw new Error("an unowned native API task launcher already exists; refusing to overwrite it");
  }
  const gatewayOrigin = await ensureGatewayOrigin({
    paths,
    existingIds,
    taskPlan,
    taskSnapshot,
    launcherCurrent,
  });
  const identityBytes = await readRegularOrAbsent(paths.service.identity, "native API gateway identity");
  if (identityBytes === null) throw new Error("native API gateway identity was not persisted");

  const journal = {
    version: JOURNAL_VERSION,
    phase: "prepared",
    ...(replacesReceipt ? { replacesReceipt } : {}),
    paths: {
      apiDir,
      codexHome,
      versionDir,
      settingsPath: taskSettingsPath,
      journalPath,
      gatewayDir: paths.service.dir,
      gatewayScript,
      gatewaySourceRoot: paths.root,
    },
    profile: { profileId, model: profile.model, protocol: profile.protocol, contextWindow: effectiveContextWindow(profile) },
    source: source.direct ? { direct: true, entry: gatewayScript } : source,
    gateway: {
      identityFile: paths.service.identity,
      identitySha256: sha256(identityBytes),
      taskPlan,
      taskSnapshot,
      originFile: paths.gatewayOrigin,
      originSha256: gatewayOrigin.sha256,
      launcher: {
        path: taskPlan.launcher.path,
        prior: { path: taskPlan.launcher.path, exists: launcherCurrent !== null, bytes: launcherCurrent },
        next: launcherNext,
      },
    },
    config: {
      path: path.join(codexHome, "config.toml"),
      profileIds: nextIds,
      priorText: priorConfig,
      nextText: nextConfig,
    },
    files: {
      role: { ...journalFile(artifacts.rolePath, artifacts.roleBytes), prior: roleSnapshot },
      catalog: { ...journalFile(artifacts.catalogPath, artifacts.catalogBytes), prior: catalogSnapshot },
      registry: {
        path: paths.registry,
        next: Buffer.from(`${JSON.stringify(nextRegistry, null, 2)}\n`),
        prior: {
          path: paths.registry,
          exists: registrySnapshot.bytes !== null,
          bytes: registrySnapshot.bytes,
        },
      },
    },
    completed: { launcher: false, files: false, task: false },
  };
  await writeJournal(journalPath, journal);
  return {
    prepared: true,
    journalPath,
    profileId,
    rolePath: artifacts.rolePath,
    catalogPath: artifacts.catalogPath,
    gatewayPort: identity.port,
  };
}

async function assertPrepared(journal, tasks, verifyRuntime, verifySource) {
  await verifyRuntime(journal.paths.versionDir);
  if (!journal.source.direct) await verifySource(journal.source, { runtimeRoot: journal.paths.gatewaySourceRoot });
  const identityBytes = await readRegularOrAbsent(journal.gateway.identityFile, "native API gateway identity");
  if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) {
    throw new Error("native API gateway identity changed since prepare");
  }
  if (!journal.gateway.launcher) throw new Error("native API install journal has no launcher snapshot; reinstall the profile");
  const launcherCurrent = await readRegularOrAbsent(journal.gateway.launcher.path, "native API task launcher");
  if (!sameBytes(launcherCurrent, journal.gateway.launcher.prior.bytes)) {
    throw new Error("native API task launcher changed since prepare");
  }
  for (const item of Object.values(journal.files)) {
    const current = await readRegularOrAbsent(item.path, "managed file");
    const prior = item.prior.bytes;
    if (!sameBytes(current, prior)) throw new Error(`native API file changed since prepare: ${item.path}`);
  }
  const configItem = journal.config;
  const currentConfig = await readRegularOrAbsent(configItem.path, "Codex config");
  if ((currentConfig === null ? "" : currentConfig.toString("utf8")) !== configItem.priorText) {
    throw new Error("Codex config changed since native API prepare");
  }
  const currentTask = await snapshotGatewayTask(journal.gateway.taskPlan, tasks);
  if (JSON.stringify(currentTask) !== JSON.stringify(journal.gateway.taskSnapshot)) {
    throw new Error("native API Task Scheduler task changed since prepare");
  }
  if (!samePath(journal.files.role.path, nativeApiRolePath(journal.paths.codexHome, journal.profile.profileId))) {
    throw new Error("native API role path changed since prepare");
  }
}

async function verifiedGatewayBaseUrl(journal) {
  const identityBytes = await readRegularOrAbsent(journal.gateway.identityFile, "native API gateway identity");
  if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) {
    throw new Error("native API gateway identity changed after activation");
  }
  let identity;
  try { identity = JSON.parse(identityBytes.toString("utf8")); } catch { throw new Error("native API gateway identity is invalid"); }
  return apiGatewayBaseUrl(identity);
}

export async function activate({ journalPath } = {}, dependencies = {}) {
  const { file, journal } = await readJournal(journalPath);
  if (journal.phase !== "prepared") throw new Error(`cannot activate native API install in phase ${journal.phase}`);
  const tasks = dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const verifyRuntime = dependencies.verifyRuntimeVersion || verifyRuntimeVersion;
  const verifySource = dependencies.verifyGatewaySource || verifyGatewaySource;
  await assertPrepared(journal, tasks, verifyRuntime, verifySource);

  const written = [];
  let taskAttempted = false;
  let taskRegistered = false;
  let launcherAttempted = false;
  try {
    launcherAttempted = true;
    await atomicWrite(journal.gateway.launcher.path, journal.gateway.launcher.next);
    journal.completed.launcher = true;
    await writeJournal(file, journal);
    for (const [name, item] of Object.entries(journal.files)) {
      await atomicWrite(item.path, item.next);
      written.push(name);
    }
    await atomicWrite(journal.config.path, Buffer.from(journal.config.nextText, "utf8"));
    written.push("config");
    taskAttempted = true;
    await registerOwnedGatewayTask(journal.gateway.taskPlan, tasks);
    taskRegistered = true;
    journal.completed.files = true;
    journal.completed.task = true;
    journal.phase = "active";
    await writeJournal(file, journal);
    return {
      activated: true,
      phase: journal.phase,
      journalPath: file,
      profileId: journal.profile.profileId,
      restartNeeded: true,
      taskState: (await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks)).state,
    };
  } catch (error) {
    const recoveryErrors = [];
    if (taskAttempted) {
      try { await restoreGatewayTask(journal.gateway.taskSnapshot, journal.gateway.taskPlan, tasks); }
      catch (item) { recoveryErrors.push(item); }
    }
    if (launcherAttempted) {
      try {
        if (sameBytes(await readRegularOrAbsent(journal.gateway.launcher.path, "native API task launcher"), journal.gateway.launcher.next)) {
          await restoreSnapshot(journal.gateway.launcher.prior);
        }
      } catch (item) { recoveryErrors.push(item); }
    }
    for (const name of [...written].reverse()) {
      try {
        if (name === "config") await restoreSnapshot({ path: journal.config.path, exists: journal.config.priorText.length > 0, bytes: Buffer.from(journal.config.priorText, "utf8") });
        else await restoreSnapshot(journal.files[name].prior);
      } catch (item) { recoveryErrors.push(item); }
    }
    journal.phase = recoveryErrors.length ? "activation_recovery_failed" : "activation_failed";
    journal.recoveryErrors = recoveryErrors.map((item) => item.message);
    await writeJournal(file, journal).catch((item) => recoveryErrors.push(item));
    if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], "native API activation failed and recovery was incomplete");
    throw error;
  }
}

export async function rollback({ journalPath } = {}, dependencies = {}) {
  const { file, journal } = await readJournal(journalPath);
  if (journal.phase === "prepared") {
    journal.phase = "rolled_back";
    await writeJournal(file, journal);
    return { rolled_back: true, removed: false, profileId: journal.profile.profileId };
  }
  if (journal.phase !== "active") throw new Error(`cannot roll back native API install in phase ${journal.phase}`);
  const tasks = dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const currentTask = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
  if (!currentTask.exists || !currentTask.owned || currentTask.specMatches !== true) {
    throw new Error("native API Task Scheduler task changed; refusing rollback");
  }
  for (const name of ["role", "catalog"]) {
    const item = journal.files[name];
    if (!sameBytes(await readRegularOrAbsent(item.path, "managed file"), item.next)) {
      throw new Error(`native API ${name} changed after activation; refusing rollback`);
    }
  }
  if (!samePath(journal.files.role.path, nativeApiRolePath(journal.paths.codexHome, journal.profile.profileId))) {
    throw new Error("native API role path changed after activation; refusing rollback");
  }
  if (!journal.completed.launcher || !journal.gateway.launcher) {
    throw new Error("native API install journal has no activated launcher; reinstall the profile");
  }
  if (!sameBytes(await readRegularOrAbsent(journal.gateway.launcher.path, "native API task launcher"), journal.gateway.launcher.next)) {
    throw new Error("native API task launcher changed after activation; refusing rollback");
  }
  const currentConfigBytes = await readRegularOrAbsent(journal.config.path, "Codex config");
  const currentConfig = currentConfigBytes === null ? "" : currentConfigBytes.toString("utf8");
  const gatewayBaseUrl = await verifiedGatewayBaseUrl(journal);
  const registry = await readRegistry(journal.files.registry.path);
  assertRegistryEntry(registry, journal, journal.profile.profileId);
  const registryIds = Object.keys(registry.value.profiles);
  const allComposed = composeApiConfig(currentConfig, {
    profileIds: registryIds,
    gatewayBaseUrl,
    codexHome: journal.paths.codexHome,
  });
  const legacyComposed = composeApiConfig(currentConfig, {
    profileIds: registryIds,
    gatewayBaseUrl,
    registerAgentRoles: false,
  });
  if (currentConfig !== allComposed && currentConfig !== legacyComposed) {
    throw new Error("native API provider block changed after activation; refusing rollback");
  }
  const remainingIds = registryIds.filter((id) => id !== journal.profile.profileId);
  const nextConfig = currentConfigBytes.equals(Buffer.from(journal.config.nextText, "utf8"))
    ? composeApiConfig(journal.config.priorText, {
      profileIds: journal.config.profileIds.filter((id) => id !== journal.profile.profileId),
      gatewayBaseUrl,
      codexHome: journal.paths.codexHome,
    })
    : composeApiConfig(currentConfig, { profileIds: remainingIds, gatewayBaseUrl, codexHome: journal.paths.codexHome });
  const nextRegistry = registryWithout(registry.value, journal.profile.profileId);
  let origin = null;
  if (remainingIds.length === 0) {
    if (!journal.gateway.originFile) throw new Error("native API gateway origin is missing; refusing rollback");
    origin = await readGatewayOrigin(journal.gateway.originFile);
    if (!origin) throw new Error("native API gateway origin is missing; refusing rollback");
    if (journal.gateway.originSha256 && origin.sha256 !== journal.gateway.originSha256) {
      throw new Error("native API gateway origin changed; refusing to restore a different baseline");
    }
    if (path.resolve(origin.value.launcher.path) !== path.resolve(journal.gateway.launcher.path)) {
      throw new Error("native API gateway origin launcher path differs from this install");
    }
  }
  if (remainingIds.length === 0) {
    const servicePaths = apiServicePaths(journal.paths.apiDir);
    if (await readGatewayState(servicePaths) !== null) {
      const stopped = await (dependencies.stopGateway || stopGateway)({ paths: servicePaths });
      if (stopped?.stopped !== true && stopped?.reason !== "not_running") {
        throw new Error(`native API gateway did not stop during rollback: ${stopped?.reason || "unknown"}`);
      }
    }
  }
  await atomicWrite(journal.config.path, Buffer.from(nextConfig, "utf8"));
  await atomicWrite(journal.files.registry.path, Buffer.from(`${JSON.stringify(nextRegistry, null, 2)}\n`, "utf8"));
  await rm(journal.files.role.path, { force: true });
  await rm(journal.files.catalog.path, { force: true });
  if (remainingIds.length === 0) {
    await restoreGatewayTask(origin.value.taskSnapshot, origin.value.taskPlan, tasks);
    await restoreLauncherIfNext({ ...journal.gateway.launcher, prior: origin.value.launcher.prior });
    if (journal.gateway.originFile) await rm(journal.gateway.originFile, { force: true });
  }
  journal.phase = "rolled_back";
  journal.completed.files = false;
  journal.completed.task = remainingIds.length > 0;
  journal.completed.launcher = remainingIds.length > 0;
  await writeJournal(file, journal);
  return {
    rolled_back: true,
    removed: true,
    profileId: journal.profile.profileId,
    remainingProfiles: remainingIds,
  };
}

export async function status({ journalPath } = {}) {
  const { file, journal } = await readJournal(journalPath);
  return {
    phase: journal.phase,
    profileId: journal.profile.profileId,
    configured: journal.phase === "active",
    restartNeeded: journal.phase === "active" ? "unknown" : false,
    journalPath: file,
    rolePath: journal.files.role.path,
    catalogPath: journal.files.catalog.path,
  };
}

export async function inspectNativeApiDispatchState({
  profileId,
  apiDir = defaultNativeApiDir(),
  settingsPath,
  journalPath,
  taskAdapter,
  requireRunning = false,
  requireCredential = true,
} = {}, dependencies = {}) {
  const paths = nativeApiPaths(apiDir);
  const file = journalPath ? path.resolve(journalPath) : paths.journal(profileId);
  const { journal } = await readJournal(file);
  if (journal.profile.profileId !== profileId) throw new Error("native API install journal belongs to another profile");
  if (journal.phase !== "active" || !journal.completed.launcher || !journal.completed.files || !journal.completed.task) {
    throw new Error("native API profile artifacts are not fully activated");
  }
  const verifyRuntime = dependencies.verifyRuntimeVersion || verifyRuntimeVersion;
  const verifySource = dependencies.verifyGatewaySource || verifyGatewaySource;
  await verifyRuntime(journal.paths.versionDir);
  if (!journal.source.direct) await verifySource(journal.source, { runtimeRoot: journal.paths.gatewaySourceRoot });
  const { settings } = await readRouterSettingsSnapshot(settingsPath || journal.paths.settingsPath || paths.settings);
  const profile = settings.profiles[profileId];
  if (!profile) throw new Error("the installed API profile is missing from router settings");
  if (profile.model !== journal.profile.model || effectiveContextWindow(profile) !== journal.profile.contextWindow) {
    throw new Error("the installed API profile no longer matches its immutable artifact definition");
  }
  if (dependencies.resolveApiCredential || requireCredential) {
    const resolveCredential = dependencies.resolveApiCredential || resolveApiCredential;
    await resolveCredential(profile);
  }
  const identityBytes = await readRegularOrAbsent(journal.gateway.identityFile, "native API gateway identity");
  if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) {
    throw new Error("native API gateway identity changed after activation");
  }
  if (!journal.gateway.launcher || !sameBytes(
    await readRegularOrAbsent(journal.gateway.launcher.path, "native API task launcher"),
    journal.gateway.launcher.next,
  )) {
    throw new Error("native API task launcher changed after activation");
  }
  const servicePaths = apiServicePaths(journal.paths.apiDir);
  const identity = await readGatewayIdentity(servicePaths);
  const gatewayBaseUrl = apiGatewayBaseUrl(identity);
  if (!identity?.token) {
    throw new Error("native API gateway identity does not match the installed provider URLs");
  }
  for (const name of ["role", "catalog"]) {
    const item = journal.files[name];
    const current = await readRegularOrAbsent(item.path, "managed file");
    if (!sameBytes(current, item.next)) {
      throw new Error(`native API ${name} changed after activation`);
    }
    if (name === "catalog" && !catalogHasInstructions(current)) {
      throw new Error("native API catalog is missing model instructions; apply the API configuration to refresh it");
    }
  }
  if (!samePath(journal.files.role.path, nativeApiRolePath(journal.paths.codexHome, profileId))) {
    throw new Error("native API role path changed after activation");
  }
  const registry = await readRegistry(journal.files.registry.path);
  assertRegistryEntry(registry, journal, profileId);
  const configBytes = await readRegularOrAbsent(journal.config.path, "Codex config");
  const config = configBytes === null ? "" : configBytes.toString("utf8");
  const composed = composeApiConfig(config, {
    profileIds: Object.keys(registry.value.profiles),
    gatewayBaseUrl,
    codexHome: journal.paths.codexHome,
  });
  if (composed !== config) throw new Error("native API provider config changed after activation");
  if (rootApiReference(config, gatewayBaseUrl)) {
    throw new Error("the root Sol provider references the native API gateway");
  }
  const tasks = taskAdapter || createWindowsTaskSchedulerAdapter();
  const task = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
  if (!task.exists || !task.owned || task.specMatches !== true || !task.enabled) {
    throw new Error("native API Task Scheduler task is missing, changed, or disabled");
  }
  if (requireRunning) {
    if (task.state !== "Running") throw new Error("native API Task Scheduler task is not Running");
    const state = await readGatewayState(servicePaths);
    if (!state || state.token !== identity.token || state.port !== identity.port || !Number.isInteger(state.pid)) {
      throw new Error("native API gateway state does not match its private identity");
    }
    await verifyApiHealth(state);
  }
  return { ready: true, profile, journal, journalPath: file, taskState: task.state };
}

export async function ensureNativeApiDispatch(options = {}, dependencies = {}) {
  const inspected = await inspectNativeApiDispatchState({ ...options, requireRunning: false }, dependencies);
  const paths = apiServicePaths(inspected.journal.paths.apiDir);
  const tasks = options.taskAdapter || dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const launchImpl = createOwnedGatewayTaskLauncher(inspected.journal.gateway.taskPlan, tasks);
  const ensured = await (dependencies.ensureGateway || ensureGateway)({ paths, launchImpl });
  const identity = await readGatewayIdentity(paths);
  const state = ensured.state;
  if (!state?.token || state.token !== identity?.token || state.port !== identity?.port || !Number.isInteger(state.pid)) {
    throw new Error("native API gateway state does not match its private identity");
  }
  const health = await gatewayHealth(state);
  if (health.reachable !== true || health.pid !== state.pid) throw new Error("native API gateway is not healthy");
  await verifyApiHealth(state);
  const task = await statusOwnedGatewayTask(inspected.journal.gateway.taskPlan, tasks);
  if (task.state !== "Running") throw new Error("native API Task Scheduler task is not Running");
  const final = await inspectNativeApiDispatchState({ ...options, requireRunning: true }, dependencies);
  return { ready: true, profile: final.profile, journal: final.journal, taskState: task.state, pid: state.pid };
}

async function journalIfPresent(file) {
  const bytes = await readRegularOrAbsent(file, "native API install journal");
  if (bytes === null) return null;
  try {
    const journal = decodeJournal(bytes.toString("utf8"));
    return journal?.version === JOURNAL_VERSION ? journal : null;
  } catch {
    throw new Error(`native API install journal is invalid JSON: ${file}`);
  }
}

async function stagedVersionDirectories(root, label) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name))
      .sort()
      .reverse();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`cannot inspect ${label}: ${error.message}`);
  }
}

export async function discoverCompatibleRuntime({ apiDir = defaultNativeApiDir(), env = process.env, verifyRuntime = verifyRuntimeVersion } = {}) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === "string" && path.isAbsolute(value) && !candidates.includes(value)) candidates.push(path.resolve(value));
  };
  add(env.SOL_LUNA_NATIVE_API_VERSION_DIR);
  if (env.SOL_LUNA_NATIVE_INSTALL_JOURNAL) {
    try {
      // This may be the DeepSeek installer journal, which has a different
      // top-level shape than an API install journal. Read only its immutable
      // runtime locator instead of requiring API-only fields.
      const legacy = JSON.parse(await readFile(path.resolve(env.SOL_LUNA_NATIVE_INSTALL_JOURNAL), "utf8"));
      add(legacy?.paths?.versionDir);
    } catch { /* a missing or foreign journal is not a runtime candidate */ }
  }
  const paths = nativeApiPaths(apiDir);
  try {
    const entries = await readdir(paths.profiles, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
      const journal = await journalIfPresent(paths.journal(entry.name)).catch(() => null);
      add(journal?.paths?.versionDir);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const root = path.dirname(paths.root);
  for (const versionRoot of [
    path.join(paths.root, "runtime", "versions"),
    path.join(root, "native-isolated", "runtime", "versions"),
  ]) {
    for (const versionDir of await stagedVersionDirectories(versionRoot, "native runtime versions")) add(versionDir);
  }
  let firstError = null;
  for (const versionDir of candidates) {
    try {
      const verified = await verifyRuntime(versionDir);
      return { versionDir, exePath: verified.exePath, error: null };
    } catch (error) {
      firstError ||= error.message;
    }
  }
  return { versionDir: null, exePath: null, error: firstError || "no approved native runtime is staged" };
}

export async function discoverApplyCompatibleRuntime({codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), verifyRuntime = verifyRuntimeVersion} = {}) {
  const versionsRoot = path.join(path.resolve(codexHome), "router-runtime", "versions");
  const candidates = await stagedVersionDirectories(versionsRoot, "approved persistent API runtime versions");
  let firstError = null;
  for (const versionDir of candidates) {
    try {
      const verified = await verifyRuntime(versionDir);
      return {versionDir, exePath: verified.exePath, error: null};
    } catch (error) { firstError ||= error.message; }
  }
  return {versionDir: null, exePath: null, error: firstError || `no approved runtime is staged below ${versionsRoot}`};
}

export async function getExecutorStatus({ settings, profileId } = {}, dependencies = {}) {
  const validated = validateRouterSettings(settings);
  const apiDir = dependencies.apiDir || defaultNativeApiDir();
  const paths = nativeApiPaths(apiDir);
  let selected = null;
  if (profileId !== undefined) {
    if (typeof profileId !== "string" || !validated.profiles[profileId]) throw new Error("the requested API profile is not present in settings");
    selected = validated.profiles[profileId];
  } else if (validated.fixedExecutor && validated.profiles[validated.fixedExecutor]) {
    selected = validated.profiles[validated.fixedExecutor];
  } else {
    const profiles = Object.values(validated.profiles);
    if (profiles.length === 1) selected = profiles[0];
  }
  if (!selected) {
    return {
      installed: false,
      runtimeCompatible: false,
      restartRequired: false,
      gatewayRunning: false,
      localHealthy: false,
      credentialAvailable: false,
      apiVerified: false,
      detail: "尚未选择 API 配置；请先保存并选择一个 profile。",
    };
  }
  let journal = null;
  try { journal = await journalIfPresent(paths.journal(selected.profileId)); }
  catch { journal = null; }
  let runtime;
  if (journal?.paths?.versionDir) {
    try {
      const verified = await (dependencies.verifyRuntimeVersion || verifyRuntimeVersion)(journal.paths.versionDir);
      runtime = { versionDir: journal.paths.versionDir, exePath: verified.exePath, error: null };
    } catch (error) {
      runtime = { versionDir: null, exePath: null, error: error.message };
    }
  } else {
    runtime = await discoverCompatibleRuntime({
      apiDir,
      env: dependencies.env || process.env,
      verifyRuntime: dependencies.verifyRuntimeVersion || verifyRuntimeVersion,
    });
  }
  let credentialAvailable = false;
  try {
    await (dependencies.resolveApiCredential || resolveApiCredential)(selected);
    credentialAvailable = true;
  } catch { credentialAvailable = false; }

  let installed = false;
  if (journal?.phase === "active" && journal.completed?.launcher && journal.completed?.files && journal.completed?.task) {
    const roleOk = samePath(journal.files.role.path, nativeApiRolePath(journal.paths.codexHome, selected.profileId))
      && sameBytes(await readRegularOrAbsent(journal.files.role.path, "managed file"), journal.files.role.next);
    const catalogBytes = await readRegularOrAbsent(journal.files.catalog.path, "managed file");
    const catalogOk = sameBytes(catalogBytes, journal.files.catalog.next) && catalogHasInstructions(catalogBytes);
    const launcherOk = Boolean(journal.gateway?.launcher) && sameBytes(
      await readRegularOrAbsent(journal.gateway.launcher.path, "native API task launcher"),
      journal.gateway.launcher.next,
    );
    let configOk = false;
    let registryOk = false;
    let registry = null;
    try {
      registry = await readRegistry(journal.files.registry.path);
      assertRegistryEntry(registry, journal, selected.profileId);
      registryOk = true;
    } catch { registryOk = false; }
    try {
      const identity = await readGatewayIdentity(apiServicePaths(apiDir));
      const configBytes = await readRegularOrAbsent(journal.config.path, "Codex config");
      const config = configBytes === null ? "" : configBytes.toString("utf8");
      configOk = composeApiConfig(config, {
        profileIds: registry ? Object.keys(registry.value.profiles) : journal.config.profileIds,
        gatewayBaseUrl: apiGatewayBaseUrl(identity),
        codexHome: journal.paths.codexHome,
      }) === config;
    } catch { configOk = false; }
    installed = roleOk && catalogOk && launcherOk && configOk && registryOk;
  }

  let gatewayRunning = false;
  let localHealthy = false;
  try {
    const tasks = dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
    const task = journal ? await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks) : null;
    gatewayRunning = Boolean(task?.exists && task.owned && task.specMatches === true && task.enabled && task.state === "Running");
    if (gatewayRunning) {
      const state = await readGatewayState(apiServicePaths(apiDir));
      if (state) {
        const health = await gatewayHealth(state);
        localHealthy = health.reachable === true && health.pid === state.pid
          && health.api_only === true && health.relay_allowed === false;
      }
    }
  } catch { gatewayRunning = false; localHealthy = false; }

  const detail = !runtime.versionDir
    ? `当前 runtime 与已批准补丁不兼容：${runtime.error}；不会启动服务或冒充 ready。`
    : !installed
      ? "配置已保存但尚未安装角色；需要显式点击“应用 API 配置”。"
      : "角色文件已安装；新增角色应用后需要完整重启 Codex，但当前采用状态无法自动确认。本地健康不代表认证或模型调用通过。";
  return {
    installed,
    runtimeCompatible: Boolean(runtime.versionDir),
    restartRequired: installed ? "unknown" : false,
    gatewayRunning,
    localHealthy,
    credentialAvailable,
    apiVerified: false,
    detail,
  };
}

async function repairLegacyApiRoleRegistrations(journal, { codexHome, runtimeDir, profile, dependencies }) {
  if (journal.phase !== "active" || !journal.completed?.launcher || !journal.completed?.files || !journal.completed?.task
      || path.resolve(journal.paths.codexHome) !== path.resolve(codexHome)
      || path.resolve(journal.paths.versionDir) !== path.resolve(runtimeDir)) return false;
  await (dependencies.verifyRuntimeVersion || verifyRuntimeVersion)(journal.paths.versionDir);
  if (!journal.source.direct) {
    await (dependencies.verifyGatewaySource || verifyGatewaySource)(journal.source, { runtimeRoot: journal.paths.gatewaySourceRoot });
  }
  if (!samePath(journal.files.role.path, nativeApiRolePath(codexHome, journal.profile.profileId))) return false;
  if (!sameBytes(await readRegularOrAbsent(journal.files.role.path, "managed file"), journal.files.role.next)) return false;
  const catalogBefore = await readRegularOrAbsent(journal.files.catalog.path, "managed file");
  const catalogMatchesJournal = sameBytes(catalogBefore, journal.files.catalog.next);
  if (!journal.gateway.launcher || !sameBytes(
    await readRegularOrAbsent(journal.gateway.launcher.path, "native API task launcher"),
    journal.gateway.launcher.next,
  )) return false;
  const registry = await readRegistry(journal.files.registry.path);
  assertRegistryEntry(registry, journal, journal.profile.profileId);
  const identityBytes = await readRegularOrAbsent(journal.gateway.identityFile, "native API gateway identity");
  if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) return false;
  const identity = await readGatewayIdentity(apiServicePaths(journal.paths.apiDir));
  const configBytes = await readRegularOrAbsent(journal.config.path, "Codex config");
  const currentConfig = configBytes === null ? "" : configBytes.toString("utf8");
  const profileIds = Object.keys(registry.value.profiles);
  const gatewayBaseUrl = apiGatewayBaseUrl(identity);
  if (rootApiReference(currentConfig, gatewayBaseUrl)) return false;
  const legacyConfig = composeApiConfig(currentConfig, {
    profileIds,
    gatewayBaseUrl,
    registerAgentRoles: false,
  });
  const nextConfig = composeApiConfig(currentConfig, { profileIds, gatewayBaseUrl, codexHome });
  if (legacyConfig !== currentConfig && nextConfig !== currentConfig) return false;
  const refreshCatalog = !catalogHasInstructions(catalogBefore) || !catalogMatchesJournal;
  let catalogNext = null;
  let catalogNeedsWrite = false;
  if (refreshCatalog) {
    if (!profile || profile.profileId !== journal.profile.profileId || profile.model !== journal.profile.model) return false;
    const modelInstructions = await nativeApiModelInstructions(codexHome);
    const artifacts = renderApiArtifacts(profile, {
      codexHome,
      baseUrl: apiProfileBaseUrl(gatewayBaseUrl, profile.profileId),
      modelInstructions,
    });
    catalogNext = artifacts.catalogBytes;
    if (sameBytes(catalogBefore, catalogNext)) catalogNeedsWrite = false;
    else if (catalogMatchesJournal && !catalogHasInstructions(catalogBefore)) catalogNeedsWrite = true;
    else return false;
  }
  if (nextConfig === currentConfig && !refreshCatalog) return false;
  const tasks = dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const task = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
  if (!task.exists || !task.owned || task.specMatches !== true || !task.enabled) return false;
  const journalPath = journal.paths.journalPath;
  if (!journalPath) return false;
  return withFileLock(`${journalPath}.repair-lock`, async () => {
    const journalBefore = await readRegularOrAbsent(journalPath, "native API install journal");
    if (!journalBefore || encodeJournal(decodeJournal(journalBefore.toString("utf8"))) !== encodeJournal(journal)) {
      throw new Error("native API journal changed during API catalog repair; reload before applying");
    }
    const configBeforeWrite = await readRegularOrAbsent(journal.config.path, "Codex config");
    const catalogBeforeWrite = await readRegularOrAbsent(journal.files.catalog.path, "native API catalog");
    if (!sameBytes(configBeforeWrite, configBytes) || !sameBytes(catalogBeforeWrite, catalogBefore)) {
      throw new Error("native API config or catalog changed during repair; preserving the later change");
    }
    if (catalogNext) {
      if (catalogNeedsWrite) await atomicWrite(journal.files.catalog.path, catalogNext);
      journal.files.catalog.next = catalogNext;
      await writeJournal(journalPath, journal);
    }
    if (nextConfig !== currentConfig) await atomicWrite(journal.config.path, Buffer.from(nextConfig, "utf8"));
    return true;
  });
}

export async function applyApiConfiguration(args = {}, dependencies = {}) {
  return withRouterMaintenanceLock({env: dependencies.env, codexHome: dependencies.codexHome},
    () => applyApiConfigurationUnlocked(args, dependencies));
}

async function applyApiConfigurationUnlocked({ settings, expectedSha256 } = {}, dependencies = {}) {
  const validated = validateRouterSettings(settings);
  const apiDir = dependencies.apiDir || defaultNativeApiDir();
  const paths = nativeApiPaths(apiDir);
  const settingsPath = assertAbsolute("settingsPath", dependencies.settingsPath || paths.settings);
  const codexHome = assertAbsolute("codexHome", dependencies.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const snapshot = await (dependencies.readRouterSettingsSnapshot || readRouterSettingsSnapshot)(settingsPath);
  if (expectedSha256 !== undefined && expectedSha256 !== snapshot.sha256) {
    throw new Error("router settings changed since they were read; reload before applying API configuration");
  }
  if (JSON.stringify(stableJson(snapshot.settings)) !== JSON.stringify(stableJson(validated))) {
    throw new Error("router settings must be saved before applying API configuration");
  }
  if (snapshot.settings.enabled === false) {
    return {
      applied: false,
      supported: true,
      restartRequired: false,
      detail: "自动分工已关闭；API 配置已保留，启用分工后再显式应用。",
      appliedProfiles: [],
      alreadyInstalled: [],
    };
  }
  const runtime = await (dependencies.discoverApplyCompatibleRuntime || discoverApplyCompatibleRuntime)({
    codexHome,
    verifyRuntime: dependencies.verifyRuntimeVersion || verifyRuntimeVersion,
  });
  if (!runtime.versionDir) {
    return {
      applied: false,
      supported: false,
      restartRequired: "unknown",
      detail: `当前 runtime 未支持 API 配置应用（unsupported/not installed）：${runtime.error}；不会下载、安装、启动或重启任何组件。`,
      appliedProfiles: [],
      alreadyInstalled: [],
    };
  }
  let bootstrap = null;
  if (Object.keys(validated.profiles).length > 0) {
    try {
      bootstrap = await (dependencies.armOrReuseApiBootstrap || armOrReuseApiBootstrap)({
        runtimeDir: runtime.versionDir,
        codexHome,
        env: {...(dependencies.env || process.env), CODEX_HOME: codexHome},
        ...(dependencies.bootstrapEnvironmentAdapter ? {adapter: dependencies.bootstrapEnvironmentAdapter} : {}),
        ...(dependencies.armApiBootstrap ? {arm: dependencies.armApiBootstrap} : {}),
        ...(dependencies.disarmApiBootstrap ? {disarm: dependencies.disarmApiBootstrap} : {}),
        ...(dependencies.bootstrapSourcePath ? {bootstrapSourcePath: dependencies.bootstrapSourcePath} : {}),
        ...(dependencies.verifyRuntimeVersion ? {verifyRuntimeVersion: dependencies.verifyRuntimeVersion} : {}),
      });
    } catch (error) {
      return {
        applied: false,
        supported: false,
        restartRequired: true,
        detail: `未能证明或启用经批准的持久启动器：${error instanceof Error ? error.message : String(error)}；未修改 API 角色。`,
        appliedProfiles: [],
        alreadyInstalled: [],
      };
    }
  }
  const applied = [];
  const alreadyInstalled = [];
  const repairedProfiles = [];
  const activatedThisApply = [];
  try { for (const profileId of Object.keys(validated.profiles)) {
    const journalPath = paths.journal(profileId);
    const existing = await journalIfPresent(journalPath);
    if (existing?.phase === "active") {
      if (existing.paths?.versionDir !== runtime.versionDir) {
        throw new Error(`API profile ${profileId} is active with a different runtime; rollback or reinstall it before counting it as installed`);
      }
      const repaired = await repairLegacyApiRoleRegistrations(existing, {
        codexHome,
        runtimeDir: runtime.versionDir,
        profile: validated.profiles[profileId],
        dependencies,
      });
      try {
        await inspectNativeApiDispatchState({
          profileId,
          apiDir,
          settingsPath,
          journalPath,
          taskAdapter: dependencies.taskAdapter,
          requireRunning: false,
          requireCredential: false,
        }, dependencies);
      } catch (error) {
        throw new Error(`API profile ${profileId} is active but incomplete or changed (${error.message}); rollback or reinstall it before counting it as installed`);
      }
      if (repaired) {
        applied.push(profileId);
        repairedProfiles.push(profileId);
      } else alreadyInstalled.push(profileId);
      continue;
    }
    if (existing?.phase === "prepared") {
      await (dependencies.activateApiProfile || activate)({ journalPath }, dependencies);
      applied.push(profileId);
      activatedThisApply.push(profileId);
      continue;
    }
    if (existing) throw new Error(`API profile ${profileId} is in an unsupported install phase`);
    await (dependencies.prepareApiProfile || prepare)({
      profileId,
      settingsPath,
      apiDir,
      codexHome,
      versionDir: runtime.versionDir,
      journalPath,
      pluginRoot: dependencies.pluginRoot || REPO_ROOT,
    }, dependencies);
    await (dependencies.activateApiProfile || activate)({ journalPath }, dependencies);
    applied.push(profileId);
    activatedThisApply.push(profileId);
  } } catch (error) {
    const recoveryErrors = [];
    for (const profileId of [...activatedThisApply].reverse()) {
      try { await (dependencies.rollbackApiProfile || rollback)({journalPath: paths.journal(profileId)}, dependencies); }
      catch (rollbackError) { recoveryErrors.push(rollbackError); }
    }
    if (bootstrap && !bootstrap.reused) {
      try {
        await (dependencies.disarmApiBootstrap || disarmApiBootstrap)({codexHome,
          ...(dependencies.bootstrapEnvironmentAdapter ? {adapter: dependencies.bootstrapEnvironmentAdapter} : {})});
      } catch (disarmError) { recoveryErrors.push(disarmError); }
    }
    if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], "API Apply failed and owned changes need recovery");
    throw error;
  }
  return {
    applied: applied.length > 0,
    supported: true,
    restartRequired: applied.length > 0 || bootstrap?.restartRequired === true,
    detail: applied.length > 0
      ? repairedProfiles.length
        ? "API 角色目录或 provider 注册已修复；受管启动器已验证或复用，需要完整重启 Codex。"
        : "API role/catalog/provider 与 Task 事务已应用；受管启动器已验证或启用，需要完整重启 Codex。"
      : bootstrap ? "API 配置已安装；受管启动器已验证或复用，需要完整重启 Codex。" : "API 配置已安装；没有新增角色。",
    appliedProfiles: applied,
    alreadyInstalled,
    ...(bootstrap ? {bootstrap: {state: bootstrap.state, restartRequired: true, reused: bootstrap.reused === true}} : {}),
  };
}

async function main(argv) {
  const command = argv[0];
  const value = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const journalPath = value("journal-path");
  if ((command === "status" || command === "activate" || command === "rollback" || command === "prepare")
      && (typeof journalPath !== "string" || !journalPath.trim())) {
    throw new Error("--journal-path is required");
  }
  if (command === "status") process.stdout.write(`${JSON.stringify(await status({ journalPath }))}\n`);
  else if (command === "activate") process.stdout.write(`${JSON.stringify(await activate({ journalPath }))}\n`);
  else if (command === "rollback") process.stdout.write(`${JSON.stringify(await rollback({ journalPath }))}\n`);
  else if (command === "prepare") {
    const result = await prepare({
      profileId: value("profile-id"),
      settingsPath: value("settings"),
      apiDir: value("api-dir"),
      codexHome: value("codex-home"),
      versionDir: value("version-dir"),
      journalPath,
      pluginRoot: value("plugin-root"),
      gatewayScriptPath: value("gateway-script"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error("usage: native-api-install.mjs <prepare|activate|rollback|status> --journal-path PATH [--profile-id ID --settings PATH --api-dir PATH --codex-home PATH --version-dir PATH --plugin-root PATH|--gateway-script PATH]");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
