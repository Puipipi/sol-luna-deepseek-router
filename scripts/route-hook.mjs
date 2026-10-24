#!/usr/bin/env node
/**
 * Codex hook adapter for the Sol/Luna/DeepSeek peak-valley router.
 *
 * The hook is deliberately small and local:
 * - It imports `decideRoute` from route.mjs; it never spawns a child process,
 *   calls a model, or touches the network.
 * - It evaluates the published schedule at hook time. There is no timer, so an
 *   idle chat is never woken and no stale backlog is queued.
 * - It injects `additionalContext` only on the first observed state for a chat
 *   and when the effective schedule/executor changes. A per-chat, atomically
 *   written state file plus a short-lived lock deduplicates concurrent hooks.
 *
 * Identity limitations (important):
 * - Codex hook payloads provide `session_id` and `model`, but not a reliable
 *   "main thread vs subagent" role field. Native Luna subagent turns use a
 *   model name containing `luna`, so those turns are suppressed. A main chat
 *   intentionally running a Luna model is therefore also silent. If a host
 *   omits `model`, or names a child model differently, a child session could
 *   receive a notice. State is keyed by the hook `session_id`, so one session
 *   can never consume another session's notification.
 * - Manual route overrides are stored by route.mjs under the ID passed with
 *   `--session` (commonly `CODEX_THREAD_ID`). Hook `session_id` is not proven
 *   to be the same value on every Codex build. Override lookup therefore
 *   prefers `CODEX_THREAD_ID` when the hook process inherits it, and falls back
 *   to the hook `session_id`. Hook notification state always uses the hook
 *   `session_id`.
 * - `additionalContext` is model-visible context, not a guaranteed UI banner.
 *   It is delivered on the next UserPromptSubmit or PreToolUse event, so an
 *   idle chat receives nothing until the user or a tool resumes work.
 * - The notice reports the router's schedule decision. It does not verify the
 *   configured DSH provider/model or that the official DeepSeek endpoint is in
 *   use; that remains the caller's responsibility before claiming valley
 *   pricing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRoute } from './route.mjs';
import { loadRouterSettings, validateRouterSettings } from './native-api-settings.mjs';
import { NativeTasks } from './native-state.mjs';

const SUPPORTED_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse']);
const STATE_VERSION = 1;
const LOCK_TIMEOUT_MS = 750;
const LOCK_STALE_MS = 30_000;
const MAX_REASON_LENGTH = 220;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function defaultHookStateDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'sol-luna-deepseek-router', 'hook-state');
}

function resolveHookStateDir(explicit) {
  return explicit || process.env.SOL_LUNA_ROUTE_HOOK_STATE_DIR || defaultHookStateDir();
}

function resolveOverrideStateDir(explicit) {
  return explicit || process.env.SOL_LUNA_ROUTE_OVERRIDE_STATE_DIR || undefined;
}

function stateFileName(sessionId) {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`;
}

function trimReason(reason) {
  const text = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 3)}...` : text;
}

/**
 * The stable part of the route that matters to an active chat. The timestamp
 * is intentionally excluded so repeated hooks in one phase stay silent.
 */
export function notificationKey(route) {
  const key = [route.phase, route.executor, route.source];
  if (route.executor === 'api' && typeof route.profileId === 'string') key.push(route.profileId);
  if (['same', 'native'].includes(route.executor) && typeof route.native_spawn?.model === 'string') key.push(route.native_spawn.model);
  return key.join('|');
}

/**
 * Pure notice builder. Kept separate so tests can freeze the clock and assert
 * the exact wording without file I/O.
 */
