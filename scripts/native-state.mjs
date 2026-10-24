import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalWorkspace, hashThread, resolveStateDir, withFileLock, writeJsonAtomic,
} from "./plugin-state.mjs";

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function childId(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("childThreadId must be a non-empty string");
  return value.trim();
}

function parentId(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("parentThreadId must be a non-empty string");
  return value.trim();
}

function nonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error("taskNonce must be a safe non-empty identifier");
  return value;
}

function normalizeBinding(binding) {
  if (binding === null || binding === undefined) return null;
  if (typeof binding !== "object" || Array.isArray(binding)) throw new Error("child executor binding must be an object");
  const executor = binding.executor;
  if (!["luna", "deepseek", "api"].includes(executor)) throw new Error("child executor binding must be luna, deepseek, or api");
  const model = typeof binding.model === "string" && binding.model.trim() ? binding.model.trim() : null;
  if (!model) throw new Error("child executor binding requires an exact model");
  if (executor === "api") {
    const profileId = binding.profileId;
    if (typeof profileId !== "string" || !/^[a-f0-9]{24}$/.test(profileId)) throw new Error("API child binding requires a 24-character lowercase profile id");
    if (binding.role !== `native_api_${profileId}`) throw new Error("API child role must match its immutable profile id");
    if (binding.providerId !== `api-native-${profileId}`) throw new Error("API child provider must match its immutable profile id");
    return { executor, profileId, model, role: binding.role, providerId: binding.providerId };
  }
  if (executor === "deepseek") {
    if (binding.role !== undefined && binding.role !== "native_deepseek") throw new Error("DeepSeek child role must be native_deepseek");
    return { executor, profileId: null, model, role: "native_deepseek", providerId: null };
  }
  if (binding.profileId !== undefined && binding.profileId !== null) throw new Error("Luna child binding cannot carry an API profile");
  return { executor, profileId: null, model, role: null, providerId: null };
}

function sameBinding(left, right) {
  return JSON.stringify(normalizeBinding(left)) === JSON.stringify(normalizeBinding(right));
}

export class NativeTasks {
  constructor({ stateDir } = {}) {
    this.stateDir = resolveStateDir(stateDir);
    this.file = path.join(this.stateDir, "native-tasks.json");
    this.lock = path.join(this.stateDir, "native-tasks.lock");
  }

  async _read() {
    const value = await readJson(this.file);
    if (!value) return { version: 1, tasks: {}, dispatches: {} };
    if (!value.tasks || typeof value.tasks !== "object" || Array.isArray(value.tasks)) {
      throw new Error("Native task state is corrupt; refusing to act");
    }
    if (value.dispatches !== undefined && (!value.dispatches || typeof value.dispatches !== 'object' || Array.isArray(value.dispatches))) {
      throw new Error("Native dispatch reservation state is corrupt; refusing to act");
    }
    value.dispatches ??= {};
    return value;
  }

  async _mutate(operation) {
    return withFileLock(this.lock, async () => {
      const data = await this._read();
      const result = await operation(data);
      data.version = 1;
      data.updated_at = new Date().toISOString();
      await writeJsonAtomic(this.file, data);
      return result;
    });
  }

