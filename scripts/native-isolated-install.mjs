import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply as applyFiles, plan as planFiles, rollback as rollbackFiles } from "./native-isolated-files.mjs";
import { autostartFile } from "./native-autostart.mjs";
import { composeIsolatedConfig, hasLegacyGatewayConfigMarker, removeIsolatedConfig, rootRoutesThroughIsolatedProvider, withTemporaryRootModelCatalog } from "./native-isolated-config.mjs";
import { runIsolatedConfigSmoke } from "./native-isolated-smoke.mjs";
import { ensureGateway, gatewayHealth, gatewayPaths, prepareGatewayIdentity, readGatewayIdentity, readGatewayState, stopGateway } from "./native-gateway-manager.mjs";
import { createWindowsTaskSchedulerAdapter, gatewayTaskPlan, registerOwnedGatewayTask, restoreGatewayTask, snapshotGatewayTask, statusOwnedGatewayTask, createOwnedGatewayTaskLauncher } from "./native-gateway-task.mjs";
import { applyBootstrapEnvironment, NATIVE_BOOTSTRAP_PATH, planBootstrapEnvironment, rollbackBootstrapEnvironment } from "./native-bootstrap-install.mjs";
import { createWindowsUserEnvironmentAdapter } from "./native-runtime-env.mjs";
import { verifyRuntimeVersion } from "./native-runtime.mjs";
import { gatewaySourceEntry, stageGatewaySource, verifyGatewaySource } from "./native-gateway-source.mjs";

const JOURNAL_VERSION = 1;
const SMOKE_STAGES = new Set(["preflight", "app_server_start", "initialize", "config_read", "model_list", "provider_config", "role_config", "cleanup", "complete"]);

function safeDiagnosticCode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "UNKNOWN";
}

function smokeDiagnosticEvidence(result) {
  const stage = (value) => SMOKE_STAGES.has(value) ? value : "unknown";
  const appServerClosed = result?.checks?.app_server_closed ?? result?.appServerClosed;
  return {
    status: result?.status === "passed" || result?.status === "failed" ? result.status : "unknown",
    stage: stage(result?.stage),
    failureStage: stage(result?.failure?.stage ?? result?.failureStage),
    failureCode: safeDiagnosticCode(result?.failure?.code ?? result?.failureCode),
    appServerClosed: typeof appServerClosed === "boolean" ? appServerClosed : null,
  };
}

function smokeFailureError(evidence) {
  const error = new Error("isolated config smoke check did not report status=passed");
  error.code = "ISOLATED_CONFIG_SMOKE_FAILED";
  error.smoke = evidence;
  return error;
}

function cleanupFailureError(cleanupError, smoke = null, primaryError = null) {
  const error = new Error(primaryError
    ? "isolated config prepare and temporary fixture cleanup failed"
    : "isolated config temporary fixture cleanup failed");
  error.code = primaryError ? "ISOLATED_CONFIG_PREPARE_FAILED" : "TEMP_SMOKE_CLEANUP_FAILED";
  error.cleanupCode = safeDiagnosticCode(cleanupError?.code);
  error.primaryCode = primaryError ? safeDiagnosticCode(primaryError.code) : undefined;
  error.smoke = smoke;
  return error;
}

const PREPARE_ERROR_MESSAGES = Object.freeze({
  ISOLATED_CONFIG_SMOKE_FAILED: "isolated config smoke failed",
  ISOLATED_CONFIG_PREPARE_FAILED: "isolated config prepare and cleanup failed",
  TEMP_SMOKE_CLEANUP_FAILED: "isolated config smoke cleanup failed",
});

export function formatInstallError(error) {
  const message = PREPARE_ERROR_MESSAGES[error?.code];
  if (!Object.hasOwn(PREPARE_ERROR_MESSAGES, error?.code)) return error?.message ?? String(error);
  const diagnostic = { code: error.code };
  if (error.smoke && typeof error.smoke === "object") diagnostic.smoke = smokeDiagnosticEvidence(error.smoke);
  if (error.primaryCode !== undefined) diagnostic.primaryCode = safeDiagnosticCode(error.primaryCode);
  if (error.cleanupCode !== undefined) diagnostic.cleanupCode = safeDiagnosticCode(error.cleanupCode);
  return `${message} ${JSON.stringify(diagnostic)}`;
}

function encodeValue(value) {
  if (Buffer.isBuffer(value)) return { $native_buffer_base64: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$native_buffer_base64 === "string") return Buffer.from(value.$native_buffer_base64, "base64");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item)]));
  }
  return value;
}

export function encodeJournal(value) { return JSON.stringify(encodeValue(value), null, 2) + "\n"; }
export function decodeJournal(value) { return decodeValue(JSON.parse(value)); }

async function regularOrAbsent(file, label) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.native-install-${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    created = true;
    await rename(temp, file);
    created = false;
  } finally {
    if (created) await rm(temp, { force: true }).catch(() => {});
  }
}

async function defaultAutostartAdapter() {
  return {
    async get(file) { return regularOrAbsent(file, "autostart file"); },
    async set(file, bytes) {
      if (bytes === null) {
        const existing = await regularOrAbsent(file, "autostart file");
        if (existing !== null) await unlink(file);
      } else await atomicWrite(file, bytes);
    },
  };
}

async function readJournal(journalPath) {
  const bytes = await regularOrAbsent(path.resolve(journalPath), "install journal");
  if (bytes === null) throw new Error(`install journal is missing: ${path.resolve(journalPath)}`);
  const journal = decodeJournal(bytes.toString("utf8"));
  if (journal?.version !== JOURNAL_VERSION || !journal.paths || !journal.files || !journal.environment || !journal.autostart) {
    throw new Error("install journal has an unsupported or incomplete format");
  }
  return journal;
}

async function writeJournal(journalPath, journal) {
  await atomicWrite(path.resolve(journalPath), Buffer.from(encodeJournal(journal), "utf8"));
}

async function canonicalForCompare(value) {
  const resolved = path.resolve(value);
  try { return await realpath(resolved); } catch (error) { if (error.code === "ENOENT") return resolved; throw error; }
}

