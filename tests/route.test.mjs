import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRoute } from '../scripts/route.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = path.join(repoRoot, 'scripts', 'route.mjs');
const shanghai = '+08:00';
const priorCodexHome = process.env.CODEX_HOME;
const priorLocalAppData = process.env.LOCALAPPDATA;
process.env.CODEX_HOME = path.join(os.tmpdir(), `route-test-codex-home-${process.pid}`);
process.env.LOCALAPPDATA = path.join(os.tmpdir(), `route-test-local-${process.pid}`);
process.on('exit', () => {
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodexHome;
  if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = priorLocalAppData;
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

function runCli(args, { env = process.env } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-cli-'));
  const stdoutPath = path.join(dir, 'stdout');
  const stderrPath = path.join(dir, 'stderr');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  let result;
  try {
    // File-backed stdio avoids the child-process pipe denial in confined
    // sandboxes while still exercising the real CLI entry point.
    result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot, env, stdio: ['ignore', stdoutFd, stderrFd], windowsHide: true,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutPath, 'utf8');
  const stderr = readFileSync(stderrPath, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.error, undefined, `CLI spawn failed: ${result.error?.message}`);
  return { status: result.status, signal: result.signal, stdout, stderr };
}

function cliJson(args, options) {
  const result = runCli([...args, '--json'], options);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, '--json must print exactly one JSON line');
  checks += 1;
  return JSON.parse(lines[0]);
}

function stateFile(stateDir, sessionId) {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return path.join(stateDir, `${digest}.json`);
}

const boundaries = [
  ['08:59:59.999 before the morning peak', '08:59:59.999', 'deepseek', 'valley'],
  ['09:00:00.000 morning peak start', '09:00:00.000', 'luna', 'peak'],
  ['11:59:59.999 morning peak end', '11:59:59.999', 'luna', 'peak'],
  ['12:00:00.000 noon valley start', '12:00:00.000', 'deepseek', 'valley'],
  ['13:59:59.999 before the afternoon peak', '13:59:59.999', 'deepseek', 'valley'],
  ['14:00:00.000 afternoon peak start', '14:00:00.000', 'luna', 'peak'],
  ['17:59:59.999 afternoon peak end', '17:59:59.999', 'luna', 'peak'],
  ['18:00:00.000 evening valley start', '18:00:00.000', 'deepseek', 'valley'],
];

for (const [name, time, executor, phase] of boundaries) {
  const result = await decideRoute({ at: `2026-10-19T${time}${shanghai}` });
  equal(result.executor, executor, name);
  equal(result.phase, phase, `${name} phase`);
  equal(result.native_spawn.fork_turns, 'none', `${name} native child has no inherited turns`);
  if (executor === 'deepseek') {
    equal(result.native_spawn.agent_type, 'native_deepseek', `${name} selects the isolated DeepSeek role`);
    equal(result.native_spawn.model, undefined, `${name} omits explicit DeepSeek model override`);
    equal(Object.hasOwn(result.native_spawn, 'model'), false, `${name} has no model property to forward`);
    equal(result.native_spawn.resolved_model, 'deepseek/deepseek-flash', `${name} identifies the fixed role model informationally`);
  } else {
    equal(result.native_spawn.agent_type, undefined, `${name} leaves Luna on native catalog resolution`);
    equal(result.native_spawn.model, undefined, `${name} does not freeze a Luna model in the route result`);
  }
  equal(result.timezone, 'Asia/Shanghai', `${name} timezone`);
  equal(result.calendarVersion, 'china-public-holidays-2026', `${name} calendar version`);
}

for (let index = 0; index < 7; index += 1) {
  const date = `2026-10-${String(19 + index).padStart(2, '0')}`;
  const result = await decideRoute({ at: `${date}T10:00:00${shanghai}` });
  const expected = index < 5 ? 'luna' : 'deepseek';
  equal(result.executor, expected, `${date} must follow the weekday/weekend schedule`);
}

const holidays = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

for (const [start, end] of holidays) {
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    for (const time of ['09:00:00.000', '10:00:00.000', '17:59:59.999']) {
      const result = await decideRoute({ at: `${date}T${time}${shanghai}` });
      equal(result.executor, 'deepseek', `${date} holiday ${time} must be valley`);
      equal(result.phase, 'valley', `${date} holiday ${time} phase`);
      equal(result.source, 'schedule', `${date} holiday ${time} source`);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

for (const date of ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']) {
  const result = await decideRoute({ at: `${date}T10:00:00${shanghai}` });
  equal(result.executor, 'deepseek', `${date} make-up workday must remain weekend valley`);
  equal(result.phase, 'valley', `${date} make-up workday phase`);
}

const equivalentInstants = [
  '2026-10-19T09:00:00.000+08:00',
  '2026-10-19T01:00:00.000Z',
  '2026-10-18T21:00:00.000-04:00',
  '2026-10-19T06:30:00.000+05:30',
];
const equivalentResults = await Promise.all(equivalentInstants.map(at => decideRoute({ at })));
for (const result of equivalentResults) equal(result.executor, 'luna', 'equivalent instants must agree');
equal(new Set(equivalentResults.map(result => result.evaluatedAt)).size, 1, 'equivalent instants evaluate identically');

const utcCli = cliJson(['--at', '2026-10-19T09:00:00.000+08:00'], { env: { ...process.env, TZ: 'UTC' } });
const pacificCli = cliJson(['--at', '2026-10-19T09:00:00.000+08:00'], { env: { ...process.env, TZ: 'America/Los_Angeles' } });
equal(utcCli.executor, 'luna', 'TZ=UTC must not change the route');
equal(pacificCli.executor, 'luna', 'TZ=America/Los_Angeles must not change the route');
assert.deepEqual(utcCli, pacificCli);
checks += 1;

for (const [date, expected, phase, source] of [
  ['2027-10-04', 'luna', 'unknown', 'calendar_missing'],
  ['2027-10-05', 'luna', 'unknown', 'calendar_missing'],
  ['2027-10-06', 'luna', 'unknown', 'calendar_missing'],
  ['2027-10-07', 'luna', 'unknown', 'calendar_missing'],
  ['2027-10-08', 'luna', 'unknown', 'calendar_missing'],
  ['2027-10-09', 'deepseek', 'valley', 'schedule'],
  ['2027-10-10', 'deepseek', 'valley', 'schedule'],
]) {
  const result = await decideRoute({ at: `${date}T10:00:00${shanghai}` });
  equal(result.executor, expected, `${date} unknown-year route`);
  equal(result.phase, phase, `${date} unknown-year phase`);
  equal(result.source, source, `${date} unknown-year source`);
  equal(result.calendarVersion, 'missing', `${date} unknown-year calendar version`);
}

for (const [at, expected] of [
  ['2025-12-31T10:00:00+08:00', 'luna'],
  ['2027-01-01T10:00:00+08:00', 'luna'],
  ['2027-10-04T11:59:59.999+08:00', 'luna'],
  ['2027-10-04T12:00:00.000+08:00', 'deepseek'],
  ['2028-02-29T10:00:00+08:00', 'luna'],
  ['2026-12-31T10:00:00+08:00', 'luna'],
]) {
  equal((await decideRoute({ at })).executor, expected, `${at} cross-year/leap route`);
}

const stateDir = await mkdtemp(path.join(os.tmpdir(), 'router-state-'));
try {
  const sessionId = 'chat-A';
  const file = stateFile(stateDir, sessionId);
  const configured = await decideRoute({
    at: `2026-10-19T10:30:00${shanghai}`, setSessionExecutor: 'deepseek', sessionId, stateDir,
  });
  equal(configured.executor, 'deepseek', 'session override applies immediately');
  equal(configured.source, 'session_override', 'session override source');

  const raw = await readFile(file, 'utf8');
  equal(raw.includes(sessionId), false, 'raw session ID must not be persisted');
  const stored = JSON.parse(raw);
  assert.deepEqual(Object.keys(stored).sort(), ['executor', 'updatedAt']);
  checks += 1;
  equal(stored.executor, 'deepseek', 'stored executor');
  equal(Number.isFinite(Date.parse(stored.updatedAt)), true, 'stored timestamp must be valid');

  const sticky = await decideRoute({ at: `2026-10-19T10:30:00${shanghai}`, sessionId, stateDir });
  equal(sticky.executor, 'deepseek', 'session override remains sticky');
  equal(sticky.source, 'session_override', 'sticky source');

  const onceWithoutSession = await decideRoute({
    at: `2026-10-19T10:30:00${shanghai}`, executor: 'deepseek',
  });
  equal(onceWithoutSession.executor, 'deepseek', 'a one-time override does not require a session');
  equal(onceWithoutSession.source, 'one_time_override', 'one-time overrides work without persisted state');

  const once = await decideRoute({
    at: `2026-10-19T10:30:00${shanghai}`, executor: 'luna', sessionId, stateDir,
  });
  equal(once.executor, 'luna', 'one-time explicit override outranks sticky setting');
  equal(once.source, 'one_time_override', 'one-time source');
  equal((await decideRoute({ at: `2026-10-19T10:30:00${shanghai}`, sessionId, stateDir })).executor,
    'deepseek', 'one-time override must not rewrite sticky state');

  const otherChat = await decideRoute({ at: `2026-10-19T10:30:00${shanghai}`, sessionId: 'chat-B', stateDir });
  equal(otherChat.executor, 'luna', 'session overrides must not leak across chats');
  equal(otherChat.source, 'schedule', 'other chat uses the automatic schedule');

  const reset = await decideRoute({
    at: `2026-10-19T10:30:00${shanghai}`, resetSession: true, sessionId, stateDir,
  });
  equal(reset.executor, 'luna', 'reset restores automatic schedule');
  equal(reset.source, 'schedule', 'reset source');
  await rejects(readFile(file), { code: 'ENOENT' }, 'reset must delete the state file');

  await decideRoute({ at: `2026-10-19T10:30:00${shanghai}`, setSessionExecutor: 'deepseek', sessionId, stateDir });
  const auto = await decideRoute({
    at: `2026-10-19T10:30:00${shanghai}`, setSessionExecutor: 'auto', sessionId, stateDir,
  });
  equal(auto.executor, 'luna', 'auto clears the override and restores the schedule');
  equal(auto.source, 'schedule', 'auto source');
  await rejects(readFile(file), { code: 'ENOENT' }, 'auto must delete the state file');

  for (const body of ['not json\n', '{"executor":"unexpected"}\n', 'null\n', '[]\n']) {
    await writeFile(file, body);
    await rejects(
      decideRoute({ at: `2026-10-19T12:00:00${shanghai}`, sessionId, stateDir }),
      /refusing automatic routing/,
      `corrupt state ${JSON.stringify(body)} must fail closed`,
    );
  }
  await rm(file, { force: true });
  const missing = await decideRoute({ at: `2026-10-19T10:30:00${shanghai}`, sessionId, stateDir });
  equal(missing.source, 'schedule', 'missing state file falls back to the schedule');

  for (const [options, pattern] of [
    [{ executor: 'other', at: `2026-10-19T10:30:00${shanghai}` }, /configured API profile/],
    [{ setSessionExecutor: 'other', sessionId, stateDir }, /--set-session-executor must be luna, deepseek, auto, or a configured API profile/],
    [{ setSessionExecutor: 'luna' }, /--session is required to save a session override/],
    [{ resetSession: true }, /--session is required to reset a session override/],
    [{ resetSession: true, setSessionExecutor: 'luna', sessionId, stateDir }, /Choose either/],
    [{ sessionId: '   ', stateDir }, /--session must be a non-empty chat ID/],
    [{ at: '2026-10-19T10:30:00' }, /explicit UTC offset/],
    [{ at: '2026-13-01T10:30:00Z' }, /Invalid --at date/],
    [{ at: new Date('invalid') }, /Invalid --at date/],
  ]) {
    await rejects(decideRoute(options), pattern, 'invalid option combination must fail');
  }
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

const raceDir = await mkdtemp(path.join(os.tmpdir(), 'router-race-'));
try {
  for (const count of [100, 24]) {
    const sessionId = `race-${count}`;
    const jobs = Array.from({ length: count }, (_, index) => decideRoute({
      at: `2026-10-19T10:30:00${shanghai}`,
      setSessionExecutor: index % 2 === 0 ? 'deepseek' : 'luna',
      sessionId,
      stateDir: raceDir,
    }));
    const settled = await Promise.allSettled(jobs);
    const rejected = settled.filter(result => result.status === 'rejected');
    assert.equal(rejected.length, 0,
      `concurrent writes must all settle: ${rejected.map(result => result.reason?.code || result.reason?.message).join(', ')}`);
    checks += 1;

    const leftovers = (await readdir(raceDir)).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'concurrent writes must not leave temporary files');
    checks += 1;

    const final = await decideRoute({ at: `2026-10-19T10:30:00${shanghai}`, sessionId, stateDir: raceDir });
    ok(['luna', 'deepseek'].includes(final.executor), 'concurrent writes must leave a valid winner');
    equal(final.source, 'session_override', 'concurrent writes must leave a readable override');
  }
} finally {
  await rm(raceDir, { recursive: true, force: true });
}

for (const [args, pattern] of [
  [['--session', '--json'], /missing value/],
  [['--session', '', '--json'], /missing value/],
  [['--at', '', '--json'], /missing value/],
  [['--executor', 'other', '--json'], /configured API profile/],
  [['--set-session-executor', 'auto', '--json'], /--session is required/],
  [['--at', '2026-10-19T10:30:00', '--json'], /explicit UTC offset/],
  [['--unknown', 'value', '--json'], /Unknown option/],
  [['--reset-session', '--set-session-executor', 'luna', '--session', 'x', '--json'], /Choose either/],
]) {
  const result = runCli(args);
  equal(result.status, 2, `${args.join(' ')} must exit 2`);
  assert.match(result.stderr, pattern);
  checks += 1;
  equal(result.stdout, '', `${args.join(' ')} must not print a result`);
}

const help = runCli(['--help']);
equal(help.status, 0, '--help exits successfully');
assert.match(help.stdout, /Usage: node scripts\/route\.mjs/);
checks += 1;

const cliState = await mkdtemp(path.join(os.tmpdir(), 'router-cli-state-'));
try {
  const sessionId = 'cli-chat';
  const base = ['--session', sessionId, '--state-dir', cliState, '--at', `2026-10-19T10:30:00${shanghai}`];
  const stored = cliJson([...base, '--set-session-executor', 'deepseek']);
  equal(stored.executor, 'deepseek', 'CLI set applies immediately');
  equal(stored.source, 'session_override', 'CLI set source');
  equal(cliJson(base).executor, 'deepseek', 'CLI state persists across processes');
  equal(cliJson([...base, '--reset-session']).source, 'schedule', 'CLI reset restores the schedule');
  equal(cliJson(base).executor, 'luna', 'CLI reset persists across processes');
} finally {
  await rm(cliState, { recursive: true, force: true });
}

const corruptCliDir = await mkdtemp(path.join(os.tmpdir(), 'router-cli-corrupt-'));
try {
  const sessionId = 'broken';
  await mkdir(corruptCliDir, { recursive: true });
  await writeFile(stateFile(corruptCliDir, sessionId), '{"executor":"unexpected"}\n');
  const result = runCli(['--session', sessionId, '--state-dir', corruptCliDir, '--json']);
  equal(result.status, 2, 'corrupt CLI state must exit 2');
  assert.match(result.stderr, /refusing automatic routing/);
  checks += 1;
} finally {
  await rm(corruptCliDir, { recursive: true, force: true });
}

console.log(`PASS ${checks} route assertions`);
