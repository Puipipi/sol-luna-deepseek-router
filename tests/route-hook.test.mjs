import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRoute } from '../scripts/route.mjs';
import {
  buildNotification, handleHook, isChildExecutor, notificationKey,
} from '../scripts/route-hook.mjs';
import { createApiProfile } from '../scripts/native-api-settings.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const hookPath = path.join(repoRoot, 'scripts', 'route-hook.mjs');
const shanghai = '+08:00';
const priorCodexHome = process.env.CODEX_HOME;
const priorLocalAppData = process.env.LOCALAPPDATA;
process.env.CODEX_HOME = path.join(os.tmpdir(), `route-hook-test-codex-home-${process.pid}`);
process.env.LOCALAPPDATA = path.join(os.tmpdir(), `route-hook-test-local-${process.pid}`);
process.on('exit', () => {
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodexHome;
  if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = priorLocalAppData;
});
// Keep every test away from the real user's sticky override state. Individual
// manual-override tests pass their own directory; everything else uses this
// empty, isolated root.
const isolatedOverrideDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-overrides-'));
process.on('exit', () => {
  try {
    rmSync(isolatedOverrideDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for a failed test run.
  }
});
let checks = 0;

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function ok(value, message) {
  assert.ok(value, message);
  checks += 1;
}

async function rejects(promise, pattern, message) {
  await assert.rejects(promise, pattern, message);
  checks += 1;
}

function stateFile(stateDir, sessionId) {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return path.join(stateDir, `${digest}.json`);
}

function inputFor(sessionId, event = 'UserPromptSubmit', model = 'gpt-6.1-sol') {
  return {
    session_id: sessionId,
    cwd: repoRoot,
    hook_event_name: event,
    model,
  };
}

async function callHook({
  sessionId, event = 'UserPromptSubmit', model = 'gpt-6.1-sol',
  now, hookStateDir, overrideStateDir = isolatedOverrideDir, overrideSessionId = sessionId,
}) {
  return handleHook({
    input: inputFor(sessionId, event, model),
    now: new Date(now),
    hookStateDir,
    overrideStateDir,
    overrideSessionId,
  });
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Ignore a descriptor that the child already inherited and closed.
  }
}

function runHookProcess({
  input, raw, stateDir, overrideStateDir, now, stdin = false,
  env = {}, omitOverrideSession = false, scriptPath = hookPath, cwd = repoRoot,
}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'route-hook-cli-'));
    const inputPath = path.join(dir, 'input.json');
    const stdoutPath = path.join(dir, 'stdout');
    const stderrPath = path.join(dir, 'stderr');
    let stdoutFd;
    let stderrFd;
    let stdinFd;
    let settled = false;

    const cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Test cleanup must not hide the actual assertion failure.
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    try {
      writeFileSync(inputPath, raw !== undefined ? raw : JSON.stringify(input));
      stdoutFd = openSync(stdoutPath, 'w');
      stderrFd = openSync(stderrPath, 'w');
      if (stdin) stdinFd = openSync(inputPath, 'r');
      const args = [scriptPath, '--state-dir', stateDir, '--now', now];
      // Never let a CLI test read the real user's sticky override state.
      args.push('--override-state-dir', overrideStateDir || path.join(dir, 'override-state'));
      if (input?.session_id && !omitOverrideSession) args.push('--override-session', input.session_id);
      if (!stdin) args.push('--input', inputPath);

      const child = spawn(process.execPath, args, {
        cwd,
        stdio: [stdin ? stdinFd : 'ignore', stdoutFd, stderrFd],
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_THREAD_ID: '',
          SOL_LUNA_ROUTE_HOOK_STATE_DIR: '',
          SOL_LUNA_ROUTE_OVERRIDE_STATE_DIR: '',
          ...env,
        },
      });
      closeQuietly(stdinFd);
      closeQuietly(stdoutFd);
      closeQuietly(stderrFd);
      stdinFd = undefined;
      stdoutFd = undefined;
      stderrFd = undefined;

      child.on('error', error => finish(error));
      child.on('close', (status, signal) => {
        try {
          finish(null, {
            status,
            signal,
            stdout: readFileSync(stdoutPath, 'utf8'),
            stderr: readFileSync(stderrPath, 'utf8'),
          });
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      closeQuietly(stdinFd);
      closeQuietly(stdoutFd);
      closeQuietly(stderrFd);
      finish(error);
    }
  });
}

