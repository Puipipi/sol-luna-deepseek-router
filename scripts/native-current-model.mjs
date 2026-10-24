import {access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function currentModelDatabasePath(env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(path.resolve(codexHome), 'state_5.sqlite');
}

export function trustedCurrentThreadId(env = process.env) {
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export async function readCurrentMainModel({
  env = process.env,
  threadId = trustedCurrentThreadId(env),
  dbPath = currentModelDatabasePath(env),
  Database = DatabaseSync,
} = {}) {
  if (!threadId) throw new Error('a trusted current Codex thread ID is required for model lookup');
  if (typeof threadId !== 'string' || threadId.length > 512) throw new Error('trusted Codex thread ID is invalid');
  try { await access(dbPath); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Codex state_5.sqlite is missing; current chat model metadata is unavailable');
    throw new Error('Codex conversation metadata is unavailable');
  }
  let database;
  try {
    database = new Database(dbPath, {readOnly: true, timeout: 200});
    const columns = database.prepare('PRAGMA table_info(threads)').all().map(column => column.name);
    if (!['id', 'model', 'model_provider', 'rollout_path'].every(column => columns.includes(column))) {
      throw new Error('threads table columns are incomplete');
    }
    const row = database.prepare('SELECT model, model_provider, rollout_path FROM threads WHERE id = ?').get(threadId);
    if (!row || typeof row.model !== 'string' || !row.model.trim()) {
      throw new Error('current thread has no recorded model metadata');
    }
    return {
      model: row.model.trim(),
      provider: typeof row.model_provider === 'string' && row.model_provider.trim() ? row.model_provider.trim() : null,
    };
  } catch (error) {
    if (error.message === 'threads table columns are incomplete' || error.message === 'current thread has no recorded model metadata') throw error;
    throw new Error('Codex conversation metadata is unavailable');
  } finally {
    database?.close();
  }
}

export async function resolveCurrentMainModel({
  env = process.env,
  trustedModel,
  explicitModel,
  threadId = trustedCurrentThreadId(env),
  dbPath = currentModelDatabasePath(env),
  Database = DatabaseSync,
  readModel = readCurrentMainModel,
} = {}) {
  let databaseModel = null;
  let databaseError = null;
  if (threadId) {
    try { databaseModel = await readModel({env, threadId, dbPath, Database}); }
    catch (error) { databaseError = error; }
  }
  const modelFromDb = databaseModel?.model;
  if (modelFromDb && typeof trustedModel === 'string' && trustedModel.trim() && modelFromDb !== trustedModel.trim()) {
    throw new Error('hook model conflicts with the active chat model metadata; refusing model substitution');
  }
  if (modelFromDb && typeof explicitModel === 'string' && explicitModel.trim() && modelFromDb !== explicitModel.trim()) {
    throw new Error('--main-model conflicts with the active chat model metadata; refusing model substitution');
  }
  const trusted = typeof trustedModel === 'string' && trustedModel.trim() ? trustedModel.trim() : null;
  const explicit = typeof explicitModel === 'string' && explicitModel.trim() ? explicitModel.trim() : null;
  const model = modelFromDb || trusted || explicit;
  if (!model) {
    throw new Error(`same-model routing requires a trusted current chat model${databaseError ? ` (${databaseError.message})` : ''}`);
  }
  return {
    model,
    provider: databaseModel?.provider ?? null,
    source: modelFromDb ? 'conversation_db' : trusted ? 'hook' : 'explicit',
  };
}
