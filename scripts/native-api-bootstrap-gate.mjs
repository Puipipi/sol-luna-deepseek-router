import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {decodeJournal} from './native-isolated-install.mjs';
import {API_BOOTSTRAP_JOURNAL, API_BOOTSTRAP_OWNER, armApiBootstrap, disarmOwnedBootstrap, observeApiBackend} from './native-bootstrap-maintenance.mjs';
import {routerRuntimeRoot} from './native-upgrade-status.mjs';
import {verifyRuntimeVersion} from './native-runtime.mjs';
import {NATIVE_BOOTSTRAP_PATH, readCodexCliVersion, readDesktopPackageVersion} from './native-bootstrap-install.mjs';
import {createWindowsUserEnvironmentAdapter} from './native-runtime-env.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isInside = (root, file) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const exactPath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const snapshotValue = value => value && typeof value === 'object' && typeof value.present === 'boolean'
  ? value.present ? String(value.value ?? '') : null
  : value == null ? null : String(value);
async function regularFile(file) {
  try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink(); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
function runNativeBootstrap(exe, mode) {
  const result = spawnSync(exe, [mode], {encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error || result.status !== 0) throw new Error(`native bootstrap ${mode} failed`);
  const output = (result.stdout || '').trim();
  if (mode === '--bootstrap-resolve-official-cli') return {exePath: output};
  try { return JSON.parse(output); } catch { throw new Error(`native bootstrap ${mode} returned invalid JSON`); }
}

async function readJson(file, read = readFile) {
  return JSON.parse(await read(file, 'utf8'));
}

async function verifyReceipt({runtimeRoot, runtimeDir, bootstrapPath, record, verifyRuntime, read}) {
  const verified = await verifyRuntime(runtimeDir);
  const manifest = verified?.manifest;
  if (!verified?.exePath || !manifest || !/^[a-f0-9]{64}$/i.test(manifest.binary_sha256 || '')) throw new Error('approved runtime manifest is unavailable');
  const receiptPath = path.join(runtimeRoot, 'compatibility.json');
  if (!exactPath(record?.paths?.receiptPath, receiptPath)) throw new Error('owned bootstrap receipt path is invalid');
  if (!exactPath(record?.receiptFile?.path, receiptPath)) throw new Error('owned bootstrap receipt ownership is unavailable');
  let receiptBytes;
  try { receiptBytes = await read(receiptPath); }
  catch { throw new Error('compatibility receipt is missing or unreadable'); }
  if (record.receiptFile.deployedSha256 && hash(receiptBytes) !== record.receiptFile.deployedSha256) throw new Error('owned bootstrap receipt changed');
  let receipt;
  try { receipt = JSON.parse(receiptBytes.toString('utf8')); }
  catch { throw new Error('compatibility receipt is invalid JSON'); }
  if (receipt.schemaVersion !== 1 || !exactPath(receipt.patchedPath, verified.exePath)
      || String(receipt.patchedSha256).toLowerCase() !== manifest.binary_sha256.toLowerCase()
      || receipt.compatibility?.status !== 'passed' || receipt.compatibility?.probe !== 'app-server-initialize'
      || receipt.compatibility?.cliVersion !== manifest.version) throw new Error('compatibility receipt does not match the approved runtime');
  if (record.bootstrapFile?.deployedSha256) {
    const bootstrapBytes = await read(bootstrapPath);
    if (hash(bootstrapBytes) !== record.bootstrapFile.deployedSha256) throw new Error('owned bootstrap binary changed');
  }
  return {verified, receipt};
}

async function resolveGeneric({runtimeRoot, env, read, verifyRuntime}) {
  const journalPath = path.join(runtimeRoot, API_BOOTSTRAP_JOURNAL);
  let record;
  try { record = await readJson(journalPath, read); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('generic bootstrap ownership journal is unreadable'); }
  if (record?.owner !== API_BOOTSTRAP_OWNER || record.schemaVersion !== 1 || record.phase !== 'applied'
      || !exactPath(record.paths?.maintenanceRoot, runtimeRoot)
      || !exactPath(path.join(record.paths?.maintenanceRoot || '', API_BOOTSTRAP_JOURNAL), journalPath)
      || !isInside(path.join(runtimeRoot, 'versions'), record.paths?.runtimeDir || '')
      || !isInside(path.join(runtimeRoot, 'bootstrap'), record.paths?.bootstrapPath || '')
      || !exactPath(snapshotValue(record.environment?.next?.CODEX_CLI_PATH), record.paths?.bootstrapPath)) {
    throw new Error('generic bootstrap ownership journal is invalid or not active');
  }
  const manifest = (await verifyRuntime(record.paths.runtimeDir)).manifest;
  if (record.runtime?.version !== manifest?.version || record.runtime?.sourceCommit !== manifest?.source_commit
      || record.runtime?.patchSha256 !== manifest?.patch_sha256 || record.runtime?.binarySha256 !== manifest?.binary_sha256) {
    throw new Error('generic bootstrap journal does not match the approved runtime');
  }
  if (!/^[a-f0-9]{64}$/i.test(record.receiptFile?.deployedSha256 || '')
      || !/^[a-f0-9]{64}$/i.test(record.bootstrapFile?.deployedSha256 || '')) {
    throw new Error('generic bootstrap journal is missing owned receipt or binary hashes');
  }
  const bootstrapPath = path.resolve(record.paths.bootstrapPath);
  const {verified, receipt} = await verifyReceipt({runtimeRoot, runtimeDir: record.paths.runtimeDir, bootstrapPath, record, verifyRuntime, read});
  return {source: 'generic', journalPath, runtimeRoot, runtimeDir: path.resolve(record.paths.runtimeDir), bootstrapPath, exePath: verified.exePath, record, receipt};
}

async function resolveLegacyDeepseek({runtimeRoot, env, read, readDeepseekJournal = async file => decodeJournal(await read(file, 'utf8')), verifyRuntime}) {
  const journalPath = env.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  if (typeof journalPath !== 'string' || !journalPath.trim()) throw new Error('DeepSeek install journal is unavailable');
  let record;
  try { record = await readDeepseekJournal(path.resolve(journalPath)); }
  catch (error) { throw new Error(error?.code === 'ENOENT' ? 'DeepSeek install journal is missing' : 'DeepSeek install ownership journal is unreadable'); }
  const bootstrapPath = snapshotValue(record?.environmentSnapshot?.next?.CODEX_CLI_PATH);
  if (record?.phase !== 'active' || record.completed?.environment !== true
      || !exactPath(record.paths?.journalPath, journalPath)
      || !exactPath(record.paths?.codexHome, env.CODEX_HOME || path.dirname(runtimeRoot))
      || !isInside(path.join(runtimeRoot, 'versions'), record.paths?.versionDir || '')
      || !isInside(path.join(runtimeRoot, 'bootstrap'), bootstrapPath || '')) {
    throw new Error('DeepSeek install ownership journal does not prove an active approved bootstrap');
  }
  const {verified} = await verifyReceipt({runtimeRoot, runtimeDir: record.paths.versionDir, bootstrapPath, record: {
    paths: {receiptPath: path.join(runtimeRoot, 'compatibility.json')},
    receiptFile: {path: path.join(runtimeRoot, 'compatibility.json')},
    bootstrapFile: record.environmentSnapshot?.bootstrapFile,
  }, verifyRuntime, read});
  return {source: 'legacy-deepseek', journalPath: path.resolve(journalPath), runtimeRoot, runtimeDir: path.resolve(record.paths.versionDir), bootstrapPath: path.resolve(bootstrapPath), exePath: verified.exePath};
}

export async function resolveOwnedGatewayBootstrap({executor, profileId, env = process.env, apiDir, read = readFile, readDeepseekJournal, verifyRuntimeVersion: verifyRuntime = verifyRuntimeVersion} = {}) {
  const root = path.resolve(routerRuntimeRoot(env));
  if (executor === 'api') {
    if (!/^[a-f0-9]{24}$/.test(profileId || '') || typeof apiDir !== 'string') throw new Error('API profile identity is required for bootstrap readiness');
    const generic = await resolveGeneric({runtimeRoot: root, env, read, verifyRuntime});
    if (generic) return generic;
    throw new Error('API bootstrap is not armed; explicitly Apply API configuration and restart Codex');
  }
  if (executor === 'deepseek') return resolveLegacyDeepseek({runtimeRoot: root, env, read, readDeepseekJournal, verifyRuntime});
  throw new Error('unsupported gateway executor');
}

export async function observeOwnedGatewayBackend(options = {}) {
  const read = options.read || readFile;
  const owned = await resolveOwnedGatewayBootstrap({...options, read});
  const {verified} = await verifyReceipt({runtimeRoot: owned.runtimeRoot, runtimeDir: owned.runtimeDir, bootstrapPath: owned.bootstrapPath,
    record: owned.source === 'generic' ? await readJson(owned.journalPath, read) : {
      paths: {receiptPath: path.join(owned.runtimeRoot, 'compatibility.json')},
      receiptFile: {path: path.join(owned.runtimeRoot, 'compatibility.json')},
      bootstrapFile: null,
    }, verifyRuntime: options.verifyRuntimeVersion || verifyRuntimeVersion, read});
  const observer = options.observer || observeApiBackend;
  return observer({bootstrapPath: owned.bootstrapPath, runtimeDir: owned.runtimeDir,
    verifyRuntimeVersion: async () => verified,
    ...(options.runBootstrap ? {runBootstrap: options.runBootstrap} : {}),
    ...(options.hashFile ? {hashFile: options.hashFile} : {}),
  });
}

export async function assertGatewayBackendReady(options = {}) {
  const result = await observeOwnedGatewayBackend(options);
  if (result?.state !== 'running-approved' || result.restartRequired !== false) {
    const detail = typeof result?.reason === 'string' ? `: ${result.reason}` : '';
    throw new Error(`当前 Codex 后端尚未运行经批准的补丁；请重启 Codex后重试${detail}`);
  }
  return result;
}

export async function armOrReuseApiBootstrap({runtimeDir, codexHome, env = process.env, adapter = createWindowsUserEnvironmentAdapter(),
  bootstrapSourcePath = NATIVE_BOOTSTRAP_PATH, read = readFile, verifyRuntimeVersion: verifyRuntime = verifyRuntimeVersion,
  arm = armApiBootstrap, disarm = disarmOwnedBootstrap,
  runBootstrap = (exe, mode) => runNativeBootstrap(exe, mode),
  readVersion = readCodexCliVersion, readPackageVersion = readDesktopPackageVersion,
  hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex'),
  ...maintenanceOptions} = {}) {
  const root = path.resolve(codexHome, 'router-runtime');
  const runtime = path.resolve(runtimeDir);
  if (!isInside(path.join(root, 'versions'), runtime)) throw new Error('API runtime is not staged under the approved CODEX_HOME/router-runtime/versions directory');
  const journalPath = path.join(root, API_BOOTSTRAP_JOURNAL);
  const current = await resolveGeneric({runtimeRoot: root, env: {...env, CODEX_HOME: codexHome}, read, verifyRuntime});
  if (current) {
    if (!exactPath(current.runtimeDir, runtime)) throw new Error('an owned API bootstrap is armed for a different approved runtime');
    const configured = snapshotValue(await adapter.get('CODEX_CLI_PATH'));
    if (!exactPath(configured, current.bootstrapPath)) throw new Error('owned API bootstrap is no longer the active CODEX_CLI_PATH');
    const manifest = (await verifyRuntime(runtime)).manifest;
    if (!manifest || !/^[a-f0-9]{64}$/i.test(manifest.binary_sha256 || '')) throw new Error('approved runtime identity is unavailable; preserving the current API bootstrap');
    if (!await regularFile(current.bootstrapPath)) throw new Error('owned native bootstrap is unavailable; preserving the current API bootstrap');
    const capabilities = await runBootstrap(current.bootstrapPath, '--bootstrap-capabilities');
    if (capabilities?.schemaVersion !== 1 || capabilities.testBuild !== false
        || capabilities.runtimeVersion !== manifest.version || capabilities.sourceCommit !== manifest.source_commit
        || !Array.isArray(capabilities.approvedPatchHashes)
        || !capabilities.approvedPatchHashes.some(value => String(value).toLowerCase() === manifest.binary_sha256.toLowerCase())) {
      throw new Error('approved native bootstrap does not authorize this runtime; preserving the current API bootstrap');
    }
    const resolved = await runBootstrap(current.bootstrapPath, '--bootstrap-resolve-official-cli');
    const officialPath = resolved?.exePath;
    if (typeof officialPath !== 'string' || !path.isAbsolute(officialPath)
        || !/\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(officialPath)
        || !await regularFile(officialPath)) throw new Error('registered official Codex CLI identity is unavailable; preserving the current API bootstrap');
    const [officialVersion, desktopPackageVersion, officialSha256] = await Promise.all([
      readVersion(officialPath), readPackageVersion(officialPath), hashFile(officialPath),
    ]);
    if (typeof officialVersion !== 'string' || !officialVersion || !/^\d+(?:\.\d+){2,}$/.test(desktopPackageVersion || '')
        || !/^[a-f0-9]{64}$/i.test(officialSha256 || '') || officialSha256.toLowerCase() === manifest.binary_sha256.toLowerCase()) {
      throw new Error('registered official Codex CLI identity is incomplete; preserving the current API bootstrap');
    }
    if (officialVersion !== manifest.version) throw new Error(`registered Codex CLI version ${officialVersion} is unsupported by approved runtime ${manifest.version}; preserving the current API bootstrap`);
    const matchesReceipt = current.receipt.officialSha256?.toLowerCase() === officialSha256.toLowerCase()
      && current.receipt.officialVersion === officialVersion
      && current.receipt.desktopPackageVersion === desktopPackageVersion;
    if (matchesReceipt) return {state: 'armed', restartRequired: true, ready: false, reused: true, journalPath, bootstrapPath: current.bootstrapPath, runtimeVersionDir: runtime};
    const disarmed = await disarm({journalPath, adapter});
    if (disarmed?.disarmed !== true) throw new Error(`registered Codex CLI changed but owned bootstrap could not be safely refreshed: ${disarmed?.reason || 'ownership changed'}; preserving later environment edits`);
    const refreshed = await arm({runtimeDir: runtime, runtimeRoot: root, journalPath, bootstrapSourcePath, adapter,
      verifyRuntimeVersion: verifyRuntime, runBootstrap, readVersion, readPackageVersion, hashFile, ...maintenanceOptions});
    return {...refreshed, reused: false, refreshed: true};
  }
  try {
    const result = await arm({runtimeDir: runtime, runtimeRoot: root, journalPath, bootstrapSourcePath, adapter,
      verifyRuntimeVersion: verifyRuntime, runBootstrap, readVersion, readPackageVersion, hashFile, ...maintenanceOptions});
    return {...result, reused: false};
  } catch (error) {
    throw error;
  }
}

export async function disarmApiBootstrap({codexHome, adapter = createWindowsUserEnvironmentAdapter(), disarm = disarmOwnedBootstrap} = {}) {
  const root = path.resolve(codexHome, 'router-runtime');
  const journalPath = path.join(root, API_BOOTSTRAP_JOURNAL);
  const record = await readJson(journalPath);
  if (record?.owner !== API_BOOTSTRAP_OWNER || record.schemaVersion !== 1 || record.phase !== 'applied'
      || !exactPath(record.paths?.maintenanceRoot, root)) throw new Error('generic API bootstrap journal is foreign or invalid');
  return disarm({journalPath, adapter});
}
