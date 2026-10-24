import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServer } from "../scripts/native-app-server.mjs";
import { runIsolatedConfigSmoke } from "../scripts/native-isolated-smoke.mjs";

const exePath = process.execPath;

function makeFixture() {
  const root = mkdtempSync(join(os.tmpdir(), "codex-config-smoke-test-"));
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents", "native_deepseek.toml"), 'model = "deepseek/deepseek-flash"\n', "utf8");
  writeFileSync(join(root, "models.json"), JSON.stringify({ models: [{ slug: "mock-main" }] }), "utf8");
  return root;
}

function fixtureConfig(home) {
  return {
    model: "mock-main",
    model_provider: "fixture-main",
    openai_base_url: null,
    model_catalog_json: join(home, "models.json"),
    model_providers: {
      "fixture-main": { base_url: "http://127.0.0.1:18111/v1", capabilities: { remote_compaction: "unsupported" } },
      "deepseek-native": { base_url: "http://127.0.0.1:18112/v1", capabilities: { remote_compaction: "unsupported" } },
    },
    agents: {
      native_deepseek: { config_file: join(home, "agents", "native_deepseek.toml") },
    },
  };
}

function mockFactory({ config, models, rejectMethod, timeoutMethod, onClose }) {
  return () => ({
    child: null,
    exitObserved: false,
    async start() { this.child = {}; },
    async call(method, params, timeoutMs) {
      assert(timeoutMs > 0);
      if (method === rejectMethod) {
        const error = new Error("sanitized mock RPC failure");
        error.rpc = { code: -32602, message: "do not expose this payload" };
        throw error;
      }
      if (method === timeoutMethod) {
        const error = new Error("timeout");
        error.code = "RPC_TIMEOUT";
        throw error;
      }
      if (method === "initialize") return {};
      if (method === "config/read") return { config, layers: [] };
      if (method === "model/list") return { data: models };
      throw new Error("unexpected method: " + method);
    },
    async close() {
      onClose();
      this.child = null;
      this.exitObserved = true;
    },
  });
}

