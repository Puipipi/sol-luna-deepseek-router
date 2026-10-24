import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultRouterSettingsPath, effectiveRouterEnabled, readRouterSettingsSnapshot} from './native-api-settings.mjs';
import {nativeApiPaths} from './native-api-install.mjs';
import {defaultNativeApiDir, stopApiGateway} from './native-api-manager.mjs';
import {decodeJournal} from './native-isolated-install.mjs';
import {gatewayPaths, stopGateway} from './native-gateway-manager.mjs';
import {createWindowsTaskSchedulerAdapter, disableOwnedGatewayTask, enableOwnedGatewayTask, statusOwnedGatewayTask} from './native-gateway-task.mjs';
import {NativeTasks} from './native-state.mjs';
import {OwnershipStore, resolveStateDir, TERMINAL_STATUSES} from './plugin-state.mjs';
import {createWindowsUserEnvironmentAdapter} from './native-runtime-env.mjs';
import {readUpgradeGuardStatus, routerRuntimeRoot} from './native-upgrade-status.mjs';
import {API_BOOTSTRAP_JOURNAL, API_BOOTSTRAP_OWNER, disarmOwnedBootstrap} from './native-bootstrap-maintenance.mjs';
import {withRouterMaintenanceLock} from './native-router-maintenance-lock.mjs';

export {readUpgradeGuardStatus, routerRuntimeRoot, upgradeStatusPath} from './native-upgrade-status.mjs';

async function activeDelegationCount({nativeTasks, ownershipStore}) {
  const [native, dsh] = await Promise.all([nativeTasks.hasActiveGatewayExecutions(), ownershipStore.hasActiveExecutions()]);
  return {native, dsh};
}

