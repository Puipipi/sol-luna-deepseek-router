import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getUpgradeGuardStatus, selectCompatibleBackend, writeUpgradeGuardStatus } from '../scripts/native-upgrade-guard.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-upgrade-guard-'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
try {
  const runtimeRoot = path.join(root, 'runtime');
  const officialPath = path.join(root, 'WindowsApps OpenAI Codex', 'app', 'resources', 'codex.exe');
  const patchedPath = path.join(runtimeRoot, 'versions', 'approved', 'codex.exe');
  const receiptPath = path.join(runtimeRoot, 'compatibility.json');
  await mkdir(path.dirname(patchedPath), { recursive: true });
  await mkdir(path.dirname(officialPath), { recursive: true });
  await writeFile(officialPath, 'official fixture');
  await writeFile(patchedPath, 'patched fixture');

  const fallback = await selectCompatibleBackend({ officialPath, officialVersion: '0.164.0-alpha.11.1', desktopPackageVersion: '26.1021.3705.0', runtimeRoot, receiptPath });
  assert.equal(fallback.exePath, officialPath, 'missing compatibility receipt launches the official CLI');
  assert.equal(fallback.state, 'disabled', 'missing patched runtime disables only routed child execution');
  assert.equal(fallback.reason, '兼容补丁尚未通过当前 Codex 版本验证');

  const receipt = {
    schemaVersion: 1,
    officialSha256: sha256('official fixture'),
    officialVersion: '0.164.0-alpha.11.1',
    desktopPackageVersion: '26.1021.3705.0',
    patchedPath,
    patchedSha256: sha256('patched fixture'),
    compatibility: { status: 'passed', probe: 'app-server-initialize', cliVersion: '0.164.0-alpha.11.1' },
  };
  await writeFile(receiptPath, JSON.stringify(receipt));
  const selected = await selectCompatibleBackend({ officialPath, officialVersion: receipt.officialVersion, desktopPackageVersion: receipt.desktopPackageVersion, runtimeRoot, receiptPath, approvedPatchHashes: [receipt.patchedSha256] });
  assert.equal(selected.exePath, patchedPath, 'a hash-approved patch is selected only for the exact tested official CLI and desktop build');
  assert.equal(selected.state, 'healthy');

  const stale = await selectCompatibleBackend({ officialPath, officialVersion: '0.165.0', desktopPackageVersion: '26.1022.4000.0', runtimeRoot, receiptPath, approvedPatchHashes: [receipt.patchedSha256] });
  assert.equal(stale.exePath, officialPath, 'a newer official app always falls back to its own CLI');
  assert.equal(stale.state, 'disabled');
  assert.match(stale.reason, /兼容补丁/);

  await writeFile(receiptPath, JSON.stringify({ ...receipt, patchedPath: path.join(root, 'foreign.exe') }));
  const foreign = await selectCompatibleBackend({ officialPath, officialVersion: receipt.officialVersion, desktopPackageVersion: receipt.desktopPackageVersion, runtimeRoot, receiptPath, approvedPatchHashes: [receipt.patchedSha256] });
  assert.equal(foreign.exePath, officialPath, 'receipt cannot select an executable outside the owned runtime root');

  const statusPath = path.join(root, 'status.json');
  assert.equal((await getUpgradeGuardStatus(statusPath)).state, 'disabled', 'unknown status never claims native routing is healthy');
  await writeUpgradeGuardStatus(statusPath, { state: 'disabled', reason: stale.reason, repairAttempted: true, updatedAt: '2026-10-24T00:00:00.000Z' });
  assert.deepEqual(await getUpgradeGuardStatus(statusPath), { state: 'disabled', reason: '兼容补丁尚未通过当前 Codex 版本验证', repairAttempted: true, updatedAt: '2026-10-24T00:00:00.000Z' });
  assert.doesNotMatch(await readFile(statusPath, 'utf8'), /token|secret|credential|api.?key/i);
  console.log('PASS native upgrade guard selection and status seams');
} finally {
  await rm(root, { recursive: true, force: true });
}
