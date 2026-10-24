import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "./plugin-state.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY_SCRIPT = path.join(REPO_ROOT, "scripts", "native-gateway.mjs");
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 8_000;

export function gatewayPaths(explicitDir) {
  const base = explicitDir || process.env.SOL_LUNA_NATIVE_GATEWAY_DIR
    || (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "sol-luna-deepseek-router", "native-gateway")
      : path.join(os.homedir(), ".local", "state", "sol-luna-deepseek-router", "native-gateway"));
  return {
    dir: path.resolve(base),
    state: path.join(path.resolve(base), "gateway.json"),
    identity: path.join(path.resolve(base), "identity.json"),
    log: path.join(path.resolve(base), "gateway.log"),
    lock: path.join(path.resolve(base), "gateway.start.lock"),
  };
}

export function gatewaySpawnOptions(env = process.env) {
  return { cwd: REPO_ROOT, detached: true, windowsHide: true, stdio: "ignore", env: { ...env } };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

export async function readGatewayState(paths = gatewayPaths()) {
  return readJson(paths.state);
}

export async function readGatewayIdentity(paths = gatewayPaths()) {
  return readJson(paths.identity);
}

async function writeJsonPrivate(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await import("node:fs/promises").then(({ rename }) => rename(temp, file));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function gatewayHealth(state, timeoutMs = 2_000) {
  if (!state?.port || !state?.token) return { reachable: false, pid: null, deepseek_only: null, api_only: null, relay_allowed: null };
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/${state.token}/_health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, pid: null };
    const health = await response.json();
    return {
      reachable: health?.ok === true,
      pid: Number.isInteger(health?.pid) && health.pid > 0 ? health.pid : null,
      deepseek_only: health?.deepseek_only === true ? true : health?.deepseek_only === false ? false : null,
      api_only: health?.api_only === true ? true : health?.api_only === false ? false : null,
      relay_allowed: health?.relay_allowed === true ? true : health?.relay_allowed === false ? false : null,
    };
  } catch {
    return { reachable: false, pid: null, deepseek_only: null, api_only: null, relay_allowed: null };
  }
}

function pidStatus(state, health) {
  if (!health.reachable) return "unreachable";
  if (health.pid === null) return "unverified";
  return health.pid === state.pid ? "match" : "mismatch";
}

function assertGatewayIdentity(state, health) {
  const status = pidStatus(state, health);
  if (status === "match") return;
  throw new Error(`Native gateway health identity is ${status}; refusing to start or control another instance.`);
}

