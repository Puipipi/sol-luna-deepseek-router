import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const GUARD_STATES = new Set(['healthy', 'repaired', 'disabled']);

export function routerRuntimeRoot(env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(path.resolve(codexHome), 'router-runtime');
}

export function upgradeStatusPath(env = process.env) {
  return path.join(routerRuntimeRoot(env), 'upgrade-status.json');
}

export async function readUpgradeGuardStatus({env = process.env, readFile: readFileImpl = readFile} = {}) {
  try {
    const status = JSON.parse(await readFileImpl(upgradeStatusPath(env), 'utf8'));
    if (!GUARD_STATES.has(status?.state) || (typeof status.reason !== 'string' && status.reason !== null)
        || typeof status.repairAttempted !== 'boolean' || typeof status.updatedAt !== 'string') {
      return {state: 'disabled', reason: '兼容状态文件无效，自动分工已停用', repairAttempted: false};
    }
    return {
      state: status.state,
      reason: typeof status.reason === 'string' ? status.reason.slice(0, 240) : null,
      repairAttempted: status.repairAttempted,
      updatedAt: status.updatedAt,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return {state: 'unmanaged', reason: null, repairAttempted: false};
    return {state: 'disabled', reason: '无法读取兼容状态，自动分工已停用', repairAttempted: false};
  }
}
