import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packagePlugin } from "../scripts/package-plugin.mjs";

if (process.platform !== "win32") {
  console.log("SKIP: plugin ZIP packaging uses Windows PowerShell/.NET; the Windows job runs the real archive tests.");
} else {
await runWindowsZipTests();
}

async function runWindowsZipTests() {
const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "plugin-distribution-fixture-"));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershell = process.env.POWERSHELL_EXE || "powershell.exe";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = {
  name: "sol-luna-deepseek-router", version: "0.12.3", mcpServers: "./.mcp.json",
};
const marketplace = {
  name: "fixture-registry", plugins: [{ name: manifest.name, source: { source: "local", path: "./" } }],
};
const mcp = { mcpServers: { [manifest.name]: { command: "node", args: ["scripts/plugin-mcp.mjs"], cwd: "." } } };
const files = new Map([
  [".codex-plugin/plugin.json", JSON.stringify(manifest)],
  [".agents/plugins/marketplace.json", JSON.stringify(marketplace)],
  [".mcp.json", JSON.stringify(mcp)],
  ["agents/openai.yaml", "display_name: test\n"],
  ["hooks/hooks.json", JSON.stringify({ hooks: {} })],
  ["ui/router-settings.html", "<!doctype html><title>fixture</title>"],
  ["scripts/plugin-mcp.mjs", "export {};"],
  ["scripts/route-hook.mjs", "export {};"],
  ["scripts/native-bootstrap-install.mjs", "export const bootstrap = true;"],
  ["scripts/native-bootstrap-maintenance.mjs", "export const maintenance = true;"],
  ["scripts/native-api-bootstrap-gate.mjs", "export const apiGate = true;"],
  ["scripts/native-router-maintenance-lock.mjs", "export const maintenanceLock = true;"],
  ["scripts/native-upgrade-guard.mjs", "export const guard = true;"],
  ["scripts/native-upgrade-status.mjs", "export const status = true;"],
  ["scripts/normalize-cargo-workspace-lock.mjs", "CI build helper; do not ship"],
  ["scripts/patch-backend-windows.mjs", "CLI source patch helper; do not ship"],
  ["scripts/helper.ps1", "Write-Output 'runtime helper'"],
  ["native/bootstrap/bootstrap.c", "int main(void) { return 0; }"],
  ["native/bootstrap/codex-bootstrap.exe", Buffer.from([0x4d, 0x5a, 0x00, 0xff])],
  ["README.md", "# Router\n"], ["SKILL.md", "# Skill\n"], ["PLUGIN.md", "# Plugin\n"], ["LICENSE", "MIT\n"],
  ["docs/native-isolated-install.md", "Install notes\n"],
  ["docs/native-connection-diagnostics.md", "Diagnostics notes\n"],
  ["docs/superpowers/specs/private-review.md", "must not ship"],
  ["tests/fixture.test.mjs", "must not ship"],
  ["evidence/report.json", "must not ship"],
  ["procedures/private.md", "must not ship"],
  ["work/generated.txt", "must not ship"],
  [".env", "SECRET=fixture-secret"],
  ["credentials/token.txt", "fixture-secret"],
  ["AGENTS.md", "build instructions must not ship"],
  ["CLAUDE.md", "build instructions must not ship"],
]);
async function createFixture(name, overrides = {}, omit = []) {
  const source = path.join(root, name);
  await mkdir(source, { recursive: true });
  for (const [relative, content] of files) {
    if (omit.includes(relative)) continue;
    const destination = path.join(source, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, overrides[relative] ?? content);
  }
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Fixture Builder");
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "add", "--all");
  git(source, "commit", "--quiet", "-m", "distribution fixture");
  await writeFile(path.join(source, ".env.local"), "UNTRACKED=must-not-ship");
  await writeFile(path.join(source, "scripts", "untracked-helper.mjs"), "untracked generated file");
  return source;
}
async function inspectZip(zipPath) {
  const helper = path.join(repoRoot, "scripts", "package-plugin-zip.ps1");
  const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", "inspect", "-Zip", zipPath], { encoding: "utf8", windowsHide: true });
  return JSON.parse(output.trim());
}
function readZipManifest(zipPath) {
  const helper = path.join(repoRoot, "scripts", "package-plugin-zip.ps1");
  return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", "manifest", "-Zip", zipPath], { encoding: "utf8", windowsHide: true }).trim();
}
try {
  const source = await createFixture("source repo 空格");
  const outputDir = path.join(root, "external distributions 文件夹");
  const output = path.join(outputDir, "router candidate.zip");
  const result = await packagePlugin({ source, out: output });
  assert.equal(result.version, "0.12.3");
  assert.equal(result.registryId, "fixture-registry");
  assert.equal(result.sourceCommit, git(source, "rev-parse", "HEAD"));
  assert.ok(result.fileCount >= 15, "runtime inventory is nonempty and includes required modules");
  assert.ok(result.bytes > 0, "the output is a real nonempty ZIP");
  const zipEntries = await inspectZip(output);
  const zipMap = new Map(zipEntries.map((entry) => [entry.path, entry]));
  const manifestEntry = zipMap.get("package-manifest.json");
  assert.ok(manifestEntry, "archive contains package-manifest.json");
  assert.equal(manifestEntry.sha256, result.manifestSha256, "archive manifest bytes match returned manifest digest");
  const archivedManifest = JSON.parse(Buffer.from(readZipManifest(output), "base64").toString("utf8"));
  assert.deepEqual(archivedManifest, result.packageManifest, "the real ZIP's decompressed manifest matches the returned inventory");
  for (const file of result.files) {
    const entry = zipMap.get(file.path);
    assert.ok(entry, `archive includes ${file.path}`);
    assert.equal(entry.size, file.size, `${file.path} extracted size matches inventory`);
    assert.equal(entry.sha256, file.sha256, `${file.path} extracted bytes match inventory`);
  }
  const listed = new Set(result.files.map((entry) => entry.path));
  for (const excluded of ["tests/fixture.test.mjs", "evidence/report.json", "procedures/private.md", "work/generated.txt", ".env", ".env.local", "credentials/token.txt", "AGENTS.md", "CLAUDE.md", "scripts/untracked-helper.mjs", "scripts/normalize-cargo-workspace-lock.mjs", "scripts/patch-backend-windows.mjs", "docs/superpowers/specs/private-review.md"]) assert.equal(listed.has(excluded), false, `${excluded} is excluded`);
  for (const required of [".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", ".mcp.json", "hooks/hooks.json", "ui/router-settings.html", "scripts/native-bootstrap-install.mjs", "scripts/native-bootstrap-maintenance.mjs", "scripts/native-api-bootstrap-gate.mjs", "scripts/native-router-maintenance-lock.mjs", "scripts/native-upgrade-guard.mjs", "scripts/native-upgrade-status.mjs", "native/bootstrap/codex-bootstrap.exe", "native/bootstrap/bootstrap.c", "SKILL.md", "README.md", "LICENSE"]) assert.equal(listed.has(required), true, `${required} is packaged`);
  assert.equal(JSON.stringify(result.packageManifest).includes(source), false, "package metadata contains no source absolute path");
  assert.equal(JSON.stringify(result.packageManifest).includes("fixture-secret"), false, "package metadata contains no fixture secret");
  assert.equal(result.packageManifest.files.some((entry) => entry.path === "package-manifest.json"), false, "manifest does not self-hash");
  const before = sha(await readFile(output));
  await assert.rejects(() => packagePlugin({ source, out: output }), /already exists/i, "existing ZIP is not overwritten");
  assert.equal(sha(await readFile(output)), before, "rejected repeated output leaves prior ZIP unchanged");

  const tempAlias = root + "-temp-junction";
  await symlink(root, tempAlias, "junction");
  const originalTemp = process.env.TEMP;
  try {
    process.env.TEMP = tempAlias;
    const tempJunctionOutput = path.join(outputDir, "temp junction.zip");
    const tempJunctionResult = await packagePlugin({ source, out: tempJunctionOutput });
    assert.ok(tempJunctionResult.bytes > 0, "packaging succeeds when TEMP is reached through a junction");
    assert.equal((await inspectZip(tempJunctionOutput)).length, tempJunctionResult.fileCount + 1, "TEMP junction package has a complete archive inventory");
  } finally {
    if (originalTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = originalTemp;
    await rm(tempAlias, { recursive: true, force: true });
  }

  const dirtySource = await createFixture("dirty tracked source");
  await writeFile(path.join(dirtySource, "README.md"), "modified tracked source");
  await assert.rejects(() => packagePlugin({ source: dirtySource, out: path.join(root, "external distributions 文件夹", "dirty.zip") }), /clean tracked/i, "dirty tracked tree cannot claim its HEAD as package contents");

  const unsupported = await createFixture("unsupported manifest", { ".codex-plugin/plugin.json": JSON.stringify({ ...manifest, name: "unexpected-plugin" }) });
  await assert.rejects(() => packagePlugin({ source: unsupported, out: path.join(root, "external distributions 文件夹", "unsupported.zip") }), /unsupported plugin manifest/i);
  const missing = await createFixture("missing assets", {}, ["native/bootstrap/codex-bootstrap.exe"]);
  await assert.rejects(() => packagePlugin({ source: missing, out: path.join(root, "external distributions 文件夹", "missing.zip") }), /required asset/i);

  const symlinkSource = await createFixture("symlink source");
  git(symlinkSource, "config", "core.symlinks", "false");
  // Replace a tracked runtime script's index entry with a symlink blob without creating or following a filesystem link.
  const linkContent = Buffer.from("../../outside/secret.mjs");
  const object = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: symlinkSource, input: linkContent, encoding: "utf8" }).trim();
  git(symlinkSource, "update-index", "--cacheinfo", `120000,${object},scripts/helper.ps1`);
  git(symlinkSource, "checkout-index", "--force", "--", "scripts/helper.ps1");
  git(symlinkSource, "commit", "--quiet", "-m", "tracked symlink fixture");
  await assert.rejects(() => packagePlugin({ source: symlinkSource, out: path.join(root, "external distributions 文件夹", "symlink.zip") }), /symlink/i, "tracked symlink is rejected without resolving its target");

  const junction = path.join(root, "source junction");
  await symlink(source, junction, "junction");
  await assert.rejects(() => packagePlugin({ source: junction, out: path.join(root, "external distributions 文件夹", "junction.zip") }), /symlink or junction/i, "a user-provided source junction is rejected");
  console.log("plugin distribution tests passed");
} finally {
  try { await rm(root, { recursive: true, force: true }); } catch (error) { if (error.code !== "EBUSY") throw error; }
}
}
