#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveRouterEnabled, loadRouterSettings, validateRouterSettings } from './native-api-settings.mjs';
import { readNativeModelOptions } from './native-model-catalog.mjs';
import { resolveCurrentMainModel } from './native-current-model.mjs';
import { readUpgradeGuardStatus } from './native-upgrade-status.mjs';

const DEEPSEEK_NATIVE_SLUG = 'deepseek/deepseek-flash';

const HOLIDAYS_2026 = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

const CHINA_TIMEZONE = 'Asia/Shanghai';
const PEAK_UTC_HOURS = [[1, 4], [6, 10]];
const BUILTIN_EXECUTORS = new Set(['luna', 'deepseek', 'same']);

function localDate(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function isHoliday2026(date) {
  return HOLIDAYS_2026.some(([start, end]) => date >= start && date <= end);
}

function scheduleRoute(instant) {
  const date = localDate(instant, CHINA_TIMEZONE);
  const year = Number(date.slice(0, 4));
  const weekday = new Date(instant).getUTCDay();
  const hour = new Date(instant).getUTCHours();

  // DeepSeek's published discount applies on UTC weekdays, with Chinese
  // public holidays excluded. Weekend make-up workdays remain valley hours.
  if (weekday === 0 || weekday === 6) {
    return { executor: 'deepseek', phase: 'valley', source: 'schedule', reason: 'weekend valley pricing' };
  }
  if (year === 2026 && isHoliday2026(date)) {
    return { executor: 'deepseek', phase: 'valley', source: 'schedule', reason: 'Chinese public holiday; official DeepSeek holiday pricing is valley' };
  }
  const peak = PEAK_UTC_HOURS.some(([start, end]) => hour >= start && hour < end);
  if (peak && year !== 2026) {
    return { executor: 'luna', phase: 'unknown', source: 'calendar_missing', reason: `no bundled Chinese holiday calendar for ${year}; using Luna conservatively during a candidate peak window` };
  }
  return peak
    ? { executor: 'luna', phase: 'peak', source: 'schedule', reason: 'weekday DeepSeek peak-price window' }
    : { executor: 'deepseek', phase: 'valley', source: 'schedule', reason: 'weekday DeepSeek valley-price window' };
}

function stateRoot(stateDir) {
  if (stateDir) return stateDir;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'sol-luna-deepseek-router', 'session-overrides');
}

const writeQueues = new Map();

function stateFile(sessionId, stateDir) {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return path.join(stateRoot(stateDir), `${digest}.json`);
}

function queueWrite(file, operation) {
  const previous = writeQueues.get(file) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(file, current);
  return current.finally(() => {
    if (writeQueues.get(file) === current) writeQueues.delete(file);
  });
}

async function readOverride(sessionId, stateDir, settings) {
  if (!sessionId) return null;
  let value;
  try {
    value = JSON.parse(await readFile(stateFile(sessionId, stateDir), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read this chat's router override; refusing automatic routing: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || typeof value.executor !== 'string') {
    throw new Error('This chat has an invalid router override; refusing automatic routing. Reset the session override after inspecting the state file.');
  }
  try { resolveSelector(value.executor, settings); }
  catch {
    throw new Error('This chat has an invalid router override; refusing automatic routing. Reset the session override after inspecting the state file.');
  }
  return value.executor;
}

function resolveSelector(selector, settings) {
  if (BUILTIN_EXECUTORS.has(selector)) return { executor: selector, profileId: null, profile: null };
  if (typeof selector === 'string' && /^native:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selector)) {
    return {executor: 'native', model: selector.slice('native:'.length), profileId: null, profile: null};
  }
  const direct = settings.profiles[selector];
  if (direct) return { executor: 'api', profileId: direct.profileId, profile: direct };
  const matches = Object.values(settings.profiles).filter((profile) => profile.aliases?.includes(selector));
  if (matches.length === 1) return { executor: 'api', profileId: matches[0].profileId, profile: matches[0] };
  throw new Error('unknown executor profile');
}

async function writeOverride(sessionId, executor, stateDir) {
  if (!sessionId) throw new Error('--session is required to save a session override');
  const file = stateFile(sessionId, stateDir);
  return queueWrite(file, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    if (executor === null) {
      await rm(file, { force: true });
      return;
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify({ executor, updatedAt: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 });
      // Windows can transiently reject replacement while another process is
      // renaming into the same destination. Retry the atomic replacement
      // instead of surfacing a spurious CLI failure or leaving partial state.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temp, file);
          break;
        } catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 8) throw error;
          const jitter = Math.floor(Math.random() * 7);
          await new Promise(resolve => setTimeout(resolve, 5 * (2 ** attempt) + jitter));
        }
      }
    } finally {
      await rm(temp, { force: true });
    }
  });
}

