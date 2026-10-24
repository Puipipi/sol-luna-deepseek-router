import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { armApiBootstrap, disarmOwnedBootstrap, observeApiBackend } from '../scripts/native-bootstrap-maintenance.mjs';
import { writeCompatibilityReceipt } from '../scripts/native-bootstrap-install.mjs';
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_VERSION, NATIVE_RUNTIME_TARGET } from '../scripts/native-runtime.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-bootstrap-maintenance-test-'));
try {
  const officialPath = path.join(root, 'WindowsApps', 'OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0', 'app', 'resources', 'codex.exe');
  const runtimeDir = path.join(root, 'runtime', 'versions', 'approved');
  const bootstrapSourcePath = path.join(root, 'bootstrap-source.exe');
  const journalPath = path.join(root, 'runtime', 'bootstrap-install.json');
  const rootReceiptPath = path.join(root, 'runtime', 'compatibility.json');
  const priorReceiptBytes = Buffer.from('{"receipt":"preexisting"}\n');
  const patchedBytes = Buffer.from('approved patched runtime fixture');
  const patchedSha256 = createHash('sha256').update(patchedBytes).digest('hex');
  const officialBytes = Buffer.from('official stock CLI fixture');
  const officialSha256 = createHash('sha256').update(officialBytes).digest('hex');
  await writeFile(bootstrapSourcePath, 'approved bootstrap fixture');
  await mkdir(path.dirname(officialPath), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(officialPath, officialBytes);
  await writeFile(path.join(runtimeDir, 'codex.exe'), patchedBytes);
  await writeFile(rootReceiptPath, priorReceiptBytes);
  const manifest = { version: NATIVE_RUNTIME_VERSION, source_commit: NATIVE_RUNTIME_SOURCE_COMMIT, patch_sha256: NATIVE_RUNTIME_PATCH_SHA256, target: NATIVE_RUNTIME_TARGET, stock_cli_version: NATIVE_RUNTIME_VERSION, binary_sha256: patchedSha256, files: { 'codex.exe': patchedSha256 } };
  const verified = { exePath: path.join(runtimeDir, 'codex.exe'), manifest };
  assert.notEqual(manifest.patch_sha256, manifest.binary_sha256, 'fixture distinguishes source patch digest from compiled executable digest');
  const capability = { schemaVersion: 1, testBuild: false, runtimeVersion: manifest.version, sourceCommit: manifest.source_commit, approvedPatchHashes: [manifest.binary_sha256] };
  const current = new Map([
    ['CODEX_CLI_PATH', { present: false, value: null }],
    ['SOL_LUNA_NATIVE_PLAINTEXT_V2', { present: false, value: null }],
  ]);
  let writes = 0;
  let failCliAfterWrite = false;
  const adapter = {
    async get(key) { return current.get(key); },
    async set(key, value) {
      writes += 1;
      current.set(key, value);
      if (failCliAfterWrite && key === 'CODEX_CLI_PATH' && value.present) throw new Error('injected env failure');
    },
  };
  const runBootstrap = async (_exe, mode) => {
    if (mode === '--bootstrap-capabilities') return capability;
    if (mode === '--bootstrap-resolve-official-cli') return { exePath: officialPath };
    if (mode === '--bootstrap-observe-backend') return { schemaVersion: 1, observed: true, exePath: officialPath, exeSha256: 'b'.repeat(64) };
    throw new Error(`unexpected bootstrap mode ${mode}`);
  };
  const common = {
    bootstrapPath: bootstrapSourcePath,
    runtimeDir,
    verifyRuntimeVersion: async () => verified,
    runBootstrap,
    hashFile: async (file) => createHash('sha256').update(await readFile(file)).digest('hex'),
  };

  const stock = await observeApiBackend({ ...common, hashFile: async () => 'b'.repeat(64), runBootstrap: async (_exe, mode) => mode === '--bootstrap-capabilities' ? capability : { schemaVersion: 1, observed: true, exePath: officialPath, exeSha256: 'b'.repeat(64) } });
  assert.equal(stock.state, 'restart-required', 'stock ancestor reports restart required rather than API ready');
  assert.equal(stock.restartRequired, true);
  const active = await observeApiBackend({ ...common, hashFile: async () => manifest.binary_sha256, runBootstrap: async (_exe, mode) => mode === '--bootstrap-capabilities' ? capability : { schemaVersion: 1, observed: true, exePath: verified.exePath, exeSha256: manifest.binary_sha256 } });
  assert.equal(active.state, 'running-approved', 'only the exact approved binary in the live ancestor chain is ready');

  const emptyAllowlist = await observeApiBackend({ ...common, runBootstrap: async () => ({ ...capability, approvedPatchHashes: [] }) });
  assert.equal(emptyAllowlist.state, 'unavailable', 'bootstrap without approved patch capability is rejected');
  writes = 0;
  await assert.rejects(() => armApiBootstrap({ ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter, runBootstrap: async () => ({ ...capability, approvedPatchHashes: [] }) }), /does not approve/i);
  assert.equal(writes, 0, 'empty allowlist refuses before writing user environment');
  await assert.rejects(() => armApiBootstrap({ ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter, verifyRuntimeVersion: async () => { throw new Error('provenance rejected'); } }), /provenance rejected/);
  assert.equal(writes, 0, 'invalid runtime provenance refuses before writing user environment');

  const writeReceipt = async (args) => {
    assert.deepEqual(args.approvedPatchHashes, [manifest.binary_sha256], 'receipt writer receives compiled binary hash rather than source patch hash');
    return writeCompatibilityReceipt(args.receiptPath, {
      officialPath, officialVersion: manifest.version, desktopPackageVersion: '26.1021.3705.0', patchedPath: verified.exePath,
      probeResult: { status: 'passed', probe: 'app-server-initialize', cliVersion: manifest.version },
      approvedPatchHashes: args.approvedPatchHashes,
    });
  };
  const success = await armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter,
    readVersion: () => manifest.version,
    readPackageVersion: () => '26.1021.3705.0',
    probeAndWriteCompatibilityReceipt: writeReceipt,
  });
  assert.equal(success.state, 'armed');
  assert.equal(success.restartRequired, true, 'arming from a maintenance/MCP process never claims the model host already uses the new backend');
  assert.equal(current.get('CODEX_CLI_PATH').value, success.bootstrapPath);
  assert.equal(current.has('SOL_LUNA_NATIVE_INSTALL_JOURNAL'), false, 'API bootstrap does not write the legacy DeepSeek journal');
  assert.deepEqual(current.get('SOL_LUNA_NATIVE_PLAINTEXT_V2'), { present: false, value: null }, 'API bootstrap maintenance only owns CODEX_CLI_PATH');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(journal.owner, 'sol-luna-native-api-bootstrap');
  assert.equal(journal.schemaVersion, 1);
  assert.equal(journal.phase, 'applied');
  assert.equal(JSON.parse(await readFile(rootReceiptPath, 'utf8')).patchedSha256, manifest.binary_sha256, 'arm writes the receipt at the router-runtime root consumed by the C bootstrap');
  assert.equal(JSON.parse(await readFile(rootReceiptPath, 'utf8')).officialSha256, officialSha256, 'the real receipt writer hashes the official fixture rather than using mocked metadata');
  assert.equal(journal.receiptFile.path, rootReceiptPath);
  assert.equal(Buffer.from(journal.receiptFile.priorBase64, 'base64').compare(priorReceiptBytes), 0, 'receipt prior bytes are journaled for CAS rollback');

  const manualValue = { present: true, value: 'D:\\Tools\\manual-codex.exe' };
  current.set('CODEX_CLI_PATH', manualValue);
  const disarmConflict = await disarmOwnedBootstrap({ journalPath, adapter });
  assert.equal(disarmConflict.disarmed, false, 'off preserves a later user-owned environment edit');
  assert.deepEqual(current.get('CODEX_CLI_PATH'), manualValue);
  assert.equal(JSON.parse(await readFile(rootReceiptPath, 'utf8')).patchedSha256, manifest.binary_sha256, 'CAS conflict leaves the compatibility receipt owned by the active bootstrap intact');
  current.set('CODEX_CLI_PATH', journal.environment.next.CODEX_CLI_PATH);
  assert.equal((await disarmOwnedBootstrap({ journalPath, adapter })).disarmed, true);
  assert.deepEqual(current.get('CODEX_CLI_PATH'), { present: false, value: null });
  assert.equal((await readFile(rootReceiptPath)).compare(priorReceiptBytes), 0, 'disarm restores the previous root receipt only while its installed hash is still owned');

  const rearmed = await armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter,
    readVersion: () => manifest.version,
    readPackageVersion: () => '26.1021.3705.0',
    probeAndWriteCompatibilityReceipt: writeReceipt,
  });
  assert.equal(rearmed.state, 'armed', 'the same owned root receipt can be atomically armed again after disarm');
  assert.equal((await disarmOwnedBootstrap({ journalPath, adapter })).disarmed, true);
  assert.equal((await readFile(rootReceiptPath)).compare(priorReceiptBytes), 0, 'rearm/disarm repeats receipt CAS restoration');

  let releaseFirstProbe;
  let firstProbeEntered;
  const firstProbeGate = new Promise((resolve) => { releaseFirstProbe = resolve; });
  const firstProbeSignal = new Promise((resolve) => { firstProbeEntered = resolve; });
  const firstArm = armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter,
    readVersion: () => manifest.version,
    readPackageVersion: () => '26.1021.3705.0',
    probeAndWriteCompatibilityReceipt: async (args) => { firstProbeEntered(); await firstProbeGate; return writeReceipt(args); },
  });
  await firstProbeSignal;
  let secondVerifyCalled = false;
  let releaseSecondVerify;
  const secondVerifyGate = new Promise((resolve) => { releaseSecondVerify = resolve; });
  const secondArm = armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter,
    verifyRuntimeVersion: async () => { secondVerifyCalled = true; await secondVerifyGate; return verified; },
    readVersion: () => manifest.version,
    readPackageVersion: () => '26.1021.3705.0',
    probeAndWriteCompatibilityReceipt: writeReceipt,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const secondEnteredWhileFirstHeldLock = secondVerifyCalled;
  releaseFirstProbe();
  const firstArmResult = await firstArm;
  releaseSecondVerify();
  await assert.rejects(() => secondArm, /already exists|CODEX_CLI_PATH/i, 'serialized concurrent Apply cannot replace an existing ownership record');
  assert.equal(secondEnteredWhileFirstHeldLock, false, 'second Apply cannot pass journal preflight while first Apply is in its probe');
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).phase, 'applied', 'second Apply leaves first successful ownership journal intact');
  assert.equal(current.get('CODEX_CLI_PATH').value, firstArmResult.bootstrapPath, 'first successful environment ownership survives the competing Apply');
  assert.equal((await disarmOwnedBootstrap({ journalPath, adapter })).disarmed, true);
  assert.equal((await readFile(rootReceiptPath)).compare(priorReceiptBytes), 0, 'serialized arm/disarm restores the prior root receipt');

  let releaseArmBeforeDisarm;
  let armEnteredProbe;
  const armDisarmGate = new Promise((resolve) => { releaseArmBeforeDisarm = resolve; });
  const armDisarmSignal = new Promise((resolve) => { armEnteredProbe = resolve; });
  const armBeforeDisarm = armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter,
    readVersion: () => manifest.version,
    readPackageVersion: () => '26.1021.3705.0',
    probeAndWriteCompatibilityReceipt: async (args) => { armEnteredProbe(); await armDisarmGate; return writeReceipt(args); },
  });
  await armDisarmSignal;
  let disarmSettled = false;
  const concurrentDisarm = disarmOwnedBootstrap({ journalPath, adapter }).then((value) => { disarmSettled = true; return { value }; }, (error) => { disarmSettled = true; return { error }; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const disarmRanWhileArmHeldLock = disarmSettled;
  releaseArmBeforeDisarm();
  await armBeforeDisarm;
  const concurrentDisarmResult = await concurrentDisarm;
  assert.equal(disarmRanWhileArmHeldLock, false, 'disarm waits for the in-flight apply transaction on the shared file lock');
  assert.equal(concurrentDisarmResult.value?.disarmed, true, 'disarm reads and clears the journal after the serialized apply completes');
  assert.equal((await readFile(rootReceiptPath)).compare(priorReceiptBytes), 0, 'serialized disarm restores the exact previous receipt bytes');

  current.set('CODEX_CLI_PATH', { present: true, value: officialPath });
  failCliAfterWrite = true;
  const failureRoot = path.join(root, 'runtime');
  const failureJournal = journalPath;
  await assert.rejects(() => armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: failureRoot, journalPath: failureJournal, adapter,
    readVersion: () => manifest.version,
    readPackageVersion: () => '26.1021.3705.0',
    probeAndWriteCompatibilityReceipt: writeReceipt,
  }), /injected env failure/);
  assert.deepEqual(current.get('CODEX_CLI_PATH'), { present: false, value: null }, 'failed application clears a restored WindowsApps prior pin instead of leaving the old kernel selected');
  assert.equal(await readFile(failureJournal, 'utf8').then(() => true, () => false), false, 'failed transaction removes its prepared journal after rollback');
  assert.deepEqual(await readdir(path.join(failureRoot, 'bootstrap')).catch(() => []), [], 'failed transaction removes its newly deployed owned bootstrap file');
  assert.equal((await readFile(rootReceiptPath)).compare(priorReceiptBytes), 0, 'failed application rolls back the owned root receipt');
  failCliAfterWrite = false;

  await armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter,
    readVersion: () => manifest.version,
    readPackageVersion: () => '26.1021.3705.0',
    probeAndWriteCompatibilityReceipt: writeReceipt,
  });
  const laterReceiptBytes = Buffer.from('{"receipt":"later manual update"}\n');
  await writeFile(rootReceiptPath, laterReceiptBytes);
  const disarmedWithReceiptEdit = await disarmOwnedBootstrap({ journalPath, adapter });
  assert.equal(disarmedWithReceiptEdit.disarmed, true, 'manual receipt changes do not block clearing the owned environment path');
  assert.ok(disarmedWithReceiptEdit.cleanupWarning, 'disarm reports when a later receipt change prevents receipt rollback');
  assert.equal((await readFile(rootReceiptPath)).compare(laterReceiptBytes), 0, 'receipt CAS preserves a later manual file edit');
  await assert.rejects(() => readFile(`${journalPath}.lock`), { code: 'ENOENT' }, 'shared transaction lock is removed after arm/disarm operations');
  console.log('PASS API bootstrap maintenance state, capability gate, CAS and rollback seams');
} finally {
  await rm(root, { recursive: true, force: true });
}
