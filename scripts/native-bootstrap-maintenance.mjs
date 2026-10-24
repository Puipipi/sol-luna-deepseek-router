import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  NATIVE_BOOTSTRAP_PATH,
  planBootstrapEnvironment,
  probeAndWriteCompatibilityReceipt,
  readCodexCliVersion,
  readDesktopPackageVersion,
} from './native-bootstrap-install.mjs';
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_VERSION, NATIVE_RUNTIME_TARGET, verifyRuntimeVersion } from './native-runtime.mjs';
import { withFileLock } from './plugin-state.mjs';

export const API_BOOTSTRAP_OWNER = 'sol-luna-native-api-bootstrap';
export const API_BOOTSTRAP_JOURNAL = 'bootstrap-install.json';
const CODEX_CLI_PATH = 'CODEX_CLI_PATH';
const API_ENV_KEYS = [CODEX_CLI_PATH];
const RESOLVE_OFFICIAL = '--bootstrap-resolve-official-cli';
const OBSERVE_BACKEND = '--bootstrap-observe-backend';
const CAPABILITIES = '--bootstrap-capabilities';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function normalize(value) {
  if (value && typeof value === 'object' && typeof value.present === 'boolean') return { present: value.present, value: value.present ? String(value.value ?? '') : null };
  return value === undefined || value === null ? { present: false, value: null } : { present: true, value: String(value) };
}
function same(left, right) {
  const a = normalize(left), b = normalize(right);
  return a.present === b.present && (!a.present || (process.platform === 'win32' ? a.value.toLowerCase() === b.value.toLowerCase() : a.value === b.value));
}
async function regularFile(file) {
  const info = await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}