// Exercise the registered command shape through a real shell. This catches
// unquoted plugin roots with spaces and proves the hook does not depend on the
// user's current working directory.
function runHookThroughShell({
  input, pluginRoot, cwd, stateDir, overrideStateDir, now, commandTemplate,
}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'route-hook-shell-'));
    const inputPath = path.join(dir, 'input.json');
    const stdoutPath = path.join(dir, 'stdout');
    const stderrPath = path.join(dir, 'stderr');
    let stdoutFd;
    let stderrFd;
    let settled = false;
    const cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    try {
      writeFileSync(inputPath, JSON.stringify(input));
      stdoutFd = openSync(stdoutPath, 'w');
      stderrFd = openSync(stderrPath, 'w');
      const registered = commandTemplate.replace('${PLUGIN_ROOT}', pluginRoot);
      const command = `${registered} --input "${inputPath}" --state-dir "${stateDir}" --override-state-dir "${overrideStateDir}" --override-session "${input.session_id}" --now "${now}"`;
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
          cwd,
          stdio: ['ignore', stdoutFd, stderrFd],
          windowsHide: true,
          // Let cmd.exe receive the already-quoted command verbatim; Node's
          // default argument quoting would add another quote layer and split
          // the plugin path at its spaces.
          windowsVerbatimArguments: true,
          env: {
            ...process.env,
            CODEX_THREAD_ID: '',
            SOL_LUNA_ROUTE_HOOK_STATE_DIR: '',
            SOL_LUNA_ROUTE_OVERRIDE_STATE_DIR: '',
          },
        })
        : spawn('/bin/sh', ['-c', command], {
          cwd,
          stdio: ['ignore', stdoutFd, stderrFd],
          env: {
            ...process.env,
            CODEX_THREAD_ID: '',
            SOL_LUNA_ROUTE_HOOK_STATE_DIR: '',
            SOL_LUNA_ROUTE_OVERRIDE_STATE_DIR: '',
          },
        });
      closeQuietly(stdoutFd);
      closeQuietly(stderrFd);
      stdoutFd = undefined;
      stderrFd = undefined;
      child.on('error', error => finish(error));
      child.on('close', (status, signal) => {
        try {
          finish(null, {
            status,
            signal,
            stdout: readFileSync(stdoutPath, 'utf8'),
            stderr: readFileSync(stderrPath, 'utf8'),
          });
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      closeQuietly(stdoutFd);
      closeQuietly(stderrFd);
      finish(error);
    }
  });
}

// Pure functions and the identity guard.
const peakRoute = {
  phase: 'peak',
  executor: 'luna',
  source: 'schedule',
  reason: 'weekday DeepSeek peak-price window',
  timezone: 'Asia/Shanghai',
};
const peakAt = new Date(`2026-10-19T09:00:00.000${shanghai}`);
const peakNotice = buildNotification(peakRoute, peakAt);
ok(peakNotice.includes('Schedule: peak'), 'notice names the peak phase');
ok(peakNotice.includes('weekday DeepSeek peak-price window'), 'notice carries the schedule reason');
ok(peakNotice.includes('native Luna'), 'peak notice names native Luna');
ok(peakNotice.includes('automatic schedule'), 'peak notice names the schedule source');
ok(peakNotice.includes(peakAt.toISOString()), 'notice includes the evaluated instant');
equal(notificationKey(peakRoute), 'peak|luna|schedule', 'notification key is stable');
ok(notificationKey({ ...peakRoute, phase: 'valley' }) !== notificationKey(peakRoute), 'phase changes the key');
ok(notificationKey({ ...peakRoute, source: 'session_override' }) !== notificationKey(peakRoute), 'source changes the key');
const fixedRoute = {
  phase: 'fixed',
  executor: 'luna',
  source: 'fixed',
  reason: 'fixed executor selection; calendar not consulted',
  timezone: 'Asia/Shanghai',
};
const fixedNotice = buildNotification(fixedRoute, peakAt);
ok(fixedNotice.includes('Schedule: fixed'), 'fixed notice names the fixed phase');
ok(fixedNotice.includes('fixed executor selection'), 'fixed notice explains the fixed source');
ok(!fixedNotice.includes('automatic schedule'), 'fixed notice must not claim an automatic schedule');
ok(fixedNotice.includes('calendar not consulted'), 'fixed notice explains that the calendar is unused');
equal(isChildExecutor({ model: 'gpt-6-luna' }), false, 'a Luna model name alone does not identify a child');
equal(isChildExecutor({ model: 'deepseek/deepseek-flash' }), false, 'a DeepSeek model name alone does not identify a child');
equal(isChildExecutor({ model: 'openai/gpt-6.1-sol' }), false, 'Sol model turns are not treated as children');
equal(isChildExecutor({ model: 'gpt-6.1-sol', agent_type: 'subagent' }), true, 'explicit subagent evidence is respected');
equal(isChildExecutor({ model: undefined }), false, 'unknown model evidence is tolerated');

