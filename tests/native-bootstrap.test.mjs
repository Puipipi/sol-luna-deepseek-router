import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCompatibilityReceipt } from '../scripts/native-bootstrap-install.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-bootstrap-test-'));
const repo = fileURLToPath(new URL('..', import.meta.url));
const gcc = process.env.CC?.trim() || 'gcc';
const backend = path.join(root, 'fake backend.exe');
const patched = path.join(root, 'fake patched backend.exe');
const harness = path.join(root, 'codex bootstrap harness.exe');
const release = path.join(root, 'codex bootstrap release.exe');
const capabilityFixture = path.join(root, 'codex bootstrap capability fixture.exe');
const runtime = path.join(root, 'runtime with spaces');
try {
  await mkdir(runtime, { recursive: true });
  const compilerVersion = spawnSync(gcc, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(compilerVersion.status, 0, `cannot run configured C compiler ${gcc}: ${compilerVersion.error ? `${compilerVersion.error.code}: ${compilerVersion.error.message}` : compilerVersion.stderr || `exit ${compilerVersion.status}`}`);
  const build = (args) => spawnSync(gcc, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const assertBuild = (result, target) => assert.equal(result.status, 0,
    `${target} build using ${gcc} failed: ${result.error ? `${result.error.code}: ${result.error.message}` : result.stderr || `exit ${result.status}`}`);
  let result = build(['-municode', '-mconsole', path.join(repo, 'tests', 'native-bootstrap-fake-backend.c'), '-o', backend]);
  assertBuild(result, 'official fake backend');
  result = build(['-DPATCHED_FAKE', '-municode', '-mconsole', path.join(repo, 'tests', 'native-bootstrap-fake-backend.c'), '-o', patched]);
  assertBuild(result, 'patched fake backend');
  const patchedSha256 = createHash('sha256').update(await readFile(patched)).digest('hex');
  result = build([`-DAPPROVED_PATCH_SHA256=\"${patchedSha256}\"`, '-DTEST_HARNESS', '-municode', '-mwindows', '-O2', path.join(repo, 'native', 'bootstrap', 'bootstrap.c'), '-o', harness, '-lbcrypt', '-lshell32']);
  assertBuild(result, 'bootstrap harness');
  result = build(['-municode', '-mwindows', '-O2', path.join(repo, 'native', 'bootstrap', 'bootstrap.c'), '-o', release, '-lbcrypt', '-lshell32']);
  assertBuild(result, 'release bootstrap');
  result = build([`-DAPPROVED_PATCH_SHA256=\"${'1'.repeat(64)}\"`, '-DAPPROVED_RUNTIME_VERSION=\"0.164.0-alpha.11.1\"', '-DAPPROVED_SOURCE_COMMIT=\"6905ecede7816e91373e9eabda3f6b0368fc747b\"', '-municode', '-mwindows', '-O2', path.join(repo, 'native', 'bootstrap', 'bootstrap.c'), '-o', capabilityFixture, '-lbcrypt', '-lshell32']);
  assertBuild(result, 'capability fixture');
  const releaseStrings = (await readFile(release)).toString('latin1');
  assert.doesNotMatch(releaseStrings, /CODEX_BOOTSTRAP_TEST_/, 'release build excludes all test-only backend/parent bypasses');
  const capabilities = spawnSync(release, ['--bootstrap-capabilities'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(capabilities.status, 0, capabilities.stderr);
  const capabilityRecord = JSON.parse(capabilities.stdout);
  assert.equal(capabilityRecord.testBuild, false, 'release capabilities cannot claim test harness');
  assert.deepEqual(capabilityRecord.approvedPatchHashes, [], 'default release allowlist remains empty until artifact approval');
  const fixtureCapabilities = spawnSync(capabilityFixture, ['--bootstrap-capabilities'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(fixtureCapabilities.status, 0, fixtureCapabilities.stderr);
  assert.deepEqual(JSON.parse(fixtureCapabilities.stdout), { schemaVersion: 1, testBuild: false, runtimeVersion: '0.164.0-alpha.11.1', sourceCommit: '6905ecede7816e91373e9eabda3f6b0368fc747b', approvedPatchHashes: ['1'.repeat(64)] }, 'capability metadata reports only compile-time release approvals');
  const observed = spawnSync(release, ['--bootstrap-observe-backend'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(observed.status, 0, observed.stderr);
  const observedRecord = JSON.parse(observed.stdout);
  assert.equal(observedRecord.schemaVersion, 1);
  if (observedRecord.observed) {
    assert.match(observedRecord.exePath, /\\codex\.exe$/i, 'a real Codex ancestor reports its executable path');
    assert.equal(observedRecord.exeSha256, createHash('sha256').update(await readFile(observedRecord.exePath)).digest('hex'));
  } else {
    assert.equal(observedRecord.exePath, null, 'absence of a Codex ancestor is represented with a null path');
    assert.equal(observedRecord.exeSha256, null, 'absence of a Codex ancestor is represented with a null hash');
  }
  const controlledCodexParent = path.join(root, 'codex.exe');
  await copyFile(backend, controlledCodexParent);
  const controlledObservation = spawnSync(controlledCodexParent, ['--spawn-observer', release], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(controlledObservation.status, 0, controlledObservation.stderr);
  const controlledRecord = JSON.parse(controlledObservation.stdout);
  assert.equal(controlledRecord.observed, true, 'a controlled codex.exe ancestor exercises the production positive path');
  assert.equal(path.resolve(controlledRecord.exePath).toLowerCase(), path.resolve(controlledCodexParent).toLowerCase());
  assert.equal(controlledRecord.exeSha256, createHash('sha256').update(await readFile(controlledCodexParent)).digest('hex'));
  console.log(`PASS live ancestor observation: ${observedRecord.observed ? 'host codex ancestor present' : 'no host codex ancestor'}; controlled positive verified`);
  const releaseResolution = spawnSync(release, ['--codex-native-resolve-official-cli-v1'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (releaseResolution.status === 0) {
    const resolvedPath = releaseResolution.stdout.trim();
    assert.match(resolvedPath, /^[A-Z]:\\.*WindowsApps\\OpenAI\.Codex_.*\\app\\resources\\codex\.exe$/i, 'production rollback resolver finds the current registered desktop CLI');
    assert.equal(path.isAbsolute(resolvedPath), true, 'production resolver returns an absolute CLI path');
    assert.equal((await lstat(resolvedPath)).isFile(), true, 'production resolver path names an installed regular CLI');
  } else {
    assert.equal(releaseResolution.status, 126, `production resolver reports a missing registered desktop CLI explicitly: ${releaseResolution.stderr}`);
    assert.equal(releaseResolution.stdout, '', 'production resolver emits no fake path when the host has no Codex package');
  }
  for (const [versionCase, expected] of [['valid', '11111'], ['wrong-field', '11110'], ['prefix', '11110']]) {
    const parser = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BOOTSTRAP_TEST_VERSION_CASE: versionCase } });
    assert.equal(parser.stdout.slice(0, 5), expected, `version parser ${versionCase} case: ${parser.stdout}`);
  }

  const packageRoot = path.join(root, 'test package', 'WindowsApps', 'OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0', 'app');
  const parentImage = path.join(packageRoot, 'Codex.exe');
  const packageCli = path.join(packageRoot, 'resources', 'codex.exe');
  await mkdir(path.dirname(packageCli), { recursive: true });
  await copyFile(backend, packageCli);
  await copyFile(backend, parentImage);
  const parentProbe = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BOOTSTRAP_TEST_PARENT_IMAGE: parentImage } });
  assert.equal(parentProbe.status, 0, parentProbe.stderr);
  assert.equal(parentProbe.stdout, `package=26.1021.3705.0|exe=${packageCli}`, 'test-only injected desktop image metadata resolves the matching packaged official CLI');


  const original = spawnSync(harness, ['argument with spaces', '中文路径'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, FAKE_EXIT_CODE: '23', PATCH_MARKER: path.join(root, 'patch-started.marker') },
  });
  assert.equal(original.status, 23, original.stderr);
  assert.equal(original.stdout, 'argc=3|argument with spaces|中文路径|', 'native bootstrap preserves arguments and stdout without protocol text');
  assert.equal(original.stderr, '', 'native bootstrap keeps diagnostics off stderr');

  await writeFile(path.join(runtime, 'codex-patched.exe'), await readFile(patched));
  const receiptPath = path.join(runtime, 'compatibility.json');
  const validReceipt = await writeCompatibilityReceipt(receiptPath, {
    officialPath: backend, officialVersion: '0.164.0-alpha.11.1', desktopPackageVersion: '26.1021.3705.0',
    patchedPath: path.join(runtime, 'codex-patched.exe'),
    probeResult: { status: 'passed', probe: 'app-server-initialize', cliVersion: '0.164.0-alpha.11.1' },
    approvedPatchHashes: [patchedSha256],
  });
  const request = '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}\n{"id":2,"method":"config/read","params":{"includeLayers":true}}\n';
  const officialResponse = '{"id":1,"result":{"userAgent":"official"}}\n{"id":2,"result":{"config":{}}}\n';
  for (const mode of ['exit', 'garbage', 'malformed', 'hang', 'error', 'wrong-version', 'wrong-field-version', 'version-prefix']) {
    const started = Date.now();
    const fallback = spawnSync(harness, ['app-server'], {
      input: request, encoding: 'utf8', windowsHide: true, timeout: 7000,
      env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, PATCHED_MODE: mode, PATCH_MARKER: path.join(root, 'patch-started.marker'), PROBE_HOME_MARKER: path.join(root, 'probe-home.txt') },
    });
    assert.equal(fallback.status, 0, `${mode}: ${fallback.stderr}`);
    assert.equal(fallback.stdout.replaceAll('\r\n', '\n'), officialResponse, `${mode} probe must not consume the desktop requests or leak patched stdout`);
    assert.equal(fallback.stderr, '', `${mode} probe must not leak diagnostics to desktop stderr`);
    assert.ok(Date.now() - started < 5000, `${mode} probe must be bounded`);
    const status = JSON.parse(await readFile(path.join(runtime, 'upgrade-status.json'), 'utf8'));
    assert.equal(status.state, 'disabled', `${mode} failure disables child routing`);
  }
  const healthy = spawnSync(harness, ['app-server'], {
    input: request, encoding: 'utf8', windowsHide: true, timeout: 7000,
    env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, PATCHED_MODE: 'success', PATCH_MARKER: path.join(root, 'patch-started.marker'), PROBE_HOME_MARKER: path.join(root, 'probe-home.txt') },
  });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(healthy.stdout.replaceAll('\r\n', '\n'), '{"id":1,"result":{"origin":"patched"}}\n{"id":2,"result":{"config":{}}}\n', 'successful isolated initialize/config-read probe selects patched CLI for untouched desktop stream');
  assert.ok((await readFile(path.join(root, 'probe-home.txt'), 'utf8')).startsWith(path.join(runtime, 'probes') + path.sep), 'preflight CODEX_HOME is created under the managed runtime root');
  const liveFailure = spawnSync(harness, ['app-server'], {
    input: request, encoding: 'utf8', windowsHide: true, timeout: 7000,
    env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, PATCHED_MODE: 'live-exit', PATCH_MARKER: path.join(root, 'patch-started.marker'), PROBE_HOME_MARKER: path.join(root, 'probe-home.txt') },
  });
  assert.equal(liveFailure.status, 2, 'a failure after successful probe exits normally instead of replaying requests to official');
  assert.equal(liveFailure.stdout.replaceAll('\r\n', '\n'), 'patched stream already consumed\n', 'formal patched stream is never followed by an official duplicate response');
  assert.equal(JSON.parse(await readFile(path.join(runtime, 'upgrade-status.json'), 'utf8')).state, 'disabled', 'late process failure disables future child routing');

  const baselinePatchStarts = (await readFile(path.join(root, 'patch-started.marker'), 'utf8')).trim().split(/\r?\n/).length;
  const invalidReceiptVariants = [
    ['nested failure', { status: 'passed', probe: 'app-server-initialize', cliVersion: '0.164.0-alpha.11.1', ...validReceipt, compatibility: { ...validReceipt.compatibility, status: 'failed' } }],
    ['nested version mismatch', { status: 'passed', probe: 'app-server-initialize', cliVersion: '0.164.0-alpha.11.1', ...validReceipt, compatibility: { ...validReceipt.compatibility, cliVersion: '0.163.0' } }],
    ['flat-only legacy receipt', { status: 'passed', probe: 'app-server-initialize', cliVersion: '0.164.0-alpha.11.1', ...validReceipt, compatibility: undefined }],
  ];
  for (const [label, badReceipt] of invalidReceiptVariants) {
    await writeFile(receiptPath, JSON.stringify(badReceipt));
    const fallback = spawnSync(harness, ['app-server'], {
      input: request, encoding: 'utf8', windowsHide: true, timeout: 7000,
      env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, PATCHED_MODE: 'success', PATCH_MARKER: path.join(root, 'patch-started.marker') },
    });
    assert.equal(fallback.status, 0, `${label}: ${fallback.stderr}`);
    assert.equal(fallback.stdout.replaceAll('\r\n', '\n'), officialResponse, `${label} must not override the canonical compatibility object`);
    assert.equal(JSON.parse(await readFile(path.join(runtime, 'upgrade-status.json'), 'utf8')).state, 'disabled', `${label} disables patched selection`);
    assert.equal((await readFile(path.join(root, 'patch-started.marker'), 'utf8')).trim().split(/\r?\n/).length, baselinePatchStarts, `${label} must not launch the patched executable`);
  }

  const currentResolution = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BOOTSTRAP_TEST_RESOLVE_ONLY: '1' } });
  if (currentResolution.status === 0) {
    const currentResolutionRecord = Object.fromEntries(currentResolution.stdout.trim().split('|').map((entry) => { const i=entry.indexOf('='); return [entry.slice(0,i),entry.slice(i+1)]; }));
    assert.match(currentResolutionRecord.exe, /^[A-Z]:\\.*WindowsApps\\OpenAI\.Codex_.*\\app\\resources\\codex\.exe$/i, 'current machine resolves a real official package path without assuming C:');
    assert.equal(path.isAbsolute(currentResolutionRecord.exe), true, 'test harness resolver returns an absolute path when Codex is installed');
    assert.equal((await lstat(currentResolutionRecord.exe)).isFile(), true, 'test harness resolver path is an installed regular CLI');
    assert.ok(['parent', 'current-package', 'registered-package'].includes(currentResolutionRecord.source), 'the actual host may expose the package through any supported registered source');
    console.log(`PASS actual machine package resolution: ${currentResolutionRecord.source} ${currentResolutionRecord.exe}`);
  } else {
    assert.equal(currentResolution.status, 126, `test harness reports that Codex is not installed: ${currentResolution.stderr}`);
    assert.equal(currentResolution.stdout, '', 'test harness emits no resolved path when Codex is absent');
  }
  const parentUnavailable = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BOOTSTRAP_TEST_RESOLVE_ONLY: '1', CODEX_BOOTSTRAP_TEST_SKIP_PARENT: '1' } });
  if (parentUnavailable.status === 0) {
    const fallbackResolution = Object.fromEntries(parentUnavailable.stdout.trim().split('|').map((entry) => { const i=entry.indexOf('='); return [entry.slice(0,i),entry.slice(i+1)]; }));
    assert.match(fallbackResolution.exe, /^[A-Z]:\\.*WindowsApps\\OpenAI\.Codex_.*\\app\\resources\\codex\.exe$/i);
    assert.equal(path.isAbsolute(fallbackResolution.exe), true);
    assert.equal((await lstat(fallbackResolution.exe)).isFile(), true, 'package fallback returns an installed regular CLI');
    assert.equal(fallbackResolution.source, 'registered-package', 'registered-package API recovers when ancestor image access is unavailable');
  } else {
    assert.equal(parentUnavailable.status, 126, `parent-unavailable resolution reports the missing package: ${parentUnavailable.stderr}`);
    assert.equal(parentUnavailable.stdout, '', 'parent-unavailable resolution emits no fake path when Codex is absent');
  }

  const virtualRegisteredRoot = 'D:\\Apps\\WindowsApps\\OpenAI.Codex_26.1024.5000.0_x64__2p2nqsd0c76g0';
  const alternateDrive = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BOOTSTRAP_TEST_RESOLVE_ONLY: '1', CODEX_BOOTSTRAP_TEST_REGISTERED_ROOTS: virtualRegisteredRoot } });
  assert.equal(alternateDrive.status, 0, alternateDrive.stderr);
  const alternateRecord = Object.fromEntries(alternateDrive.stdout.trim().split('|').map((entry) => { const i=entry.indexOf('='); return [entry.slice(0,i),entry.slice(i+1)]; }));
  assert.equal(alternateRecord.exe, `${virtualRegisteredRoot}\\app\\resources\\codex.exe`, 'registered package path resolution accepts a package on a non-C drive');

  const missingPackage = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_CLI_PATH: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe', CODEX_BOOTSTRAP_TEST_FORCE_NO_OFFICIAL: '1', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root } });
  assert.equal(missingPackage.status, 126, 'missing official installation is distinguished as unrecoverable');
  assert.equal(missingPackage.stdout, '', 'a stale CODEX_CLI_PATH is never blindly launched as fallback');
  const missingStatus = JSON.parse(await readFile(path.join(runtime, 'upgrade-status.json'), 'utf8'));
  assert.equal(missingStatus.state, 'disabled', 'unresolved package writes local degraded status before returning');
  assert.match(missingStatus.reason, /官方 CLI|桌面包|重新安装/);

  assert.equal((await readFile(path.join(root, 'patch-started.marker'), 'utf8')).trim().split(/\r?\n/).length, 12, 'failed probes never start a formal patched process; only healthy probes do');
  console.log('PASS native bootstrap: isolated app-server probe, clean official fallback, untouched desktop request');
} finally {
  await rm(root, { recursive: true, force: true });
}