async function readEnvironment(adapter) {
  if (!adapter?.get || !adapter?.set) throw new Error('Windows user environment adapter is required');
  return Object.fromEntries(await Promise.all(API_ENV_KEYS.map(async (key) => [key, normalize(await adapter.get(key))])));
}
function atomicJson(file, value) {
  const target = path.resolve(file);
  return mkdir(path.dirname(target), { recursive: true }).then(async () => {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, target); } finally { await rm(temporary, { force: true }).catch(() => {}); }
    return sha256(bytes);
  });
}
async function removeOwnedJournal(file, expectedHash) {
  const bytes = await readFile(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (bytes && sha256(bytes) === expectedHash) await rm(file);
}
async function deployOwnedBootstrap(file, sourceBytes, expectedPriorBytes, comparePrior = false) {
  const target = path.resolve(file);
  const prior = await readFile(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (comparePrior && (prior === null ? expectedPriorBytes !== null : !prior.equals(expectedPriorBytes))) throw new Error(`owned file changed before deployment: ${target}`);
  if (prior?.equals(sourceBytes)) return { path: target, prior, deployedSha256: sha256(sourceBytes), changed: false };
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, sourceBytes, { flag: 'wx', mode: 0o700 }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  return { path: target, prior, deployedSha256: sha256(sourceBytes), changed: true };
}
async function rollbackOwnedBootstrap(snapshot) {
  if (!snapshot?.changed) return;
  const current = await readFile(snapshot.path);
  if (sha256(current) !== snapshot.deployedSha256) throw new Error('owned bootstrap file changed; refusing rollback');
  if (snapshot.prior === null) await rm(snapshot.path);
  else {
    const temporary = `${snapshot.path}.${process.pid}.rollback.tmp`;
    await writeFile(temporary, snapshot.prior, { flag: 'wx', mode: 0o700 });
    try { await rename(temporary, snapshot.path); } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
function runBootstrap(exe, mode, runner = spawnSync) {
  const result = runner(exe, [mode], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`native bootstrap ${mode} failed`);
  const text = (result.stdout || '').trim();
  if (mode === RESOLVE_OFFICIAL) return { exePath: text };
  try { return JSON.parse(text); } catch { throw new Error(`native bootstrap ${mode} returned invalid JSON`); }
}
function manifestMatchesCapabilities(manifest, capabilities) {
  // The bootstrap's legacy `approvedPatchHashes` field contains the SHA-256
  // of the compiled patched codex.exe, not the source patch file digest.
  return capabilities?.schemaVersion === 1 && capabilities.testBuild === false
    && capabilities.runtimeVersion === manifest.version
    && capabilities.sourceCommit === manifest.source_commit
    && Array.isArray(capabilities.approvedPatchHashes)
    && capabilities.approvedPatchHashes.some((hash) => String(hash).toLowerCase() === String(manifest.binary_sha256).toLowerCase());
}
function validManifest(manifest) {
  return manifest?.version === NATIVE_RUNTIME_VERSION
    && manifest?.source_commit === NATIVE_RUNTIME_SOURCE_COMMIT
    && manifest?.patch_sha256 === NATIVE_RUNTIME_PATCH_SHA256
    && manifest?.target === NATIVE_RUNTIME_TARGET
    && manifest?.stock_cli_version === manifest.version
    && /^[a-f0-9]{64}$/i.test(manifest?.binary_sha256 || '')
    && manifest.files?.['codex.exe'] === manifest.binary_sha256;
}
function disable(reason) { return { state: 'unavailable', restartRequired: true, reason }; }

export async function observeApiBackend({ bootstrapPath = NATIVE_BOOTSTRAP_PATH, runtimeDir, verifyRuntimeVersion: verifyRuntime = verifyRuntimeVersion, runBootstrap: run = (exe, mode) => runBootstrap(exe, mode), hashFile = async (file) => sha256(await readFile(file)) } = {}) {
  try {
    if (!await regularFile(bootstrapPath)) return disable('native bootstrap binary is missing');
    const verified = await verifyRuntime(runtimeDir);
    const manifest = verified.manifest;
    if (!validManifest(manifest)) return disable('runtime manifest does not match the approved Codex source and patch');
    const capabilities = await run(bootstrapPath, CAPABILITIES);
    if (!manifestMatchesCapabilities(manifest, capabilities)) return disable('bootstrap release does not approve this runtime patch');
    const observed = await run(bootstrapPath, OBSERVE_BACKEND);
    if (observed?.schemaVersion !== 1 || observed.observed !== true || typeof observed.exePath !== 'string' || !/^[a-f0-9]{64}$/i.test(observed.exeSha256 || '')) {
      return { state: 'restart-required', restartRequired: true, observed: null, reason: 'current model host has not exposed a Codex backend process in the approved runtime' };
    }
    const isApproved = observed.exeSha256.toLowerCase() === manifest.binary_sha256.toLowerCase()
      && (await hashFile(observed.exePath)).toLowerCase() === manifest.binary_sha256.toLowerCase();
    return isApproved
      ? { state: 'running-approved', restartRequired: false, observed: { exePath: observed.exePath, exeSha256: observed.exeSha256.toLowerCase() }, reason: null }
      : { state: 'restart-required', restartRequired: true, observed: { exePath: observed.exePath, exeSha256: observed.exeSha256.toLowerCase() }, reason: 'Codex is still running a different CLI binary' };
  } catch (error) {
    return disable(error instanceof Error ? error.message : 'native backend observation failed');
  }
}

async function armApiBootstrapUnlocked({
  runtimeDir, runtimeRoot = path.dirname(path.dirname(path.resolve(runtimeDir))),
  bootstrapPath = NATIVE_BOOTSTRAP_PATH, bootstrapSourcePath = bootstrapPath,
  journalPath = path.join(runtimeRoot, API_BOOTSTRAP_JOURNAL), adapter,
  verifyRuntimeVersion: verifyRuntime = verifyRuntimeVersion,
  runBootstrap: run = (exe, mode) => runBootstrap(exe, mode),
  readVersion = readCodexCliVersion, readPackageVersion = readDesktopPackageVersion,
  hashFile = async (file) => sha256(await readFile(file)),
  probeAndWriteCompatibilityReceipt: probeAndWriteReceipt = probeAndWriteCompatibilityReceipt,
} = {}) {
  if (typeof runtimeDir !== 'string' || typeof runtimeRoot !== 'string' || typeof journalPath !== 'string') throw new Error('runtimeDir, runtimeRoot and journalPath are required');
  const root = path.resolve(runtimeRoot), journal = path.resolve(journalPath);
  if (journal !== path.join(root, API_BOOTSTRAP_JOURNAL)) throw new Error('API bootstrap journal must be router-runtime/bootstrap-install.json');
  if (!inside(path.join(root, 'versions'), runtimeDir)) throw new Error('verified runtime must be staged below router-runtime/versions');
  const existingJournal = await lstat(journal).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingJournal) throw new Error('an API bootstrap ownership journal already exists');
  const verified = await verifyRuntime(runtimeDir);
  const manifest = verified.manifest;
  if (!validManifest(manifest)) throw new Error('runtime artifact provenance does not match the approved source/version/patch');
  if (!await regularFile(bootstrapSourcePath)) throw new Error('approved native bootstrap source is missing');
  const sourceBytes = await readFile(bootstrapSourcePath);
  const sourceHash = sha256(sourceBytes);
  const capabilities = await run(bootstrapSourcePath, CAPABILITIES);
  if (!manifestMatchesCapabilities(manifest, capabilities)) throw new Error('bootstrap does not approve this runtime patch; refusing to change environment');
  const official = await run(bootstrapSourcePath, RESOLVE_OFFICIAL);
  const officialPath = official?.exePath;
  if (typeof officialPath !== 'string' || !path.isAbsolute(officialPath) || !/\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(officialPath) || !await regularFile(officialPath)) throw new Error('registered official Codex CLI could not be resolved');
  const officialVersion = await readVersion(officialPath);
  if (officialVersion !== manifest.version) throw new Error('official Codex CLI version does not match the approved patched runtime');
  const desktopPackageVersion = await readPackageVersion(officialPath);
  if (!/^\d+(?:\.\d+){2,}$/.test(desktopPackageVersion)) throw new Error('official desktop package version is invalid');
  const officialSha256 = (await hashFile(officialPath)).toLowerCase();
  const patchedSha256 = (await hashFile(verified.exePath)).toLowerCase();
  if (officialSha256 === patchedSha256 || patchedSha256 !== manifest.binary_sha256.toLowerCase()) throw new Error('patched CLI hash does not match the verified runtime manifest');
  const receiptPath = path.join(root, 'compatibility.json');
  const receiptInfo = await lstat(receiptPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (receiptInfo && (!receiptInfo.isFile() || receiptInfo.isSymbolicLink())) throw new Error('existing bootstrap compatibility receipt must be a regular file');
  const priorReceiptBytes = receiptInfo ? await readFile(receiptPath) : null;
  const probeReceiptDir = await mkdtemp(path.join(os.tmpdir(), 'codex-api-bootstrap-probe-'));
  const probeReceiptPath = path.join(probeReceiptDir, 'compatibility.json');
  let probeResult, receipt, receiptBytes;
  try {
    probeResult = await probeAndWriteReceipt({ officialPath, patchedPath: verified.exePath, runtimeRoot: root, receiptPath: probeReceiptPath, approvedPatchHashes: [manifest.binary_sha256] });
    receiptBytes = await readFile(probeReceiptPath);
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } finally { await rm(probeReceiptDir, { recursive: true, force: true }); }
  if (probeResult?.schemaVersion !== 1 || probeResult.compatibility?.status !== 'passed'
      || probeResult.compatibility?.probe !== 'app-server-initialize' || probeResult.compatibility?.cliVersion !== manifest.version
      || receipt.schemaVersion !== 1 || receipt.patchedPath !== path.resolve(verified.exePath)
      || receipt.officialSha256 !== officialSha256 || receipt.officialVersion !== officialVersion
      || receipt.desktopPackageVersion !== desktopPackageVersion || receipt.patchedSha256 !== patchedSha256
      || receipt.compatibility?.status !== 'passed' || receipt.compatibility?.probe !== 'app-server-initialize'
      || receipt.compatibility?.cliVersion !== manifest.version
      || probeResult.patchedSha256 !== receipt.patchedSha256 || probeResult.officialSha256 !== receipt.officialSha256
      || probeResult.officialVersion !== receipt.officialVersion || probeResult.desktopPackageVersion !== receipt.desktopPackageVersion
      || probeResult.patchedPath !== receipt.patchedPath) {
    throw new Error('isolated initialize/config-read compatibility probe did not produce a matching receipt');
  }

  if (sha256(await readFile(bootstrapSourcePath)) !== sourceHash) throw new Error('native bootstrap changed during compatibility setup');
  const persistentBootstrap = path.join(root, 'bootstrap', `${sourceHash}.exe`);
  const receiptFileChanged = !priorReceiptBytes || !priorReceiptBytes.equals(receiptBytes);
  const currentEnvironment = await readEnvironment(adapter);
  const plan = await planBootstrapEnvironment({ bootstrapPath: persistentBootstrap, bootstrapSourcePath, officialPath, currentEnvironment, journalPath: journal });
  const priorCli = normalize(plan.prior[CODEX_CLI_PATH]);
  if (priorCli.present && path.resolve(priorCli.value) === path.resolve(persistentBootstrap)) throw new Error('CODEX_CLI_PATH already points to a bootstrap not owned by this API journal');
  const apiPlan = {
    ...plan,
    prior: Object.fromEntries(API_ENV_KEYS.map((key) => [key, normalize(plan.prior[key])])),
    next: Object.fromEntries(API_ENV_KEYS.map((key) => [key, normalize(plan.next[key])])),
  };
  const bootstrapInfo = await lstat(persistentBootstrap).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (bootstrapInfo && (!bootstrapInfo.isFile() || bootstrapInfo.isSymbolicLink())) throw new Error('existing bootstrap destination must be a regular file');
  const priorBootstrapBytes = bootstrapInfo ? await readFile(persistentBootstrap) : null;
  const record = {
    owner: API_BOOTSTRAP_OWNER, schemaVersion: 1, phase: 'prepared', updatedAt: new Date().toISOString(),
    runtime: { version: manifest.version, sourceCommit: manifest.source_commit, patchSha256: manifest.patch_sha256, binarySha256: patchedSha256 },
    paths: { maintenanceRoot: root, runtimeDir: path.resolve(runtimeDir), officialPath, bootstrapPath: persistentBootstrap, receiptPath },
    environment: { prior: apiPlan.prior, next: apiPlan.next },
    bootstrapFile: { path: persistentBootstrap, priorBase64: priorBootstrapBytes?.toString('base64') ?? null, deployedSha256: sourceHash, changed: !priorBootstrapBytes || !priorBootstrapBytes.equals(sourceBytes) },
    receiptFile: { path: receiptPath, priorBase64: priorReceiptBytes?.toString('base64') ?? null, deployedSha256: sha256(receiptBytes), changed: receiptFileChanged },
  };
  let journalHash = await atomicJson(journal, record);
  let fileSnapshot = null;
  let receiptSnapshot = { path: receiptPath, prior: priorReceiptBytes, deployedSha256: sha256(receiptBytes), changed: receiptFileChanged };
  let receiptDeployed = false;
  let envWriteAttempted = false;
  try {
    for (const key of API_ENV_KEYS) if (!same(await adapter.get(key), apiPlan.prior[key])) throw new Error(`environment changed since API bootstrap plan: ${key}`);
    if (receiptSnapshot.changed) { receiptSnapshot = await deployOwnedBootstrap(receiptPath, receiptBytes, priorReceiptBytes, true); receiptDeployed = true; }
    fileSnapshot = await deployOwnedBootstrap(persistentBootstrap, sourceBytes, priorBootstrapBytes, true);
    if (!same(await adapter.get(CODEX_CLI_PATH), apiPlan.prior[CODEX_CLI_PATH])) throw new Error(`environment changed since API bootstrap plan: ${CODEX_CLI_PATH}`);
    envWriteAttempted = true;
    await adapter.set(CODEX_CLI_PATH, apiPlan.next[CODEX_CLI_PATH]);
    record.phase = 'applied'; record.updatedAt = new Date().toISOString();
    journalHash = await atomicJson(journal, record);
  } catch (error) {
    const recoveryErrors = [];
    if (envWriteAttempted) {
      try {
        if (same(await adapter.get(CODEX_CLI_PATH), apiPlan.next[CODEX_CLI_PATH])) {
          const priorCli = apiPlan.prior[CODEX_CLI_PATH];
          const safePrior = priorCli?.present && /(?:^|[\\/])WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]codex\.exe$/i.test(priorCli.value || '') ? { present: false, value: null } : priorCli;
          await adapter.set(CODEX_CLI_PATH, safePrior);
        }
      } catch (rollbackError) { recoveryErrors.push(rollbackError); }
    }
    if (fileSnapshot) try { await rollbackOwnedBootstrap(fileSnapshot); } catch (rollbackError) { recoveryErrors.push(rollbackError); }
    if (receiptDeployed) try { await rollbackOwnedBootstrap(receiptSnapshot); } catch (rollbackError) { recoveryErrors.push(rollbackError); }
    if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], 'API bootstrap apply failed and rollback requires recovery; ownership journal retained');
    await removeOwnedJournal(journal, journalHash);
    throw error;
  }
  return { state: 'armed', restartRequired: true, ready: false, owner: API_BOOTSTRAP_OWNER, journalPath: journal, bootstrapPath: persistentBootstrap, receiptPath, runtimeVersionDir: path.resolve(runtimeDir), reason: 'Codex must restart before the model-host backend can be verified' };
}

export async function armApiBootstrap(options = {}) {
  const runtimeDir = options.runtimeDir;
  if (typeof runtimeDir !== 'string') throw new Error('runtimeDir is required');
  const runtimeRoot = path.resolve(options.runtimeRoot ?? path.dirname(path.dirname(path.resolve(runtimeDir))));
  const journalPath = path.resolve(options.journalPath ?? path.join(runtimeRoot, API_BOOTSTRAP_JOURNAL));
  if (journalPath !== path.join(runtimeRoot, API_BOOTSTRAP_JOURNAL)) throw new Error('API bootstrap journal must be router-runtime/bootstrap-install.json');
  return withFileLock(`${journalPath}.lock`, () => armApiBootstrapUnlocked({ ...options, runtimeRoot, journalPath }), { timeoutMs: 120_000, staleMs: 300_000 });
}

async function disarmOwnedBootstrapUnlocked({ journalPath, adapter } = {}) {
  if (typeof journalPath !== 'string' || !adapter?.get || !adapter?.set) throw new Error('journalPath and Windows user environment adapter are required');
  const journal = path.resolve(journalPath);
  const record = JSON.parse(await readFile(journal, 'utf8'));
  if (record?.owner !== API_BOOTSTRAP_OWNER || record.schemaVersion !== 1 || !['prepared', 'applied'].includes(record.phase)) throw new Error('bootstrap journal is not owned by this API maintenance helper');
  if (path.basename(journal) !== API_BOOTSTRAP_JOURNAL || path.resolve(path.join(record.paths?.maintenanceRoot || '', API_BOOTSTRAP_JOURNAL)) !== journal
      || !inside(path.join(record.paths.maintenanceRoot, 'bootstrap'), record.paths?.bootstrapPath || '')
      || record.paths?.receiptPath !== path.join(record.paths.maintenanceRoot, 'compatibility.json')
      || record.receiptFile?.path !== record.paths.receiptPath
      || !same(record.environment?.next?.[CODEX_CLI_PATH], { present: true, value: record.paths.bootstrapPath })
      || !Object.keys(record.environment?.next || {}).every((key) => key === CODEX_CLI_PATH)
      || !Object.keys(record.environment?.prior || {}).every((key) => key === CODEX_CLI_PATH)
      || (record.environment?.prior?.[CODEX_CLI_PATH]?.present && !/(?:^|[\\/])WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]codex\.exe$/i.test(record.environment.prior[CODEX_CLI_PATH].value || ''))
      || (record.bootstrapFile?.path && !same(record.bootstrapFile.path, record.paths.bootstrapPath))) throw new Error('API bootstrap journal ownership paths or environment snapshot are invalid');
  const snapshot = {
    prior: record.environment?.prior, next: record.environment?.next,
    bootstrapPath: record.paths?.bootstrapPath,
    bootstrapFile: {
      path: record.bootstrapFile?.path,
      prior: record.bootstrapFile?.priorBase64 === null ? null : Buffer.from(record.bootstrapFile?.priorBase64 || '', 'base64'),
      deployedSha256: record.bootstrapFile?.deployedSha256,
      changed: record.bootstrapFile?.changed === true,
    },
  };
  const receiptSnapshot = {
    path: record.receiptFile.path,
    prior: record.receiptFile.priorBase64 === null ? null : Buffer.from(record.receiptFile.priorBase64 || '', 'base64'),
    deployedSha256: record.receiptFile.deployedSha256,
    changed: record.receiptFile.changed === true,
  };
  const currentCli = normalize(await adapter.get(CODEX_CLI_PATH));
  if (!same(currentCli, snapshot.next?.[CODEX_CLI_PATH])) {
    if (same(currentCli, snapshot.prior?.[CODEX_CLI_PATH])) {
      let cleanupWarning = null;
      try { await rollbackOwnedBootstrap(snapshot.bootstrapFile); } catch (error) { cleanupWarning = error instanceof Error ? error.message : String(error); }
      try { await rollbackOwnedBootstrap(receiptSnapshot); } catch (error) { cleanupWarning = [cleanupWarning, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; '); }
      await rm(journal);
      return { disarmed: true, alreadyDisarmed: true, journalPath: journal, cleanupWarning };
    }
    return { disarmed: false, reason: 'CODEX_CLI_PATH changed after API bootstrap ownership was recorded; preserving the later value' };
  }
  const prior = snapshot.prior?.[CODEX_CLI_PATH];
  const safePrior = prior?.present && /(?:^|[\\/])WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]codex\.exe$/i.test(prior.value || '') ? { present: false, value: null } : prior;
  if (!same(await adapter.get(CODEX_CLI_PATH), snapshot.next[CODEX_CLI_PATH])) return { disarmed: false, reason: 'CODEX_CLI_PATH changed during disarm; preserving the later value' };
  await adapter.set(CODEX_CLI_PATH, safePrior);
  let cleanupWarning = null;
  try { await rollbackOwnedBootstrap(snapshot.bootstrapFile); } catch (error) { cleanupWarning = error instanceof Error ? error.message : String(error); }
  try { await rollbackOwnedBootstrap(receiptSnapshot); } catch (error) { cleanupWarning = [cleanupWarning, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; '); }
  await rm(journal);
  return { disarmed: true, journalPath: journal, cleanupWarning };
}

export async function disarmOwnedBootstrap(options = {}) {
  if (typeof options.journalPath !== 'string') throw new Error('journalPath is required');
  const journalPath = path.resolve(options.journalPath);
  return withFileLock(`${journalPath}.lock`, () => disarmOwnedBootstrapUnlocked({ ...options, journalPath }), { timeoutMs: 120_000, staleMs: 300_000 });
}
