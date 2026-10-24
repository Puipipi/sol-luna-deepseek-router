import { createHash } from 'node:crypto';
import { lstat, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const DISABLED_REASON = '兼容补丁尚未通过当前 Codex 版本验证';
const ALLOWED_STATES = new Set(['healthy', 'repaired', 'disabled']);

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function regularFile(file) {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function hash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function disabled(reason = DISABLED_REASON) {
  return { exePath: null, state: 'disabled', reason, repairAttempted: false };
}

export async function selectCompatibleBackend({ officialPath, officialVersion, desktopPackageVersion, runtimeRoot, receiptPath, approvedPatchHashes = [] } = {}) {
  if (typeof officialPath !== 'string' || !officialPath || typeof officialVersion !== 'string' || !officialVersion
      || typeof desktopPackageVersion !== 'string' || !desktopPackageVersion || typeof runtimeRoot !== 'string' || !runtimeRoot) {
    throw new Error('official CLI identity and runtimeRoot are required');
  }
  if (!await regularFile(officialPath)) throw new Error('the official Codex CLI is missing or is not a regular file');
  const officialSha256 = await hash(officialPath);
  if (!receiptPath || !await regularFile(receiptPath)) return { ...disabled(), exePath: officialPath };

  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    const patchPath = typeof receipt.patchedPath === 'string' ? path.resolve(receipt.patchedPath) : '';
    const expectedHash = String(receipt.patchedSha256 ?? '').toLowerCase();
    if (receipt.schemaVersion !== 1 || receipt.officialSha256 !== officialSha256
        || receipt.officialVersion !== officialVersion || receipt.desktopPackageVersion !== desktopPackageVersion
        || receipt.compatibility?.status !== 'passed' || receipt.compatibility?.probe !== 'app-server-initialize'
        || receipt.compatibility?.cliVersion !== officialVersion || !/^[a-f0-9]{64}$/.test(expectedHash)
        || !approvedPatchHashes.some((item) => String(item).toLowerCase() === expectedHash)
        || !inside(runtimeRoot, patchPath) || patchPath === path.resolve(officialPath)
        || !await regularFile(patchPath) || await hash(patchPath) !== expectedHash) {
      return { ...disabled(), exePath: officialPath };
    }
    return { exePath: patchPath, state: 'healthy', reason: null, repairAttempted: false };
  } catch {
    return { ...disabled(), exePath: officialPath };
  }
}

export async function writeUpgradeGuardStatus(file, value) {
  if (!value || !ALLOWED_STATES.has(value.state) || (typeof value.reason !== 'string' && value.reason !== null)
      || typeof value.repairAttempted !== 'boolean' || typeof value.updatedAt !== 'string') {
    throw new Error('invalid upgrade guard status');
  }
  const safe = { state: value.state, reason: value.reason, repairAttempted: value.repairAttempted, updatedAt: value.updatedAt };
  const target = path.resolve(file);
  const temp = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(safe)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return safe;
}

export async function getUpgradeGuardStatus(file) {
  try {
    const status = JSON.parse(await readFile(file, 'utf8'));
    if (!ALLOWED_STATES.has(status?.state) || (typeof status.reason !== 'string' && status.reason !== null)
        || typeof status.repairAttempted !== 'boolean' || typeof status.updatedAt !== 'string') return disabled();
    return { state: status.state, reason: status.reason, repairAttempted: status.repairAttempted, updatedAt: status.updatedAt };
  } catch {
    return disabled();
  }
}

