import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REF_SCHEMA = "sol-luna-native-gateway-source-ref/v1";
const MANIFEST_SCHEMA = "sol-luna-native-gateway-source-manifest/v1";
const MANIFEST_NAME = "bundle-manifest.json";
const SCRIPT_NAMES = Object.freeze([
  "native-credentials.mjs",
  "native-gateway.mjs",
  "native-relay.mjs",
  "native-routing.mjs",
  "native-usage.mjs",
]);
const DEFAULT_ENTRY = "scripts/native-gateway.mjs";
const MANAGED_FILES = SCRIPT_NAMES.map((name) => `scripts/${name}`);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalJson = (value) => `${JSON.stringify(value)}\n`;
const normalized = (value) => process.platform === "win32" ? value.toLowerCase() : value;

function assertWithin(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".") return;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its managed root`);
  }
}

async function requireCanonicalDirectory(input, label) {
  const resolved = path.resolve(input);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  const actual = await realpath(resolved);
  if (normalized(actual) !== normalized(resolved)) throw new Error(`${label} must not traverse a reparse point`);
  return actual;
}

async function requireRegularFile(root, relative, label) {
  const candidate = path.resolve(root, relative);
  assertWithin(root, candidate, label);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const actual = await realpath(candidate);
  if (normalized(actual) !== normalized(candidate)) throw new Error(`${label} must not traverse a reparse point`);
  return readFile(candidate);
}

function contentDigest(files) {
  return sha256(Buffer.from(canonicalJson({ schema: MANIFEST_SCHEMA, files })));
}

function isValidEntry(entry) {
  return typeof entry === "string" && /^scripts\/[A-Za-z0-9._-]+\.mjs$/.test(entry);
}

async function verifyManifestBundle(directory, ref) {
  if (!ref || ref.schema !== REF_SCHEMA || !/^[a-f0-9]{64}$/.test(ref.contentDigest ?? "")
      || ref.relativeDirectory !== `gateway-source/${ref.contentDigest}`
      || !isValidEntry(ref.entry) || !/^[a-f0-9]{64}$/.test(ref.manifestSha256 ?? "")) {
    throw new Error("gateway source bundle reference is invalid");
  }
  const bytes = await requireRegularFile(directory, MANIFEST_NAME, "gateway source manifest");
  if (sha256(bytes) !== ref.manifestSha256) throw new Error("gateway source manifest hash changed");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("gateway source manifest is invalid JSON"); }
  if (manifest?.schema !== MANIFEST_SCHEMA || manifest.contentDigest !== ref.contentDigest || !Array.isArray(manifest.files)) {
    throw new Error("gateway source manifest identity is invalid");
  }
  const names = manifest.files.map((item) => item?.path);
  if (names.length === 0 || new Set(names).size !== names.length
      || names.some((name) => !isValidEntry(name))
      || JSON.stringify(names) !== JSON.stringify([...names].sort())
      || !names.includes(ref.entry)) throw new Error("gateway source bundle file list is not canonical");
  if (manifest.files.some((item) => !/^[a-f0-9]{64}$/.test(item?.sha256 ?? "")) || contentDigest(manifest.files) !== ref.contentDigest) {
    throw new Error("gateway source bundle digest is invalid");
  }
  if (Array.isArray(ref.files) && JSON.stringify(manifest.files) !== JSON.stringify(ref.files)) {
    throw new Error("gateway source bundle file list changed from its reference");
  }
  const expected = new Set([...manifest.files.map((item) => item.path), MANIFEST_NAME]);
  const found = new Set();
  async function walk(current, relative = "") {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${item.name}` : item.name;
      const full = path.join(current, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink() || item.isSymbolicLink()) throw new Error("gateway source bundle contains a reparse point");
      if (info.isDirectory()) {
        if (rel !== "scripts") throw new Error("gateway source bundle contains an unexpected directory");
        await walk(full, rel);
      } else if (info.isFile()) {
        if (!expected.has(rel) || found.has(rel)) throw new Error("gateway source bundle contains an unexpected file");
        found.add(rel);
      } else throw new Error("gateway source bundle contains a non-regular entry");
    }
  }
  await walk(directory);
  if (found.size !== expected.size || [...expected].some((name) => !found.has(name))) throw new Error("gateway source bundle is incomplete");
  for (const item of manifest.files) {
    const file = await requireRegularFile(directory, item.path, "gateway source module");
    if (sha256(file) !== item.sha256) throw new Error(`gateway source module hash changed: ${item.path}`);
  }
  return true;
}

export async function verifyGatewaySource(ref, { runtimeRoot } = {}) {
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) throw new Error("gateway source runtimeRoot must be absolute");
  const root = await requireCanonicalDirectory(runtimeRoot, "gateway source runtimeRoot");
  const relative = ref?.relativeDirectory;
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\\")) throw new Error("gateway source bundle path is invalid");
  const directory = path.resolve(root, ...relative.split("/"));
  assertWithin(root, directory, "gateway source bundle");
  const canonicalBundle = await requireCanonicalDirectory(directory, "gateway source bundle");
  if (normalized(canonicalBundle) !== normalized(directory)) throw new Error("gateway source bundle path is not canonical");
  return verifyManifestBundle(directory, ref);
}