async function requireExplicitPaths({ versionDir, codexHome, gatewayDir, startupDir, journalPath }) {
  for (const [name, value] of Object.entries({ versionDir, codexHome, gatewayDir, startupDir, journalPath })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be provided explicitly`);
  }
  const [isolatedGateway, legacyGateway] = await Promise.all([canonicalForCompare(gatewayDir), canonicalForCompare(gatewayPaths().dir)]);
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(isolatedGateway) === normalize(legacyGateway)) throw new Error("gatewayDir must be separate from the legacy/default gateway directory");
}

async function canonicalGatewayScript({ gatewayScriptPath, pluginRoot, runtimeRoot }) {
  if (Boolean(gatewayScriptPath) === Boolean(pluginRoot)) throw new Error("provide exactly one of gatewayScriptPath or pluginRoot explicitly");
  if (pluginRoot) {
    const sourceBundle = await stageGatewaySource({ pluginRoot, runtimeRoot });
    return { gatewayScriptPath: gatewaySourceEntry(sourceBundle, runtimeRoot), sourceBundle };
  }
  const input = gatewayScriptPath || path.join(pluginRoot, "scripts", "native-gateway.mjs");
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("gateway script path or plugin root must be absolute");
  const candidate = path.resolve(input);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`gateway script must be an installed regular file: ${candidate}`);
  return { gatewayScriptPath: await realpath(candidate), sourceBundle: null };
}

async function verifyJournalGatewaySource(journal) {
  const sourceBundle = journal.gateway?.sourceBundle;
  if (sourceBundle === undefined) return false;
  const runtimeRoot = journal.paths?.gatewaySourceRoot;
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) throw new Error("gateway source runtime root is missing from install journal");
  await verifyGatewaySource(sourceBundle, { runtimeRoot });
  if (path.resolve(journal.paths.gatewayScript) !== gatewaySourceEntry(sourceBundle, runtimeRoot)) {
    throw new Error("gateway Task script does not match its immutable source bundle");
  }
  return true;
}

function taskLauncherBytes(taskPlan) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskPlan.launcher.content, "utf16le")]);
}

function isManagedOldStartup(bytes) {
  if (bytes === null) return true;
  const content = Buffer.from(bytes).toString("utf8");
  return content.startsWith("' Sol Luna native gateway: start hidden before the first Codex request.")
    && content.includes("native-gateway-manager.mjs") && content.includes("ensure --json");
}

function matchesTaskSnapshot(left, right) {
  return left?.version === right?.version && left?.taskName === right?.taskName && left?.marker === right?.marker
    && left?.planFingerprint === right?.planFingerprint && left?.priorExists === right?.priorExists && left?.priorOwned === right?.priorOwned;
}

async function requireLauncherSnapshot(file, prior, next, marker) {
  const current = await regularOrAbsent(file, "gateway task launcher");
  if (!sameBytes(current, prior)) throw new Error("gateway task launcher changed since prepare");
  if (current !== null && !current.equals(next)) {
    if (current.length < 2 || current[0] !== 0xff || current[1] !== 0xfe || !current.toString("utf16le", 2).startsWith(`' ${marker}\r\n`)) {
      throw new Error("unowned gateway task launcher already exists; refusing to overwrite it");
    }
  }
}

function stateSummary(journal) {
  const configured = journal.phase === "active";
  return {
    phase: journal.phase,
    configured,
    runtimeObserved: false,
    desktopAccepted: false,
    restartNeeded: configured,
    gatewayCleanup: journal.gateway?.cleanup || null,
    indeterminateStages: journal.indeterminateStages || [],
    codexHome: journal.paths.codexHome,
    versionDir: journal.paths.versionDir,
    gatewayDir: journal.paths.gatewayDir,
    startupFile: journal.autostart.file,
    journalPath: journal.paths.journalPath,
  };
}

const INSTALL_JOURNAL_ENV_KEY = "SOL_LUNA_NATIVE_INSTALL_JOURNAL";

async function snapshotEnvironment(adapter, keys = ["CODEX_CLI_PATH", "SOL_LUNA_NATIVE_PLAINTEXT_V2"]) {
  const currentEnvironment = {};
  for (const key of keys) currentEnvironment[key] = await adapter.get(key);
  return currentEnvironment;
}

async function snapshotStartup(adapter, file) { return adapter.get(file); }

