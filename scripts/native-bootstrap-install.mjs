import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AppServer } from "./native-app-server.mjs";
import { createWindowsUserEnvironmentAdapter } from "./native-runtime-env.mjs";

const CODEX_CLI_PATH = "CODEX_CLI_PATH";
const PLAINTEXT_KEY = "SOL_LUNA_NATIVE_PLAINTEXT_V2";
const JOURNAL_KEY = "SOL_LUNA_NATIVE_INSTALL_JOURNAL";
const BASIC_KEYS = [CODEX_CLI_PATH, PLAINTEXT_KEY];
const ALLOWED_KEYS = [CODEX_CLI_PATH, PLAINTEXT_KEY, JOURNAL_KEY];
export const NATIVE_BOOTSTRAP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../native/bootstrap/codex-bootstrap.exe");

function normalize(value) {
  if (value && typeof value === "object" && typeof value.present === "boolean") {
    return { present: value.present, value: value.present ? String(value.value ?? "") : null };
  }
  return value === undefined || value === null ? { present: false, value: null } : { present: true, value: String(value) };
}
function equal(left, right) {
  const a = normalize(left), b = normalize(right);
  return a.present === b.present && (!a.present || a.value === b.value);
}
function keysFor(plan) {
  const prior = Object.keys(plan?.prior ?? {}).sort().join(",");
  const next = Object.keys(plan?.next ?? {}).sort().join(",");
  const sortedAllowed = [BASIC_KEYS, ALLOWED_KEYS].map((keys) => keys.slice().sort().join(","));
  if (prior !== next || !sortedAllowed.includes(prior)) throw new Error("bootstrap environment transaction keys are invalid");
  return prior === BASIC_KEYS.slice().sort().join(",") ? BASIC_KEYS : ALLOWED_KEYS;
}
async function regularFile(file) {
  try {
    const stat = await lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function isPathEqual(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function planBootstrapEnvironment({ bootstrapPath = NATIVE_BOOTSTRAP_PATH, bootstrapSourcePath, officialPath, currentEnvironment = {}, journalPath } = {}) {
  if (officialPath !== undefined && (typeof officialPath !== "string" || !path.isAbsolute(officialPath))) throw new Error("officialPath must be absolute when provided");
  if (typeof journalPath !== "string" || !journalPath.trim()) throw new Error("journalPath must be a non-empty path");
  const exePath = path.resolve(bootstrapPath);
  const sourcePath = path.resolve(bootstrapSourcePath || bootstrapPath);
  if (!await regularFile(sourcePath)) throw new Error("native Codex bootstrap source is missing or not a regular file");
  const current = Object.fromEntries(ALLOWED_KEYS.map((key) => [key, normalize(Object.hasOwn(currentEnvironment, key) ? currentEnvironment[key] : undefined)]));
  const configured = current[CODEX_CLI_PATH];
  const isOfficialPackagePath = /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(configured.value || "");
  if (configured.present && !isPathEqual(configured.value, exePath) && !(officialPath && isPathEqual(configured.value, officialPath)) && !isOfficialPackagePath) {
    throw new Error("CODEX_CLI_PATH belongs to a user-managed backend; refusing to replace it without an owned installation receipt");
  }
  const next = {
    [CODEX_CLI_PATH]: { present: true, value: exePath },
    [PLAINTEXT_KEY]: { present: true, value: "1" },
    [JOURNAL_KEY]: { present: true, value: path.resolve(journalPath) },
  };
  return { bootstrapPath: exePath, bootstrapSourcePath: sourcePath, officialPath: officialPath ? path.resolve(officialPath) : null, prior: current, next };
}

async function deployBootstrap(plan) {
  const source = await readFile(plan.bootstrapSourcePath || plan.bootstrapPath);
  const target = path.resolve(plan.bootstrapPath);
  let prior = null;
  try { prior = await readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (prior && prior.equals(source)) return { path: target, prior, deployedSha256: createHash("sha256").update(source).digest("hex"), changed: false };
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, source, { flag: "wx", mode: 0o700 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return { path: target, prior, deployedSha256: createHash("sha256").update(source).digest("hex"), changed: true };
}
async function rollbackBootstrapFile(snapshot) {
  if (!snapshot?.changed) return;
  const current = await readFile(snapshot.path);
  if (createHash("sha256").update(current).digest("hex") !== snapshot.deployedSha256) throw new Error("bootstrap file changed since install; refusing rollback");
  if (snapshot.prior === null) await rm(snapshot.path);
  else {
    const temporary = `${snapshot.path}.${process.pid}.rollback.tmp`;
    await writeFile(temporary, snapshot.prior, { flag: "wx", mode: 0o700 });
    try { await rename(temporary, snapshot.path); } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}

export async function applyBootstrapEnvironment(plan, adapter) {
  if (!plan?.bootstrapPath || !adapter?.get || !adapter?.set) throw new Error("a valid bootstrap plan and environment adapter are required");
  const keys = keysFor(plan);
  if (path.resolve(plan.bootstrapPath) !== plan.next[CODEX_CLI_PATH]?.value) throw new Error("bootstrap plan path does not match its owned environment value");
  for (const key of keys) if (!equal(await adapter.get(key), plan.prior[key])) throw new Error(`environment changed since bootstrap plan: ${key}`);
  const bootstrapFile = await deployBootstrap(plan);
  const attempted = [];
  try {
    for (const key of keys) {
      if (!equal(await adapter.get(key), plan.prior[key])) throw new Error(`environment changed since bootstrap plan: ${key}`);
      attempted.push(key);
      await adapter.set(key, plan.next[key]);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const key of attempted.reverse()) {
      try { if (equal(await adapter.get(key), plan.next[key])) await adapter.set(key, plan.prior[key]); } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    try { await rollbackBootstrapFile(bootstrapFile); } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], "bootstrap environment apply failed and recovery also failed");
    throw error;
  }
  return { prior: plan.prior, next: plan.next, bootstrapPath: plan.bootstrapPath, bootstrapFile };
}

function isWindowsAppsOfficialPath(value) {
  return typeof value === "string" && /(?:^|[\\/])WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]codex\.exe$/i.test(value);
}

export async function rollbackBootstrapEnvironment(snapshot, adapter) {
  if (!snapshot?.prior || !snapshot?.next || !adapter?.get || !adapter?.set) throw new Error("a valid bootstrap environment snapshot is required");
  const keys = keysFor(snapshot);
  for (const key of keys) if (!equal(await adapter.get(key), snapshot.next[key])) throw new Error(`environment changed since bootstrap apply: ${key}`);
  const prior = { ...snapshot.prior };
  const oldCli = prior[CODEX_CLI_PATH];
  if (oldCli?.present && isWindowsAppsOfficialPath(oldCli.value)) prior[CODEX_CLI_PATH] = { present: false, value: null };
  for (const key of [...keys].reverse()) {
    if (!equal(await adapter.get(key), snapshot.next[key])) throw new Error(`environment changed since bootstrap apply: ${key}`);
    await adapter.set(key, prior[key]);
  }
  await rollbackBootstrapFile(snapshot.bootstrapFile);
  return { restored: true, cliPath: prior[CODEX_CLI_PATH] };
}

export async function writeCompatibilityReceipt(file, { officialPath, officialVersion, desktopPackageVersion, patchedPath, probeResult, approvedPatchHashes = [] } = {}) {
  if (!officialVersion || !desktopPackageVersion || !probeResult || probeResult.status !== "passed" || probeResult.probe !== "app-server-initialize" || probeResult.cliVersion !== officialVersion) {
    throw new Error("a successful exact-version app-server initialize probe is required");
  }
  const [officialInfo, patchInfo] = await Promise.all([lstat(officialPath), lstat(patchedPath)]);
  if (!officialInfo.isFile() || officialInfo.isSymbolicLink() || !patchInfo.isFile() || patchInfo.isSymbolicLink()) throw new Error("compatibility binaries must be regular files");
  const [officialBytes, patchBytes] = await Promise.all([readFile(officialPath), readFile(patchedPath)]);
  const officialSha256 = createHash("sha256").update(officialBytes).digest("hex");
  const patchedSha256 = createHash("sha256").update(patchBytes).digest("hex");
  if (!approvedPatchHashes.some((value) => String(value).toLowerCase() === patchedSha256)) throw new Error("patched CLI hash is not approved by this bootstrap build");
  const receipt = {
    schemaVersion: 1,
    officialSha256,
    officialVersion,
    desktopPackageVersion,
    patchedPath: path.resolve(patchedPath),
    patchedSha256,
    compatibility: { status: "passed", probe: "app-server-initialize", cliVersion: officialVersion },
  };
  const target = path.resolve(file);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
  return receipt;
}

export function readCodexCliVersion(exePath, runner = spawnSync) {
  const result = runner(exePath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error("official Codex CLI version probe failed");
  const match = /^codex-cli\s+(\S+)\s*$/m.exec(result.stdout || "");
  if (!match) throw new Error("official Codex CLI returned an invalid version");
  return match[1];
}

export function readDesktopPackageVersion(exePath) {
  const escaped = path.resolve(exePath).replaceAll("\\", "/");
  const match = /\/WindowsApps\/OpenAI\.Codex_([0-9.]+)_x64__2p2nqsd0c76g0\/app\/resources\/codex\.exe$/i.exec(escaped);
  if (!match) throw new Error("official Codex CLI is not under the expected Windows desktop package");
  return match[1];
}

function hasExactVersionToken(userAgent, cliVersion) {
  if (typeof userAgent !== "string" || typeof cliVersion !== "string" || !cliVersion) return false;
  const isVersionChar = (value) => value !== undefined && /[A-Za-z0-9.+-]/.test(value);
  let offset = userAgent.indexOf(cliVersion);
  while (offset !== -1) {
    const end = offset + cliVersion.length;
    if (!isVersionChar(userAgent[offset - 1]) && !isVersionChar(userAgent[end])) return true;
    offset = userAgent.indexOf(cliVersion, offset + 1);
  }
  return false;
}

export async function probePatchedAppServer({ exePath, codexHome, cwd, cliVersion, timeoutMs = 10_000, AppServer: AppServerImpl = AppServer } = {}) {
  if (typeof AppServerImpl !== "function") throw new Error("AppServer implementation must be available");
  const server = new AppServerImpl({ exe: exePath, codexHome, cwd });
  let initialized = false;
  let timer;
  try {
    await Promise.race([server.start(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("app-server initialize probe timed out")), timeoutMs); })]);
    clearTimeout(timer);
    const result = await server.call("initialize", {
      clientInfo: { name: "native-bootstrap-probe", title: "Native Bootstrap Probe", version: "1" },
      capabilities: { experimentalApi: true },
    }, timeoutMs);
    if (!hasExactVersionToken(result?.userAgent, cliVersion)) throw new Error("app-server initialize returned an unexpected CLI identity");
    const config = await server.call("config/read", { includeLayers: true, cwd }, timeoutMs);
    if (!config?.config || typeof config.config !== "object") throw new Error("app-server config/read returned an invalid configuration");
    initialized = true;
    return { status: "passed", probe: "app-server-initialize", cliVersion };
  } finally {
    clearTimeout(timer);
    await server.close({ timeoutMs: Math.min(timeoutMs, 3000), killAfterMs: Math.min(timeoutMs, 1000) }).catch(() => {});
    if (!initialized) await server.close().catch(() => {});
  }
}

export async function probeAndWriteCompatibilityReceipt({ officialPath, patchedPath, runtimeRoot, receiptPath = path.join(runtimeRoot, "compatibility.json"), approvedPatchHashes = [], timeoutMs = 10_000, AppServer: AppServerImpl = AppServer, readVersion = readCodexCliVersion, readPackageVersion = readDesktopPackageVersion } = {}) {
  const officialVersion = readVersion(officialPath);
  const desktopPackageVersion = readPackageVersion(officialPath);
  const probeRoot = path.join(path.resolve(runtimeRoot), "probes");
  await mkdir(probeRoot, { recursive: true, mode: 0o700 });
  const tempHome = await mkdtemp(path.join(probeRoot, "compatibility-"));
  const cwd = path.join(tempHome, "workspace");
  const codexHome = path.join(tempHome, "codex-home");
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\napproval_policy = "never"\n', { flag: "wx" });
    const probeResult = await probePatchedAppServer({ exePath: patchedPath, codexHome, cwd, cliVersion: officialVersion, timeoutMs, AppServer: AppServerImpl });
    return await writeCompatibilityReceipt(receiptPath, { officialPath, officialVersion, desktopPackageVersion, patchedPath, probeResult, approvedPatchHashes });
  } finally {
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

export { createWindowsUserEnvironmentAdapter };