export function gatewaySourceEntry(ref, runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot) || typeof ref?.relativeDirectory !== "string" || !isValidEntry(ref?.entry)) {
    throw new Error("gateway source reference and absolute runtimeRoot are required");
  }
  if (!/^[a-f0-9]{64}$/.test(ref.contentDigest ?? "") || ref.relativeDirectory !== `gateway-source/${ref.contentDigest}`
      ) throw new Error("gateway source bundle reference is invalid");
  return path.resolve(path.resolve(runtimeRoot), ...ref.relativeDirectory.split("/"), ...ref.entry.split("/"));
}

export async function cleanupOwnedGatewaySourceStage(storePath, temporaryPath) {
  if (typeof storePath !== "string" || !path.isAbsolute(storePath)
      || typeof temporaryPath !== "string" || !path.isAbsolute(temporaryPath)) {
    throw new Error("gateway source cleanup paths must be absolute");
  }
  const store = path.resolve(storePath);
  const temporary = path.resolve(temporaryPath);
  if (normalized(path.dirname(temporary)) !== normalized(store) || !/^\.stage-[A-Za-z0-9-]+$/.test(path.basename(temporary))) {
    throw new Error("gateway source cleanup target is not an owned staging child");
  }
  const storeInfo = await lstat(store);
  if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink()) throw new Error("gateway source cleanup store must be a regular directory");
  const canonicalStore = await realpath(store);
  if (normalized(canonicalStore) !== normalized(store)) throw new Error("gateway source cleanup store must not traverse a reparse point");
  const temporaryInfo = await lstat(temporary);
  if (!temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink()) throw new Error("gateway source cleanup target must be a regular directory");
  const canonicalTemporary = await realpath(temporary);
  if (normalized(canonicalTemporary) !== normalized(temporary)) throw new Error("gateway source cleanup target must not traverse a reparse point");
  assertWithin(canonicalStore, canonicalTemporary, "owned temporary gateway source stage");
  await rm(temporary, { recursive: true, force: true });
}

export async function stageGatewaySource({ pluginRoot, runtimeRoot, sourceFiles: requestedFiles = SCRIPT_NAMES, entry = DEFAULT_ENTRY } = {}) {
  if (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot)
      || typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw new Error("pluginRoot and runtimeRoot must be absolute to stage gateway source");
  }
  if (!isValidEntry(entry)) throw new Error("gateway source entry must be a scripts/*.mjs path");
  const sourceNames = [...requestedFiles];
  if (sourceNames.length === 0 || new Set(sourceNames).size !== sourceNames.length
      || sourceNames.some((name) => typeof name !== "string" || path.basename(name) !== name || !name.endsWith(".mjs"))) {
    throw new Error("gateway source file list must contain unique script filenames");
  }
  const managedFiles = sourceNames.map((name) => `scripts/${name}`).sort();
  if (!managedFiles.includes(entry)) throw new Error("gateway source entry must be part of its file list");
  const sourceRoot = await requireCanonicalDirectory(pluginRoot, "pluginRoot");
  const scriptsRoot = path.join(sourceRoot, "scripts");
  await requireCanonicalDirectory(scriptsRoot, "plugin scripts directory");
  const sourceFiles = [];
  for (const relative of managedFiles) {
    const bytes = await requireRegularFile(sourceRoot, relative, "plugin gateway source");
    sourceFiles.push({ path: relative, bytes });
  }
  const files = sourceFiles.map(({ path: name, bytes }) => ({ path: name, sha256: sha256(bytes) }));
  const digest = contentDigest(files);
  const manifestBytes = Buffer.from(canonicalJson({ schema: MANIFEST_SCHEMA, contentDigest: digest, files }));
  const resolvedRuntimeRoot = await requireCanonicalDirectory(runtimeRoot, "gateway source runtimeRoot");
  const store = path.join(resolvedRuntimeRoot, "gateway-source");
  try { await mkdir(store); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const storeInfo = await lstat(store);
  if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink() || normalized(await realpath(store)) !== normalized(store)) {
    throw new Error("gateway source store must be a regular managed directory");
  }
  const relativeDirectory = `gateway-source/${digest}`;
  const finalDirectory = path.join(resolvedRuntimeRoot, ...relativeDirectory.split("/"));
  assertWithin(resolvedRuntimeRoot, finalDirectory, "gateway source bundle");
  const ref = {
    schema: REF_SCHEMA,
    contentDigest: digest,
    relativeDirectory,
    entry,
    manifestSha256: sha256(manifestBytes),
  };
  let finalExists = false;
  try {
    await lstat(finalDirectory);
    finalExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (finalExists) {
    await verifyGatewaySource(ref, { runtimeRoot: resolvedRuntimeRoot });
    return { ...ref, files };
  }
  const tempDirectory = path.join(store, `.stage-${randomUUID()}`);
  let ownsTemp = false;
  try {
    await mkdir(tempDirectory);
    ownsTemp = true;
    const tempScripts = path.join(tempDirectory, "scripts");
    await mkdir(tempScripts);
    for (const { path: relative, bytes } of sourceFiles) {
      const destination = path.join(tempDirectory, ...relative.split("/"));
      await writeFile(destination, bytes, { flag: "wx" });
    }
    await writeFile(path.join(tempDirectory, MANIFEST_NAME), manifestBytes, { flag: "wx" });
    await verifyManifestBundle(tempDirectory, ref);
    try {
      await rename(tempDirectory, finalDirectory);
      ownsTemp = false;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      await verifyGatewaySource(ref, { runtimeRoot: resolvedRuntimeRoot });
    }
    return { ...ref, files };
  } finally {
    if (ownsTemp) await cleanupOwnedGatewaySourceStage(store, tempDirectory);
  }
}