function sameBytes(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  return Buffer.from(actual).equals(Buffer.from(expected));
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function requireEnvironmentPrior(transaction, adapter) {
  for (const key of Object.keys(transaction.prior)) {
    const current = await adapter.get(key);
    const expected = transaction.prior[key];
    if (current?.present !== expected?.present || (current?.present && current.value !== expected.value)) {
      throw new Error(`environment changed since plan: ${key}`);
    }
  }
}

async function requireFilesPrior(transaction) {
  for (const item of Object.values(transaction.files)) {
    const current = await regularOrAbsent(item.path, "managed file");
    if (item.prior.exists ? current === null || !current.equals(item.prior.bytes) : current !== null) {
      throw new Error(`file changed since plan: ${item.path}`);
    }
  }
}

async function restoreLauncherIfNext(launcher) {
  const current = await regularOrAbsent(launcher.path, "gateway task launcher");
  if (sameBytes(current, launcher.next)) {
    if (launcher.prior === null) await unlink(launcher.path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    else await atomicWrite(launcher.path, launcher.prior);
  } else if (!sameBytes(current, launcher.prior)) {
    throw new Error("gateway task launcher changed after activation; preserving the later change");
  }
}

async function restoreLauncherChecked(launcher) {
  const current = await regularOrAbsent(launcher.path, "gateway task launcher");
  if (!sameBytes(current, launcher.next)) throw new Error("gateway task launcher changed since activation; preserving the later change");
  if (launcher.prior === null) await unlink(launcher.path).catch((error) => { if (error.code !== "ENOENT") throw error; });
  else await atomicWrite(launcher.path, launcher.prior);
}

async function taskSnapshotStillMatches(journal, adapter) {
  const current = await snapshotGatewayTask(journal.gateway.taskPlan, adapter);
  if (!matchesTaskSnapshot(current, journal.gateway.taskSnapshot)) throw new Error("gateway task changed since prepare");
}

async function restoreStartupChecked(autostart, adapter) {
  const current = await adapter.get(autostart.file);
  const expected = autostart.next === null ? null : Buffer.from(autostart.next, "utf8");
  if (!sameBytes(current, expected)) throw new Error("autostart file changed since activation; preserving the later change");
  await adapter.set(autostart.file, autostart.prior);
}

function withRecovery(primary, recoveryErrors, label) {
  return recoveryErrors.length ? new AggregateError([primary, ...recoveryErrors], `${label}; recovery also failed`) : primary;
}

export async function prepare(options = {}, dependencies = {}) {
  const { versionDir, codexHome, gatewayDir, startupDir, journalPath, legacyManifestPath, expectedMainModel, expectedMainProvider, expectedRootBaseUrl } = options;
  const smokeCheck = dependencies.smokeCheck ?? (Object.hasOwn(options, "smokeCheck") ? options.smokeCheck : runIsolatedConfigSmoke);
  await requireExplicitPaths({ versionDir, codexHome, gatewayDir, startupDir, journalPath });
  if (typeof smokeCheck !== "function") throw new Error("a real read-only config smoke check is required before prepare completes");
  if (typeof expectedMainModel !== "string" || !expectedMainModel) throw new Error("expectedMainModel must be provided explicitly");
  if (!(typeof expectedMainProvider === "string" && expectedMainProvider) && expectedMainProvider !== null) throw new Error("expectedMainProvider must be a provider id or null");
  if (!Object.hasOwn(options, "expectedRootBaseUrl") || (expectedRootBaseUrl !== null && (typeof expectedRootBaseUrl !== "string" || !expectedRootBaseUrl))) {
    throw new Error("expectedRootBaseUrl must be explicitly provided as a URL or null");
  }
  await verifyRuntimeVersion(versionDir);
  const envAdapter = dependencies.envAdapter || options.envAdapter || createWindowsUserEnvironmentAdapter({ allowInstallJournal: true });
  const autostartAdapter = dependencies.autostartAdapter || options.autostartAdapter || await defaultAutostartAdapter();
  const taskAdapter = dependencies.taskAdapter || options.taskAdapter || createWindowsTaskSchedulerAdapter();
  const prepareIdentity = dependencies.prepareGatewayIdentity || options.prepareGatewayIdentity || prepareGatewayIdentity;
  const paths = gatewayPaths(gatewayDir);
  const journal = path.resolve(journalPath);
  const startupFile = autostartFile(startupDir);
  if (await regularOrAbsent(journal, "install journal") !== null) throw new Error(`install journal already exists: ${journal}`);
  const gatewaySourceRoot = path.dirname(paths.dir);
  const gatewaySource = await canonicalGatewayScript({ gatewayScriptPath: options.gatewayScriptPath, pluginRoot: options.pluginRoot, runtimeRoot: gatewaySourceRoot });
  const gatewayScript = gatewaySource.gatewayScriptPath;

  // Prepare only the private identity. The service is started later by the owned Task Scheduler task.
  const identity = await prepareIdentity({ paths });
  if (!identity?.token || !Number.isInteger(identity?.port)) throw new Error("identity preparation did not return a valid private gateway identity");
  const identityBytes = await regularOrAbsent(paths.identity, "gateway identity");
  const persistedIdentity = identityBytes === null ? null : JSON.parse(identityBytes.toString("utf8"));
  if (!persistedIdentity?.token || persistedIdentity.token !== identity.token || persistedIdentity.port !== identity.port) throw new Error("gateway identity could not be verified");
  const baseUrl = `http://127.0.0.1:${identity.port}/${identity.token}/v1`;
  const resolvedJournalPath = path.resolve(journalPath);
  const bootstrapSourcePath = options.bootstrapSourcePath || NATIVE_BOOTSTRAP_PATH;
  const bootstrapSourceHash = createHash("sha256").update(await readFile(bootstrapSourcePath)).digest("hex");
  const envPlan = await planBootstrapEnvironment({
    bootstrapPath: options.bootstrapPath || path.join(path.resolve(codexHome), "router-runtime", "bootstrap", `${bootstrapSourceHash}.exe`),
    bootstrapSourcePath,
    officialPath: options.officialPath,
    currentEnvironment: await snapshotEnvironment(envAdapter, ["CODEX_CLI_PATH", "SOL_LUNA_NATIVE_PLAINTEXT_V2", INSTALL_JOURNAL_ENV_KEY]),
    journalPath: resolvedJournalPath,
  });
  const startupPrior = await snapshotStartup(autostartAdapter, startupFile);
  if (!isManagedOldStartup(startupPrior)) throw new Error("unowned Startup VBS exists; refusing to remove or replace it");
  let legacyManifest = null;
  if (legacyManifestPath) {
    const manifestBytes = await regularOrAbsent(path.resolve(legacyManifestPath), "legacy install manifest");
    if (manifestBytes === null) throw new Error(`legacy install manifest is missing: ${path.resolve(legacyManifestPath)}`);
    legacyManifest = JSON.parse(manifestBytes.toString("utf8"));
  }
  const realFiles = await planFiles({ codexHome, baseUrl, versionDir, legacyManifest });
  const taskPlan = gatewayTaskPlan({ paths, gatewayScriptPath: gatewayScript });
  const launcherPrior = await regularOrAbsent(taskPlan.launcher.path, "gateway task launcher");
  const launcherNext = taskLauncherBytes(taskPlan);
  await requireLauncherSnapshot(taskPlan.launcher.path, launcherPrior, launcherNext, taskPlan.marker);
  const taskSnapshot = await snapshotGatewayTask(taskPlan, taskAdapter);
  const previousGatewayState = await readGatewayState(paths);

  const fixtureHome = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "native-isolated-smoke-")));
  let smokeEvidence;
  let smokeOutcome = null;
  let primaryError = null;
  try {
    await mkdir(path.join(fixtureHome, "agents"), { recursive: true });
    const cacheBytes = await readFile(path.join(codexHome, "models_cache.json"));
    await writeFile(path.join(fixtureHome, "models_cache.json"), cacheBytes, { flag: "wx", mode: 0o600 });
    const previousConfig = realFiles.files["config.toml"].prior;
    if (previousConfig.exists) await writeFile(path.join(fixtureHome, "config.toml"), previousConfig.bytes, { flag: "wx", mode: 0o600 });
    const smokeFiles = await planFiles({ codexHome: fixtureHome, baseUrl, versionDir, legacyManifest });
    await applyFiles(smokeFiles);
    const smokeConfigPath = path.join(fixtureHome, "config.toml");
    const smokeConfig = withTemporaryRootModelCatalog(await readFile(smokeConfigPath, "utf8"), path.join(fixtureHome, "models_cache.json"));
    await writeFile(smokeConfigPath, smokeConfig, { mode: 0o600 });
    let smokeResult;
    try {
      smokeResult = await smokeCheck({
        exePath: realFiles.runtimeExePath,
        preparedHome: fixtureHome,
        expectedMainModel,
        expectedMainProvider,
        expectedRootBaseUrl,
      });
    } catch (error) {
      smokeOutcome = smokeDiagnosticEvidence({ status: "failed", stage: "unknown", failure: { stage: "unknown", code: error?.code } });
      throw smokeFailureError(smokeOutcome);
    }
    smokeOutcome = smokeDiagnosticEvidence(smokeResult);
    if (smokeResult?.status !== "passed") throw smokeFailureError(smokeOutcome);
    smokeEvidence = { status: "passed", checks: smokeResult.checks ?? {} };
  } catch (error) {
    primaryError = error;
  }
  const resolvedFixture = path.resolve(fixtureHome);
  let cleanupError = null;
  if (resolvedFixture.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    try {
      await (dependencies.removeSmokeFixture ?? ((target, options) => rm(target, options)))(resolvedFixture, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 350,
      });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupFailureError(cleanupError, smokeOutcome, primaryError);
  if (primaryError) throw primaryError;

  const journalData = {
    version: JOURNAL_VERSION,
    phase: "prepared",
    paths: { versionDir: path.resolve(versionDir), codexHome: path.resolve(codexHome), gatewayDir: paths.dir, gatewayScript, ...(gatewaySource.sourceBundle ? { gatewaySourceRoot } : {}), startupDir: path.resolve(startupDir), journalPath: journal },
    files: realFiles,
    environment: envPlan,
    autostart: {
      file: startupFile,
      prior: startupPrior,
      next: null,
      retiredLegacy: startupPrior !== null && isManagedOldStartup(startupPrior),
    },
    gateway: { taskPlan, taskSnapshot, ...(gatewaySource.sourceBundle ? { sourceBundle: gatewaySource.sourceBundle } : {}), launcher: { path: taskPlan.launcher.path, prior: launcherPrior, next: launcherNext }, identityFile: paths.identity, identitySha256: sha256(identityBytes), preexistingPid: previousGatewayState?.pid ?? null, startedByTransaction: false, pid: null },
    smoke: smokeEvidence,
    completed: { launcher: false, task: false, gateway: false, files: false, environment: false, autostart: false },
  };
  await writeJournal(journal, journalData);
  return { prepared: true, phase: journalData.phase, journalPath: journal, codexHome: path.resolve(codexHome), versionDir: path.resolve(versionDir), gatewayDir: paths.dir };
}

