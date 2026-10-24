import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createApiProfile, saveRouterSettings} from "../scripts/native-api-settings.mjs";
import {
  NATIVE_RUNTIME_PATCH_SHA256,
  NATIVE_RUNTIME_SOURCE_COMMIT,
  NATIVE_RUNTIME_TARGET,
  NATIVE_RUNTIME_VERSION,
  REQUIRED_COMPANIONS,
} from "../scripts/native-runtime.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(path.join(os.tmpdir(), "plugin-mcp-env-"));
const settingsFile = path.join(temp, "sol-luna-deepseek-router", "native-api", "router.json");
const codexHome = path.join(temp, "codex-home");
const fakeRuntime = path.join(temp, "runtime", "versions", "compatible");
const fakeJournal = path.join(temp, "legacy-install-journal.json");
await mkdir(path.dirname(settingsFile), {recursive: true});
await mkdir(codexHome, {recursive: true});
await mkdir(fakeRuntime, {recursive: true});

const sha = value => createHash("sha256").update(value).digest("hex");
const runtimeFiles = {
  "codex.exe": Buffer.from("fake compatible codex fixture"),
  "provenance.json": null,
  ...Object.fromEntries(REQUIRED_COMPANIONS.map(name => [name, Buffer.from(`fixture ${name}`)])),
};
const provenance = {
  source_commit: NATIVE_RUNTIME_SOURCE_COMMIT,
  patch_sha256: NATIVE_RUNTIME_PATCH_SHA256,
  target: NATIVE_RUNTIME_TARGET,
};
const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
runtimeFiles["provenance.json"] = provenanceBytes;
for (const [name, bytes] of Object.entries(runtimeFiles)) {
  await writeFile(path.join(fakeRuntime, name), bytes);
}
const manifest = {
  version: NATIVE_RUNTIME_VERSION,
  source_commit: NATIVE_RUNTIME_SOURCE_COMMIT,
  patch_sha256: NATIVE_RUNTIME_PATCH_SHA256,
  target: NATIVE_RUNTIME_TARGET,
  stock_cli_version: NATIVE_RUNTIME_VERSION,
  binary_sha256: sha(runtimeFiles["codex.exe"]),
  files: Object.fromEntries(Object.entries(runtimeFiles).map(([name, bytes]) => [name, sha(bytes)])),
};
await writeFile(path.join(fakeRuntime, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(fakeJournal, `${JSON.stringify({
  version: 1,
  phase: "active",
  paths: {versionDir: fakeRuntime},
  files: {},
  environment: {},
  autostart: {},
})}\n`);

const profile = createApiProfile({
  protocol: "responses",
  baseUrl: "https://api.example.invalid/v1",
  model: "env-forwarding-model",
  reasoning: {supported: ["none"], default: "none", parameter: "none"},
  credential: {type: "env", name: "CODEX_HOME"},
});
const settings = {
  schemaVersion: 1,
  mode: "fixed",
  fixedExecutor: profile.profileId,
  profiles: {[profile.profileId]: profile},
};
await saveRouterSettings(settingsFile, settings);
const manifestConfig = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8"));
const allowlist = manifestConfig.mcpServers["sol-luna-deepseek-router"].env_vars;
for (const key of ["CODEX_HOME", "SOL_LUNA_NATIVE_INSTALL_JOURNAL", "SOL_LUNA_NATIVE_API_VERSION_DIR"]) {
  assert.ok(allowlist.includes(key), `${key} must be in the canonical MCP env allowlist`);
}

class StdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { this.stderr += chunk; });
    child.stdout.on("data", chunk => this.#read(chunk));
    child.on("exit", (code, signal) => {
      const error = new Error(`plugin MCP exited (${code ?? signal}); stderr: ${this.stderr.slice(-1000)}`);
      for (const {reject} of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }
  #read(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
    });
  }
  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

function filteredEnv(extra = {}) {
  const base = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  base.LOCALAPPDATA = temp;
  base.CODEX_HOME = codexHome;
  for (const key of ["CODEX_HOME", "SOL_LUNA_NATIVE_INSTALL_JOURNAL", "SOL_LUNA_NATIVE_API_VERSION_DIR"]) {
    delete base[key];
  }
  return {...base, ...extra};
}

async function statusWithEnv(extra) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "plugin-mcp.mjs")], {
    cwd: root,
    env: filteredEnv(extra),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const client = new StdioClient(child);
  try {
    await client.request("initialize", {protocolVersion: "2025-11-25"});
    const response = await client.request("tools/call", {
      name: "router_settings_executor_status",
      arguments: {profileId: profile.profileId},
    });
    assert.ok(response.result && response.result.isError !== true, `status failed: ${response.result?.content?.[0]?.text ?? "unknown"}`);
    return response.result.structuredContent;
  } finally {
    await client.close();
  }
}

try {
  // The real stdio entry receives only the .mcp.json allowlist. CODEX_HOME is
  // enough for the env credential reference; the version variable selects the
  // staged runtime.
  const direct = await statusWithEnv({
    CODEX_HOME: codexHome,
    SOL_LUNA_NATIVE_API_VERSION_DIR: fakeRuntime,
  });
  assert.equal(direct.runtimeCompatible, true, direct.detail);
  assert.equal(direct.credentialAvailable, true);
  assert.equal(direct.apiVerified, false);

  // A legacy install journal must also be forwarded; without it the same
  // filtered process cannot discover the staged runtime.
  const journal = await statusWithEnv({
    CODEX_HOME: codexHome,
    SOL_LUNA_NATIVE_INSTALL_JOURNAL: fakeJournal,
  });
  assert.equal(journal.runtimeCompatible, true, journal.detail);
  assert.equal(journal.credentialAvailable, true);

  const isolated = await statusWithEnv({CODEX_HOME: codexHome});
  assert.equal(isolated.runtimeCompatible, false);
  assert.equal(isolated.credentialAvailable, true);
  console.log("PASS plugin MCP filtered env lifecycle status assertions");
} finally {
  await rm(temp, {recursive: true, force: true});
}
