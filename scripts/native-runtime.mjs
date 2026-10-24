import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const NATIVE_RUNTIME_VERSION = "0.164.0-alpha.11.1";
export const NATIVE_RUNTIME_SOURCE_COMMIT = "6905ecede7816e91373e9eabda3f6b0368fc747b";
export const NATIVE_RUNTIME_PATCH_SHA256 = "d0cb44027e64296045dfa26dbc79ed878ee8b5feee325267640c6337b9c8e76e";
export const NATIVE_RUNTIME_TARGET = "x86_64-pc-windows-msvc";
export const REQUIRED_COMPANIONS = [
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
];
export const OPTIONAL_COMPANIONS = ["codex-windows-sandbox-service.exe"];
const MANIFEST_NAME = "runtime-manifest.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function requireRegularFile(file, label) {
  let info;
  try { info = await lstat(file); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${file}`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
  return file;
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

function parseProvenance(text, file) {
  let provenance;
  try { provenance = JSON.parse(text); } catch { throw new Error(`invalid provenance JSON: ${file}`); }
  if (provenance?.source_commit !== NATIVE_RUNTIME_SOURCE_COMMIT) throw new Error("provenance source_commit does not match the approved source");
  if (provenance?.patch_sha256 !== NATIVE_RUNTIME_PATCH_SHA256) throw new Error("provenance patch_sha256 does not match the approved patch");
  if (provenance?.target !== NATIVE_RUNTIME_TARGET) throw new Error("provenance target does not match x86_64-pc-windows-msvc");
  return provenance;
}

async function readPlanInputs({ artifactDir, companionDir, runtimeDir, versionChecker }) {
  if (!artifactDir || !companionDir || !runtimeDir) throw new Error("artifactDir, companionDir, and runtimeDir are required");
  const artifactRoot = path.resolve(artifactDir);
  const companionRoot = path.resolve(companionDir);
  const runtimeRoot = path.resolve(runtimeDir);
  await requireRegularFile(path.join(artifactRoot, "codex.exe"), "artifact codex.exe");
  const provenanceFile = await requireRegularFile(path.join(artifactRoot, "provenance.json"), "artifact provenance.json");
  const provenanceBytes = await readFile(provenanceFile);
  const provenance = parseProvenance(provenanceBytes.toString("utf8"), provenanceFile);
  const fileInputs = new Map();
  const add = async (name, file, kind) => {
    if (path.basename(name) !== name || name === "." || name === "..") throw new Error(`unsafe staged filename: ${name}`);
    if (fileInputs.has(name)) throw new Error(`duplicate staged filename: ${name}`);
    await requireRegularFile(file, `${kind} ${name}`);
    fileInputs.set(name, { name, source: file, kind, sha256: await hashFile(file) });
  };
  await add("codex.exe", path.join(artifactRoot, "codex.exe"), "artifact");
  await add("provenance.json", provenanceFile, "artifact");
  for (const name of ["LICENSE", "NOTICE"]) {
    const file = path.join(artifactRoot, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`artifact ${name} must be a regular file`);
      await add(name, file, "artifact");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const companionNames = await readdir(companionRoot);
  const stockCliPath = path.join(companionRoot, "codex.exe");
  await requireRegularFile(stockCliPath, "stock companion codex.exe");
  const stockCliVersion = await checkStockCliVersion(stockCliPath, { versionChecker });
  for (const required of REQUIRED_COMPANIONS) {
    if (!companionNames.includes(required)) throw new Error(`required companion is missing: ${required}`);
  }
  for (const name of [...REQUIRED_COMPANIONS, ...OPTIONAL_COMPANIONS]) {
    if (!companionNames.includes(name)) continue;
    const file = path.join(companionRoot, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`companion must not be a symbolic link: ${name}`);
    if (!info.isFile()) continue;
    await add(name, file, "companion");
  }

  const binaryHash = fileInputs.get("codex.exe").sha256;
  if (provenance.binary_sha256 !== undefined && String(provenance.binary_sha256).toLowerCase() !== binaryHash) {
    throw new Error("provenance binary_sha256 does not match artifact codex.exe");
  }
  const versionId = `${provenance.source_commit.slice(0, 12)}-${provenance.patch_sha256.slice(0, 12)}-${binaryHash.slice(0, 12)}`;
  const versionsDir = path.join(runtimeRoot, "versions");
  const versionDir = path.join(versionsDir, versionId);
  if (!inside(runtimeRoot, versionsDir) || !inside(runtimeRoot, versionDir)) throw new Error("resolved staging path escapes runtimeDir");
  for (const candidate of [versionsDir, versionDir]) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`staging path must not be a symbolic link: ${candidate}`);
      if (candidate === versionsDir && !info.isDirectory()) throw new Error(`versions path is not a directory: ${candidate}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const files = Object.fromEntries([...fileInputs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(({ name, sha256: hash }) => [name, hash]));
  const manifest = {
    version: NATIVE_RUNTIME_VERSION,
    source_commit: provenance.source_commit,
    patch_sha256: provenance.patch_sha256,
    target: provenance.target,
    stock_cli_version: stockCliVersion,
    binary_sha256: binaryHash,
    files,
  };
  return { artifactRoot, companionRoot, runtimeRoot, versionsDir, versionDir, versionId, provenance, fileInputs: [...fileInputs.values()], manifest };
}

async function verifyExistingVersion(plan) {
  let entries;
  try { entries = await readdir(plan.versionDir); } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const info = await lstat(plan.versionDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`existing staged version path is not a regular directory: ${plan.versionDir}`);
  let actualManifest;
  try { actualManifest = JSON.parse(await readFile(path.join(plan.versionDir, MANIFEST_NAME), "utf8")); } catch {
    throw new Error(`existing staged version has no valid ${MANIFEST_NAME}: ${plan.versionDir}`);
  }
  if (JSON.stringify(actualManifest) !== JSON.stringify(plan.manifest)) throw new Error(`existing staged version manifest differs: ${plan.versionDir}`);
  const expectedEntries = [...Object.keys(plan.manifest.files), MANIFEST_NAME].sort();
  if (entries.sort().join("\n") !== expectedEntries.join("\n")) throw new Error(`existing staged version contents differ: ${plan.versionDir}`);
  for (const [name, expectedHash] of Object.entries(plan.manifest.files)) {
    const file = path.join(plan.versionDir, name);
    await requireRegularFile(file, `existing staged file ${name}`);
    if (await hashFile(file) !== expectedHash) throw new Error(`existing staged version file changed: ${name}`);
  }
  return true;
}

export async function planRuntime(options) {
  const plan = await readPlanInputs(options);
  const alreadyStaged = await verifyExistingVersion(plan);
  return {
    version: NATIVE_RUNTIME_VERSION,
    versionId: plan.versionId,
    versionDir: plan.versionDir,
    staged: alreadyStaged,
    alreadyStaged,
    source_commit: plan.provenance.source_commit,
    patch_sha256: plan.provenance.patch_sha256,
    target: plan.provenance.target,
    binary_sha256: plan.manifest.binary_sha256,
    files: plan.manifest.files,
  };
}

export async function verifyRuntimeVersion(versionDir) {
  if (!versionDir) throw new Error("versionDir is required");
  const root = path.resolve(versionDir);
  const info = await lstat(root).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`runtime version directory is missing: ${root}`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`runtime version path must be a regular directory: ${root}`);
  const manifestPath = await requireRegularFile(path.join(root, MANIFEST_NAME), MANIFEST_NAME);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { throw new Error(`invalid ${MANIFEST_NAME}: ${manifestPath}`); }
  if (manifest?.version !== NATIVE_RUNTIME_VERSION) throw new Error("runtime manifest version does not match the approved version");
  if (manifest?.source_commit !== NATIVE_RUNTIME_SOURCE_COMMIT) throw new Error("runtime manifest source_commit does not match the approved source");
  if (manifest?.patch_sha256 !== NATIVE_RUNTIME_PATCH_SHA256) throw new Error("runtime manifest patch_sha256 does not match the approved patch");
  if (manifest?.target !== NATIVE_RUNTIME_TARGET) throw new Error("runtime manifest target does not match x86_64-pc-windows-msvc");
  if (manifest?.stock_cli_version !== NATIVE_RUNTIME_VERSION) throw new Error("runtime manifest stock_cli_version does not match the approved version");
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("runtime manifest files must be a filename-to-hash map");
  const required = ["codex.exe", "provenance.json", ...REQUIRED_COMPANIONS];
  for (const name of required) if (!Object.hasOwn(manifest.files, name)) throw new Error(`runtime manifest is missing required file: ${name}`);
  const entries = (await readdir(root)).sort();
  const expectedEntries = [...Object.keys(manifest.files), MANIFEST_NAME].sort();
  if (entries.join("\n") !== expectedEntries.join("\n")) throw new Error("runtime directory contents do not match its manifest");
  for (const [name, expectedHash] of Object.entries(manifest.files)) {
    if (path.basename(name) !== name || name === "." || name === "..") throw new Error(`runtime manifest contains unsafe filename: ${name}`);
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`runtime manifest contains invalid SHA-256 for ${name}`);
    const file = await requireRegularFile(path.join(root, name), `runtime file ${name}`);
    if (await hashFile(file) !== expectedHash) throw new Error(`runtime file hash mismatch: ${name}`);
  }
  const binaryHash = manifest.files["codex.exe"];
  if (manifest.binary_sha256 !== binaryHash) throw new Error("runtime manifest binary_sha256 does not match codex.exe");
  const provenance = parseProvenance(await readFile(path.join(root, "provenance.json"), "utf8"), path.join(root, "provenance.json"));
  if (provenance.binary_sha256 !== undefined && String(provenance.binary_sha256).toLowerCase() !== binaryHash) throw new Error("runtime provenance binary_sha256 does not match codex.exe");
  return { exePath: path.join(root, "codex.exe"), manifest };
}