async function assertPreparedState(journal, { envAdapter, startup, taskAdapter }) {
  await verifyRuntimeVersion(journal.paths.versionDir);
  await requireEnvironmentPrior(journal.environment, envAdapter);
  if (!sameBytes(await startup.get(journal.autostart.file), journal.autostart.prior)) throw new Error("autostart file changed since prepare");
  if (!isManagedOldStartup(journal.autostart.prior)) throw new Error("Startup VBS is no longer owned; refusing to remove it");
  await requireFilesPrior(journal.files);
  await requireLauncherSnapshot(journal.gateway.launcher.path, journal.gateway.launcher.prior, journal.gateway.launcher.next, journal.gateway.taskPlan.marker);
  await taskSnapshotStillMatches(journal, taskAdapter);
  const identityBytes = await regularOrAbsent(journal.gateway.identityFile, "gateway identity");
  if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) throw new Error("gateway identity changed since prepare");
}

async function stopTransactionGateway(journal, { paths, readState, readIdentity, health, stop, allowUnrecordedStart = false }) {
  if (!journal.gateway.startedByTransaction && !allowUnrecordedStart) return false;
  const identityBytes = await regularOrAbsent(journal.gateway.identityFile, "gateway identity");
  if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) return false;
  const identity = await readIdentity(paths);
  const state = await readState(paths);
  if (!identity?.token || !state?.token || state.token !== identity.token || state.port !== identity.port) return false;
  if (journal.gateway.pid && state.pid !== journal.gateway.pid) return false;
  if (journal.gateway.preexistingPid && state.pid === journal.gateway.preexistingPid) return false;
  const live = await health(state);
  if (live?.reachable !== true || live.pid !== state.pid) return false;
  await stop({ paths });
  return true;
}

