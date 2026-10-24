import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import net from "node:net";

function terminateWindowsProcessTree(pid, timeoutMs) {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    shell: false,
    stdio: "ignore",
    timeout: Math.max(1, timeoutMs),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error("taskkill.exe did not confirm process-tree termination"), {
      code: "APP_SERVER_TREE_TERMINATION_FAILED",
    });
  }
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

function waitForPort(port, timeoutMs = 20_000, signal) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let timer;
    let socket;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket?.destroy();
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("app-server startup aborted"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const attempt = () => {
      if (signal?.aborted) return;
      socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { cleanup(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          cleanup();
          reject(new Error("app-server websocket did not open"));
        } else timer = setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function isolatedChildEnvironment(codexHome, envOverrides) {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (
      name === "CODEX_HOME"
      || name.startsWith("OPENAI_")
      || name.startsWith("DEEPSEEK_")
      || /API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BASE_URL|PROXY/i.test(name)
    ) continue;
    env[name] = process.env[name];
  }
  env.CODEX_HOME = codexHome;
  for (const [name, value] of Object.entries(envOverrides)) env[name] = String(value);
  return env;
}

export class AppServer {
  constructor({ exe, codexHome, cwd, eventLog, envOverrides = {}, spawnProcess = spawn, terminateProcessTree = terminateWindowsProcessTree }) {
    this.exe = exe;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.eventLog = eventLog;
    this.envOverrides = envOverrides;
    this.spawnProcess = spawnProcess;
    this.terminateProcessTree = terminateProcessTree;
    this.child = null;
    this.spawnError = null;
    this.liveOwnedProcess = false;
    this.ws = null;
    this.port = null;
    this.exitObserved = false;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = new Set();
  }

  async start() {
    this.port = await freePort();
    const startupAbort = new AbortController();
    try {
      this.child = this.spawnProcess(
        this.exe,
        ["app-server", "--listen", `ws://127.0.0.1:${this.port}`],
        {
          cwd: this.cwd,
          env: { ...isolatedChildEnvironment(this.codexHome, this.envOverrides), RUST_LOG: "error" },
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch (error) {
      this.spawnError = error;
      this.exitObserved = true;
      throw Object.assign(new Error("app-server process could not be spawned"), { code: "APP_SERVER_SPAWN_ERROR" });
    }
    this.liveOwnedProcess = this.child.pid !== undefined && this.child.pid !== null;
    this.child.on("error", (error) => {
      this.spawnError = error;
      if (this.child?.pid === undefined || this.child?.pid === null) {
        this.liveOwnedProcess = false;
        this.exitObserved = true;
        startupAbort.abort(Object.assign(new Error("app-server process could not be spawned"), { code: "APP_SERVER_SPAWN_ERROR" }));
      }
    });
    this.child.on("exit", (code, signal) => {
      this.exitObserved = true;
      this.liveOwnedProcess = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(Object.assign(new Error(`app-server exited (${code ?? signal})`), { code: "APP_SERVER_EXIT" }));
      }
      this.pending.clear();
      for (const waiter of this.waiters) waiter.reject(Object.assign(new Error("app-server exited"), { code: "APP_SERVER_EXIT" }));
      this.waiters.clear();
    });
    await waitForPort(this.port, 20_000, startupAbort.signal);
    if (typeof WebSocket !== "function") throw new Error("Node WebSocket is unavailable");
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("timeout connecting to app-server websocket"));
      }, 20_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("app-server websocket error"));
      }, { once: true });
      ws.addEventListener("message", (event) => this.onMessage(event.data));
      ws.addEventListener("close", () => {
        for (const { reject: fail, timer: pendingTimer } of this.pending.values()) {
          clearTimeout(pendingTimer);
          fail(Object.assign(new Error("app-server websocket closed"), { code: "APP_SERVER_CLOSED" }));
        }
        this.pending.clear();
      });
    });
  }

  onMessage(data) {
    const line = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (this.eventLog) {
      try { appendFileSync(this.eventLog, `${line}\n`); } catch { /* best effort */ }
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(Object.assign(new Error(JSON.stringify(message.error)), { rpc: message.error }));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      this.notifications.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    }
  }

  request(id, method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`timeout waiting for ${method}`), { code: "RPC_TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  call(method, params, timeoutMs = 30_000) {
    return this.request(this.nextId++, method, params, timeoutMs);
  }

  waitFor(predicate, timeoutMs = 30_000) {
    for (const message of this.notifications) {
      if (predicate(message)) return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(Object.assign(new Error("timeout waiting for notification"), { code: "NOTIFICATION_TIMEOUT" }));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async close({ timeoutMs = 5000, killAfterMs = 1500 } = {}) {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    const child = this.child;
    if (!child) return;
    if (!this.liveOwnedProcess && (child.pid === undefined || child.pid === null)) {
      this.exitObserved = true;
      this.child = null;
      return;
    }
    child.stdin?.end();
    const started = Date.now();
    const deadline = started + Math.max(1, timeoutMs);
    const normalDeadline = Math.min(deadline, started + Math.max(0, killAfterMs));
    const hasExited = () => (child.exitCode !== null && child.exitCode !== undefined)
      || (child.signalCode !== null && child.signalCode !== undefined);
    const waitForExit = (until) => new Promise((resolve) => {
      if (hasExited()) {
        this.exitObserved = true;
        resolve(true);
        return;
      }
      const remaining = Math.max(0, until - Date.now());
      const onExit = () => {
        this.exitObserved = true;
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        if (hasExited()) this.exitObserved = true;
        resolve(hasExited());
      }, remaining);
      child.once("exit", onExit);
    });
    let exited = await waitForExit(normalDeadline);
    if (!exited && !hasExited()) {
      let terminationError = null;
      try {
        if (process.platform === "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
          this.terminateProcessTree(child.pid, Math.max(1, deadline - Date.now()));
        } else {
          child.kill();
        }
      } catch (error) {
        terminationError = error;
      }
      exited = await waitForExit(deadline);
      if (!exited && !hasExited() && terminationError) {
        throw Object.assign(new Error("owned app-server process tree could not be terminated"), {
          code: "APP_SERVER_EXIT_TIMEOUT",
          cause: terminationError,
        });
      }
    }
    if (!exited && hasExited()) {
      this.exitObserved = true;
      exited = true;
    }
    if (!exited) {
      throw Object.assign(new Error("owned app-server did not exit within the close deadline"), {
        code: "APP_SERVER_EXIT_TIMEOUT",
      });
    }
    this.exitObserved = true;
    this.child = null;
  }
}