  async begin({ parentThreadId, childThreadId, model, workspace = null, taskNonce = null, binding = null }) {
    const parent = parentId(parentThreadId);
    const child = childId(childThreadId);
    const task = taskNonce === null || taskNonce === undefined ? null : nonce(taskNonce);
    const normalizedBinding = normalizeBinding(binding);
    return this._mutate((data) => {
      const existing = data.tasks[child];
      if (existing && existing.owner !== hashThread(parent)) {
        throw new Error("This child thread belongs to another parent chat");
      }
      const immutable = existing?.binding ? normalizeBinding(existing.binding) : null;
      if (immutable && normalizedBinding && !sameBinding(immutable, normalizedBinding)) {
        throw new Error("This child's executor/profile binding is immutable and cannot be changed");
      }
      if (!immutable && normalizedBinding && existing?.model && existing.model !== normalizedBinding.model) {
        throw new Error("This child already has a different model; a late executor binding cannot change it");
      }
      const bound = immutable || normalizedBinding;
      if (immutable && typeof model === "string" && model !== immutable.model) {
        throw new Error("This child's model binding is immutable and cannot be changed");
      }
      if (existing?.task_nonce && task && existing.task_nonce !== task) {
        throw new Error("This child's task nonce cannot be changed");
      }
      const gatewayBinding = bound && ['api', 'deepseek'].includes(bound.executor) ? bound : null;
      let gatewayReservation = null;
      if (gatewayBinding) {
        gatewayReservation = task ? data.dispatches[task] : null;
        if (!gatewayReservation) throw new Error('gateway child binding requires a matching pending dispatch intent');
        if (gatewayReservation.owner !== hashThread(parent) || gatewayReservation.executor !== gatewayBinding.executor
            || (gatewayBinding.executor === 'api' && gatewayReservation.profile_id !== gatewayBinding.profileId)
            || gatewayReservation.model !== gatewayBinding.model) {
          throw new Error('gateway dispatch intent does not match the child binding');
        }
        const reuseChildId = gatewayReservation.reuse_child_id || null;
        if (reuseChildId && reuseChildId !== child) throw new Error('gateway dispatch intent is linked to a different existing child');
        if (existing && !reuseChildId) throw new Error('an existing gateway child requires a fresh follow-up intent linked to that child');
        if (reuseChildId && !existing) throw new Error('follow-up intent references a child that is not registered to this parent');
        if (Object.values(data.tasks).some(record => record.task_nonce === task && record.child_thread_id !== child)) {
          throw new Error('gateway dispatch task nonce is already bound to a different child');
        }
      }
      if (task && !gatewayBinding && data.dispatches[task]) {
        throw new Error('a pending gateway dispatch nonce cannot be consumed by a non-gateway child');
      }
      const at = new Date().toISOString();
      data.tasks[child] = {
        child_thread_id: child,
        owner: hashThread(parent),
        task_nonce: existing?.task_nonce || task,
        model: bound ? bound.model : (typeof model === "string" ? model : existing?.model ?? null),
        ...(bound ? { binding: bound } : {}),
        workspace,
        status: "running",
        created_at: existing?.created_at ?? at,
        updated_at: at,
      };
      if (gatewayReservation) delete data.dispatches[task];
      return { ...data.tasks[child], owner: undefined };
    });
  }