export async function activate({ journalPath, envAdapter = createWindowsUserEnvironmentAdapter({ allowInstallJournal: true }), autostartAdapter, taskAdapter } = {}, dependencies = {}) {
  if (typeof journalPath !== "string" || !journalPath) throw new Error("journalPath must be provided explicitly");
  const journal = await readJournal(journalPath);
  if (journal.phase !== "prepared") throw new Error(`cannot activate install transaction in phase ${journal.phase}`);
  const startup = autostartAdapter || await defaultAutostartAdapter();
  const tasks = taskAdapter || dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const ensure = dependencies.ensureGateway || ensureGateway;
  const writer = dependencies.writeLauncherAtomic || atomicWrite;
  const paths = gatewayPaths(journal.paths.gatewayDir);
  await verifyJournalGatewaySource(journal);
  await assertPreparedState(journal, { envAdapter, startup, taskAdapter: tasks });

  const attempted = { launcher: false, task: false, gateway: false, autostart: false, files: false, environment: false };
  let taskStartInvoked = false;
  let taskStartAccepted = false;
  let gatewayVerified = false;
  journal.attempted = { ...attempted };
  journal.phase = "activating";
  await writeJournal(journalPath, journal);
  try {
    attempted.launcher = journal.attempted.launcher = true; await writeJournal(journalPath, journal);
    await writer(journal.gateway.launcher.path, journal.gateway.launcher.next);
    journal.completed.launcher = true; await writeJournal(journalPath, journal);

    await taskSnapshotStillMatches(journal, tasks);
    attempted.task = journal.attempted.task = true; await writeJournal(journalPath, journal);
    await registerOwnedGatewayTask(journal.gateway.taskPlan, tasks);
    journal.completed.task = true; await writeJournal(journalPath, journal);

    attempted.gateway = journal.attempted.gateway = true; await writeJournal(journalPath, journal);
    const ownedLauncher = createOwnedGatewayTaskLauncher(journal.gateway.taskPlan, tasks);
    const launchImpl = async (request) => {
      taskStartInvoked = true;
      const result = await ownedLauncher(request);
      taskStartAccepted = true;
      return result;
    };
    const started = await ensure({ paths, launchImpl });
    const identity = await readGatewayIdentity(paths);
    const state = started?.state;
    if (!state?.token || state.token !== identity?.token || state.port !== identity?.port || !Number.isInteger(state.pid)) {
      throw new Error("Task Scheduler gateway did not return the prepared healthy identity");
    }
    const live = await (dependencies.gatewayHealth || gatewayHealth)(state);
    if (live?.reachable !== true || live.pid !== state.pid) throw new Error("Task Scheduler gateway health PID could not be verified");
    const taskStatus = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
    if (taskStatus.state !== "Running") throw new Error("Task Scheduler gateway task is not Running after startup");
    if (live.deepseek_only !== true || live.relay_allowed !== false) {
      throw new Error("Task Scheduler gateway is healthy but does not enforce DeepSeek-only routing");
    }
    journal.gateway.startedByTransaction = started.started === true;
    journal.gateway.pid = started.started === true ? state.pid : null;
    journal.completed.gateway = true; await writeJournal(journalPath, journal); gatewayVerified = true;

    if (!sameBytes(await startup.get(journal.autostart.file), journal.autostart.prior)) throw new Error("autostart file changed since prepare");
    attempted.autostart = journal.attempted.autostart = true; await writeJournal(journalPath, journal);
    await startup.set(journal.autostart.file, null);
    journal.completed.autostart = true; await writeJournal(journalPath, journal);

    attempted.files = journal.attempted.files = true; await writeJournal(journalPath, journal);
    await applyFiles(journal.files);
    journal.completed.files = true; await writeJournal(journalPath, journal);

    attempted.environment = journal.attempted.environment = true; await writeJournal(journalPath, journal);
    journal.environmentSnapshot = await applyBootstrapEnvironment(journal.environment, envAdapter);
    journal.completed.environment = true; await writeJournal(journalPath, journal);

    journal.phase = "active";
    await writeJournal(journalPath, journal);
    return stateSummary(journal);
  } catch (error) {
    const recoveryErrors = [];
    const indeterminate = [];
    if (attempted.gateway) {
      try {
        const stopped = await stopTransactionGateway(journal, {
          paths, readState: dependencies.readGatewayState || readGatewayState,
          readIdentity: dependencies.readGatewayIdentity || readGatewayIdentity,
          health: dependencies.gatewayHealth || gatewayHealth,
          stop: dependencies.stopGateway || stopGateway,
          allowUnrecordedStart: taskStartInvoked,
        });
        if (stopped) journal.completed.gateway = false;
        else if (taskStartAccepted && !gatewayVerified) {
          let observed;
          try { observed = await (dependencies.readGatewayState || readGatewayState)(paths); } catch { observed = null; }
          if (!journal.gateway.preexistingPid || observed?.pid !== journal.gateway.preexistingPid) {
            const recoveryError = new Error("Task Scheduler launch was invoked but the isolated gateway could not be proven stopped or unchanged");
            recoveryErrors.push(recoveryError); indeterminate.push("gateway"); journal.completed.gateway = null;
          }
        }
      } catch (item) { recoveryErrors.push(item); indeterminate.push("gateway"); journal.completed.gateway = null; }
    }
    if (attempted.environment && journal.environmentSnapshot) {
      try { await rollbackBootstrapEnvironment(journal.environmentSnapshot, envAdapter); journal.completed.environment = false; }
      catch (item) { recoveryErrors.push(item); indeterminate.push("environment"); journal.completed.environment = null; }
    } else if (attempted.environment && error instanceof AggregateError) {
      recoveryErrors.push(error); indeterminate.push("environment"); journal.completed.environment = null;
    }
    if (attempted.files) {
      try {
        const allPrior = await Promise.all(Object.values(journal.files.files).map(async (item) => {
          const current = await regularOrAbsent(item.path, "managed file");
          return item.prior.exists ? current !== null && current.equals(item.prior.bytes) : current === null;
        }));
        if (allPrior.every(Boolean)) journal.completed.files = false;
        else { await rollbackFiles(journal.files); journal.completed.files = false; }
      } catch (item) { recoveryErrors.push(item); indeterminate.push("files"); journal.completed.files = null; }
    }
    if (attempted.autostart) {
      try {
        const current = await startup.get(journal.autostart.file);
        if (current === null) await startup.set(journal.autostart.file, journal.autostart.prior);
        else if (!sameBytes(current, journal.autostart.prior)) throw new Error("Startup VBS changed after activation; preserving the later change");
        journal.completed.autostart = false;
      } catch (item) { recoveryErrors.push(item); indeterminate.push("autostart"); journal.completed.autostart = null; }
    }
    if (attempted.task && !indeterminate.includes("gateway")) {
      try { await restoreGatewayTask(journal.gateway.taskSnapshot, journal.gateway.taskPlan, tasks); journal.completed.task = false; }
      catch (item) { recoveryErrors.push(item); indeterminate.push("task"); journal.completed.task = null; }
    }
    if (attempted.launcher && !indeterminate.includes("gateway")) {
      try { await restoreLauncherIfNext(journal.gateway.launcher); journal.completed.launcher = false; }
      catch (item) { recoveryErrors.push(item); indeterminate.push("launcher"); journal.completed.launcher = null; }
    }
    journal.indeterminateStages = [...new Set(indeterminate)];
    journal.phase = recoveryErrors.length || indeterminate.length ? "activation_recovery_failed" : "activation_failed";
    journal.recoveryErrors = recoveryErrors.map((item) => item.message);
    await writeJournal(journalPath, journal).catch((item) => recoveryErrors.push(item));
    throw withRecovery(error, recoveryErrors, "activation failed");
  }
}

function gatewayProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("isolated gateway process identity is invalid");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw new Error("isolated gateway process liveness could not be verified");
  }
}

