import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NATIVE_RUNTIME_PATCH_SHA256, checkStockCliVersion, planRuntime, stageRuntime, verifyRuntimeVersion } from "../scripts/native-runtime.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const rejects = async (fn, pattern, message) => { await assert.rejects(fn, pattern, message); checks += 1; };
const sha = (value) => createHash("sha256").update(value).digest("hex");

const root = await mkdtemp(path.join(os.tmpdir(), "native-runtime-test-"));
try {
  const artifactDir = path.join(root, "artifact");
  const companionDir = path.join(root, "stock-bin");
  const runtimeDir = path.join(root, "runtime");
  await mkdir(artifactDir);
  await mkdir(companionDir);
  const binary = Buffer.from("test binary fixture");
  const stockBinary = Buffer.from("unexecuted stock codex fixture");
  const companions = {
    "codex-code-mode-host.exe": Buffer.from("code mode host"),
    "codex-command-runner.exe": Buffer.from("command runner"),
    "codex-windows-sandbox-setup.exe": Buffer.from("sandbox setup"),
    "codex-windows-sandbox-service.exe": Buffer.from("optional service"),
    "unrelated.exe": Buffer.from("must not be staged"),
  };
  await writeFile(path.join(artifactDir, "codex.exe"), binary);
  await writeFile(path.join(artifactDir, "LICENSE"), "upstream license\n");
  await writeFile(path.join(artifactDir, "NOTICE"), "upstream notice\n");
  for (const [name, value] of Object.entries(companions)) await writeFile(path.join(companionDir, name), value);
  await writeFile(path.join(companionDir, "codex.exe"), stockBinary);
  const provenance = {
    source_commit: "6905ecede7816e91373e9eabda3f6b0368fc747b",
    patch_sha256: NATIVE_RUNTIME_PATCH_SHA256,
    target: "x86_64-pc-windows-msvc",
  };
  await writeFile(path.join(artifactDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

  const before = await readdir(artifactDir);
  const versionChecker = async (exePath, args, options) => {
    equal(path.basename(exePath), "codex.exe", "preflight checks the stock companion CLI");
    equal(args.join(" "), "--version", "preflight runs only the stock version command");
    equal(options.windowsHide, true, "stock version command is hidden");
    return "codex-cli 0.164.0-alpha.11.1\n";
  };
  const plan = await planRuntime({ artifactDir, companionDir, runtimeDir, versionChecker });
  equal(plan.version, "0.164.0-alpha.11.1", "plan identifies the pinned release from source metadata");
  equal(plan.staged, false, "read-only plan does not claim the runtime is staged");
  equal((await readdir(artifactDir)).join(","), before.join(","), "plan does not mutate artifact inputs");
  equal((await stat(runtimeDir).catch(() => null)), null, "plan does not create runtime directories");

  const staged = await stageRuntime({ artifactDir, companionDir, runtimeDir, versionChecker });
  ok(staged.staged, "stage reports staged without claiming activation");
  ok(staged.versionDir.startsWith(path.join(runtimeDir, "versions")), "staging stays under the versioned runtime directory");
  ok(path.basename(staged.versionDir).startsWith(`6905ecede781-${NATIVE_RUNTIME_PATCH_SHA256.slice(0, 12)}-`), "version directory is keyed by source, patch, and binary hashes");
  equal(await readFile(path.join(staged.versionDir, "codex.exe"), "utf8"), binary.toString("utf8"), "artifact CLI is staged");
  for (const [name, value] of Object.entries(companions)) {
    if (name === "unrelated.exe") equal(await stat(path.join(staged.versionDir, name)).catch(() => null), null, "unrelated files are not staged");
    else equal(await readFile(path.join(staged.versionDir, name), "utf8"), value.toString("utf8"), `${name} companion is staged`);
  }
  equal(await readFile(path.join(staged.versionDir, "LICENSE"), "utf8"), "upstream license\n", "upstream LICENSE is staged");
  equal(await readFile(path.join(staged.versionDir, "NOTICE"), "utf8"), "upstream notice\n", "upstream NOTICE is staged");
  const manifest = JSON.parse(await readFile(path.join(staged.versionDir, "runtime-manifest.json"), "utf8"));
  equal(manifest.source_commit, provenance.source_commit, "manifest records source commit");
  equal(manifest.patch_sha256, provenance.patch_sha256, "manifest records patch hash");
  equal(manifest.target, provenance.target, "manifest records target triple");
  equal(manifest.stock_cli_version, "0.164.0-alpha.11.1", "manifest records preflight stock CLI version");
  equal(manifest.files["codex.exe"], sha(binary), "manifest records staged CLI hash");
  equal(manifest.files["codex-command-runner.exe"], sha(companions["codex-command-runner.exe"]), "manifest records helper hash");
  equal(manifest.files["provenance.json"], sha(await readFile(path.join(artifactDir, "provenance.json"))), "manifest records provenance hash");
  const verified = await verifyRuntimeVersion(staged.versionDir);
  equal(verified.exePath, path.join(staged.versionDir, "codex.exe"), "runtime verifier returns the staged CLI path");
  equal(verified.manifest.binary_sha256, sha(binary), "runtime verifier returns the verified manifest");
  const repeated = await stageRuntime({ artifactDir, companionDir, runtimeDir, versionChecker });
  equal(repeated.versionDir, staged.versionDir, "same inputs stage idempotently");
  equal(repeated.alreadyStaged, true, "repeat stage validates and reports existing version");

  await writeFile(path.join(staged.versionDir, "codex.exe"), "tampered");
  await rejects(() => verifyRuntimeVersion(staged.versionDir), /hash mismatch.*codex\.exe/i, "runtime verifier rejects a changed staged executable");
  await rejects(() => stageRuntime({ artifactDir, companionDir, runtimeDir, versionChecker }), /existing staged version.*changed/i, "modified existing version is refused without overwrite");
  equal(await readFile(path.join(staged.versionDir, "codex.exe"), "utf8"), "tampered", "refusal leaves existing staged files untouched");

  const badArtifact = path.join(root, "bad-artifact");
  await mkdir(badArtifact);
  await writeFile(path.join(badArtifact, "codex.exe"), binary);
  await writeFile(path.join(badArtifact, "provenance.json"), JSON.stringify({ ...provenance, binary_sha256: "0".repeat(64) }));
  const badRuntime = path.join(root, "bad-runtime");
  await rejects(() => stageRuntime({ artifactDir: badArtifact, companionDir, runtimeDir: badRuntime, versionChecker }), /binary_sha256.*does not match/i, "provenance binary hash mismatch is refused before staging");
  equal(await stat(badRuntime).catch(() => null), null, "invalid artifact creates no runtime path");

  const wrongSourceArtifact = path.join(root, "wrong-source-artifact");
  await mkdir(wrongSourceArtifact);
  await writeFile(path.join(wrongSourceArtifact, "codex.exe"), binary);
  await writeFile(path.join(wrongSourceArtifact, "provenance.json"), JSON.stringify({ ...provenance, source_commit: "4ebc485ca321243727539187169425fcf972f2c4" }));
  await rejects(() => planRuntime({ artifactDir: wrongSourceArtifact, companionDir, runtimeDir: path.join(root, "wrong-source-runtime"), versionChecker }), /source_commit.*approved source/i, "provenance from the superseded source is refused");
  equal(await stat(path.join(root, "wrong-source-runtime")).catch(() => null), null, "wrong source commit creates no runtime path");

  const wrongPatchArtifact = path.join(root, "wrong-patch-artifact");
  await mkdir(wrongPatchArtifact);
  await writeFile(path.join(wrongPatchArtifact, "codex.exe"), binary);
  await writeFile(path.join(wrongPatchArtifact, "provenance.json"), JSON.stringify({ ...provenance, patch_sha256: "0".repeat(64) }));
  await rejects(() => planRuntime({ artifactDir: wrongPatchArtifact, companionDir, runtimeDir: path.join(root, "wrong-patch-runtime"), versionChecker }), /patch_sha256.*approved patch/i, "unapproved patch digest is refused");
  equal(await stat(path.join(root, "wrong-patch-runtime")).catch(() => null), null, "wrong patch digest creates no runtime path");

  const wrongVersionRuntime = path.join(root, "wrong-version-runtime");
  await rejects(() => stageRuntime({ artifactDir, companionDir, runtimeDir: wrongVersionRuntime, versionChecker: async () => "codex-cli 9.9.9" }), /expected stock CLI version 0.164.0-alpha.11.1/i, "wrong stock version blocks staging during preflight");
  equal(await stat(wrongVersionRuntime).catch(() => null), null, "wrong stock version fails before creating runtime directories");

  const missingHelper = path.join(root, "missing-helper");
  await mkdir(missingHelper);
  await writeFile(path.join(missingHelper, "codex.exe"), stockBinary);
  await rejects(() => planRuntime({ artifactDir, companionDir: missingHelper, runtimeDir: path.join(root, "missing-runtime"), versionChecker }), /required companion.*missing/i, "plan requires each prepared-layout helper");

  let invocation;
  const version = await checkStockCliVersion("C:\\Codex\\stock\\codex.exe", {
    versionChecker: async (exePath, args, options) => {
      invocation = { exePath, args, windowsHide: options.windowsHide };
      return "codex-cli 0.164.0-alpha.11.1\n";
    },
  });
  equal(version, "0.164.0-alpha.11.1", "stock checker accepts only the required version");
  equal(invocation.args.join(" "), "--version", "stock checker invokes only --version");
  equal(invocation.windowsHide, true, "stock CLI version check hides its process window");
  await rejects(() => checkStockCliVersion("stock.exe", {
    versionChecker: async () => "codex-cli 0.162.0\n",
  }), /expected stock CLI version 0.164.0-alpha.11.1/i, "stock version mismatch is explicit");
  await rejects(() => checkStockCliVersion("stock.exe", {
    versionChecker: async () => "codex-cli 0.163.0-alpha.10.2\n",
  }), /expected stock CLI version 0.164.0-alpha.11.1/i, "the superseded desktop CLI version cannot satisfy the runtime preflight");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native runtime staging assertions`);