export function buildNotification(route, at) {
  if (route.executor === 'off') {
    return `[sol-luna-deepseek-router] 已关闭自动子代理分工；Sol 将自行处理本轮任务。已运行任务不会被中断。`;
  }
  const reason = trimReason(route.reason);
  const schedule = route.phase === 'unknown'
    ? `unknown${reason ? ` (${reason})` : ''}`
    : `${route.phase}${reason ? ` (${reason})` : ''}`;
  const executor = route.executor === 'deepseek'
    ? 'native DeepSeek gateway'
    : route.executor === 'api'
      ? `native API profile ${route.profileLabel || route.profileId || 'unknown'}`
      : route.executor === 'same'
        ? `current chat model ${route.native_spawn?.model || 'unknown'}`
        : route.executor === 'native'
          ? `Codex model ${route.native_spawn?.model || 'unknown'}`
          : route.executor === 'luna'
            ? 'native Luna'
            : 'native executor';
  const source = route.source === 'session_override'
    ? 'sticky chat override; it outranks the automatic schedule'
    : route.source === 'one_time_override'
      ? 'one-time explicit override'
      : route.source === 'calendar_missing'
        ? 'conservative fallback because the holiday calendar is missing'
        : route.source === 'fixed'
          ? 'fixed executor selection; the peak/valley calendar is not used'
          : 'automatic schedule';
  const timezone = route.timezone || 'Asia/Shanghai';
  return `[sol-luna-deepseek-router] Schedule: ${schedule}. Configured executor status: ${executor} (${source}). Evaluated at ${at.toISOString()} (${timezone}). This is status context only; native child chats must not start another child. Already running tasks are not interrupted; the notice repeats only after the effective schedule, executor, or API profile changes.`;
}

/**
 * Model names are not child identity: a parent can intentionally use a child
 * model. Suppress only explicit role evidence from the hook payload.
 */
export function isChildExecutor(input, apiProfiles = {}) {
  for (const key of ['agent_type', 'agent_role', 'subagent_type']) {
    const value = input?.[key];
    if (typeof value === 'string' && (/luna|deepseek|subagent/i.test(value) || /^native_api_[a-f0-9]{24}$/.test(value))) return true;
  }
  return false;
}

async function readState(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.version !== STATE_VERSION || typeof value.lastNotifiedKey !== 'string') return null;
    return value;
  } catch {
    // A corrupt or partially written state file is recoverable: treat it as
    // unseen and rewrite a valid state atomically. This cannot cause a loop
    // because this chat receives one fresh notice, not one per hook.
    return null;
  }
}

async function writeStateAtomic(file, state) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Windows can transiently reject replacement while another process is
    // renaming into the destination. Retry instead of failing the hook or
    // leaving a partial state file.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, file);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 8) throw error;
        await sleep(5 * (2 ** attempt) + Math.floor(Math.random() * 7));
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      } catch (error) {
        await rm(lockPath, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) return false;
      await sleep(10 + Math.floor(Math.random() * 10));
    }
  }
}

async function releaseLock(lockPath) {
  try {
    await rm(lockPath, { force: true });
  } catch {
    // A leftover lock becomes stale after LOCK_STALE_MS and is reclaimed by
    // the next hook, so cleanup failure must not fail the hook.
  }
}

/**
 * Handle one hook payload. Returns `{output, route, state, reason}`.
 * `output` is null when there is nothing to inject.
 */
export async function handleHook({
  input,
  now = new Date(),
  hookStateDir,
  overrideStateDir,
  overrideSessionId,
  routerSettings,
  settingsPath,
  guardStatus,
} = {}) {
  const event = input?.hook_event_name;
  if (!SUPPORTED_EVENTS.has(event)) return { output: null, reason: 'unsupported_event' };
  const sessionId = typeof input?.session_id === 'string' ? input.session_id.trim() : '';
  if (!sessionId) return { output: null, reason: 'missing_session' };
  if (isChildExecutor(input)) return { output: null, reason: 'child_executor' };
  const settings = routerSettings === undefined
    ? await loadRouterSettings(settingsPath)
    : validateRouterSettings(routerSettings);
  const recordedThreadId = [input?.thread_id, input?.threadId, sessionId]
    .find(value => typeof value === 'string' && value.trim());
  if (recordedThreadId && await new NativeTasks().hasChild(recordedThreadId.trim())) {
    return {output: null, reason: 'child_executor'};
  }

  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid hook clock');
  const routeSessionId = typeof overrideSessionId === 'string' && overrideSessionId.trim()
    ? overrideSessionId.trim()
    : sessionId;
  const route = await decideRoute({
    at,
    sessionId: routeSessionId,
    mainModel: typeof input?.model === 'string' ? input.model : undefined,
    currentModelThreadId: recordedThreadId?.trim(),
    guardStatus,
    stateDir: resolveOverrideStateDir(overrideStateDir),
    routerSettings: settings,
  });
  const key = notificationKey(route);
  const directory = resolveHookStateDir(hookStateDir);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, stateFileName(sessionId));

  // Fast path: most PreToolUse calls see no phase/executor change and should
  // not contend for the write lock at all.
  const fastState = await readState(file);
  if (fastState?.lastNotifiedKey === key) return { output: null, reason: 'unchanged', route };

  const lockPath = `${file}.lock`;
  if (!await acquireLock(lockPath)) return { output: null, reason: 'busy', route };
  try {
    // Re-check after acquiring the lock: another hook may have just written
    // the same state while this process was waiting.
    const previous = await readState(file);
    if (previous?.lastNotifiedKey === key) return { output: null, reason: 'unchanged', route };

    const additionalContext = buildNotification(route, at);
    const state = {
      version: STATE_VERSION,
      lastNotifiedKey: key,
      lastNotifiedAt: at.toISOString(),
      lastPhase: route.phase,
      lastExecutor: route.executor,
      lastSource: route.source,
    };
    // Commit the dedup state before writing stdout. If the process is killed
    // between these steps the chat can miss one notice, but it cannot receive
    // the same notice twice from concurrent hooks.
    await writeStateAtomic(file, state);
    return {
      output: { hookSpecificOutput: { hookEventName: event, additionalContext } },
      route,
      state,
    };
  } finally {
    await releaseLock(lockPath);
  }
}