async function waitForGatewayProcessExit(pid, dependencies) {
  const isAlive = dependencies.isGatewayProcessAlive || gatewayProcessAlive;
  const timeoutMs = Number.isFinite(dependencies.gatewayExitTimeoutMs) && dependencies.gatewayExitTimeoutMs >= 0
    ? dependencies.gatewayExitTimeoutMs : 10_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!(await isAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}

async function stopTransactionGatewayForRollback(journal, journalPath, tasks, dependencies, paths) {
  if (!journal.completed.gateway || !journal.gateway.startedByTransaction) return false;
  const identityBytes = await regularOrAbsent(journal.gateway.identityFile, "gateway identity");
  if (!identityBytes || sha256(identityBytes) !== journal.gateway.identitySha256) {
    throw new Error("isolated gateway identity changed; refusing rollback while ownership is unverified");
  }
  const identity = await (dependencies.readGatewayIdentity || readGatewayIdentity)(paths);
  if (!identity?.token || !Number.isInteger(identity.port)) throw new Error("isolated gateway identity is invalid");
  const task = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
  if (!task.exists || !task.owned || task.specMatches !== true || !task.enabled) {
    throw new Error("isolated gateway Task ownership changed; refusing rollback");
  }
  const state = await (dependencies.readGatewayState || readGatewayState)(paths);
  const isAlive = dependencies.isGatewayProcessAlive || gatewayProcessAlive;
  let pid;
  if (state) {
    if (state.token !== identity.token || state.port !== identity.port) {
      throw new Error("isolated gateway state no longer matches its private identity");
    }
    const previousCleanup = journal.gateway.cleanupProcess;
    if (previousCleanup && (previousCleanup.identitySha256 !== journal.gateway.identitySha256 ||
        !Number.isInteger(previousCleanup.pid) || previousCleanup.pid <= 0)) {
      throw new Error("recorded gateway cleanup identity is invalid; refusing rollback");
    }
    if (previousCleanup && previousCleanup.pid !== state.pid && await isAlive(previousCleanup.pid)) {
      throw new Error("previously verified gateway PID is still alive; refusing rollback");
    }
    if (state.pid === journal.gateway.preexistingPid) {
      journal.gateway.startedByTransaction = false;
      journal.gateway.cleanup = "preserved_preexisting";
      journal.completed.gateway = false;
      delete journal.gateway.cleanupProcess;
      return false;
    }
    const live = await (dependencies.gatewayHealth || gatewayHealth)(state);
    if (!Number.isInteger(state.pid) || state.pid <= 0 || live?.reachable !== true || live.pid !== state.pid ||
        live.deepseek_only !== true || live.relay_allowed !== false) {
      throw new Error("isolated gateway strict health is not verified; refusing rollback");
    }
    pid = state.pid;
    journal.gateway.cleanupProcess = { pid, identitySha256: journal.gateway.identitySha256 };
    await writeJournal(journalPath, journal);
    const stopped = await (dependencies.stopGateway || stopGateway)({ paths });
    if (stopped?.stopped !== true || stopped.pid !== pid) {
      throw new Error("isolated gateway graceful shutdown was not confirmed");
    }
  } else {
    const previousCleanup = journal.gateway.cleanupProcess;
    if (!previousCleanup || previousCleanup.identitySha256 !== journal.gateway.identitySha256 ||
        !Number.isInteger(previousCleanup.pid) || previousCleanup.pid <= 0) {
      throw new Error("gateway state is missing and no identity-bound cleanup PID was recorded; refusing rollback");
    }
    pid = previousCleanup.pid;
  }
  if (!(await waitForGatewayProcessExit(pid, { ...dependencies, isGatewayProcessAlive: isAlive }))) {
    throw new Error("isolated gateway process exit was not observed; refusing remaining rollback steps");
  }
  const after = await (dependencies.readGatewayState || readGatewayState)(paths);
  if (after !== null) throw new Error("isolated gateway state reappeared after shutdown; refusing remaining rollback steps");
  journal.gateway.cleanupEligible = true;
  journal.gateway.startedByTransaction = false;
  journal.completed.gateway = false;
  journal.gateway.cleanup = "stopped";
  return true;
}

export async function rollback({ journalPath, envAdapter = createWindowsUserEnvironmentAdapter({ allowInstallJournal: true }), autostartAdapter, taskAdapter } = {}, dependencies = {}) {
  if (typeof journalPath !== "string" || !journalPath) throw new Error("journalPath must be provided explicitly");
  const journal = await readJournal(journalPath);
  const configFilePlan = journal.files?.files?.["config.toml"];
  const legacyMigration = journal.files?.legacyMigration === true
    || (configFilePlan?.prior?.exists && hasLegacyGatewayConfigMarker(configFilePlan.prior.bytes.toString("utf8")));
  const retiredLegacyStartup = journal.autostart?.retiredLegacy === true || legacyMigration;
  if (legacyMigration && !configFilePlan?.uninstallPrior?.exists) {
    throw new Error("legacy migration uninstall target is missing; refusing to restore deprecated gateway config");
  }
  if (journal.indeterminateStages?.length) throw new Error(`transaction has indeterminate stages requiring manual recovery: ${journal.indeterminateStages.join(", ")}`);
  if (!Object.values(journal.completed || {}).some(Boolean)) throw new Error(`nothing to roll back in phase ${journal.phase}`);
  const startup = autostartAdapter || await defaultAutostartAdapter();
  const tasks = taskAdapter || dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  // Check all owned state before mutating any of it.
  if (journal.completed.autostart && !sameBytes(await startup.get(journal.autostart.file), journal.autostart.next === null ? null : Buffer.from(journal.autostart.next, "utf8"))) throw new Error("autostart file changed since activation; preserving the later change");
  if (journal.completed.launcher && !sameBytes(await regularOrAbsent(journal.gateway.launcher.path, "gateway task launcher"), journal.gateway.launcher.next)) throw new Error("gateway task launcher changed since activation; preserving the later change");
  if (journal.completed.task) {
    const currentTask = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
    if (!currentTask.exists || !currentTask.owned || currentTask.specMatches !== true || !currentTask.enabled) throw new Error("gateway task changed since activation; preserving the later change");
  }
  if (journal.completed.environment) {
    for (const key of Object.keys(journal.environmentSnapshot.next)) {
      const current = await envAdapter.get(key);
      const expected = journal.environmentSnapshot.next[key];
      if (current?.present !== expected?.present || (current?.present && current.value !== expected.value)) throw new Error(`environment changed since activation: ${key}`);
    }
  }
  let filesForRollback = journal.files;
  if (journal.completed.files) {
    const overrides = {};
    for (const [name, item] of Object.entries(journal.files.files)) {
      const current = await regularOrAbsent(item.path, "managed file");
      if (name !== "config.toml") {
        if (current && current.equals(Buffer.from(item.next, "utf8"))) continue;
        throw new Error(`file changed since activation: ${item.path}`);
      }
      if (!current) throw new Error(`file changed since activation: ${item.path}`);
      const identityBytes = await regularOrAbsent(journal.gateway.identityFile, "gateway identity");
      if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) {
        throw new Error("isolated gateway identity changed after activation");
      }
      const identityPlan = JSON.parse(identityBytes.toString("utf8"));
      const expectedBaseUrl = `http://127.0.0.1:${identityPlan.port}/${identityPlan.token}/v1`;
      const expectedRolePath = path.join(journal.paths.codexHome, "agents", "native_deepseek.toml");
      const currentConfig = current.toString("utf8");
      const configOptions = { baseUrl: expectedBaseUrl, agentConfigPath: expectedRolePath };
      if (composeIsolatedConfig(currentConfig, configOptions) !== currentConfig) {
        throw new Error(`file changed since activation: ${item.path}`);
      }
      if (rootRoutesThroughIsolatedProvider(currentConfig, { baseUrl: expectedBaseUrl })) {
        throw new Error("root config depends on the isolated DeepSeek provider; refusing to remove it");
      }
      if (current.equals(Buffer.from(item.next, "utf8"))) continue;
      const restoredConfig = Buffer.from(removeIsolatedConfig(currentConfig), "utf8");
      const restoredExists = restoredConfig.length > 0;
      overrides[name] = {
        ...item,
        next: currentConfig,
        prior: { exists: restoredExists, bytes: restoredExists ? restoredConfig : null },
        uninstallPrior: { exists: restoredExists, bytes: restoredExists ? restoredConfig : null },
      };
    }
    if (Object.keys(overrides).length) {
      filesForRollback = { ...journal.files, files: { ...journal.files.files, ...overrides } };
    }
  }

  const paths = gatewayPaths(journal.paths.gatewayDir);
  await stopTransactionGatewayForRollback(journal, journalPath, tasks, dependencies, paths);
  const errors = [];
  journal.phase = "rolling_back"; await writeJournal(journalPath, journal);
  const indeterminate = [];
  if (journal.completed.task) try {
    await restoreGatewayTask(journal.gateway.taskSnapshot, journal.gateway.taskPlan, tasks); journal.completed.task = false;
  } catch (error) {
    journal.completed.task = null; indeterminate.push("task"); errors.push(error);
    journal.indeterminateStages = [...new Set([...(journal.indeterminateStages || []), ...indeterminate])];
    journal.phase = "rollback_failed"; journal.recoveryErrors = errors.map((item) => item.message);
    await writeJournal(journalPath, journal).catch((writeError) => errors.push(writeError));
    throw new AggregateError(errors, "rollback could not restore the gateway Task; remaining owned state was preserved");
  }
  if (journal.completed.environment) try { await rollbackBootstrapEnvironment(journal.environmentSnapshot, envAdapter); journal.completed.environment = false; } catch (error) { journal.completed.environment = null; indeterminate.push("environment"); errors.push(error); }
  if (journal.completed.files) try { await rollbackFiles(filesForRollback, { target: legacyMigration ? "uninstall" : "prior" }); journal.completed.files = false; } catch (error) { journal.completed.files = null; indeterminate.push("files"); errors.push(error); }
  if (journal.completed.autostart) try {
    if (!retiredLegacyStartup) await restoreStartupChecked(journal.autostart, startup);
    journal.completed.autostart = false;
  } catch (error) { journal.completed.autostart = null; indeterminate.push("autostart"); errors.push(error); }
  if (journal.completed.launcher) try { await restoreLauncherChecked(journal.gateway.launcher); journal.completed.launcher = false; } catch (error) { journal.completed.launcher = null; indeterminate.push("launcher"); errors.push(error); }
  journal.indeterminateStages = [...new Set([...(journal.indeterminateStages || []), ...indeterminate])];
  journal.phase = errors.length ? "rollback_failed" : "rolled_back";
  journal.recoveryErrors = errors.map((item) => item.message);
  await writeJournal(journalPath, journal).catch((error) => errors.push(error));
  if (errors.length) throw new AggregateError(errors, "rollback did not fully restore the isolated install transaction");
  return stateSummary(journal);
}