export async function decideRoute({
  at = new Date(), executor, setSessionExecutor, mainModel, trustedMainModel = mainModel,
  explicitMainModel, currentModelThreadId, guardStatus,
  resetSession = false, sessionId, stateDir, routerSettings, settingsPath,
  readNativeModels = readNativeModelOptions, currentModelResolver = resolveCurrentMainModel,
  readGuardStatus = readUpgradeGuardStatus,
} = {}) {
  if (typeof at === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) {
    throw new Error('--at must be a complete ISO timestamp with Z or an explicit UTC offset');
  }
  const instant = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(instant.getTime())) throw new Error(`Invalid --at date: ${at}`);
  const settings = routerSettings === undefined
    ? await loadRouterSettings(settingsPath)
    : validateRouterSettings(routerSettings);
  const effectiveGuardStatus = settings.enabled === false
    ? guardStatus
    : guardStatus === undefined ? await readGuardStatus() : guardStatus;
  if (!effectiveRouterEnabled(settings, effectiveGuardStatus)) {
    const guarded = effectiveGuardStatus?.state === 'disabled';
    return {
      phase: 'disabled',
      source: guarded ? 'guard_disabled' : 'disabled',
      executor: 'off',
      profileId: null,
      evaluatedAt: instant.toISOString(),
      timezone: CHINA_TIMEZONE,
      reason: guarded
        ? 'automatic child delegation is disabled by the lifecycle guard'
        : 'automatic child delegation is disabled in router settings',
    };
  }
  if (executor !== undefined) {
    try { resolveSelector(executor, settings); }
    catch { throw new Error('--executor must be luna, deepseek, or a configured API profile/alias'); }
  }
  if (setSessionExecutor !== undefined && setSessionExecutor !== 'auto') {
    try { resolveSelector(setSessionExecutor, settings); }
    catch { throw new Error('--set-session-executor must be luna, deepseek, auto, or a configured API profile/alias'); }
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) throw new Error('--session must be a non-empty chat ID');
  if (setSessionExecutor && !sessionId) throw new Error('--session is required to save a session override');
  if (resetSession && !sessionId) throw new Error('--session is required to reset a session override');
  if (resetSession && setSessionExecutor) throw new Error('Choose either --reset-session or --set-session-executor');

  if (resetSession) await writeOverride(sessionId, null, stateDir);
  if (setSessionExecutor) {
    const normalizedOverride = setSessionExecutor === 'auto' ? null : resolveSelector(setSessionExecutor, settings).profileId || setSessionExecutor;
    await writeOverride(sessionId, normalizedOverride, stateDir);
  }

  const scheduled = settings.mode === 'fixed'
    ? { phase: 'fixed', source: 'fixed', reason: 'fixed executor selection; calendar not consulted' }
    : scheduleRoute(instant);
  const plan = {
    ...scheduled,
    evaluatedAt: instant.toISOString(),
    timezone: CHINA_TIMEZONE,
    calendarVersion: settings.mode === 'fixed' ? 'not_used' : localDate(instant, CHINA_TIMEZONE).startsWith('2026-') ? 'china-public-holidays-2026' : 'missing',
  };
  const planSelector = settings.mode === 'fixed'
    ? settings.fixedExecutor
    : settings.mode === 'scheduled'
      ? settings.schedule[scheduled.phase === 'valley' ? 'valley' : 'peak']
      : scheduled.executor;
  let selector = planSelector;
  let source = plan.source;
  let reason = plan.reason;
  if (executor !== undefined) {
    selector = executor;
    source = 'one_time_override';
    reason = `one-time explicit executor override: ${executor}`;
  } else {
    const sticky = await readOverride(sessionId, stateDir, settings);
    if (sticky) {
      selector = sticky;
      source = 'session_override';
      reason = `sticky executor override for this chat: ${sticky}`;
    }
  }
  const resolved = resolveSelector(selector, settings);
  if (resolved.executor === 'native') {
    const catalog = await readNativeModels();
    if (!catalog.some(model => model?.value === resolved.model)) {
      throw new Error(`Selected native model is not present in the current Codex catalog: ${resolved.model}`);
    }
  }
  const result = { ...plan, executor: resolved.executor, profileId: resolved.profileId, source, reason };
  const currentModel = resolved.executor === 'same'
      ? await currentModelResolver({trustedModel: trustedMainModel, explicitModel: explicitMainModel, ...(currentModelThreadId ? {threadId: currentModelThreadId} : {})})
    : null;
  const nativeSpawn = resolved.executor === 'api'
    ? {
      fork_turns: 'none',
      agent_type: `native_api_${resolved.profileId}`,
      provider_id: `api-native-${resolved.profileId}`,
      profile_id: resolved.profileId,
      resolved_model: resolved.profile.model,
    }
    : {
      fork_turns: 'none',
      ...(resolved.executor === 'deepseek'
        ? { agent_type: 'native_deepseek', resolved_model: DEEPSEEK_NATIVE_SLUG }
        : {}),
      ...(resolved.executor === 'same' ? {model: currentModel.model} : {}),
      ...(resolved.executor === 'native' ? {model: resolved.model} : {}),
    };
  return {
    ...result,
    native_spawn: nativeSpawn,
  };
}

function usage() {
  return `Usage: node scripts/route.mjs [options]\n\nOptions:\n  --at ISO_DATE                    Evaluate a test or supplied instant\n  --executor SELECTOR             One-task override: luna, deepseek, same, native:<slug>, profile ID, or alias\n  --main-model MODEL               Explicit fallback; live chat metadata takes precedence\n  --session ID                     Chat-specific state key (not a prompt or secret)\n  --set-session-executor SELECTOR  luna, deepseek, same, native:<slug>, profile ID/alias, or auto\n  --settings PATH                  Router settings JSON (default: plugin LocalAppData path)\n  --reset-session                  Clear this chat's sticky override\n  --state-dir PATH                 State root (tests only; default is per-user LocalAppData)\n  --json                           Print one JSON result\n`;
}

async function main(argv) {
  const options = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help' || arg === '-h') { process.stdout.write(usage()); return; }
    const fields = {
      '--at': 'at', '--executor': 'executor', '--main-model': 'explicitMainModel',
      '--session': 'sessionId', '--set-session-executor': 'setSessionExecutor',
      '--state-dir': 'stateDir', '--settings': 'settingsPath',
    };
    if (arg === '--reset-session') { options.resetSession = true; continue; }
    const value = argv[i + 1];
    if (!fields[arg] || value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`Unknown option or missing value: ${arg}`);
    options[fields[arg]] = argv[++i];
  }
  const result = await decideRoute(options);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.executor}: ${result.phase} (${result.reason})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
