// Durable, per-chat ownership and workspace writer leases for the Codex
// plugin. Only hashes of Codex thread IDs are persisted. All read-modify-write
// operations are serialized across plugin processes with an on-disk lock.
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, open, readFile, realpath, rename, stat, unlink, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TERMINAL_STATUSES = new Set(['completed', 'error', 'interrupted', 'context_exhausted', 'closed']);
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function hashThread(threadId) {
  return createHash('sha256').update(String(threadId), 'utf8').digest('hex');
}

export function resolveStateDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SOL_LUNA_PLUGIN_STATE) return path.resolve(process.env.SOL_LUNA_PLUGIN_STATE);
  const base = process.env.LOCALAPPDATA
    || (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'));
  return path.join(base, 'sol-luna-deepseek-router', 'plugin');
}

export function normalizeWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('Workspace cwd must be a non-empty absolute path.');
  if (!path.isAbsolute(workspace)) throw new Error('Workspace cwd must be an absolute path.');
  const absolute = path.resolve(workspace);
  const root = path.parse(absolute).root;
  const resolved = absolute === root ? root : absolute.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Resolve the real directory, not just the spelling. This collapses Windows
// case/short-name/trailing-separator aliases and symlinks/junctions so two
// aliases of one directory cannot take independent writer leases.
export async function canonicalWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('Workspace cwd must be a non-empty absolute path.');
  if (!path.isAbsolute(workspace)) throw new Error('Workspace cwd must be an absolute path.');
  let real;
  try {
    real = await realpath(workspace);
  } catch (error) {
    throw new Error(`Workspace cwd cannot be resolved to a real directory; refusing to lock it: ${error.message}`);
  }
  let info;
  try {
    info = await stat(real);
  } catch (error) {
    throw new Error(`Workspace cwd cannot be inspected; refusing to lock it: ${error.message}`);
  }
  if (!info.isDirectory()) throw new Error('Workspace cwd must resolve to a directory.');
  const absolute = path.resolve(real);
  const root = path.parse(absolute).root;
  const resolved = absolute === root ? root : absolute.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function workspaceKey(workspace) {
  return createHash('sha256').update(await canonicalWorkspace(workspace), 'utf8').digest('hex');
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function lockIsStale(lockPath, staleMs, now) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    // Windows can briefly deny a reader while another process has the lock
    // open or is replacing it. Treat that as contention, not as staleness.
    if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
    throw error;
  }
  let value = null;
  try { value = JSON.parse(raw); } catch { /* A writer may not have finished its first write. */ }
  // Reclaim only a lock whose recorded process is gone. Age-based reclamation
  // races with a live owner and can admit two critical sections; a live owner
  // is allowed to finish or the waiter fails closed on timeout.
  return Boolean(value && Number.isInteger(value.pid) && !isProcessAlive(value.pid));
}

// Atomic create-or-wait lock. A process crash leaves a lock that is reclaimed
// when its PID is gone or it exceeds the stale interval.
async function reclaimStale(lockPath, staleMs, now) {
  // Serialize stale reclamation. Without this guard, two waiters can both see
  // a dead owner, and the slower unlink can remove the winner's fresh lock.
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await open(guardPath, 'wx', 0o600);
  } catch (error) {
    if (['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
    throw error;
  }
  try {
    if (!(await lockIsStale(lockPath, staleMs, now))) return false;
    await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return true;
  } finally {
    await guard.close().catch(() => {});
    await unlink(guardPath).catch(() => {});
  }
}

export async function withFileLock(lockPath, operation, {timeoutMs = 15000, staleMs = 60000, now = Date.now} = {}) {
  await mkdir(path.dirname(lockPath), {recursive: true});
  const token = randomBytes(16).toString('hex');
  const started = now();
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({pid: process.pid, token, created_at: new Date(now()).toISOString()})}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      break;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      if (await lockIsStale(lockPath, staleMs, now)) {
        await reclaimStale(lockPath, staleMs, now);
        continue;
      }
      if (now() - started >= timeoutMs) throw new Error('Timed out waiting for the plugin ownership lock; another Codex chat is still updating it.');
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await operation();
  } finally {
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current?.token === token) await unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A lock we no longer own must never be removed by this process.
      }
    }
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function readJson(file, label) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${label}; refusing to act: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`The ${label} is corrupt; refusing to act. Inspect or remove it while no DSH agent is active.`);
  }
}

function assertRecordShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The plugin ownership state is not an object; refusing to act.');
  if (data.agents === undefined) data.agents = {};
  if (!data.agents || typeof data.agents !== 'object' || Array.isArray(data.agents)) throw new Error('The plugin ownership state has an invalid agents map; refusing to act.');
  if (data.version === undefined) data.version = 1;
  return data;
}

export class OwnershipStore {
  constructor({stateDir, now = Date.now, lockTimeoutMs = 15000} = {}) {
    this.stateDir = resolveStateDir(stateDir);
    this.file = path.join(this.stateDir, 'ownership.json');
    this.lockFile = path.join(this.stateDir, 'ownership.lock');
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async _read() {
    const data = await readJson(this.file, 'plugin ownership state');
    return data === null ? {version: 1, agents: {}} : assertRecordShape(data);
  }

  async _mutate(operation) {
    return withFileLock(this.lockFile, async () => {
      const data = await this._read();
      const result = await operation(data);
      data.version = 1;
      data.updated_at = new Date(this.now()).toISOString();
      await writeJsonAtomic(this.file, data);
      return result;
    }, {timeoutMs: this.lockTimeoutMs, now: this.now});
  }

  notAvailable(agentId) {
    return new Error(`Agent ${agentId} is not available to this chat.`);
  }

  async claim(agentId, threadId, {workspace = null, write = false, status = 'active'} = {}) {
    if (!AGENT_ID.test(String(agentId))) throw new Error('The DSH agent id cannot be stored safely.');
    const owner = hashThread(threadId);
    return this._mutate(data => {
      const existing = data.agents[agentId];
      if (existing && existing.owner !== owner) throw this.notAvailable(agentId);
      const at = new Date(this.now()).toISOString();
      const record = {
        ...existing,
        owner,
        workspace: workspace ? normalizeWorkspace(workspace) : existing?.workspace ?? null,
        write: Boolean(write),
        status,
        created_at: existing?.created_at ?? at,
        updated_at: at,
      };
      data.agents[agentId] = record;
      return {...record, agent_id: agentId};
    });
  }

  async assertOwner(agentId, threadId) {
    const data = await this._read();
    const record = data.agents[agentId];
    if (!record || record.owner !== hashThread(threadId)) throw this.notAvailable(agentId);
    return {...record, agent_id: agentId};
  }

  async markStatus(agentId, threadId, status) {
    const owner = hashThread(threadId);
    return this._mutate(data => {
      const record = data.agents[agentId];
      if (!record || record.owner !== owner) throw this.notAvailable(agentId);
      record.status = status;
      record.updated_at = new Date(this.now()).toISOString();
      return {...record, agent_id: agentId};
    });
  }

  async owned(threadId) {
    const owner = hashThread(threadId);
    const data = await this._read();
    return Object.entries(data.agents)
      .filter(([, record]) => record?.owner === owner)
      .map(([agentId, record]) => ({...record, agent_id: agentId}));
  }

  async ownedCount(threadId) {
    return (await this.owned(threadId)).length;
  }

  async snapshot() {
    return this._read();
  }

  async hasActiveExecutions() {
    const data = await this._read();
    const idle = new Set([...TERMINAL_STATUSES, 'idle']);
    return Object.values(data.agents).some(record => !idle.has(record?.status));
  }
}

const ACTIVE_LEASE_STATUSES = new Set(['starting', 'running', 'interrupting']);

function isReservation(lease) {
  return lease?.bound === false || !lease?.agent_id || String(lease.agent_id).startsWith('reservation:');
}

export class WorkspaceLeases {
  constructor({stateDir, now = Date.now, lockTimeoutMs = 15000} = {}) {
    this.stateDir = resolveStateDir(stateDir);
    this.directory = path.join(this.stateDir, 'leases');
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async _paths(workspace) {
    const canonical = await canonicalWorkspace(workspace);
    const key = createHash('sha256').update(canonical, 'utf8').digest('hex');
    return {
      key,
      canonical,
      lease: path.join(this.directory, `${key}.json`),
      guard: path.join(this.directory, `${key}.guard`),
    };
  }

  async _read(leasePath) {
    const value = await readJson(leasePath, 'workspace writer lease');
    if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('The workspace writer lease is corrupt; refusing to act.');
    return value;
  }

  async acquire({workspace, threadId, agentId, bound = true, reconcile}) {
    const paths = await this._paths(workspace);
    const owner = hashThread(threadId);
    await mkdir(this.directory, {recursive: true});
    return withFileLock(paths.guard, async () => {
      const existing = await this._read(paths.lease);
      if (existing) {
        const same = existing.owner === owner && existing.agent_id === agentId;
        if (same) {
          const lease = {
            ...existing,
            workspace: paths.canonical,
            bound: Boolean(existing.bound ?? !isReservation(existing)),
            pid: process.pid,
            updated_at: new Date(this.now()).toISOString(),
          };
          delete lease.expires_at;
          await writeJsonAtomic(paths.lease, lease);
          return lease;
        }
        if (isReservation(existing)) {
          throw new Error(`Workspace is busy: an uncertain start reservation (${existing.agent_id ?? 'unknown'}) is retained in ${paths.canonical}. The plugin never expires this reservation automatically because it has no verified DSH agent id. Deliberate recovery only: verify that no DSH task is running, then remove ${paths.lease} and retry.`);
        }
        if (typeof reconcile !== 'function') {
          throw new Error(`Workspace is locked: DSH status for agent ${existing.agent_id} cannot be verified because no backend reconciler is available. The lease is retained.`);
        }
        let status;
        try {
          status = await reconcile(existing);
        } catch (error) {
          throw new Error(`Workspace is locked: the DSH backend is unavailable or failed to report status for agent ${existing.agent_id} (${error.message}). The lease is retained at ${paths.lease}; retry only after DSH is reachable and do not remove the lease while the task may be running.`);
        }
        status = String(status ?? '').trim().toLowerCase();
        if (![...TERMINAL_STATUSES, 'idle'].includes(status)) {
          if (ACTIVE_LEASE_STATUSES.has(status)) {
            throw new Error(`Workspace is busy: DSH agent ${existing.agent_id} is ${status} in ${paths.canonical}. Only a confirmed terminal or idle status permits replacement.`);
          }
          throw new Error(`Workspace is locked: DSH returned an unknown status ${JSON.stringify(status)} for agent ${existing.agent_id}. The lease is retained at ${paths.lease}; verify DSH before any deliberate recovery.`);
        }
        // Only a confirmed terminal/idle backend status permits replacement.
        await unlink(paths.lease).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      const at = new Date(this.now()).toISOString();
      const lease = {
        version: 2,
        workspace: paths.canonical,
        owner,
        agent_id: agentId,
        bound: Boolean(bound),
        pid: process.pid,
        created_at: existing?.owner === owner && existing?.agent_id === agentId ? existing.created_at : at,
        updated_at: at,
      };
      await writeJsonAtomic(paths.lease, lease);
      return lease;
    }, {timeoutMs: this.lockTimeoutMs, now: this.now});
  }

  async release({workspace, threadId, agentId}) {
    const paths = await this._paths(workspace);
    const owner = hashThread(threadId);
    await mkdir(this.directory, {recursive: true});
    return withFileLock(paths.guard, async () => {
      const existing = await this._read(paths.lease);
      if (existing && existing.owner === owner && existing.agent_id === agentId) {
        await unlink(paths.lease).catch(error => { if (error.code !== 'ENOENT') throw error; });
        return true;
      }
      return false;
    }, {timeoutMs: this.lockTimeoutMs, now: this.now});
  }

  async bind({workspace, threadId, reservationId, agentId}) {
    const paths = await this._paths(workspace);
    const owner = hashThread(threadId);
    await mkdir(this.directory, {recursive: true});
    return withFileLock(paths.guard, async () => {
      const existing = await this._read(paths.lease);
      if (!existing || existing.owner !== owner || existing.agent_id !== reservationId) {
        throw new Error('The workspace writer lease changed while DSH was starting; refusing to continue.');
      }
      existing.agent_id = agentId;
      existing.bound = true;
      existing.workspace = paths.canonical;
      existing.updated_at = new Date(this.now()).toISOString();
      delete existing.expires_at;
      await writeJsonAtomic(paths.lease, existing);
      return existing;
    }, {timeoutMs: this.lockTimeoutMs, now: this.now});
  }

  async get(workspace) {
    const paths = await this._paths(workspace);
    return this._read(paths.lease);
  }

  async list() {
    let names;
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const leases = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const value = await readJson(path.join(this.directory, name), 'workspace writer lease');
      if (value) leases.push(value);
    }
    return leases;
  }
}