function unavailableStop(message, reason) {
  return {stopped: false, message, ...(reason ? {reason} : {})};
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameEnvValue(left, right) {
  const normalize = value => value && typeof value === 'object' && typeof value.present === 'boolean'
    ? {present: value.present, value: value.present ? String(value.value ?? '') : null}
    : value === undefined || value === null ? {present: false, value: null} : {present: true, value: String(value)};
  const a = normalize(left), b = normalize(right);
  return a.present === b.present && (!a.present || a.value === b.value);
}

export async function clearOwnedBootstrapOverride({
  env = process.env,
  environmentAdapter = createWindowsUserEnvironmentAdapter({allowInstallJournal: true}),
  readDeepseekJournal = async file => decodeJournal(await readFile(file, 'utf8')),
  disarmApiBootstrap = disarmOwnedBootstrap,
} = {}) {
  const genericJournalPath = path.join(routerRuntimeRoot(env), API_BOOTSTRAP_JOURNAL);
  let genericBytes = null;
  try { genericBytes = await readFile(genericJournalPath); }
  catch (error) { if (error?.code !== 'ENOENT') return {cleared: false, preserved: true, message: 'API 启动器记录无法读取；保留 CLI 路径并停用新分工。'}; }
  if (genericBytes !== null) {
    let genericJournal;
    try { genericJournal = JSON.parse(genericBytes.toString('utf8')); }
    catch { return {cleared: false, preserved: true, message: 'API 启动器记录无效；保留 CLI 路径并停用新分工。'}; }
    if (genericJournal?.owner !== API_BOOTSTRAP_OWNER || genericJournal.schemaVersion !== 1
        || genericJournal.phase !== 'applied' || !samePath(genericJournal.paths?.maintenanceRoot, routerRuntimeRoot(env))) {
      return {cleared: false, preserved: true, message: 'API 启动器所有权无法确认；保留 CLI 路径并停用新分工。'};
    }
    try {
      const result = await disarmApiBootstrap({journalPath: genericJournalPath, adapter: environmentAdapter});
      if (result?.disarmed !== true) return {cleared: false, preserved: true, message: 'API 启动器路径已发生变化；保留用户路径并停用新分工。'};
      return {cleared: true, message: '已解除本插件拥有的 API 启动器覆盖；当前进程不热切换，下次启动使用官方 Codex。'};
    } catch {
      return {cleared: false, preserved: true, message: 'API 启动器无法安全解除；保留 CLI 路径并停用新分工。'};
    }
  }
  const journalPath = env.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  if (typeof journalPath !== 'string' || !journalPath.trim()) return {cleared: false, skipped: true, message: '没有受管兼容安装；未修改用户 CLI 路径。'};
  let journal;
  try { journal = await readDeepseekJournal(journalPath); }
  catch { return {cleared: false, message: '兼容安装记录无法验证；保留 CLI 路径并停用新分工。'}; }
  const snapshot = journal?.environmentSnapshot;
  const expectedJournal = snapshot?.next?.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  const expectedCli = snapshot?.next?.CODEX_CLI_PATH;
  if (journal?.phase !== 'active' || journal.completed?.environment !== true
      || !samePath(journal.paths?.journalPath, journalPath)
      || !sameEnvValue(expectedJournal, {present: true, value: path.resolve(journalPath)})
      || expectedCli?.present !== true || typeof expectedCli.value !== 'string') {
    return {cleared: false, preserved: true, message: '兼容安装所有权无法确认；保留现有 CLI 路径并停用新分工。'};
  }
  const configuredJournal = await environmentAdapter.get('SOL_LUNA_NATIVE_INSTALL_JOURNAL');
  if (!sameEnvValue(configuredJournal, expectedJournal)) {
    return {cleared: false, preserved: true, message: '用户安装记录路径已改变；保留 CLI 路径。'};
  }
  const current = await environmentAdapter.get('CODEX_CLI_PATH');
  if (!sameEnvValue(current, expectedCli)) {
    return {cleared: false, preserved: true, message: 'CODEX_CLI_PATH 已不是本插件安装的启动器；保留用户路径。'};
  }
  if (!sameEnvValue(await environmentAdapter.get('CODEX_CLI_PATH'), expectedCli)) {
    return {cleared: false, preserved: true, message: 'CODEX_CLI_PATH 在关闭期间发生变化；保留用户路径。'};
  }
  await environmentAdapter.set('CODEX_CLI_PATH', {present: false, value: null});
  if (!sameEnvValue(await environmentAdapter.get('CODEX_CLI_PATH'), {present: false, value: null})) {
    return {cleared: false, message: '无法确认已解除受管 CLI 覆盖；请在设置中重试。'};
  }
  return {cleared: true, message: '已解除本插件拥有的 CLI 覆盖；当前进程不热切换，下次启动使用官方 Codex。'};
}

async function disableOwnedTaskService({journal, taskAdapter, label}) {
  const plan = journal?.gateway?.taskPlan;
  if (!plan) return unavailableStop(`${label} 安装记录缺少任务身份；未停止后台服务。`, 'journal_incomplete');
  const taskStatus = await statusOwnedGatewayTask(plan, taskAdapter);
  if (!taskStatus.exists || !taskStatus.owned || taskStatus.specMatches !== true) {
    return unavailableStop(`${label} 计划任务身份未能确认；未停止后台服务。`, 'task_unverified');
  }
  await disableOwnedGatewayTask(plan, taskAdapter);
  return {stopped: true};
}

async function stopOwnedIdleExecutionsUnlocked({
  settings,
  settingsPath = defaultRouterSettingsPath(),
  stateDir,
  env = process.env,
  nativeTasks = new NativeTasks({stateDir}),
  ownershipStore = new OwnershipStore({stateDir}),
  apiDir = defaultNativeApiDir(env),
  taskAdapter = createWindowsTaskSchedulerAdapter(),
  stopApi = stopApiGateway,
  stopDeepseek = stopGateway,
  resolveDeepseekJournal = value => value.SOL_LUNA_NATIVE_INSTALL_JOURNAL || null,
  readApiJournal = async file => JSON.parse(await readFile(file, 'utf8')),
  readDeepseekJournal = async file => decodeJournal(await readFile(file, 'utf8')),
} = {}) {
  try {
    let bootstrapOverride;
    try { bootstrapOverride = await clearOwnedBootstrapOverride({env, readDeepseekJournal}); }
    catch { bootstrapOverride = {cleared: false, message: '受管 CLI 覆盖状态无法确认；请在路由设置中重试。'}; }
    const services = [];
    let legacyRecordMissing = false;
    const profiles = settings?.profiles && typeof settings.profiles === 'object' ? Object.keys(settings.profiles) : [];
    for (const profileId of profiles) {
      if (!/^[a-f0-9]{24}$/.test(profileId)) continue;
      const journalFile = nativeApiPaths(apiDir).journal(profileId);
      let present = true;
      try { await readFile(journalFile); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
      if (!present) continue;
      const journal = await readApiJournal(journalFile);
      if (journal?.phase !== 'active' || journal.profile?.profileId !== profileId
          || !samePath(journal.paths?.apiDir, apiDir) || !samePath(journal.paths?.journalPath, journalFile)) {
        return unavailableStop('API 安装身份无法确认；未停止后台服务。', 'journal_unverified');
      }
      const result = await disableOwnedTaskService({journal, taskAdapter, label: 'API'});
      if (result?.stopped !== true) return result;
      services.push({label: 'API', stop: () => stopApi({apiDir: journal.paths.apiDir})});
    }

    const deepseekJournal = resolveDeepseekJournal(env);
    if (deepseekJournal) {
      let journal;
      try { journal = await readDeepseekJournal(deepseekJournal); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        legacyRecordMissing = true;
      }
      if (!legacyRecordMissing && (journal?.phase !== 'active' || !samePath(journal.paths?.journalPath, deepseekJournal))) {
        return unavailableStop('DeepSeek 安装身份无法确认；未停止后台服务。', 'journal_unverified');
      }
      if (!legacyRecordMissing) {
        const result = await disableOwnedTaskService({journal, taskAdapter, label: 'DeepSeek'});
        if (result?.stopped !== true) return result;
        services.push({label: 'DeepSeek', stop: () => stopDeepseek({paths: gatewayPaths(journal.paths.gatewayDir)})});
      }
    }

    const active = await activeDelegationCount({nativeTasks, ownershipStore});
    if (active.dsh || (services.length > 0 && active.native)) {
      return {stopped: false, deferred: true, tasksDisabled: services.length, bootstrapOverride, message: `已有子任务仍在运行；后台计划任务已停用，空闲网关将在最后一个任务完成后停止。${bootstrapOverride?.message ? ` ${bootstrapOverride.message}` : ''}`, reason: 'active_children'};
    }
    for (const service of services) {
      const result = await service.stop();
      if (result?.stopped !== true && result?.reason !== 'not_running' && result?.reason !== 'stale_state_removed') {
        return unavailableStop(`${service.label} 后台网关未能确认停止；请在设置中重试。`, result?.reason || 'stop_unconfirmed');
      }
    }
    const notices = [
      bootstrapOverride?.message,
      ...(legacyRecordMissing ? ['旧版 DeepSeek 安装记录已缺失；跳过未登记的旧服务。'] : []),
    ].filter(Boolean);
    return {stopped: true, deferred: false, servicesStopped: services.length, bootstrapOverride,
      ...(legacyRecordMissing ? {legacyRecordMissing: true} : {}),
      ...(notices.length ? {message: notices.join(' ')} : {})};
  } catch {
    return unavailableStop('后台执行器状态无法确认或停止失败；设置已关闭，请在路由设置中重试。', 'stop_failed');
  }
}

export async function stopOwnedIdleExecutions(options = {}) {
  if (options.maintenanceLockHeld === true) return stopOwnedIdleExecutionsUnlocked(options);
  return withRouterMaintenanceLock({env: options.env},
    () => stopOwnedIdleExecutionsUnlocked({...options, maintenanceLockHeld: true}));
}

export async function stopIfRoutingDisabled({
  settingsPath = defaultRouterSettingsPath(),
  guardStatus,
  readGuardStatus = readUpgradeGuardStatus,
  stop = stopOwnedIdleExecutions,
  ...options
} = {}) {
  try {
    const {settings} = await readRouterSettingsSnapshot(settingsPath);
    if (settings.enabled === false) return stop({settings, settingsPath, ...options});
    const guard = guardStatus === undefined ? await readGuardStatus(options.env ? {env: options.env} : {}) : guardStatus;
    if (!effectiveRouterEnabled(settings, guard)) return stop({settings, settingsPath, ...options});
    return {stopped: false, skipped: true, message: '自动分工仍启用；未停止后台执行器。'};
  } catch {
    return unavailableStop('无法确认分工状态；未停止或修改任何后台执行器。', 'settings_unavailable');
  }
}

export async function finalizePendingDisable(options = {}) {
  return stopIfRoutingDisabled(options);
}

export async function enableOwnedExecutionsForDispatch({
  executor,
  profileId,
  apiDir = defaultNativeApiDir(),
  env = process.env,
  taskAdapter = createWindowsTaskSchedulerAdapter(),
  resolveDeepseekJournal = value => value.SOL_LUNA_NATIVE_INSTALL_JOURNAL || null,
  readApiJournal = async file => JSON.parse(await readFile(file, 'utf8')),
  readDeepseekJournal = async file => decodeJournal(await readFile(file, 'utf8')),
} = {}) {
  if (executor === 'api') {
    if (!/^[a-f0-9]{24}$/.test(profileId || '')) throw new Error('API executor profile identity is invalid');
    const journalFile = nativeApiPaths(apiDir).journal(profileId);
    let journal;
    try { journal = await readApiJournal(journalFile); }
    catch (error) { throw new Error(error?.code === 'ENOENT' ? 'API install journal is missing; explicit Apply is required' : 'API install journal is unavailable'); }
    if (journal?.phase !== 'active' || journal.profile?.profileId !== profileId
        || !samePath(journal.paths?.apiDir, apiDir) || !samePath(journal.paths?.journalPath, journalFile)
        || !journal.gateway?.taskPlan) throw new Error('API installation identity is unavailable; refused to re-enable its background task');
    return enableOwnedGatewayTask(journal.gateway.taskPlan, taskAdapter);
  }
  if (executor === 'deepseek') {
    const journalFile = resolveDeepseekJournal(env);
    if (!journalFile) throw new Error('DeepSeek installation journal is unavailable; refused to re-enable its background task');
    let journal;
    try { journal = await readDeepseekJournal(journalFile); }
    catch (error) { throw new Error(error?.code === 'ENOENT' ? 'DeepSeek install journal is missing; isolated setup is required' : 'DeepSeek install journal is unavailable'); }
    if (journal?.phase !== 'active' || !samePath(journal.paths?.journalPath, journalFile)
        || !journal.gateway?.taskPlan) throw new Error('DeepSeek installation identity is unavailable; refused to re-enable its background task');
    return enableOwnedGatewayTask(journal.gateway.taskPlan, taskAdapter);
  }
  return {enabled: false, skipped: true};
}
