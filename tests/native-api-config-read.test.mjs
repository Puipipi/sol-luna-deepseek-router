import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiProfileBaseUrl, composeApiConfig, renderApiArtifacts } from "../scripts/native-api-artifacts.mjs";
import { createApiProfile } from "../scripts/native-api-settings.mjs";

const CODEX = process.env.CODEX_CLI_PATH || "codex";
const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sourceCache = path.join(sourceHome, "models_cache.json");
if (!existsSync(sourceCache)) {
  console.error("native API config/read gate requires a local models_cache.json; refusing to fake green");
  process.exit(2);
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

function waitForPort(port) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > 20_000) reject(new Error("app-server websocket did not open"));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function readConfig(codexHome, cwd) {
  const port = await freePort();
  const child = spawn(CODEX, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "error" },
    stdio: "ignore",
    windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    await waitForPort(port);
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error("websocket connect timeout")), 20_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(socket); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("websocket connect error")); }, { once: true });
    });
    let requestId = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!pending.has(message.id)) return;
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await request("initialize", {
      clientInfo: { name: "native-api-config-read", title: "Native API Config Read", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    const config = await request("config/read", { includeLayers: true, cwd });
    ws.close();
    return config;
  } finally {
    if (process.platform === "win32" && child.pid) {
      try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* process already exited */ }
    } else {
      try { child.kill(); } catch { /* already exited */ }
    }
    let timer;
    await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, 3_000); })]);
    clearTimeout(timer);
  }
}

function registeredRole(value, roleName, expectedFile) {
  const expected = path.resolve(expectedFile);
  const normalize = (file) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  const target = normalize(expected);
  const visit = (current, seen = new Set()) => {
    if (!current || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    if (!Array.isArray(current) && current[roleName] && typeof current[roleName] === "object") {
      const file = current[roleName].config_file;
      if (typeof file === "string" && normalize(file) === target) return true;
    }
    return Object.values(current).some((item) => visit(item, seen));
  };
  return visit(value);
}

function removeOwnedTree(target) {
  let info;
  try { info = lstatSync(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of readdirSync(target)) removeOwnedTree(path.join(target, name));
    rmdirSync(target);
  } else unlinkSync(target);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(path.join(repoRoot, "tests", ".native-api-config-read-"));
const profile = createApiProfile({
  protocol: "responses",
  baseUrl: "https://api.example.invalid/v1",
  model: "fixture/model",
  reasoning: { supported: ["low", "high"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "env", name: "FIXTURE_API_KEY" },
});
const gatewayBaseUrl = "http://127.0.0.1:42123/gate-token-1234567890";
const roleName = `native_api_${profile.profileId}`;
let rolePath;
try {
  const codexHome = path.join(temp, "codex-home");
  const cwd = path.join(temp, "workspace");
  const agents = path.join(codexHome, "agents");
  const artifacts = renderApiArtifacts(profile, {
    codexHome,
    baseUrl: apiProfileBaseUrl(gatewayBaseUrl, profile.profileId),
  });
  rolePath = artifacts.rolePath;
  const configPath = path.join(codexHome, "config.toml");
  mkdirSync(agents, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  copyFileSync(sourceCache, path.join(codexHome, "models_cache.json"));
  writeFileSync(rolePath, artifacts.roleBytes);
  const configText = composeApiConfig([
    'model = "gpt-6.1-sol"',
    'model_provider = "openai"',
    "",
  ].join("\n"), { profileIds: [profile.profileId], gatewayBaseUrl, codexHome });
  writeFileSync(configPath, configText, "utf8");
  const config = await readConfig(codexHome, cwd);
  const effective = config.config || {};
  const mainModelPreserved = effective.model === "gpt-6.1-sol";
  const roleRegistered = registeredRole(config, roleName, artifacts.rolePath);
  assert.equal(mainModelPreserved, true, "config/read preserves the root model");
  assert.equal(roleRegistered, true, "config/read exposes the native API role and its config_file path");
  console.log("PASS native API app-server config/read role registration gate (one read request; no model request)");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { removeOwnedTree(temp); } catch (error) {
    console.error(`fixture cleanup failed (${error.code || "unknown"})`);
    process.exitCode = 1;
  }
}