  async reserveDispatch({parentThreadId, taskNonce, executor, profileId = null, model, reuseChildThreadId = null}) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    if (!['api', 'deepseek'].includes(executor)) throw new Error('only gateway-backed executors can reserve dispatch');
    if (executor === 'api' && !/^[a-f0-9]{24}$/.test(profileId || '')) throw new Error('API dispatch reservation requires a profile id');
    if (executor === 'deepseek' && profileId !== null) throw new Error('DeepSeek dispatch reservation cannot have an API profile');
    if (typeof model !== 'string' || !model.trim()) throw new Error('dispatch reservation requires an exact model');
    const reuseChild = reuseChildThreadId === null ? null : childId(reuseChildThreadId);
    return this._mutate(data => {
      const existing = data.dispatches[task];
      if (existing) throw new Error('dispatch task nonce already has a pending intent; duplicate gates cannot share it');
      const nonceRecords = Object.values(data.tasks).filter(record => record.task_nonce === task);
      if (reuseChild) {
        const child = data.tasks[reuseChild];
        if (!child || child.child_thread_id !== reuseChild || child.owner !== owner || (child.task_nonce && child.task_nonce !== task)) {
          throw new Error('follow-up intent requires the exact existing child, owner, and task nonce');
        }
        if (nonceRecords.some(record => record.child_thread_id !== reuseChild)) {
          throw new Error('task nonce is already bound to a different child');
        }
        const prior = child.binding ? normalizeBinding(child.binding) : null;
        if (prior && (prior.executor !== executor || prior.profileId !== profileId || prior.model !== model.trim())) {
          throw new Error('follow-up intent does not match the existing child executor binding');
        }
        if (!prior && child.model !== model.trim()) throw new Error('follow-up intent does not match the existing child model');
        if (Object.values(data.dispatches).some(intent => intent.reuse_child_id === reuseChild)) {
          throw new Error('this child already has a pending follow-up intent');
        }
      } else if (nonceRecords.length) {
        throw new Error('dispatch task nonce is already bound; follow-up must name the existing child');
      }
      const reservation = {owner, task_nonce: task, executor, profile_id: profileId, model: model.trim(),
        ...(reuseChild ? {reuse_child_id: reuseChild} : {}), state: 'pending', created_at: new Date().toISOString()};
      data.dispatches[task] = reservation;
      return {...reservation, owner: undefined};
    });
  }

  async cancelDispatch({parentThreadId, taskNonce}) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    return this._mutate(data => {
      const existing = data.dispatches[task];
      if (!existing) return {cancelled: false, missing: true};
      if (existing.owner !== owner) throw new Error('dispatch reservation belongs to another parent chat');
      const activeChildren = Object.values(data.tasks).filter(record => record.task_nonce === task
        && !['idle', 'completed', 'error', 'interrupted', 'context_exhausted', 'closed'].includes(record.status));
      if (activeChildren.length && (!existing.reuse_child_id
          || activeChildren.some(record => record.child_thread_id !== existing.reuse_child_id))) {
        throw new Error('dispatch reservation is already bound to an active child; refusing cancellation');
      }
      delete data.dispatches[task];
      return {cancelled: true};
    });
  }

  async finish({ parentThreadId, childThreadId, status = "completed" }) {
    const parent = parentId(parentThreadId);
    const child = childId(childThreadId);
    return this._mutate((data) => {
      const existing = data.tasks[child];
      if (!existing || existing.owner !== hashThread(parent)) throw new Error("This child thread belongs to another parent chat");
      existing.status = status;
      existing.updated_at = new Date().toISOString();
      if (['idle', 'completed', 'error', 'interrupted', 'context_exhausted', 'closed'].includes(status)) {
        for (const [task, intent] of Object.entries(data.dispatches)) {
          if (intent?.owner === existing.owner && intent.reuse_child_id === child) delete data.dispatches[task];
        }
      }
      return { ...existing, owner: undefined };
    });
  }

  async assertOwner(childThreadId, parentThreadId) {
    const data = await this._read();
    const task = data.tasks[childId(childThreadId)];
    if (!task || task.owner !== hashThread(parentId(parentThreadId))) throw new Error("This child thread belongs to another parent chat");
    return { ...task, owner: undefined };
  }

  async owned(parentThreadId) {
    const owner = hashThread(parentId(parentThreadId));
    const data = await this._read();
    return Object.values(data.tasks)
      .filter((task) => task.owner === owner)
      .map((task) => ({ ...task, owner: undefined }));
  }

  async binding({ parentThreadId, childThreadId }) {
    const task = await this.assertOwner(childThreadId, parentThreadId);
    return task.binding ? normalizeBinding(task.binding) : null;
  }

  async hasChild(childThreadId) {
    const child = childId(childThreadId);
    const data = await this._read();
    const task = data.tasks[child];
    return Boolean(task && task.child_thread_id === child);
  }

  async list() {
    const data = await this._read();
    return Object.values(data.tasks).map(task => ({...task, owner: undefined}));
  }

  async hasActiveGatewayExecutions() {
    const data = await this._read();
    if (Object.values(data.dispatches).some(dispatch => ['api', 'deepseek'].includes(dispatch?.executor))) return true;
    return Object.values(data.tasks).some(task => {
      const executor = task.binding?.executor;
      const legacyDeepseek = !executor && typeof task.model === 'string' && /deepseek/i.test(task.model);
      const gatewayExecutor = executor === 'deepseek' || executor === 'api' || legacyDeepseek;
      return gatewayExecutor && !['idle', 'completed', 'error', 'interrupted', 'context_exhausted', 'closed'].includes(task.status);
    });
  }
}