export async function status({ journalPath } = {}) {
  if (typeof journalPath !== "string" || !journalPath) throw new Error("journalPath must be provided explicitly");
  return stateSummary(await readJournal(journalPath));
}

export async function inspectNativeDeepseekDispatchState({ journalPath, envAdapter = createWindowsUserEnvironmentAdapter({ allowInstallJournal: true }), taskAdapter, requireRunning = false } = {}, dependencies = {}) {
  if (typeof journalPath !== "string" || !journalPath) throw new Error("an installed isolation journal path is required for native DeepSeek readiness inspection");
  const journal = await readJournal(journalPath);
  if (journal.phase !== "active" || Object.values(journal.completed || {}).some((value) => value !== true)) {
    throw new Error("isolated native DeepSeek gateway is not fully activated");
  }
  await verifyRuntimeVersion(journal.paths.versionDir);
  await verifyJournalGatewaySource(journal);
  for (const key of Object.keys(journal.environment.next)) {
    const current = await envAdapter.get(key);
    const expected = journal.environment.next[key];
    if (current?.present !== expected?.present || (current?.present && current.value !== expected.value)) {
      throw new Error(`isolated native DeepSeek environment changed: ${key}`);
    }
  }
  const identityBytes = await regularOrAbsent(journal.gateway.identityFile, "gateway identity");
  if (identityBytes === null || sha256(identityBytes) !== journal.gateway.identitySha256) throw new Error("isolated gateway identity changed after activation");
  const identityPlan = JSON.parse(identityBytes.toString("utf8"));
  const expectedBaseUrl = `http://127.0.0.1:${identityPlan.port}/${identityPlan.token}/v1`;
  const configItem = Object.values(journal.files.files).find((item) => path.basename(item.path).toLowerCase() === "config.toml");
  if (!configItem) throw new Error("isolated configuration journal has no config.toml entry");
  const currentConfigBytes = await regularOrAbsent(configItem.path, "Codex config");
  if (currentConfigBytes === null) throw new Error("isolated Codex config is missing");
  const currentConfig = currentConfigBytes.toString("utf8");
  const expectedRolePath = path.join(journal.paths.codexHome, "agents", "native_deepseek.toml");
  if (composeIsolatedConfig(currentConfig, { baseUrl: expectedBaseUrl, agentConfigPath: expectedRolePath }) !== currentConfig) {
    throw new Error("isolated DeepSeek provider or role block changed after activation");
  }
  for (const item of Object.values(journal.files.files).filter((entry) => entry !== configItem)) {
    const current = await regularOrAbsent(item.path, "managed file");
    if (!current || !current.equals(Buffer.from(item.next, "utf8"))) throw new Error("isolated native DeepSeek configuration changed after activation");
  }
  const launcher = await regularOrAbsent(journal.gateway.launcher.path, "gateway task launcher");
  if (!sameBytes(launcher, journal.gateway.launcher.next)) throw new Error("isolated gateway task launcher is missing or changed");
  const tasks = taskAdapter || dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const task = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
  if (!task.exists || !task.owned || task.specMatches !== true || !task.enabled) throw new Error("isolated gateway Task Scheduler task is missing, changed, or disabled");
  const paths = gatewayPaths(journal.paths.gatewayDir);
  let strictHealth = null;
  if (requireRunning) {
    if (task.state !== "Running") throw new Error("isolated gateway Task Scheduler task is not Running");
    const gateway = dependencies.gatewayAdapter || dependencies;
    const identity = await (gateway.readGatewayIdentity || readGatewayIdentity)(paths);
    const state = await (gateway.readGatewayState || readGatewayState)(paths);
    if (!identity?.token || identity.token !== identityPlan.token || identity.port !== identityPlan.port
        || !state?.token || state.token !== identity.token || state.port !== identity.port || !Number.isInteger(state.pid)) {
      throw new Error("isolated gateway health state does not match its private identity");
    }
    const live = await (gateway.gatewayHealth || gatewayHealth)(state);
    if (live?.reachable !== true || live.pid !== state.pid) throw new Error("isolated gateway is not healthy for native DeepSeek readiness inspection");
    if (live.deepseek_only !== true || live.relay_allowed !== false) throw new Error("isolated gateway does not enforce DeepSeek-only routing");
    strictHealth = true;
  }
  return { ready: true, journal, taskState: task.state, strictHealth };
}

