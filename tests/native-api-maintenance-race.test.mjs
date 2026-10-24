import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {applyApiConfiguration} from '../scripts/native-api-install.mjs';
import {createApiProfile, readRouterSettingsSnapshot, saveRouterSettings} from '../scripts/native-api-settings.mjs';
import {createRouterSettingsService} from '../scripts/router-settings-mcp.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'api-maintenance-races-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
try {
  const codexHome = path.join(root, 'codex-home');
  const env = {CODEX_HOME: codexHome, LOCALAPPDATA: path.join(root, 'local'), CODEX_CLI_PATH: 'stock', FIXTURE_KEY: 'test-only'};
  const apiDir = path.join(root, 'api');
  const settingsPath = path.join(apiDir, 'router.json');
  const runtimeDir = path.join(codexHome, 'router-runtime', 'versions', 'approved');
  await mkdir(runtimeDir, {recursive: true});
  const profile = createApiProfile({protocol: 'responses', baseUrl: 'https://api.example.invalid/v1', model: 'fixture-model',
    reasoning: {supported: ['low', 'high'], default: 'high', parameter: 'reasoning_effort'}, credential: {type: 'env', name: 'FIXTURE_KEY'}});
  const settings = {schemaVersion: 1, enabled: true, mode: 'fixed', fixedExecutor: profile.profileId, schedule: {peak: 'luna', valley: 'deepseek'}, profiles: {[profile.profileId]: profile}};
  await saveRouterSettings(settingsPath, settings);
  const ownedBootstrapPath = path.join(codexHome, 'router-runtime', 'bootstrap-owner.json');
  const aEnteredArm = deferred();
  const releaseA = deferred();
  let bEnteredArm = false;
  const makeDependencies = label => ({
    apiDir, settingsPath, codexHome, env, pluginRoot: path.resolve('..', '..'),
    discoverApplyCompatibleRuntime: async () => ({versionDir: runtimeDir}),
    verifyRuntimeVersion: async dir => ({exePath: path.join(dir, 'codex.exe'), manifest: {version: 'fixture', source_commit: 'fixture', patch_sha256: 'fixture', binary_sha256: 'a'.repeat(64)}}),
    armOrReuseApiBootstrap: async () => {
      if (label === 'A') {
        await writeFile(ownedBootstrapPath, JSON.stringify({owner: 'A'}));
        env.CODEX_CLI_PATH = 'owned-A';
        aEnteredArm.resolve();
        await releaseA.promise;
      } else {
        bEnteredArm = true;
        await writeFile(ownedBootstrapPath, JSON.stringify({owner: 'B'}));
        env.CODEX_CLI_PATH = 'owned-B';
      }
      return {state: 'armed', restartRequired: true, ready: false, reused: false};
    },
    disarmApiBootstrap: async () => {
      await rm(ownedBootstrapPath, {force: true});
      env.CODEX_CLI_PATH = 'stock';
      return {disarmed: true};
    },
    prepareApiProfile: async () => {},
    activateApiProfile: async () => { if (label === 'A') throw new Error('fixture activation failure'); },
    rollbackApiProfile: async () => {},
  });

  const callA = applyApiConfiguration({settings, expectedSha256: (await readRouterSettingsSnapshot(settingsPath)).sha256}, makeDependencies('A'));
  await aEnteredArm.promise;
  const callB = applyApiConfiguration({settings, expectedSha256: (await readRouterSettingsSnapshot(settingsPath)).sha256}, makeDependencies('B'));
  await wait(80);
  assert.equal(bEnteredArm, false, 'second Apply instance cannot reuse a bootstrap while the first transaction can still roll it back');
  releaseA.resolve();
  await assert.rejects(callA, /fixture activation failure/);
  const bResult = await callB;
  assert.equal(bResult.applied, true);
  assert.deepEqual(JSON.parse(await readFile(ownedBootstrapPath, 'utf8')), {owner: 'B'}, 'successful second Apply retains its own bootstrap after the first Apply rolls back');
  assert.equal(env.CODEX_CLI_PATH, 'owned-B');

  const beforeOff = await readRouterSettingsSnapshot(settingsPath);
  const armEntered = deferred();
  const releaseApply = deferred();
  const offBootstrapPath = path.join(codexHome, 'router-runtime', 'off-race-owner.json');
  let ownedBackground = false;
  const applyService = createRouterSettingsService({settingsPath, env,
    applyApiConfiguration: async ({settings: latest, expectedSha256}) => applyApiConfiguration({settings: latest, expectedSha256}, {
      ...makeDependencies('off-race'),
      armOrReuseApiBootstrap: async () => {
        await writeFile(offBootstrapPath, 'armed');
        env.CODEX_CLI_PATH = 'owned-during-apply';
        ownedBackground = true;
        armEntered.resolve();
        await releaseApply.promise;
        return {state: 'armed', restartRequired: true, ready: false, reused: false};
      },
      disarmApiBootstrap: async () => { await rm(offBootstrapPath, {force: true}); env.CODEX_CLI_PATH = 'stock'; return {disarmed: true}; },
    }),
    guardStatus: async () => ({state: 'healthy'}),
    onRoutingDisabled: async () => { await rm(offBootstrapPath, {force: true}); env.CODEX_CLI_PATH = 'stock'; ownedBackground = false; return {stopped: true}; },
  });
  const offService = createRouterSettingsService({settingsPath, env,
    guardStatus: async () => ({state: 'healthy'}),
    onRoutingDisabled: async () => { await rm(offBootstrapPath, {force: true}); env.CODEX_CLI_PATH = 'stock'; ownedBackground = false; return {stopped: true}; },
  });
  const applyPending = applyService.callTool('router_settings_apply', {expectedSha256: beforeOff.sha256});
  await armEntered.promise;
  const offSettings = {...beforeOff.settings, enabled: false};
  const offPending = offService.callTool('router_settings_save', {settings: offSettings, expectedSha256: beforeOff.sha256});
  await wait(80);
  let offReturned = false;
  offPending.then(() => { offReturned = true; });
  await wait(30);
  assert.equal(offReturned, false, 'a second settings service cannot report Off complete while Apply can still arm or activate');
  releaseApply.resolve();
  await applyPending;
  const offResult = await offPending;
  assert.equal(offResult.payload.settings.enabled, false);
  assert.equal(ownedBackground, false, 'Off returns only after the applying transaction has exited and owned background state is stopped');
  assert.equal(env.CODEX_CLI_PATH, 'stock', 'Off CAS cleanup leaves no owned CLI override after returning');
  await assert.rejects(readFile(offBootstrapPath), {code: 'ENOENT'});
} finally {
  await rm(root, {recursive: true, force: true});
}

console.log('native API maintenance race tests passed');