export class NativeWriterLease {
  constructor({ stateDir } = {}) {
    this.stateDir = resolveStateDir(stateDir);
    this.directory = path.join(this.stateDir, "native-leases");
  }

  async _paths(workspace) {
    const canonical = await canonicalWorkspace(workspace);
    const key = createHash("sha256").update(canonical).digest("hex");
    return {
      canonical,
      lease: path.join(this.directory, `${key}.json`),
      guard: path.join(this.directory, `${key}.guard`),
    };
  }

  async reserve({ workspace, parentThreadId, taskNonce = randomUUID() }) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    const paths = await this._paths(workspace);
    return withFileLock(paths.guard, async () => {
      const existing = await readJson(paths.lease);
      if (existing) {
        if (existing.owner !== owner || existing.task_nonce !== task) {
          throw new Error(`Workspace is already reserved by another native task in ${paths.canonical}; only an explicit release or a known terminal task may clear it`);
        }
        return { ...existing, owner: undefined };
      }
      const at = new Date().toISOString();
      const lease = {
        version: 2,
        workspace: paths.canonical,
        owner,
        task_nonce: task,
        state: "reserved",
        child_thread_id: null,
        created_at: at,
        updated_at: at,
      };
      await writeJsonAtomic(paths.lease, lease);
      return { ...lease, owner: undefined };
    });
  }

  async bind({ workspace, parentThreadId, taskNonce, childThreadId }) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    const child = childId(childThreadId);
    const paths = await this._paths(workspace);
    return withFileLock(paths.guard, async () => {
      const existing = await readJson(paths.lease);
      if (!existing || existing.owner !== owner || existing.task_nonce !== task) {
        throw new Error("The workspace reservation changed before the native child was bound; refusing to continue");
      }
      existing.child_thread_id = child;
      existing.state = "active";
      existing.updated_at = new Date().toISOString();
      await writeJsonAtomic(paths.lease, existing);
      return { ...existing, owner: undefined };
    });
  }

  async release({ workspace, parentThreadId, taskNonce }) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    const paths = await this._paths(workspace);
    return withFileLock(paths.guard, async () => {
      const existing = await readJson(paths.lease);
      if (!existing || existing.owner !== owner || existing.task_nonce !== task) return false;
      await unlink(paths.lease).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return true;
    });
  }

  async get(workspace) {
    const paths = await this._paths(workspace);
    const value = await readJson(paths.lease);
    return value ? { ...value, owner: undefined } : null;
  }
}

function trustedParent() {
  const value = process.env.CODEX_THREAD_ID?.trim() || process.env.CODEX_SESSION_ID?.trim();
  if (!value) throw new Error("CODEX_THREAD_ID or CODEX_SESSION_ID is required; ownership must come from the trusted Codex environment, not an arbitrary --parent argument");
  return value;
}