function usage() {
  return `Usage: node scripts/route-hook.mjs [options]\n\nReads one Codex hook payload as JSON from stdin and writes one hook output\nJSON line when this chat needs a peak/valley notice.\n\nOptions:\n  --input PATH                 Read the hook payload from a file (tests)\n  --state-dir PATH             Hook notification state root\n  --override-state-dir PATH    route.mjs session override root\n  --override-session ID        Session key for manual override lookup\n  --now ISO_DATE               Evaluate a supplied instant (tests)\n  --help, -h                   Show this help\n\nEnvironment overrides for deployment/testing:\n  SOL_LUNA_ROUTE_HOOK_STATE_DIR\n  SOL_LUNA_ROUTE_OVERRIDE_STATE_DIR\n  CODEX_THREAD_ID              Preferred manual override session key\n  SOL_LUNA_ROUTE_HOOK_DEBUG=1  Print hook errors to stderr\n`;
}

function parseArgs(argv) {
  const options = {};
  const fields = {
    '--input': 'input',
    '--state-dir': 'stateDir',
    '--override-state-dir': 'overrideStateDir',
    '--override-session': 'overrideSessionId',
    '--now': 'now',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const field = fields[argument];
    if (!field) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || !value.trim()) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[field] = value;
    index += 1;
  }
  return options;
}

async function readHookInput(options) {
  if (options.input) return readFile(options.input, 'utf8');
  // Collect Buffers so a multi-byte UTF-8 character split across chunks is
  // decoded once at the end instead of becoming replacement characters.
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  let now;
  if (options.now !== undefined) {
    now = new Date(options.now);
    if (!Number.isFinite(now.getTime())) {
      process.stderr.write('Invalid --now date\n');
      process.exitCode = 2;
      return;
    }
  }

  try {
    const raw = await readHookInput(options);
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const payload = input && typeof input === 'object' ? input : {};
    const overrideSessionId = options.overrideSessionId
      || process.env.CODEX_THREAD_ID?.trim()
      || (typeof payload.session_id === 'string' ? payload.session_id : '');
    const result = await handleHook({
      input: payload,
      now,
      hookStateDir: options.stateDir,
      overrideStateDir: options.overrideStateDir,
      overrideSessionId,
    });
    if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  } catch (error) {
    // Hooks must not block the user's work when state is unavailable. Keep the
    // default silent and make diagnostics opt-in so a broken state directory
    // cannot fail the turn.
    if (process.env.SOL_LUNA_ROUTE_HOOK_DEBUG === '1') {
      process.stderr.write(`route-hook: ${error.message}\n`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    if (process.env.SOL_LUNA_ROUTE_HOOK_DEBUG === '1') {
      process.stderr.write(`route-hook: ${error.message}\n`);
    }
  });
}