export async function stageRuntime(options) {
  const plan = await readPlanInputs(options);
  if (await verifyExistingVersion(plan)) {
    return { version: NATIVE_RUNTIME_VERSION, versionId: plan.versionId, versionDir: plan.versionDir, staged: true, alreadyStaged: true, manifest: plan.manifest };
  }
  await mkdir(plan.versionsDir, { recursive: true });
  const versionsInfo = await lstat(plan.versionsDir);
  if (versionsInfo.isSymbolicLink() || !versionsInfo.isDirectory()) throw new Error(`versions path is not a regular directory: ${plan.versionsDir}`);
  const tempDir = path.join(plan.versionsDir, `.stage-${randomUUID()}`);
  if (!inside(plan.runtimeRoot, tempDir) || !path.basename(tempDir).startsWith(".stage-")) throw new Error("refusing unsafe staging temp directory");
  let created = false;
  try {
    await mkdir(tempDir);
    created = true;
    const runtimeRealPath = await realpath(plan.runtimeRoot);
    const tempRealPath = await realpath(tempDir);
    if (!inside(runtimeRealPath, tempRealPath)) throw new Error("staging temp directory resolves outside runtimeDir");
    for (const entry of plan.fileInputs) {
      if (await hashFile(entry.source) !== entry.sha256) throw new Error(`staging input changed after preflight: ${entry.name}`);
      const destination = path.join(tempDir, entry.name);
      if (!inside(tempDir, destination)) throw new Error(`staged file path escapes temp directory: ${entry.name}`);
      await copyFile(entry.source, destination);
      if (await hashFile(destination) !== entry.sha256) throw new Error(`staged file hash mismatch: ${entry.name}`);
    }
    await writeFile(path.join(tempDir, MANIFEST_NAME), `${JSON.stringify(plan.manifest, null, 2)}\n`, { flag: "wx" });
    await rename(tempDir, plan.versionDir);
    created = false;
  } catch (error) {
    if (created && inside(plan.runtimeRoot, tempDir) && path.basename(tempDir).startsWith(".stage-")) {
      try {
        const runtimeRealPath = await realpath(plan.runtimeRoot);
        const tempRealPath = await realpath(tempDir);
        if (inside(runtimeRealPath, tempRealPath)) await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
    }
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      if (await verifyExistingVersion(plan)) {
        return { version: NATIVE_RUNTIME_VERSION, versionId: plan.versionId, versionDir: plan.versionDir, staged: true, alreadyStaged: true, manifest: plan.manifest };
      }
    }
    throw error;
  }
  return { version: NATIVE_RUNTIME_VERSION, versionId: plan.versionId, versionDir: plan.versionDir, staged: true, alreadyStaged: false, manifest: plan.manifest };
}

