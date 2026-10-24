import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultNativeApiDir } from "../scripts/native-api-manager.mjs";
import { cleanupOwnedGatewaySourceStage, stageGatewaySource, verifyGatewaySource } from "../scripts/native-gateway-source.mjs";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-gateway-source-test-")));
const files = [
  "native-gateway.mjs",
  "native-routing.mjs",
  "native-relay.mjs",
  "native-usage.mjs",
  "native-credentials.mjs",
];
let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };

try {
  const pluginRoot = path.join(root, "plugin");
  const runtimeRoot = path.join(root, "native-isolated");
  await mkdir(path.join(pluginRoot, "scripts"), { recursive: true });
  await mkdir(runtimeRoot);
  for (const file of files) await writeFile(path.join(pluginRoot, "scripts", file), `export const source = ${JSON.stringify(file)};\n`);
  const staged = await stageGatewaySource({ pluginRoot, runtimeRoot });
  equal(staged.files.length, 5, "bundle contains exactly the five gateway modules");
  ok(staged.contentDigest && staged.manifestSha256, "bundle reference is content addressed and manifest-bound");
  equal(staged.entry, "scripts/native-gateway.mjs", "bundle entry is fixed");
  equal(await verifyGatewaySource(staged, { runtimeRoot }), true, "fresh bundle verifies");

  await rm(pluginRoot, { recursive: true });
  const durableEntry = path.join(runtimeRoot, staged.relativeDirectory, staged.entry);
  equal(await readFile(durableEntry, "utf8"), 'export const source = "native-gateway.mjs";\n', "durable entry remains available after plugin cache removal");
  await import(`${pathToFileURL(durableEntry).href}?test=${Date.now()}`);
  const sameContentPlugin = path.join(root, "same-content-plugin");
  await mkdir(path.join(sameContentPlugin, "scripts"), { recursive: true });
  for (const file of files) await writeFile(path.join(sameContentPlugin, "scripts", file), `export const source = ${JSON.stringify(file)};\n`);
  const reused = await stageGatewaySource({ pluginRoot: sameContentPlugin, runtimeRoot });
  equal(reused.contentDigest, staged.contentDigest, "identical content reuses immutable bundle");
  await assert.rejects(() => stageGatewaySource({ pluginRoot: "relative-plugin", runtimeRoot }), /absolute/i);
  assertions += 1;
  await assert.rejects(() => verifyGatewaySource(staged, { runtimeRoot: "." }), /absolute/i);
  assertions += 1;

  const msixLikeLocal = path.join(root, "AppData", "Local");
  const msixLikeTarget = path.join(msixLikeLocal, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Local", "sol-luna-deepseek-router", "native-api");
  const msixLikeAlias = path.join(msixLikeLocal, "sol-luna-deepseek-router", "native-api");
  await mkdir(msixLikeTarget, { recursive: true });
  let msixAliasCreated = false;
  try {
    await mkdir(path.dirname(msixLikeAlias), { recursive: true });
    await symlink(msixLikeTarget, msixLikeAlias, "junction");
    msixAliasCreated = true;
  } catch (error) {
    if (!new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error.code)) throw error;
  }
  if (msixAliasCreated) {
    equal(defaultNativeApiDir({ LOCALAPPDATA: msixLikeLocal }), msixLikeAlias,
      "default API root keeps a real MSIX-shaped junction at its nominal path");
    await assert.rejects(() => verifyGatewaySource(staged, { runtimeRoot: msixLikeAlias }), /regular directory|reparse point/i);
    assertions += 1;
    await assert.rejects(() => stageGatewaySource({ pluginRoot: sameContentPlugin, runtimeRoot: msixLikeAlias }), /regular directory|reparse point/i);
    assertions += 1;
  }

  const conflictRoot = path.join(root, "conflict-runtime");
  const conflictDirectory = path.join(conflictRoot, staged.relativeDirectory);
  await mkdir(conflictDirectory, { recursive: true });
  await assert.rejects(() => stageGatewaySource({ pluginRoot: sameContentPlugin, runtimeRoot: conflictRoot }), /existing.*incomplete|bundle.*incomplete|manifest/i);
  assertions += 1;
  equal((await (await import("node:fs/promises")).readdir(conflictDirectory)).length, 0, "an existing incomplete digest directory is not populated or replaced");

  await writeFile(path.join(runtimeRoot, staged.relativeDirectory, staged.entry), "tampered\n");
  await assert.rejects(() => verifyGatewaySource(staged, { runtimeRoot }), /hash|digest|manifest|changed/i);
  assertions += 1;
  await writeFile(path.join(runtimeRoot, staged.relativeDirectory, staged.entry), originalGatewayBytes(files));
  const extraFile = path.join(runtimeRoot, staged.relativeDirectory, "scripts", "unexpected.mjs");
  await writeFile(extraFile, "export {};\n");
  await assert.rejects(() => verifyGatewaySource(staged, { runtimeRoot }), /unexpected file/i);
  assertions += 1;
  await rm(extraFile);
  const manifestPath = path.join(runtimeRoot, staged.relativeDirectory, "bundle-manifest.json");
  const validManifest = await readFile(manifestPath);
  await writeFile(manifestPath, Buffer.concat([validManifest, Buffer.from(" ")]));
  await assert.rejects(() => verifyGatewaySource(staged, { runtimeRoot }), /manifest hash changed/i);
  assertions += 1;
  await writeFile(manifestPath, validManifest);
  await assert.rejects(() => verifyGatewaySource({ ...staged, relativeDirectory: "../../outside" }, { runtimeRoot }), /reference is invalid|path is invalid|escapes/i);
  assertions += 1;

  const usageFile = path.join(runtimeRoot, staged.relativeDirectory, "scripts", "native-usage.mjs");
  const usageBytes = await readFile(usageFile);
  const outsideFile = path.join(root, "outside.mjs");
  await writeFile(outsideFile, usageBytes);
  await unlink(usageFile);
  let reparseCreated = false;
  try {
    await symlink(outsideFile, usageFile, "file");
    reparseCreated = true;
  } catch (error) {
    if (!new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error.code)) throw error;
  }
  if (reparseCreated) {
    await assert.rejects(() => verifyGatewaySource(staged, { runtimeRoot }), /reparse point|regular file/i);
    assertions += 1;
    await unlink(usageFile);
  }
  await writeFile(usageFile, usageBytes);

  const cleanupStore = path.join(root, "cleanup-store");
  const cleanupVictim = path.join(cleanupStore, "victim");
  const cleanupLink = path.join(cleanupStore, ".stage-test");
  await mkdir(cleanupVictim, { recursive: true });
  const victimMarker = path.join(cleanupVictim, "preserve.txt");
  await writeFile(victimMarker, "preserve\n");
  try {
    await symlink(cleanupVictim, cleanupLink, "junction");
    await assert.rejects(() => cleanupOwnedGatewaySourceStage(cleanupStore, cleanupLink), /reparse point|regular directory/i);
    assertions += 1;
    equal(await readFile(victimMarker, "utf8"), "preserve\n", "temporary cleanup refuses redirected staging paths");
  } catch (error) {
    if (!new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error.code)) throw error;
  }
  console.log(JSON.stringify({ status: "passed", assertions }));
} finally {
  await rm(root, { recursive: true, force: true });
}

function originalGatewayBytes(names) {
  return Buffer.from(`export const source = ${JSON.stringify(names.find((name) => name === "native-gateway.mjs"))};\n`);
}