async function waitForHealth(paths, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const state = await readGatewayState(paths);
    if (state) {
      const health = await gatewayHealth(state);
      if (pidStatus(state, health) === "match") return state;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Native gateway did not become healthy; inspect ${paths.log} and ${paths.state}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function prepareGatewayIdentityUnlocked(paths) {
  const current = await readGatewayState(paths);
  if (current) {
    const health = await gatewayHealth(current);
    if (pidStatus(current, health) === "match") {
      let identity = await readGatewayIdentity(paths);
      if (!identity?.token && current.token && Number.isInteger(current.port)) {
        identity = { version: 1, token: current.token, port: current.port, created_at: current.started_at || new Date().toISOString() };
        await writeJsonPrivate(paths.identity, identity);
      }
      if (!identity?.token || identity.token !== current.token || identity.port !== current.port) {
        throw new Error("healthy native gateway does not match its private identity file");
      }
      return { identity, existing: current };
    }
    if (health.reachable) assertGatewayIdentity(current, health);
    if (isAlive(current.pid)) {
      throw new Error(`Native gateway state exists for a live PID ${current.pid} but health failed; refusing to replace its identity. Inspect ${paths.log}.`);
    }
    rmSync(paths.state, { force: true });
  }

  let identity = await readGatewayIdentity(paths);
  if (!identity?.token || !Number.isInteger(identity?.port) || identity.port < 1 || identity.port > 65535) {
    identity = {
      version: 1,
      token: randomBytes(32).toString("base64url"),
      port: await freePort(),
      created_at: new Date().toISOString(),
    };
    await writeJsonPrivate(paths.identity, identity);
  }
  return { identity, existing: null };
}

export async function prepareGatewayIdentity({ paths = gatewayPaths() } = {}) {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const result = await withFileLock(paths.lock, () => prepareGatewayIdentityUnlocked(paths), { timeoutMs: 30_000 });
  return result.identity;
}

export async function ensureGateway({ paths = gatewayPaths(), spawnImpl = spawn, launchImpl, startTimeoutMs = START_TIMEOUT_MS } = {}) {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const existing = await readGatewayState(paths);
  if (existing) {
    const health = await gatewayHealth(existing);
    if (pidStatus(existing, health) === "match") return { state: existing, started: false };
    if (health.reachable) assertGatewayIdentity(existing, health);
  }

  return withFileLock(paths.lock, async () => {
    const { identity, existing } = await prepareGatewayIdentityUnlocked(paths);
    if (existing) return { state: existing, started: false };
    let child = null;
    if (launchImpl) {
      await launchImpl({ paths, identity });
    } else {
      child = spawnImpl(process.execPath, [
        GATEWAY_SCRIPT, "--serve", "--state", paths.state, "--identity", paths.identity, "--log", paths.log,
      ], gatewaySpawnOptions());
      child.unref();
    }
    const state = await waitForHealth(paths, startTimeoutMs);
    return { state, started: true, pid: state.pid, childPid: child?.pid ?? null };
  }, { timeoutMs: 30_000 });
}

export async function stopGateway({ paths = gatewayPaths() } = {}) {
  const state = await readGatewayState(paths);
  if (!state) return { stopped: false, reason: "not_running" };
  const health = await gatewayHealth(state);
  const status = pidStatus(state, health);
  if (status === "mismatch") return { stopped: false, reason: "pid_mismatch", state_pid: state.pid, live_pid: health.pid };
  if (status === "unverified") return { stopped: false, reason: "pid_unverified", state_pid: state.pid };
  if (status === "unreachable" && !isAlive(state.pid)) {
    rmSync(paths.state, { force: true });
    return { stopped: false, reason: "stale_state_removed" };
  }
  if (status === "unreachable") return { stopped: false, reason: "health_unreachable", state_pid: state.pid };
  const response = await fetch(`http://127.0.0.1:${state.port}/${state.token}/_shutdown`, {
    method: "POST",
    headers: { "x-sol-luna-token": state.token },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Native gateway shutdown was rejected with HTTP ${response.status}`);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const currentHealth = await gatewayHealth(state);
    if (pidStatus(state, currentHealth) !== "match") {
      const current = await readGatewayState(paths);
      if (current?.token === state.token && current?.pid === state.pid) rmSync(paths.state, { force: true });
      return { stopped: true, pid: state.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Native gateway PID ${state.pid} did not stop; it was not force-killed.`);
}

export async function gatewayStatus({ paths = gatewayPaths() } = {}) {
  const state = await readGatewayState(paths);
  if (!state) return { running: false, state: null };
  const health = await gatewayHealth(state);
  const status = pidStatus(state, health);
  return {
    running: status === "match",
    pid: status === "match" ? health.pid : null,
    state_pid: state.pid,
    live_pid: health.pid,
    pid_status: status,
    port: state.port,
    model: state.model || null,
    started_at: state.started_at || null,
    log: state.log || paths.log,
  };
}

async function main(argv) {
  const command = argv[0] || "status";
  const json = argv.includes("--json");
  const dirAt = argv.indexOf("--dir");
  const paths = gatewayPaths(dirAt >= 0 ? argv[dirAt + 1] : undefined);
  if (command === "start" || command === "ensure") {
    const result = await ensureGateway({ paths });
    process.stdout.write(json ? `${JSON.stringify({ started: result.started, pid: result.state.pid, port: result.state.port, model: result.state.model })}\n` : `native gateway ${result.started ? "started" : "already running"}\n`);
    return;
  }
  if (command === "stop") {
    const result = await stopGateway({ paths });
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `native gateway ${result.stopped ? "stopped" : result.reason}\n`);
    return;
  }
  if (command === "status") {
    const result = await gatewayStatus({ paths });
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `native gateway ${result.running ? "healthy" : "not running"}\n`);
    return;
  }
  throw new Error("usage: native-gateway-manager.mjs <start|ensure|stop|status> [--dir PATH] [--json]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