async function main(argv) {
  if (argv.includes("--parent")) {
    throw new Error("--parent is not accepted; ownership comes only from the trusted CODEX_THREAD_ID environment");
  }
  const command = argv[0];
  const get = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const stateDir = get("state-dir");
  const workspace = get("workspace");
  const taskNonce = get("task-nonce");
  const taskNonceAt = argv.indexOf("--task-nonce");
  if (taskNonceAt >= 0 && (argv[taskNonceAt + 1] === undefined || argv[taskNonceAt + 1].startsWith("--"))) {
    throw new Error("--task-nonce must be followed by a safe non-empty value, not another flag");
  }
  const parent = trustedParent();
  if (command === "reserve") {
    const lease = await new NativeWriterLease({ stateDir }).reserve({ workspace, parentThreadId: parent, taskNonce: taskNonce || randomUUID() });
    process.stdout.write(`${JSON.stringify({ parent, writer: lease })}\n`);
    return;
  }
  if (command === "bind") {
    const child = get("child");
    const bindingValues = {
      executor: get("executor"),
      profileId: get("profile-id"),
      role: get("role"),
      providerId: get("provider-id"),
      model: get("model"),
    };
    const hasBinding = ["executor", "profile-id", "role", "provider-id"].some((name) => bindingValues[name] !== undefined);
    const writer = await new NativeWriterLease({ stateDir }).bind({ workspace, parentThreadId: parent, taskNonce, childThreadId: child });
    const task = await new NativeTasks({ stateDir }).begin({
      parentThreadId: parent,
      childThreadId: child,
      model: get("model"),
      workspace,
      taskNonce,
      binding: hasBinding ? bindingValues : null,
    });
    process.stdout.write(`${JSON.stringify({ task, writer })}\n`);
    return;
  }
  if (command === "record") {
    const executor = get("executor") || "api";
    if (!new Set(["api", "deepseek"]).has(executor)) throw new Error("record is only for a gateway-backed read-only child binding");
    const child = get("child");
    const profileId = executor === "api" ? get("profile-id") : null;
    const model = get("model");
    const task = await new NativeTasks({ stateDir }).begin({
      parentThreadId: parent,
      childThreadId: child,
      model,
      workspace,
      taskNonce,
      binding: executor === "api"
        ? {executor, profileId, role: get("role"), providerId: get("provider-id"), model}
        : {executor, role: "native_deepseek", model},
    });
    process.stdout.write(`${JSON.stringify({ task })}\n`);
    return;
  }
  if (command === "complete") {
    const child = get("child");
    const task = await new NativeTasks({ stateDir }).finish({ parentThreadId: parent, childThreadId: child, status: get("status") || "completed" });
    const {finalizePendingDisable} = await import("./native-execution-lifecycle.mjs");
    const cleanup = await finalizePendingDisable({stateDir});
    process.stdout.write(`${JSON.stringify({ task, ...(cleanup.stopped === false && cleanup.skipped !== true && cleanup.deferred !== true ? {cleanup} : {}) })}\n`);
    return;
  }
  if (command === "finish") {
    const child = get("child");
    const task = await new NativeTasks({ stateDir }).finish({ parentThreadId: parent, childThreadId: child, status: get("status") || "completed" });
    const released = await new NativeWriterLease({ stateDir }).release({ workspace, parentThreadId: parent, taskNonce });
    const {finalizePendingDisable} = await import("./native-execution-lifecycle.mjs");
    const cleanup = await finalizePendingDisable({stateDir});
    process.stdout.write(`${JSON.stringify({ task, released, ...(cleanup.stopped === false && cleanup.skipped !== true && cleanup.deferred !== true ? {cleanup} : {}) })}\n`);
    return;
  }
  if (command === "dispatch-cancel") {
    const task = await new NativeTasks({stateDir}).cancelDispatch({parentThreadId: parent, taskNonce});
    const {finalizePendingDisable} = await import("./native-execution-lifecycle.mjs");
    const cleanup = await finalizePendingDisable({stateDir});
    process.stdout.write(`${JSON.stringify({task, ...(cleanup.stopped === false && cleanup.skipped !== true && cleanup.deferred !== true ? {cleanup} : {})})}\n`);
    return;
  }
  if (command === "who") {
    const owned = await new NativeTasks({ stateDir }).owned(parent);
    process.stdout.write(`${JSON.stringify({ owned })}\n`);
    return;
  }
  if (command === "binding") {
    const child = get("child");
    const binding = await new NativeTasks({ stateDir }).binding({ parentThreadId: parent, childThreadId: child });
    process.stdout.write(`${JSON.stringify({ binding })}\n`);
    return;
  }
  throw new Error("usage: native-state.mjs <reserve|bind|finish|record|complete|dispatch-cancel|who|binding> --workspace PATH [--task-nonce ID] [--child ID] [--model MODEL] [--executor NAME --profile-id ID --role ROLE --provider-id ID] [--state-dir PATH]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
