import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readCurrentMainModel, resolveCurrentMainModel} from '../scripts/native-current-model.mjs';

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
async function rejects(action, pattern, message) { await assert.rejects(action, pattern, message); checks += 1; }

const root = await mkdtemp(path.join(os.tmpdir(), 'native-current-model-'));
try {
  const codexHome = path.join(root, 'codex-home');
  await import('node:fs/promises').then(fs => fs.mkdir(codexHome, {recursive: true}));
  const dbFile = path.join(codexHome, 'state_5.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, model_provider TEXT, rollout_path TEXT, turns TEXT);
    INSERT INTO threads VALUES ('chat-a', 'gpt-6.1-sol', 'openai', 'private-a.jsonl', 'must never read');
    INSERT INTO threads VALUES ('chat-b', 'gpt-6-astra', 'openai', 'private-b.jsonl', 'also private');`);
  db.close();
  await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
  const envA = {CODEX_HOME: codexHome, CODEX_THREAD_ID: 'chat-a'};
  const envB = {CODEX_HOME: codexHome, CODEX_SESSION_ID: 'chat-b'};
  equal((await readCurrentMainModel({env: envA})).model, 'gpt-6.1-sol', 'chat A model comes from its exact threads row');
  equal((await readCurrentMainModel({env: envB})).model, 'gpt-6-astra', 'chat B independently resolves its own threads row');
  equal(Object.hasOwn(await readCurrentMainModel({env: envA}), 'rolloutPath'), false, 'resolver never returns rollout paths or turn content');
  equal((await resolveCurrentMainModel({env: envA, explicitModel: 'gpt-6.1-sol'})).source, 'conversation_db', 'exact database model is preferred over explicit fallback');
  await rejects(resolveCurrentMainModel({env: envA, explicitModel: 'gpt-6-astra'}), /conflicts with the active chat model/, 'an explicit model cannot override conflicting live chat metadata');

  await rejects(readCurrentMainModel({env: {CODEX_HOME: codexHome}}), /trusted current Codex thread ID/, 'database lookup requires a trusted thread ID');
  await rejects(readCurrentMainModel({env: {CODEX_HOME: path.join(root, 'missing'), CODEX_THREAD_ID: 'chat-a'}}), /state_5\.sqlite is missing/, 'missing metadata store fails clearly');
  await rejects(readCurrentMainModel({env: envA, Database: class { constructor() { const error = new Error('database locked'); error.code = 'SQLITE_BUSY'; throw error; } }}), /conversation metadata is unavailable/, 'locked database errors are sanitized and explicit');

  const badHome = path.join(root, 'bad-home');
  await import('node:fs/promises').then(fs => fs.mkdir(badHome, {recursive: true}));
  const badDb = new DatabaseSync(path.join(badHome, 'state_5.sqlite'));
  badDb.exec('CREATE TABLE something_else (id TEXT)');
  badDb.close();
  await rejects(readCurrentMainModel({env: {CODEX_HOME: badHome, CODEX_THREAD_ID: 'chat-a'}}), /threads table columns are incomplete/, 'bad schema does not fall back to global config');
  await rejects(resolveCurrentMainModel({env: {CODEX_HOME: path.join(root, 'missing'), CODEX_THREAD_ID: 'chat-a'}}), /same-model routing requires a trusted current chat model/, 'same fails if DB and trusted fallback are unavailable');
} finally {
  await rm(root, {recursive: true, force: true});
}

console.log(`PASS ${checks} current model metadata assertions`);
