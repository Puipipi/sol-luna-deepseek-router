import os from 'node:os';
import path from 'node:path';
import {withFileLock} from './plugin-state.mjs';

export function routerMaintenanceLockPath({env = process.env, codexHome} = {}) {
  const home = codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(path.resolve(home), 'router-runtime', 'maintenance.lock');
}

export function withRouterMaintenanceLock(context, operation) {
  if (typeof operation !== 'function') throw new Error('router maintenance operation is required');
  return withFileLock(routerMaintenanceLockPath(context), operation, {timeoutMs: 120_000, staleMs: 300_000});
}