export async function checkStockCliVersion(stockCliPath, { versionChecker = defaultVersionChecker } = {}) {
  const output = await versionChecker(stockCliPath, ["--version"], { windowsHide: true });
  const text = typeof output === "string" ? output : output?.stdout ?? "";
  const escapedVersion = NATIVE_RUNTIME_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)(${escapedVersion})(?=\\s|$)`, "m").exec(text);
  if (!match || (typeof output !== "string" && output?.status !== 0)) {
    throw new Error(`expected stock CLI version ${NATIVE_RUNTIME_VERSION}; got ${text.trim() || "no version output"}`);
  }
  return match[1];
}

function defaultVersionChecker(exePath, args, options) {
  const result = spawnSync(exePath, args, { encoding: "utf8", timeout: 10_000, windowsHide: options?.windowsHide === true });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function parseArgs(argv) {
  let command = "plan";
  const args = {};
  const values = { "artifact-dir": "artifactDir", "companion-dir": "companionDir", "runtime-dir": "runtimeDir" };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) command = argv[index++];
  if (command !== "plan" && command !== "stage") throw new Error("usage: native-runtime.mjs [plan|stage] --artifact-dir PATH --companion-dir PATH --runtime-dir PATH");
  while (index < argv.length) {
    const key = values[argv[index].replace(/^--/, "")];
    const value = argv[index + 1];
    if (!key || !value || value.startsWith("--")) throw new Error("usage: native-runtime.mjs [plan|stage] --artifact-dir PATH --companion-dir PATH --runtime-dir PATH");
    args[key] = value;
    index += 2;
  }
  return { command, args };
}

async function main(argv) {
  const { command, args } = parseArgs(argv);
  const result = command === "stage" ? await stageRuntime(args) : await planRuntime(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
