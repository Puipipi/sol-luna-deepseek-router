import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_MANIFEST = "package-manifest.json";
const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const ROOT_FILES = new Set([
  ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", ".mcp.json", "agents/openai.yaml",
  "hooks/hooks.json", "ui/router-settings.html", "scripts/plugin-mcp.mjs", "scripts/route-hook.mjs",
  "native/bootstrap/bootstrap.c", "native/bootstrap/codex-bootstrap.exe",
  "README.md", "SKILL.md", "PLUGIN.md", "LICENSE",
]);
const GUIDE_DOCS = new Set([
  "docs/native-account-auth.md", "docs/native-api-executors.md", "docs/native-catalog.md",
  "docs/native-connection-diagnostics.md", "docs/native-isolated-cli-build.md", "docs/native-isolated-files.md",
  "docs/native-isolated-install.md", "docs/native-runtime-env.md", "docs/native-timeout.md",
  "docs/native-upgrade-guard.md", "docs/router-settings-mcp.md",
]);
const BUILD_ONLY_SCRIPTS = new Set([
  "scripts/normalize-cargo-workspace-lock.mjs",
  "scripts/patch-backend-windows.mjs",
]);
const REQUIRED_FILES = [
  ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", ".mcp.json", "agents/openai.yaml",
  "hooks/hooks.json", "ui/router-settings.html", "scripts/plugin-mcp.mjs", "scripts/route-hook.mjs",
  "scripts/native-bootstrap-install.mjs", "scripts/native-upgrade-guard.mjs", "scripts/native-upgrade-status.mjs",
  "scripts/native-api-bootstrap-gate.mjs", "scripts/native-bootstrap-maintenance.mjs", "scripts/native-router-maintenance-lock.mjs",
  "native/bootstrap/bootstrap.c", "native/bootstrap/codex-bootstrap.exe", "README.md", "SKILL.md", "PLUGIN.md", "LICENSE",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
const equalPath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function git(source, args, encoding = "utf8") {
  try {
    const options = { cwd: source, stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_GIT_BUFFER };
    if (encoding !== "buffer") options.encoding = encoding;
    return execFileSync("git", args, options);
  } catch {
    throw new Error("source repository could not be inspected with local Git");
  }
}
function safeRelative(relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\\") || /[\u0000-\u001f\u007f]/.test(relative) || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return false;
  return relative.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":"));
}
function isIncluded(relative) {
  if (ROOT_FILES.has(relative) || GUIDE_DOCS.has(relative)) return true;
  if (relative.startsWith("scripts/")) {
    return /\.(?:mjs|ps1)$/i.test(relative)
      && !/(?:^|\/)[^/]*\.test\.mjs$/i.test(relative)
      && !BUILD_ONLY_SCRIPTS.has(relative)
      && !["scripts/package-plugin.mjs", "scripts/package-plugin-zip.ps1"].includes(relative);
  }
  if (relative.startsWith("hooks/")) return /\.(?:json|mjs|ps1)$/i.test(relative);
  if (relative.startsWith("ui/")) return /\.(?:html|css|js)$/i.test(relative);
  if (relative.startsWith("native/bootstrap/")) return /\.(?:exe|c|provenance\.json|sha256)$/i.test(relative);
  return false;
}
function parseManifest(bytes, relative) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`invalid JSON in required manifest: ${relative}`); }
}
function validateContracts(entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  const plugin = parseManifest(byPath.get(".codex-plugin/plugin.json"), ".codex-plugin/plugin.json");
  if (plugin.name !== "sol-luna-deepseek-router" || !/^\d+\.\d+\.\d+$/.test(plugin.version ?? "") || plugin.mcpServers !== "./.mcp.json") {
    throw new Error("unsupported plugin manifest contract");
  }
  const registry = parseManifest(byPath.get(".agents/plugins/marketplace.json"), ".agents/plugins/marketplace.json");
  const matching = Array.isArray(registry.plugins) ? registry.plugins.filter((item) => item?.name === plugin.name) : [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(registry.name ?? "") || matching.length !== 1 || matching[0].source?.path !== "./") {
    throw new Error("unsupported marketplace registry contract");
  }
  const mcp = parseManifest(byPath.get(".mcp.json"), ".mcp.json");
  const server = mcp.mcpServers?.[plugin.name];
  if (server?.command !== "node" || server?.cwd !== "." || !Array.isArray(server.args) || server.args[0] !== "scripts/plugin-mcp.mjs") {
    throw new Error("unsupported plugin MCP entrypoint contract");
  }
  return { pluginName: plugin.name, version: plugin.version, registryId: registry.name };
}
async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  let canonical;
  try { canonical = await realpath(path.resolve(value)); }
  catch { throw new Error(`${label} does not exist or cannot be resolved`); }
  if (!equalPath(canonical, path.resolve(value))) throw new Error(`${label} must not traverse a symlink or junction`);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  return canonical;
}
async function rejectSymlinkPathComponents(value, label) {
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") return; throw new Error(`${label} path cannot be inspected`); }
    if (info.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink or junction`);
  }
}
async function assertOutputDirectory(outputDir, sourceRoot) {
  await rejectSymlinkPathComponents(outputDir, "output directory");
  await mkdir(outputDir, { recursive: true });
  const canonical = await canonicalDirectory(outputDir, "output directory");
  if (isWithin(sourceRoot, canonical) || isWithin(canonical, sourceRoot)) throw new Error("output directory must be disjoint from the source tree");
  return canonical;
}
async function safeRemoveStage(stageRoot, sourceRoot) {
  if (!stageRoot) return;
  const canonical = await realpath(stageRoot).catch(() => null);
  if (!canonical || !equalPath(canonical, stageRoot) || isWithin(sourceRoot, canonical) || isWithin(canonical, sourceRoot)) {
    throw new Error("temporary package cleanup path failed its safety check");
  }
  await rm(canonical, { recursive: true, force: true });
}
function readTrackedFiles(source, commit) {
  const listing = git(source, ["ls-files", "--stage", "-z"], "buffer").toString("utf8");
  const selected = [];
  const seen = new Set();
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("Git tracked file list is malformed");
    const [mode, object, stage] = record.slice(0, tab).split(" ");
    const relative = record.slice(tab + 1);
    if (!isIncluded(relative)) continue;
    if (!safeRelative(relative)) throw new Error("unsafe relative path in plugin package allowlist");
    if (mode === "120000") throw new Error(`symlink is not allowed in package path: ${relative}`);
    if (mode !== "100644" && mode !== "100755") throw new Error(`non-regular tracked asset is not allowed: ${relative}`);
    const folded = relative.toLowerCase();
    if (seen.has(folded)) throw new Error("case-colliding paths are not supported in Windows ZIP packages");
    seen.add(folded);
    if (stage !== "0" || !/^[a-f0-9]{40,64}$/.test(object)) throw new Error("invalid Git blob metadata in source tree");
    const bytes = git(source, ["cat-file", "blob", `${commit}:${relative}`], "buffer");
    selected.push({ path: relative, bytes, size: bytes.length, sha256: sha256(bytes) });
  }
  selected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const found = new Set(selected.map((entry) => entry.path));
  const missing = REQUIRED_FILES.filter((relative) => !found.has(relative));
  if (missing.length) throw new Error(`required asset is missing from tracked source: ${missing[0]}`);
  return selected;
}
function runZipHelper(helper, action, values) {
  const executable = process.env.POWERSHELL_EXE || "powershell.exe";
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", action, ...values], {
    encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("Windows .NET ZIP operation failed");
  return result.stdout.trim();
}
function inspectArchive(helper, zipPath, packageManifest) {
  let entries;
  try { entries = JSON.parse(runZipHelper(helper, "inspect", ["-Zip", zipPath])); }
  catch { throw new Error("generated ZIP could not be inspected"); }
  if (!Array.isArray(entries)) throw new Error("generated ZIP inventory is malformed");
  const expected = new Map(packageManifest.files.map((entry) => [entry.path, entry]));
  const manifestBytes = Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
  expected.set(PACKAGE_MANIFEST, { path: PACKAGE_MANIFEST, size: manifestBytes.length, sha256: sha256(manifestBytes) });
  if (entries.length !== expected.size) throw new Error("generated ZIP has unexpected or missing entries");
  const actual = new Set();
  for (const entry of entries) {
    if (!safeRelative(entry.path) || actual.has(entry.path)) throw new Error("generated ZIP contains an unsafe or duplicate path");
    actual.add(entry.path);
    const wanted = expected.get(entry.path);
    if (!wanted || entry.size !== wanted.size || entry.sha256 !== wanted.sha256) throw new Error("generated ZIP content does not match its SHA-256 inventory");
  }
  return { manifestSha256: sha256(manifestBytes), manifestSize: manifestBytes.length };
}

export async function packagePlugin({ source, out } = {}) {
  const sourceRoot = await canonicalDirectory(source, "source");
  const repository = git(sourceRoot, ["rev-parse", "--show-toplevel"]).trim();
  if (!equalPath(await realpath(repository), sourceRoot)) throw new Error("source must be the Git repository root");
  const dirty = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (dirty) throw new Error("source repository must have a clean tracked working tree");
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("source HEAD is not a full Git commit");
  if (typeof out !== "string" || !path.isAbsolute(out) || path.extname(out).toLowerCase() !== ".zip") throw new Error("out must be an absolute .zip path");
  const outputPath = path.resolve(out);
  const outputDir = await assertOutputDirectory(path.dirname(outputPath), sourceRoot);
  if (!equalPath(path.dirname(outputPath), outputDir)) throw new Error("output path must not traverse a symlink or junction");
  try { await lstat(outputPath); throw new Error("output ZIP already exists; refusing to overwrite it"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const selected = readTrackedFiles(sourceRoot, commit);
  const contract = validateContracts(selected);
  const canonicalTempParent = await realpath(os.tmpdir());
  const stateRoot = await mkdtemp(path.join(canonicalTempParent, "sol-luna-plugin-package-"));
  const stage = path.join(stateRoot, "content");
  const zipTemp = path.join(outputDir, `.plugin-${randomUUID()}.tmp.zip`);
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "package-plugin-zip.ps1");
  let linked = false;
  try {
    const tempReal = await realpath(stateRoot);
    if (!equalPath(tempReal, stateRoot) || isWithin(sourceRoot, tempReal) || isWithin(tempReal, sourceRoot)) throw new Error("temporary package directory failed its safety check");
    await mkdir(stage);
    const packageManifest = {
      version: contract.version,
      registryId: contract.registryId,
      pluginName: contract.pluginName,
      sourceCommit: commit,
      files: selected.map(({ path: relative, size, sha256: hash }) => ({ path: relative, size, sha256: hash })),
    };
    for (const entry of selected) {
      const destination = path.join(stage, ...entry.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.bytes, { flag: "wx" });
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(stage, PACKAGE_MANIFEST), manifestBytes, { flag: "wx" });
    runZipHelper(helper, "create", ["-Stage", stage, "-Zip", zipTemp]);
    const verification = inspectArchive(helper, zipTemp, packageManifest);
    await link(zipTemp, outputPath);
    linked = true;
    await unlink(zipTemp);
    const outputStat = await stat(outputPath);
    const outputHash = sha256(await readFile(outputPath));
    return {
      out: outputPath,
      version: contract.version,
      registryId: contract.registryId,
      sourceCommit: commit,
      fileCount: selected.length,
      bytes: outputStat.size,
      zipSha256: outputHash,
      manifestSha256: verification.manifestSha256,
      packageManifest,
      files: packageManifest.files,
    };
  } finally {
    await unlink(zipTemp).catch(() => {});
    await safeRemoveStage(stateRoot, sourceRoot);
  }
}

async function main(argv) {
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  try {
    const result = await packagePlugin({ source: value("source"), out: value("out") });
    process.stdout.write(`${JSON.stringify({ out: result.out, version: result.version, registryId: result.registryId, sourceCommit: result.sourceCommit, fileCount: result.fileCount, bytes: result.bytes, zipSha256: result.zipSha256, manifestSha256: result.manifestSha256 })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