const hookApiProfile = createApiProfile({
  protocol: 'responses', baseUrl: 'https://api.example.invalid/v1', model: 'example-child-model',
  reasoning: { supported: ['none'], default: 'none', parameter: 'none' },
  credential: { type: 'env', name: 'EXAMPLE_API_KEY' },
});
const hookApiSettings = {
  schemaVersion: 1, mode: 'fixed', fixedExecutor: hookApiProfile.profileId,
  profiles: { [hookApiProfile.profileId]: hookApiProfile },
};
equal(isChildExecutor({ model: hookApiProfile.model }, hookApiSettings.profiles), false,
  'configured API model alone does not identify a child');
const apiChildHookDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-api-child-'));
try {
  const result = await handleHook({
    input: inputFor('api-child-session', 'PreToolUse', hookApiProfile.model),
    now: new Date(`2026-10-19T10:30:00${shanghai}`),
    hookStateDir: apiChildHookDir,
    overrideStateDir: isolatedOverrideDir,
    routerSettings: hookApiSettings,
  });
  ok(Boolean(result.output?.hookSpecificOutput.additionalContext), 'a parent using the API model is not silently suppressed');
  equal(result.reason, undefined, 'model name alone does not report child identity');
  equal((await readdir(apiChildHookDir)).filter(name => name.endsWith('.json')).length, 1,
    'the parent receives its own notification state');
} finally {
  await rm(apiChildHookDir, { recursive: true, force: true });
}

