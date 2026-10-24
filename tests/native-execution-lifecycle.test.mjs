import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeTasks} from '../scripts/native-state.mjs';
import {OwnershipStore} from '../scripts/plugin-state.mjs';
import {
  readUpgradeGuardStatus,
  stopIfRoutingDisabled,
  stopOwnedIdleExecutions,
  enableOwnedExecutionsForDispatch,
  clearOwnedBootstrapOverride,
  upgradeStatusPath,
} from '../scripts/native-execution-lifecycle.mjs';
import {nativeApiPaths} from '../scripts/native-api-install.mjs';

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function ok(actual, message) { assert.ok(actual, message); checks += 1; }

const root = await mkdtemp(path.join(os.tmpdir(), 'native-execution-lifecycle-'));
try {
  const codexHome = path.join(root, 'codex-home');
  const env = {CODEX_HOME: codexHome, LOCALAPPDATA: path.join(root, 'local')};
  const statusFile = upgradeStatusPath(env);
  equal(statusFile, path.join(codexHome, 'router-runtime', 'upgrade-status.json'), 'guard status uses persistent CODEX_HOME router-runtime');
  equal((await readUpgradeGuardStatus({env})).state, 'unmanaged', 'missing upgrade status means unmanaged');
  await mkdir(path.dirname(statusFile), {recursive: true});
  await writeFile(statusFile, JSON.stringify({state: 'disabled', reason: 'mock failure', repairAttempted: true, updatedAt: new Date().toISOString()}));
  equal((await readUpgradeGuardStatus({env})).state, 'disabled', 'managed disabled status is read from disk');
  const malformed = await readUpgradeGuardStatus({env, readFile: async () => '{'});
  equal(malformed.state, 'disabled', 'malformed status fails closed');

  const bootstrapJournalPath = path.join(root, 'deepseek', 'bootstrap-install.json');
  const bootstrapPath = path.join(codexHome, 'router-runtime', 'bootstrap', 'owned-bootstrap.exe');
  const bootstrapJournal = {phase: 'active', completed: {environment: true}, paths: {journalPath: bootstrapJournalPath}, environmentSnapshot: {next: {
    CODEX_CLI_PATH: {present: true, value: bootstrapPath},
    SOL_LUNA_NATIVE_INSTALL_JOURNAL: {present: true, value: bootstrapJournalPath},
  }}};
  const environment = new Map([
    ['CODEX_CLI_PATH', {present: true, value: bootstrapPath}],
    ['SOL_LUNA_NATIVE_INSTALL_JOURNAL', {present: true, value: bootstrapJournalPath}],
  ]);
  const envAdapter = {get: async key => environment.get(key) ?? {present: false, value: null}, set: async (key, value) => environment.set(key, value)};
  const clearResult = await clearOwnedBootstrapOverride({env: {CODEX_HOME: codexHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: bootstrapJournalPath}, environmentAdapter: envAdapter, readDeepseekJournal: async () => bootstrapJournal});
  equal(clearResult.cleared, true, 'off clears only the exact owned bootstrap override');
  equal((await envAdapter.get('CODEX_CLI_PATH')).present, false, 'next launch will resolve the official Codex path');
  environment.set('CODEX_CLI_PATH', {present: true, value: 'C:\\custom\\codex.exe'});
  const customResult = await clearOwnedBootstrapOverride({env: {CODEX_HOME: codexHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: bootstrapJournalPath}, environmentAdapter: envAdapter, readDeepseekJournal: async () => bootstrapJournal});
  equal(customResult.preserved, true, 'user-managed CLI path is preserved');
  equal((await envAdapter.get('CODEX_CLI_PATH')).value, 'C:\\custom\\codex.exe', 'CAS does not overwrite a later manual path');

  const genericRoot = path.join(codexHome, 'router-runtime');
  const genericJournalPath = path.join(genericRoot, 'bootstrap-install.json');
  await mkdir(genericRoot, {recursive: true});
  await writeFile(genericJournalPath, JSON.stringify({owner: 'sol-luna-native-api-bootstrap', schemaVersion: 1, phase: 'applied', paths: {maintenanceRoot: genericRoot}}));
  let genericDisarms = 0;
  let legacyReads = 0;
  const genericOff = await clearOwnedBootstrapOverride({env, environmentAdapter: envAdapter,
    disarmApiBootstrap: async ({journalPath}) => { genericDisarms += 1; equal(journalPath, genericJournalPath, 'off targets the exact persistent generic journal'); return {disarmed: true}; },
    readDeepseekJournal: async () => { legacyReads += 1; return bootstrapJournal; },
  });
  equal(genericOff.cleared, true, 'off disarms a valid generic API bootstrap first');
  equal(genericDisarms, 1, 'generic bootstrap is disarmed once');
  equal(legacyReads, 0, 'generic success never falls through to the legacy journal');
  await writeFile(genericJournalPath, '{broken');
  const corruptGenericOff = await clearOwnedBootstrapOverride({env, environmentAdapter: envAdapter,
    disarmApiBootstrap: async () => { genericDisarms += 1; return {disarmed: true}; },
    readDeepseekJournal: async () => { legacyReads += 1; return bootstrapJournal; },
  });
  equal(corruptGenericOff.preserved, true, 'corrupt generic ownership is preserved');
  equal(legacyReads, 0, 'corrupt generic ownership never falls through to legacy cleanup');

  const settingsPath = path.join(root, 'router.json');
  await writeFile(settingsPath, JSON.stringify({schemaVersion: 1, enabled: false, mode: 'fixed', fixedExecutor: 'luna', schedule: {peak: 'luna', valley: 'deepseek'}, profiles: {}}));
  const tasks = new NativeTasks({stateDir: path.join(root, 'state')});
  const ownership = new OwnershipStore({stateDir: path.join(root, 'state')});
  let apiStops = 0;
  let deepseekStops = 0;
  const stopDependencies = {
    env,
    settingsPath,
    nativeTasks: tasks,
    ownershipStore: ownership,
    stopApiProfile: async () => { apiStops += 1; return {stopped: true}; },
    stopDeepseekGateway: async () => { deepseekStops += 1; return {stopped: true}; },
  };

  const noChildren = await stopOwnedIdleExecutions({settings: {profiles: {}}, ...stopDependencies});
  ok(noChildren.stopped, 'idle owned-service cleanup completes');
  equal(apiStops, 0, 'cleanup does not guess an API service when no profile is installed');
  equal(deepseekStops, 0, 'cleanup does not discover an unjournaled gateway');

  const removedLegacyJournalPath = path.join(root, 'removed-deepseek', 'install.json');
  let missingLegacyGatewayStops = 0;
  const missingLegacyStop = await stopOwnedIdleExecutions({settings: {profiles: {}}, ...stopDependencies,
    env: {...env, SOL_LUNA_NATIVE_INSTALL_JOURNAL: removedLegacyJournalPath},
    resolveDeepseekJournal: value => value.SOL_LUNA_NATIVE_INSTALL_JOURNAL,
    readDeepseekJournal: async () => { throw Object.assign(new Error('missing legacy journal'), {code: 'ENOENT'}); },
    stopDeepseek: async () => { missingLegacyGatewayStops += 1; return {stopped: true}; }});
  equal(missingLegacyStop.stopped, true, 'a missing legacy journal does not block off when no verified service remains');
  equal(missingLegacyStop.legacyRecordMissing, true, 'a missing legacy journal is reported as skipped');
  equal(missingLegacyGatewayStops, 0, 'missing legacy ownership never stops an unjournaled DeepSeek service');

  const invalidLegacyStop = await stopOwnedIdleExecutions({settings: {profiles: {}}, ...stopDependencies,
    env: {...env, SOL_LUNA_NATIVE_INSTALL_JOURNAL: removedLegacyJournalPath},
    resolveDeepseekJournal: value => value.SOL_LUNA_NATIVE_INSTALL_JOURNAL,
    readDeepseekJournal: async () => { throw new SyntaxError('invalid legacy journal'); },
    stopDeepseek: async () => { missingLegacyGatewayStops += 1; return {stopped: true}; }});
  equal(invalidLegacyStop.stopped, false, 'an existing but invalid legacy journal keeps off failed closed');
  equal(invalidLegacyStop.reason, 'stop_failed', 'an invalid legacy journal is not misclassified as missing');
  equal(missingLegacyGatewayStops, 0, 'invalid legacy ownership does not stop an unverified DeepSeek service');

  const inaccessibleLegacyStop = await stopOwnedIdleExecutions({settings: {profiles: {}}, ...stopDependencies,
    env: {...env, SOL_LUNA_NATIVE_INSTALL_JOURNAL: removedLegacyJournalPath},
    resolveDeepseekJournal: value => value.SOL_LUNA_NATIVE_INSTALL_JOURNAL,
    readDeepseekJournal: async () => { throw Object.assign(new Error('inaccessible legacy journal'), {code: 'EACCES'}); },
    stopDeepseek: async () => { missingLegacyGatewayStops += 1; return {stopped: true}; }});
  equal(inaccessibleLegacyStop.stopped, false, 'an inaccessible legacy journal keeps off failed closed');
  equal(inaccessibleLegacyStop.reason, 'stop_failed', 'permission failure is not misclassified as missing');
  equal(missingLegacyGatewayStops, 0, 'permission failure never stops an unverified DeepSeek service');

  const apiDir = path.join(root, 'owned-api');
  const ownedJournalPath = nativeApiPaths(apiDir).journal('b'.repeat(24));
  await mkdir(path.dirname(ownedJournalPath), {recursive: true});
  await writeFile(ownedJournalPath, '{}');
  let taskEnabled = true;
  let ownedStops = 0;
  const taskPlan = {name: 'owned-api-task', marker: 'owned-api-marker', directory: apiDir, action: {execute: 'node', arguments: 'gateway', workingDirectory: apiDir}};
  const taskAdapter = {
    status: async () => ({exists: true, owned: true, specMatches: true, enabled: taskEnabled}),
    disable: async () => { taskEnabled = false; },
    enable: async () => { taskEnabled = true; },
  };
  const ownedProfile = 'b'.repeat(24);
  const journalRecord = {phase: 'active', profile: {profileId: ownedProfile}, paths: {apiDir, journalPath: ownedJournalPath}, gateway: {taskPlan}};
  const ownedCleanup = await stopOwnedIdleExecutions({settings: {profiles: {[ownedProfile]: {}}}, apiDir, env,
    resolveDeepseekJournal: () => null, taskAdapter,
    nativeTasks: tasks, ownershipStore: ownership, readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; }});
  equal(ownedCleanup.stopped, true, 'verified journal plus owned scheduler task allows idle service stop');
  equal(taskEnabled, false, 'off disables only the verified owned scheduler task');
  equal(ownedStops, 1, 'idle cleanup invokes the verified local API gateway stop');
  await enableOwnedExecutionsForDispatch({executor: 'api', profileId: ownedProfile, apiDir, taskAdapter, readApiJournal: async () => journalRecord});
  equal(taskEnabled, true, 'dispatch re-enables only the exact journal-matched owned task');

  await tasks.reserveDispatch({parentThreadId: 'parent', taskNonce: 'pending-gateway-task-01', executor: 'api', profileId: ownedProfile, model: 'mock-api-model'});
  const pendingIntent = await stopOwnedIdleExecutions({settings: {profiles: {[ownedProfile]: {}}}, apiDir, env,
    resolveDeepseekJournal: () => null, taskAdapter, nativeTasks: tasks, ownershipStore: ownership,
    readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; }});
  equal(pendingIntent.deferred, true, 'pending gateway dispatch intent defers idle service stop before spawn/bind');
  equal(taskEnabled, false, 'off still disables owned automatic triggers while an intent is pending');
  equal(ownedStops, 1, 'pending intent prevents gateway shutdown');
  await tasks.cancelDispatch({parentThreadId: 'parent', taskNonce: 'pending-gateway-task-01'});
  const afterCancel = await stopOwnedIdleExecutions({settings: {profiles: {[ownedProfile]: {}}}, apiDir, env,
    resolveDeepseekJournal: () => null, taskAdapter, nativeTasks: tasks, ownershipStore: ownership,
    readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; }});
  equal(afterCancel.stopped, true, 'confirmed cancellation clears intent and permits retry of deferred cleanup');
  equal(ownedStops, 2, 'terminal cancellation retries and then stops the idle gateway');
  await enableOwnedExecutionsForDispatch({executor: 'api', profileId: ownedProfile, apiDir, taskAdapter, readApiJournal: async () => journalRecord});

  const throughTerminalNonce = 'gateway-off-through-terminal-01';
  await tasks.reserveDispatch({parentThreadId: 'parent', taskNonce: throughTerminalNonce, executor: 'api', profileId: ownedProfile, model: 'mock-api-model'});
  const offBeforeBind = await stopOwnedIdleExecutions({settings: {profiles: {[ownedProfile]: {}}}, apiDir, env,
    resolveDeepseekJournal: () => null, taskAdapter, nativeTasks: tasks, ownershipStore: ownership,
    readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; }});
  equal(offBeforeBind.deferred, true, 'off remains deferred while an authenticated gateway intent is awaiting child bind');
  equal(ownedStops, 2, 'off never stops the gateway between reservation and bind');
  await tasks.begin({parentThreadId: 'parent', childThreadId: 'gateway-off-child', taskNonce: throughTerminalNonce,
    model: 'mock-api-model', binding: {executor: 'api', profileId: ownedProfile, model: 'mock-api-model',
      role: `native_api_${ownedProfile}`, providerId: `api-native-${ownedProfile}`}});
  const offWhileChildRuns = await stopOwnedIdleExecutions({settings: {profiles: {[ownedProfile]: {}}}, apiDir, env,
    resolveDeepseekJournal: () => null, taskAdapter, nativeTasks: tasks, ownershipStore: ownership,
    readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; }});
  equal(offWhileChildRuns.deferred, true, 'binding intent to a real child keeps off deferred until terminal evidence');
  equal(ownedStops, 2, 'active gateway child is not interrupted by off');
  await tasks.finish({parentThreadId: 'parent', childThreadId: 'gateway-off-child', status: 'completed'});
  const offAfterTerminal = await stopOwnedIdleExecutions({settings: {profiles: {[ownedProfile]: {}}}, apiDir, env,
    resolveDeepseekJournal: () => null, taskAdapter, nativeTasks: tasks, ownershipStore: ownership,
    readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; }});
  equal(offAfterTerminal.stopped, true, 'terminal gateway child permits deferred idle cleanup');
  equal(ownedStops, 3, 'idle gateway stops only after the child reaches terminal status');

  const deepseekJournalPath = path.join(root, 'deepseek', 'install.json');
  const deepseekGatewayDir = path.join(root, 'deepseek', 'gateway');
  const deepseekPlan = {...taskPlan, name: 'owned-deepseek-task', directory: deepseekGatewayDir};
  let deepseekTaskEnabled = true;
  let deepseekGatewayStops = 0;
  const deepseekTaskAdapter = {
    status: async () => ({exists: true, owned: true, specMatches: true, enabled: deepseekTaskEnabled}),
    disable: async () => { deepseekTaskEnabled = false; },
    enable: async () => { deepseekTaskEnabled = true; },
  };
  const deepseekJournal = {phase: 'active', paths: {journalPath: deepseekJournalPath, gatewayDir: deepseekGatewayDir}, gateway: {taskPlan: deepseekPlan}};
  const deepseekCleanup = await stopOwnedIdleExecutions({settings: {profiles: {}}, env,
    resolveDeepseekJournal: () => deepseekJournalPath, readDeepseekJournal: async () => deepseekJournal,
    taskAdapter: deepseekTaskAdapter, nativeTasks: tasks, ownershipStore: ownership,
    stopDeepseek: async ({paths}) => { equal(paths.dir, deepseekGatewayDir, 'DeepSeek cleanup targets only the journaled gateway directory'); deepseekGatewayStops += 1; return {stopped: true}; }});
  equal(deepseekCleanup.stopped, true, 'verified isolated journal and task permits idle DeepSeek stop');
  equal(deepseekTaskEnabled, false, 'off disables the verified DeepSeek startup trigger');
  equal(deepseekGatewayStops, 1, 'idle DeepSeek gateway is stopped through its verified local adapter');
  await enableOwnedExecutionsForDispatch({executor: 'deepseek', env: {...env, SOL_LUNA_NATIVE_INSTALL_JOURNAL: deepseekJournalPath},
    resolveDeepseekJournal: value => value.SOL_LUNA_NATIVE_INSTALL_JOURNAL, readDeepseekJournal: async () => deepseekJournal, taskAdapter: deepseekTaskAdapter});
  equal(deepseekTaskEnabled, true, 'DeepSeek dispatch re-enables only the matching task after explicit route selection');

  await tasks.begin({parentThreadId: 'parent', childThreadId: 'native-child', model: 'gpt-6-luna'});
  const nativeActive = await stopOwnedIdleExecutions({settings: {profiles: {}}, ...stopDependencies});
  equal(nativeActive.stopped, true, 'active Luna child does not keep an unrelated gateway alive');
  await tasks.finish({parentThreadId: 'parent', childThreadId: 'native-child'});

  const profileId = ownedProfile;
  await tasks.reserveDispatch({parentThreadId: 'parent', taskNonce: 'api-active-child-01', executor: 'api', profileId, model: 'mock-model'});
  await tasks.begin({parentThreadId: 'parent', childThreadId: 'api-child', taskNonce: 'api-active-child-01', model: 'mock-model', binding: {executor: 'api', profileId, role: `native_api_${profileId}`, providerId: `api-native-${profileId}`, model: 'mock-model'}});
  const gatewayActive = await stopOwnedIdleExecutions({settings: {profiles: {[profileId]: {}}}, apiDir, env,
    resolveDeepseekJournal: () => null, taskAdapter, nativeTasks: tasks, ownershipStore: ownership,
    readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; }});
  equal(gatewayActive.deferred, true, 'active gateway-backed native child defers idle gateway stop');
  equal(ownedStops, 3, 'active gateway-backed child prevents the journaled service stop');
  await tasks.finish({parentThreadId: 'parent', childThreadId: 'api-child'});

  const apiStopWithMissingLegacy = await stopOwnedIdleExecutions({settings: {profiles: {[profileId]: {}}}, apiDir,
    env: {...env, SOL_LUNA_NATIVE_INSTALL_JOURNAL: removedLegacyJournalPath},
    resolveDeepseekJournal: value => value.SOL_LUNA_NATIVE_INSTALL_JOURNAL,
    readDeepseekJournal: async () => { throw Object.assign(new Error('missing legacy journal'), {code: 'ENOENT'}); },
    taskAdapter, nativeTasks: tasks, ownershipStore: ownership, readApiJournal: async () => journalRecord,
    stopApi: async () => { ownedStops += 1; return {stopped: true}; },
    stopDeepseek: async () => { missingLegacyGatewayStops += 1; return {stopped: true}; }});
  equal(apiStopWithMissingLegacy.stopped, true, 'a missing legacy journal does not block cleanup of another verified service');
  equal(ownedStops, 4, 'the verified API service still stops with a missing legacy journal');
  equal(missingLegacyGatewayStops, 0, 'the missing legacy service remains unprobed and unstopped');

  await ownership.claim('dsh-child', 'parent', {status: 'running'});
  const dshActive = await stopOwnedIdleExecutions({settings: {profiles: {}}, ...stopDependencies});
  equal(dshActive.deferred, true, 'active plugin-owned DSH child defers gateway stop');
  await ownership.markStatus('dsh-child', 'parent', 'completed');

  const disabled = await stopIfRoutingDisabled(stopDependencies);
  equal(disabled.stopped, true, 'terminal child completion retries idle cleanup when settings are disabled');
} finally {
  await rm(root, {recursive: true, force: true});
}

console.log(`PASS ${checks} native execution lifecycle assertions`);