// Called only at native DeepSeek dispatch time. It never registers a task or
// falls back to a child process; a missing/inactive install fails closed.
export async function ensureNativeDeepseekDispatch({ journalPath, envAdapter = createWindowsUserEnvironmentAdapter({ allowInstallJournal: true }), taskAdapter } = {}, dependencies = {}) {
  const inspected = await inspectNativeDeepseekDispatchState({ journalPath, envAdapter, taskAdapter }, dependencies);
  const { journal } = inspected;
  const tasks = taskAdapter || dependencies.taskAdapter || createWindowsTaskSchedulerAdapter();
  const paths = gatewayPaths(journal.paths.gatewayDir);
  const launchImpl = createOwnedGatewayTaskLauncher(journal.gateway.taskPlan, tasks);
  const gateway = dependencies.gatewayAdapter || dependencies;
  const ensured = await (gateway.ensureGateway || ensureGateway)({ paths, launchImpl });
  const identity = await (gateway.readGatewayIdentity || readGatewayIdentity)(paths);
  const state = ensured?.state;
  if (!state?.token || state.token !== identity?.token || state.port !== identity?.port || !Number.isInteger(state.pid)) {
    throw new Error("isolated gateway health state does not match its private identity");
  }
  const live = await (gateway.gatewayHealth || gatewayHealth)(state);
  if (live?.reachable !== true || live.pid !== state.pid) throw new Error("isolated gateway is not healthy for native DeepSeek dispatch");
  const currentTask = await statusOwnedGatewayTask(journal.gateway.taskPlan, tasks);
  if (currentTask.state !== "Running") throw new Error("isolated gateway Task Scheduler task is not Running");
  if (live.deepseek_only !== true || live.relay_allowed !== false) {
    throw new Error("isolated gateway is healthy but does not enforce DeepSeek-only routing");
  }
  return { ready: true, taskName: journal.gateway.taskPlan.name, gatewayDir: paths.dir, pid: state.pid };
}

async function main(argv) {
  const command = argv[0];
  const value = (name) => { const at = argv.indexOf(`--${name}`); return at < 0 ? undefined : argv[at + 1]; };
  const journalPath = value("journal-path");
  if (!journalPath) throw new Error("--journal-path is required");
  if (command === "status") process.stdout.write(`${JSON.stringify(await status({ journalPath }))}\n`);
  else if (command === "activate") process.stdout.write(`${JSON.stringify(await activate({ journalPath }))}\n`);
  else if (command === "rollback") process.stdout.write(`${JSON.stringify(await rollback({ journalPath }))}\n`);
  else if (command === "prepare") {
    const options = Object.fromEntries(["version-dir", "codex-home", "gateway-dir", "gateway-script", "plugin-root", "startup-dir", "journal-path", "legacy-manifest-path", "expected-main-model", "expected-main-provider", "expected-root-base-url"].map((name) => [name, value(name)]).filter(([, item]) => item !== undefined));
    const nullable = (item) => item === "null" ? null : item;
    process.stdout.write(`${JSON.stringify(await prepare({ versionDir: options["version-dir"], codexHome: options["codex-home"], gatewayDir: options["gateway-dir"], gatewayScriptPath: options["gateway-script"], pluginRoot: options["plugin-root"], startupDir: options["startup-dir"], journalPath: options["journal-path"], legacyManifestPath: options["legacy-manifest-path"], expectedMainModel: options["expected-main-model"], expectedMainProvider: nullable(options["expected-main-provider"]), expectedRootBaseUrl: nullable(options["expected-root-base-url"]) }))}\n`);
  } else throw new Error("usage: native-isolated-install.mjs <prepare|activate|rollback|status> --journal-path PATH [--version-dir PATH --codex-home PATH --gateway-dir PATH --gateway-script PATH|--plugin-root PATH --startup-dir PATH --expected-main-model SLUG --expected-main-provider ID|null --expected-root-base-url URL|null]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${formatInstallError(error)}\n`); process.exitCode = 1; });
}