async function runFixture({ configOverride, models, rejectMethod, timeoutMethod, expectedMainProvider = "fixture-main", expectedRootBaseUrl = null } = {}) {
  const home = makeFixture();
  const beforeFiles = readdirSync(home).sort();
  const beforeUserEnv = { CODEX_HOME: process.env.CODEX_HOME, SOL_LUNA_NATIVE_PLAINTEXT_V2: process.env.SOL_LUNA_NATIVE_PLAINTEXT_V2 };
  let closeCount = 0;
  try {
    const result = await runIsolatedConfigSmoke({
      exePath,
      preparedHome: home,
      expectedMainModel: "mock-main",
      expectedMainProvider,
      expectedRootBaseUrl,
      appServerFactory: mockFactory({
        config: configOverride ?? fixtureConfig(home),
        models: models ?? [{ id: "mock-main", model: "mock-main" }],
        rejectMethod,
        timeoutMethod,
        onClose: () => { closeCount += 1; },
      }),
    });
    assert.deepEqual(readdirSync(home).sort(), beforeFiles, "smoke must not modify preparedHome");
    assert.deepEqual({ CODEX_HOME: process.env.CODEX_HOME, SOL_LUNA_NATIVE_PLAINTEXT_V2: process.env.SOL_LUNA_NATIVE_PLAINTEXT_V2 }, beforeUserEnv, "smoke must not mutate the parent environment");
    assert.equal(closeCount, 1, "owned app-server must close in finally");
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

test("passes read-only config, static model-list, provider, and role checks", async () => {
  const result = await runFixture();
  assert.equal(result.status, "passed");
  assert.equal(result.checks.root_catalog_is_local_and_not_deepseek_only, true);
  assert.equal(result.checks.role_config_file_present, true);
  assert.equal(result.checks.root_base_url_matches_expectation, true);
  assert.equal(result.checks.main_provider_separate_from_deepseek_loopback, true);
  assert.equal(result.checks.app_server_closed, true);
  assert.equal(JSON.stringify(result).includes("do not expose this payload"), false);
});

test("invalid effective config fails and still closes the app-server", async () => {
  const result = await runFixture({ configOverride: { model: "wrong", model_provider: "wrong" } });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.stage, "config_read");
  assert.equal(result.checks.app_server_closed, true);
});

test("config/read null provider is accepted as the schema's unset value", async () => {
  const home = makeFixture();
  let closeCount = 0;
  try {
    const config = fixtureConfig(home);
    config.model_provider = null;
    const result = await runIsolatedConfigSmoke({
      exePath,
      preparedHome: home,
      expectedMainModel: "mock-main",
      expectedMainProvider: null,
      expectedRootBaseUrl: null,
      appServerFactory: mockFactory({ config, models: [{ model: "mock-main" }], onClose: () => { closeCount += 1; } }),
    });
    assert.equal(result.status, "passed");
    assert.equal(closeCount, 1);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

test("rejects a main provider loopback endpoint shared with DeepSeek", async () => {
  const home = makeFixture();
  try {
    const config = fixtureConfig(home);
    config.model_providers["fixture-main"].base_url = "http://localhost:18112/v1";
    const result = await runIsolatedConfigSmoke({
      exePath,
      preparedHome: home,
      expectedMainModel: "mock-main",
      expectedMainProvider: "fixture-main",
      expectedRootBaseUrl: null,
      appServerFactory: mockFactory({ config, models: [{ model: "mock-main" }], onClose() {} }),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failure.stage, "provider_config");
    assert.equal(JSON.stringify(result).includes("18112"), false);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

test("root base URL must match the explicit expected value", async () => {
  const home = makeFixture();
  try {
    const config = fixtureConfig(home);
    config.openai_base_url = "http://127.0.0.1:18113/v1";
    const result = await runIsolatedConfigSmoke({
      exePath,
      preparedHome: home,
      expectedMainModel: "mock-main",
      expectedMainProvider: "fixture-main",
      expectedRootBaseUrl: null,
      appServerFactory: mockFactory({ config, models: [{ model: "mock-main" }], onClose() {} }),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failure.stage, "config_read");
    assert.equal(JSON.stringify(result).includes("18113"), false);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

test("spawn rejection is handled and close does not wait for a nonexistent process", async () => {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = undefined;
  child.signalCode = undefined;
  child.kill = () => { throw new Error("spawn-failed child must not be killed"); };
  const app = new AppServer({
    exe: "not-launched-by-this-test",
    codexHome: os.tmpdir(),
    cwd: os.tmpdir(),
    eventLog: null,
    spawnProcess() {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("mock ENOENT"), { code: "ENOENT" })));
      return child;
    },
  });
  await assert.rejects(app.start(), (error) => error.code === "APP_SERVER_SPAWN_ERROR");
  assert.equal(app.liveOwnedProcess, false);
  assert.equal(app.exitObserved, true);
  await app.close({ timeoutMs: 50, killAfterMs: 10 });
  assert.equal(app.child, null);
  assert.equal(app.exitObserved, true);
});

test("close ends owned child stdin and observes its normal EOF exit before the kill bound", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdin.on("end", () => { process.stdout.write("stdin-eof\\n"); process.exit(0); }); process.stdin.resume();'], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let stdout = "";
  let killCalls = 0;
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  const realKill = child.kill.bind(child);
  child.kill = (...args) => { killCalls += 1; return realKill(...args); };
  const exited = once(child, "exit");
  const app = new AppServer({ exe: process.execPath, codexHome: os.tmpdir(), cwd: os.tmpdir(), eventLog: null });
  app.child = child;
  app.liveOwnedProcess = true;

  await app.close({ timeoutMs: 1000, killAfterMs: 800 });
  const [code, signal] = await exited;

  assert.equal(stdout, "stdin-eof\n", "the child exits only after receiving stdin EOF");
  assert.equal(code, 0, "the owned child completed its normal EOF shutdown");
  assert.equal(signal, null, "the child was not terminated by a signal");
  assert.equal(killCalls, 0, "close did not use the bounded force-kill path");
  assert.equal(app.exitObserved, true, "close observed the actual child exit");
  assert.equal(app.child, null, "closed child ownership is released");
});

test("close retains the bounded kill fallback when a child ignores stdin EOF", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdin.on("end", () => { setInterval(() => {}, 1000); }); process.stdin.resume();'], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  let killCalls = 0;
  const realKill = child.kill.bind(child);
  child.kill = (...args) => { killCalls += 1; return realKill(...args); };
  const exited = once(child, "exit");
  const app = new AppServer({
    exe: process.execPath,
    codexHome: os.tmpdir(),
    cwd: os.tmpdir(),
    eventLog: null,
    terminateProcessTree(pid) {
      assert.equal(pid, child.pid, "only the child owned by this test is targeted");
      child.kill();
    },
  });
  app.child = child;
  app.liveOwnedProcess = true;

  await app.close({ timeoutMs: 500, killAfterMs: 30 });
  const [code, signal] = await exited;

  assert.equal(killCalls, 1, "a child that ignores EOF still uses the existing bounded kill fallback");
  assert.equal(code, null, "the child did not exit normally");
  assert.ok(signal, "the child exit was caused by the bounded kill");
  assert.equal(app.exitObserved, true, "close observed termination after the bounded fallback");
  assert.equal(app.child, null, "closed child ownership is released after the fallback");
});

test("Windows close terminates an owned wrapper process tree and releases its working directory", { skip: process.platform !== "win32" }, async () => {
  const ownedDir = mkdtempSync(join(os.tmpdir(), "codex-app-server-tree-"));
  const grandchildScript = 'process.stdin.resume(); setInterval(() => {}, 1000);';
  const wrapperScript = [
    'const { spawn } = require("node:child_process");',
    `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore", windowsHide: true, detached: true });`,
    'process.stdout.write(String(grandchild.pid) + "\\n");',
    'process.stdin.resume();',
    'process.stdin.on("end", () => setInterval(() => {}, 1000));',
    'setInterval(() => {}, 1000);',
  ].join("\n");
  const child = spawn(process.execPath, ["-e", wrapperScript], {
    cwd: ownedDir,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let grandchildPid;
  let stdout = "";
  const grandchildReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrapper did not report its grandchild PID")), 3000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n")[0];
      if (/^\d+$/.test(line)) {
        grandchildPid = Number(line);
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("wrapper exited before reporting its grandchild PID"));
    });
  });
  const app = new AppServer({ exe: process.execPath, codexHome: ownedDir, cwd: ownedDir, eventLog: null });
  app.child = child;
  app.liveOwnedProcess = true;
  const rootExited = once(child, "exit");

  try {
    await grandchildReady;
    const startedGrandchild = spawnSync("tasklist.exe", ["/FI", `PID eq ${grandchildPid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    assert.equal(startedGrandchild.error, undefined, "the pre-close process query completed");
    assert.ok((startedGrandchild.stdout ?? "").includes(`"${grandchildPid}"`), "the fixture grandchild is running before close");
    await app.close({ timeoutMs: 2000, killAfterMs: 40 });
    await rootExited;
    const grandchildListing = spawnSync("tasklist.exe", ["/FI", `PID eq ${grandchildPid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    assert.equal(grandchildListing.error, undefined, "the process query completed");
    assert.equal(grandchildListing.status, 0, "the process query succeeded");
    assert.equal((grandchildListing.stdout ?? "").includes(`"${grandchildPid}"`), false, "the owned grandchild exited with its wrapper");
    rmSync(ownedDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    assert.equal(existsSync(ownedDir), false, "the working directory is unlocked after the owned process tree exits");
  } finally {
    if (grandchildPid && process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(grandchildPid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (existsSync(ownedDir)) rmSync(ownedDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

test("model-list RPC errors fail without leaking the RPC payload and close the app-server", async () => {
  const result = await runFixture({ rejectMethod: "model/list" });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.stage, "model_list");
  assert.equal(result.failure.code, -32602);
  assert.equal(JSON.stringify(result).includes("do not expose this payload"), false);
  assert.equal(result.checks.app_server_closed, true);
});

test("RPC timeouts fail and still close the app-server", async () => {
  const result = await runFixture({ timeoutMethod: "config/read" });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.stage, "config_read");
  assert.equal(result.failure.code, "RPC_TIMEOUT");
  assert.equal(result.checks.app_server_closed, true);
});