// Weekday boundaries: initial notice then only changes.
const boundaryDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-boundary-'));
try {
  const sessionId = 'boundary-chat';
  let result = await callHook({
    sessionId, now: `2026-10-19T08:59:59.999${shanghai}`, hookStateDir: boundaryDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: valley'), 'before-peak valley notice');
  result = await callHook({
    sessionId, now: `2026-10-19T09:00:00.000${shanghai}`, hookStateDir: boundaryDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: peak'), 'peak boundary notice');
  result = await callHook({
    sessionId, now: `2026-10-19T09:30:00.000${shanghai}`, hookStateDir: boundaryDir,
  });
  equal(result.output, null, 'same peak phase must not repeat');
  result = await callHook({
    sessionId, now: `2026-10-19T12:00:00.000${shanghai}`, hookStateDir: boundaryDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: valley'), 'noon valley notice');
  result = await callHook({
    sessionId, now: `2026-10-19T13:59:59.999${shanghai}`, hookStateDir: boundaryDir,
  });
  equal(result.output, null, 'same noon valley must not repeat');
  result = await callHook({
    sessionId, now: `2026-10-19T14:00:00.000${shanghai}`, hookStateDir: boundaryDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: peak'), 'afternoon peak notice');
  result = await callHook({
    sessionId, now: `2026-10-19T18:00:00.000${shanghai}`, hookStateDir: boundaryDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: valley'), 'evening valley notice');

  const preTool = await callHook({
    sessionId: 'boundary-pre', event: 'PreToolUse', now: `2026-10-19T10:30:00${shanghai}`, hookStateDir: boundaryDir,
  });
  equal(preTool.output?.hookSpecificOutput.hookEventName, 'PreToolUse', 'PreToolUse output names its event');
  ok(preTool.output?.hookSpecificOutput.additionalContext.includes('Schedule: peak'), 'PreToolUse gets the current route');
  assert.deepEqual(Object.keys(preTool.output).sort(), ['hookSpecificOutput'], 'output has only the hook-specific envelope');
  checks += 1;
  const preToolAgain = await callHook({
    sessionId: 'boundary-pre', event: 'PreToolUse', now: `2026-10-19T10:31:00${shanghai}`, hookStateDir: boundaryDir,
  });
  equal(preToolAgain.output, null, 'same PreToolUse phase must not repeat');
} finally {
  await rm(boundaryDir, { recursive: true, force: true });
}

// Fixed mode consults no calendar, announces once, and reminds again only when
// the effective fixed profile changes.
const fixedHookDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-fixed-'));
try {
  const fixedA = createApiProfile({
    protocol: 'responses', baseUrl: 'https://api.fixed-a.invalid/v1', model: 'fixed-model-a',
    reasoning: { supported: ['none'], default: 'none', parameter: 'none' },
    credential: { type: 'env', name: 'FIXED_A_API_KEY' },
  });
  const fixedB = createApiProfile({
    protocol: 'responses', baseUrl: 'https://api.fixed-b.invalid/v1', model: 'fixed-model-b',
    reasoning: { supported: ['none'], default: 'none', parameter: 'none' },
    credential: { type: 'env', name: 'FIXED_B_API_KEY' },
  });
  const fixedProfiles = { [fixedA.profileId]: fixedA, [fixedB.profileId]: fixedB };
  const fixedSettings = (profileId) => ({
    schemaVersion: 1, mode: 'fixed', fixedExecutor: profileId, profiles: fixedProfiles,
  });
  const sessionId = 'fixed-profile-chat';
  const at = new Date(`2026-10-19T10:30:00${shanghai}`);
  const scheduledSettings = {
    schemaVersion: 1, mode: 'scheduled',
    schedule: { peak: 'luna', valley: 'deepseek' },
    profiles: fixedProfiles,
  };
  const peakSchedule = await decideRoute({ at, routerSettings: scheduledSettings });
  const valleySchedule = await decideRoute({
    at: new Date(`2026-10-19T13:30:00${shanghai}`),
    routerSettings: scheduledSettings,
  });
  equal(peakSchedule.phase, 'peak', 'the first fixed-mode evaluation coincides with a peak phase');
  equal(valleySchedule.phase, 'valley', 'the second fixed-mode evaluation coincides with a valley phase');

  let result = await handleHook({
    input: inputFor(sessionId),
    now: at,
    hookStateDir: fixedHookDir,
    overrideStateDir: isolatedOverrideDir,
    routerSettings: fixedSettings(fixedA.profileId),
  });
  const firstNotice = result.output?.hookSpecificOutput.additionalContext || '';
  ok(firstNotice.includes('Schedule: fixed'), 'fixed mode initial notice names the fixed schedule');
  ok(firstNotice.includes(fixedA.profileId), 'fixed mode notice names the effective profile');
  ok(!firstNotice.includes('automatic schedule'), 'fixed mode notice never claims an automatic schedule');
  ok(firstNotice.includes('calendar not consulted'), 'fixed mode notice explains the calendar is unused');

  result = await handleHook({
    input: inputFor(sessionId),
    now: new Date(`2026-10-19T13:30:00${shanghai}`),
    hookStateDir: fixedHookDir,
    overrideStateDir: isolatedOverrideDir,
    routerSettings: fixedSettings(fixedA.profileId),
  });
  equal(result.output, null, 'fixed profile stays silent across a peak-to-valley boundary');

  result = await handleHook({
    input: inputFor(sessionId),
    now: at,
    hookStateDir: fixedHookDir,
    overrideStateDir: isolatedOverrideDir,
    routerSettings: fixedSettings(fixedB.profileId),
  });
  const changedNotice = result.output?.hookSpecificOutput.additionalContext || '';
  ok(changedNotice.includes(fixedB.profileId), 'a changed fixed profile is announced');
  ok(!changedNotice.includes('automatic schedule'), 'a changed fixed profile still avoids the automatic wording');

  result = await handleHook({
    input: inputFor(sessionId),
    now: at,
    hookStateDir: fixedHookDir,
    overrideStateDir: isolatedOverrideDir,
    routerSettings: fixedSettings(fixedB.profileId),
  });
  equal(result.output, null, 'the changed fixed profile is announced only once');

  const stored = JSON.parse(await readFile(stateFile(fixedHookDir, sessionId), 'utf8'));
  equal(stored.lastSource, 'fixed', 'fixed notification state records the fixed source');
  equal(stored.lastPhase, 'fixed', 'fixed notification state records the fixed phase');
} finally {
  await rm(fixedHookDir, { recursive: true, force: true });
}

// Weekend, holiday, and unknown-calendar behavior.
const calendarDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-calendar-'));
try {
  let result = await callHook({
    sessionId: 'weekend-chat', now: `2026-10-17T10:00:00${shanghai}`, hookStateDir: calendarDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: valley'), 'weekend valley notice');
  result = await callHook({
    sessionId: 'weekend-chat', now: `2026-10-17T11:00:00${shanghai}`, hookStateDir: calendarDir,
  });
  equal(result.output, null, 'weekend valley stays silent after the first notice');

  result = await callHook({
    sessionId: 'holiday-chat', now: `2026-10-02T10:00:00${shanghai}`, hookStateDir: calendarDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: valley'), 'holiday valley notice');
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Chinese public holiday'), 'holiday reason included');

  result = await callHook({
    sessionId: 'unknown-calendar-chat', now: `2027-10-04T10:00:00${shanghai}`, hookStateDir: calendarDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: unknown'), 'unknown calendar phase notice');
  ok(result.output?.hookSpecificOutput.additionalContext.includes('conservative fallback'), 'unknown calendar fallback explained');
  result = await callHook({
    sessionId: 'unknown-calendar-chat', now: `2027-10-04T12:00:00${shanghai}`, hookStateDir: calendarDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: valley'), 'unknown calendar enters known valley');
} finally {
  await rm(calendarDir, { recursive: true, force: true });
}

// Manual sticky overrides are preserved and their changes are announced once.
const manualDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-manual-'));
const manualHookDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-manual-state-'));
try {
  const sessionId = 'manual-chat';
  const peak = new Date(`2026-10-19T10:30:00${shanghai}`);
  await decideRoute({ at: peak, setSessionExecutor: 'deepseek', sessionId, stateDir: manualDir });
  const overridePath = stateFile(manualDir, sessionId);
  const overrideBefore = await readFile(overridePath, 'utf8');
  let result = await callHook({
    sessionId, now: peak, hookStateDir: manualHookDir, overrideStateDir: manualDir,
  });
  const overrideAfter = await readFile(overridePath, 'utf8');
  equal(overrideAfter, overrideBefore, 'hook does not modify the manual override');
  ok(result.output?.hookSpecificOutput.additionalContext.includes('Schedule: peak'), 'manual override still reports the peak schedule');
  ok(result.output?.hookSpecificOutput.additionalContext.includes('native DeepSeek gateway'), 'manual DeepSeek override is effective');
  ok(result.output?.hookSpecificOutput.additionalContext.includes('sticky chat override'), 'manual override source is explained');

  await decideRoute({ at: peak, setSessionExecutor: 'luna', sessionId, stateDir: manualDir });
  result = await callHook({
    sessionId, now: peak, hookStateDir: manualHookDir, overrideStateDir: manualDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('native Luna'), 'manual Luna override is effective');
  ok(result.output?.hookSpecificOutput.additionalContext.includes('sticky chat override'), 'manual Luna override source is explained');

  await decideRoute({ at: peak, resetSession: true, sessionId, stateDir: manualDir });
  result = await callHook({
    sessionId, now: peak, hookStateDir: manualHookDir, overrideStateDir: manualDir,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('automatic schedule'), 'reset restores the automatic schedule');
  result = await callHook({
    sessionId, now: peak, hookStateDir: manualHookDir, overrideStateDir: manualDir,
  });
  equal(result.output, null, 'unchanged automatic route stays silent');

  // The hook state key and the route.mjs override key are allowed to differ:
  // the CLI prefers an inherited CODEX_THREAD_ID for override lookup while
  // still keeping notification state under the hook session_id.
  const routeKey = 'route-key-only';
  const hookKey = 'hook-session-only';
  await decideRoute({ at: peak, setSessionExecutor: 'deepseek', sessionId: routeKey, stateDir: manualDir });
  result = await callHook({
    sessionId: hookKey, now: peak, hookStateDir: manualHookDir,
    overrideStateDir: manualDir, overrideSessionId: routeKey,
  });
  ok(result.output?.hookSpecificOutput.additionalContext.includes('sticky chat override'), 'override lookup can use a separate chat key');
  const splitState = JSON.parse(await readFile(stateFile(manualHookDir, hookKey), 'utf8'));
  equal(splitState.lastSource, 'session_override', 'hook state is still keyed by the hook session');
} finally {
  await rm(manualDir, { recursive: true, force: true });
  await rm(manualHookDir, { recursive: true, force: true });
}

// Different chats have separate state and cannot suppress each other's notice.
const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-sessions-'));
try {
  const valley = new Date(`2026-10-19T12:00:00${shanghai}`);
  let first = await callHook({ sessionId: 'chat-A', now: valley, hookStateDir: sessionsDir });
  let other = await callHook({ sessionId: 'chat-B', now: valley, hookStateDir: sessionsDir });
  ok(first.output, 'chat A gets its initial notice');
  ok(other.output, 'chat B gets its initial notice');

  first = await callHook({ sessionId: 'chat-A', now: `2026-10-19T14:00:00${shanghai}`, hookStateDir: sessionsDir });
  other = await callHook({ sessionId: 'chat-B', now: valley, hookStateDir: sessionsDir });
  ok(first.output, 'chat A gets its own phase-change notice');
  equal(other.output, null, 'chat B stays silent while its own phase is unchanged');

  const rawA = await readFile(stateFile(sessionsDir, 'chat-A'), 'utf8');
  const rawB = await readFile(stateFile(sessionsDir, 'chat-B'), 'utf8');
  equal(rawA.includes('chat-A'), false, 'chat A raw ID is not persisted');
  equal(rawB.includes('chat-B'), false, 'chat B raw ID is not persisted');
  const stateFiles = (await readdir(sessionsDir)).filter(name => name.endsWith('.json'));
  equal(stateFiles.length, 2, 'each chat has its own durable state file');
} finally {
  await rm(sessionsDir, { recursive: true, force: true });
}

// Explicit child role evidence is ignored and does not create notification state.
const childDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-child-'));
try {
  const result = await handleHook({
    input: {...inputFor('child-luna-session', 'PreToolUse', 'gpt-6-luna'), agent_type: 'native_subagent'},
    now: new Date(`2026-10-19T10:30:00${shanghai}`),
    hookStateDir: childDir,
    overrideStateDir: isolatedOverrideDir,
  });
  equal(result.output, null, 'child Luna turns get no notice');
  equal(result.reason, 'child_executor', 'child Luna turns are identified');
  const childFiles = (await readdir(childDir)).filter(name => name.endsWith('.json'));
  equal(childFiles.length, 0, 'child Luna turns create no state');
} finally {
  await rm(childDir, { recursive: true, force: true });
}

// Corrupt state is recoverable with a single fresh notice.
const corruptDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-corrupt-'));
try {
  const sessionId = 'corrupt-chat';
  await mkdir(corruptDir, { recursive: true });
  await writeFile(stateFile(corruptDir, sessionId), 'not json\n');
  const result = await callHook({
    sessionId, now: `2026-10-19T12:00:00${shanghai}`, hookStateDir: corruptDir,
  });
  ok(result.output, 'corrupt state produces one fresh notice');
  const stored = JSON.parse(await readFile(stateFile(corruptDir, sessionId), 'utf8'));
  equal(stored.version, 1, 'corrupt state is replaced with valid state');
  equal(typeof stored.lastNotifiedKey, 'string', 'recovered state has a notification key');
} finally {
  await rm(corruptDir, { recursive: true, force: true });
}

// A stale lock is reclaimed instead of blocking the hook.
const staleLockDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-lock-'));
try {
  const sessionId = 'stale-lock-chat';
  await mkdir(staleLockDir, { recursive: true });
  const lockPath = `${stateFile(staleLockDir, sessionId)}.lock`;
  await writeFile(lockPath, 'stale\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const result = await callHook({
    sessionId, now: `2026-10-19T12:00:00${shanghai}`, hookStateDir: staleLockDir,
  });
  ok(result.output, 'stale lock does not suppress the notice');
  await rejects(stat(lockPath), { code: 'ENOENT' }, 'stale lock is removed');
} finally {
  await rm(staleLockDir, { recursive: true, force: true });
}

// Hook registration points at the new runner for both events. The command
// must resolve from the plugin root, not the user's workspace, and must quote
// the path because installed plugin roots can contain spaces.
const hookCommand = 'node "${PLUGIN_ROOT}/scripts/route-hook.mjs"';
const config = JSON.parse(readFileSync(path.join(repoRoot, 'hooks', 'hooks.json'), 'utf8'));
equal(config.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command, hookCommand, 'UserPromptSubmit uses the quoted plugin-root command');
equal(config.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command, hookCommand, 'PreToolUse uses the quoted plugin-root command');
equal(config.hooks.PreToolUse[0].matcher, '*', 'PreToolUse covers every tool');
equal(config.hooks.UserPromptSubmit[0].hooks[0].timeout, 10, 'hook timeout is bounded');
equal(config.hooks.PreToolUse[0].hooks[0].additionalContextLimit, 2000, 'hook context is bounded');

// The command must work from the plugin root rather than the user's workspace,
// including a plugin path with spaces. Copy the route runtime dependency set
// into a temporary plugin-shaped tree and launch from an unrelated directory.
const spaceRoot = await mkdtemp(path.join(os.tmpdir(), 'route-hook-space-'));
try {
  const pluginRoot = path.join(spaceRoot, 'plugin root with spaces');
  const unrelated = path.join(spaceRoot, 'unrelated cwd');
  const pluginScripts = path.join(pluginRoot, 'scripts');
  await mkdir(pluginScripts, { recursive: true });
  await mkdir(unrelated, { recursive: true });
  await cp(path.join(repoRoot, 'scripts', 'route-hook.mjs'), path.join(pluginScripts, 'route-hook.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'route.mjs'), path.join(pluginScripts, 'route.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'native-model-catalog.mjs'), path.join(pluginScripts, 'native-model-catalog.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'native-current-model.mjs'), path.join(pluginScripts, 'native-current-model.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'native-upgrade-status.mjs'), path.join(pluginScripts, 'native-upgrade-status.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'native-api-settings.mjs'), path.join(pluginScripts, 'native-api-settings.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'native-state.mjs'), path.join(pluginScripts, 'native-state.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'native-credentials.mjs'), path.join(pluginScripts, 'native-credentials.mjs'));
  await cp(path.join(repoRoot, 'scripts', 'plugin-state.mjs'), path.join(pluginScripts, 'plugin-state.mjs'));
  const stateDir = path.join(spaceRoot, 'hook state');
  const overrideDir = path.join(spaceRoot, 'override state');
  const now = `2026-10-19T12:00:00${shanghai}`;
  let result = await runHookProcess({
    input: inputFor('space-chat'), stateDir, overrideStateDir: overrideDir, now,
    scriptPath: path.join(pluginScripts, 'route-hook.mjs'), cwd: unrelated,
  });
  equal(result.status, 0, 'copied plugin hook exits zero from an unrelated cwd');
  ok(result.stdout.includes('Schedule: valley'), 'copied plugin hook resolves route.mjs beside itself');
  result = await runHookProcess({
    input: inputFor('space-chat'), stateDir, overrideStateDir: overrideDir, now,
    scriptPath: path.join(pluginScripts, 'route-hook.mjs'), cwd: unrelated,
  });
  equal(result.stdout, '', 'copied plugin hook dedups from an unrelated cwd');

  const shellInput = inputFor('shell-space-chat');
  let shell = await runHookThroughShell({
    input: shellInput, pluginRoot, cwd: unrelated, stateDir, overrideStateDir: overrideDir, now,
    commandTemplate: hookCommand,
  });
  equal(shell.status, 0, 'quoted shell command exits zero from an unrelated cwd');
  ok(shell.stdout.includes('Schedule: valley'), 'quoted shell command reaches the hook');
  shell = await runHookThroughShell({
    input: shellInput, pluginRoot, cwd: unrelated, stateDir, overrideStateDir: overrideDir, now,
    commandTemplate: hookCommand,
  });
  equal(shell.stdout, '', 'quoted shell command dedups across invocations');
  const stateFiles = (await readdir(stateDir)).filter(name => name.endsWith('.json'));
  equal(stateFiles.length, 2, 'each copied-plugin session keeps its own state file');
} finally {
  await rm(spaceRoot, { recursive: true, force: true });
}

// Real CLI process, stdin path, and duplicate suppression across processes.
const cliDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-cli-state-'));
try {
  const sessionId = 'cli-chat';
  const input = { ...inputFor(sessionId), prompt: '检查峰谷状态：中文提示' };
  let result = await runHookProcess({
    input, stateDir: cliDir, now: `2026-10-19T12:00:00${shanghai}`, stdin: true,
  });
  equal(result.status, 0, 'stdin hook exits zero');
  equal(result.stderr, '', 'stdin hook keeps stderr quiet');
  const parsed = JSON.parse(result.stdout.trim());
  equal(result.stdout.trim().split(/\r?\n/).length, 1, 'CLI output is exactly one JSON line');
  assert.deepEqual(Object.keys(parsed).sort(), ['hookSpecificOutput'], 'CLI output has only the hook envelope');
  checks += 1;
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName'], 'CLI hook envelope has the documented fields');
  checks += 1;
  equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit', 'CLI output names the event');
  ok(parsed.hookSpecificOutput.additionalContext.includes('Schedule: valley'), 'CLI output carries the route');

  result = await runHookProcess({
    input, stateDir: cliDir, now: `2026-10-19T12:00:00${shanghai}`, stdin: true,
  });
  equal(result.status, 0, 'duplicate stdin hook exits zero');
  equal(result.stdout, '', 'duplicate stdin hook is silent');
} finally {
  await rm(cliDir, { recursive: true, force: true });
}

// The CLI prefers an inherited CODEX_THREAD_ID for manual override lookup
// while keeping notification state under the hook session_id.
const envOverrideDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-env-override-'));
const envHookDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-env-hook-'));
try {
  const routeKey = 'env-route-key';
  const hookKey = 'env-hook-session';
  const at = new Date(`2026-10-19T10:30:00${shanghai}`);
  await decideRoute({ at, setSessionExecutor: 'deepseek', sessionId: routeKey, stateDir: envOverrideDir });
  const result = await runHookProcess({
    input: inputFor(hookKey),
    stateDir: envHookDir,
    overrideStateDir: envOverrideDir,
    now: `2026-10-19T10:30:00${shanghai}`,
    omitOverrideSession: true,
    env: { CODEX_THREAD_ID: routeKey },
  });
  equal(result.status, 0, 'env override hook exits zero');
  const parsed = JSON.parse(result.stdout.trim());
  ok(parsed.hookSpecificOutput.additionalContext.includes('sticky chat override'), 'CLI uses inherited CODEX_THREAD_ID for override lookup');
  const stored = JSON.parse(await readFile(stateFile(envHookDir, hookKey), 'utf8'));
  equal(stored.lastSource, 'session_override', 'env override is reflected in the route');
} finally {
  await rm(envOverrideDir, { recursive: true, force: true });
  await rm(envHookDir, { recursive: true, force: true });
}

// Concurrent hook processes emit exactly one notice for the same chat.
const raceDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-race-'));
try {
  const input = inputFor('race-chat');
  const results = await Promise.all(Array.from({ length: 10 }, () => runHookProcess({
    input, stateDir: raceDir, now: `2026-10-19T12:00:00${shanghai}`,
  })));
  const emitted = results.filter(result => result.stdout.trim());
  equal(emitted.length, 1, 'concurrent hooks emit exactly one notice');
  const parsed = JSON.parse(emitted[0].stdout.trim());
  equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit', 'winning concurrent output is valid');
  const leftovers = (await readdir(raceDir)).filter(name => !name.endsWith('.json'));
  assert.deepEqual(leftovers, [], 'concurrent hooks leave no lock or temp files');
  checks += 1;
  const stored = JSON.parse(await readFile(stateFile(raceDir, 'race-chat'), 'utf8'));
  equal(stored.lastPhase, 'valley', 'concurrent hooks persist the winning route');
} finally {
  await rm(raceDir, { recursive: true, force: true });
}

// Bad input and unavailable state must fail open, not block the turn.
const failOpenDir = await mkdtemp(path.join(os.tmpdir(), 'route-hook-fail-open-'));
try {
  let result = await runHookProcess({
    raw: '{not json', stateDir: failOpenDir, now: `2026-10-19T12:00:00${shanghai}`,
  });
  equal(result.status, 0, 'malformed stdin exits zero');
  equal(result.stdout, '', 'malformed stdin produces no context');
  equal(result.stderr, '', 'malformed stdin stays quiet');

  result = await runHookProcess({
    input: { hook_event_name: 'UserPromptSubmit', model: 'gpt-6.1-sol' },
    stateDir: failOpenDir,
    now: `2026-10-19T12:00:00${shanghai}`,
  });
  equal(result.status, 0, 'missing session exits zero');
  equal(result.stdout, '', 'missing session produces no context');
  equal(result.stderr, '', 'missing session stays quiet');

  result = await runHookProcess({
    input: inputFor('unsupported-chat', 'SessionStart'),
    stateDir: failOpenDir,
    now: `2026-10-19T12:00:00${shanghai}`,
  });
  equal(result.status, 0, 'unsupported event exits zero');
  equal(result.stdout, '', 'unsupported event produces no context');
  equal(result.stderr, '', 'unsupported event stays quiet');

  const notADirectory = path.join(failOpenDir, 'not-a-directory');
  await writeFile(notADirectory, 'x');
  result = await runHookProcess({
    input: inputFor('unavailable-state'),
    stateDir: notADirectory,
    now: `2026-10-19T12:00:00${shanghai}`,
  });
  equal(result.status, 0, 'unavailable state exits zero');
  equal(result.stdout, '', 'unavailable state produces no context');
  equal(result.stderr, '', 'unavailable state stays quiet');
} finally {
  await rm(failOpenDir, { recursive: true, force: true });
}

await rm(isolatedOverrideDir, { recursive: true, force: true });
console.log(`PASS ${checks} route-hook assertions`);
