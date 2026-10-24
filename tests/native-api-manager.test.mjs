import assert from "node:assert/strict";
import path from "node:path";
import { apiTaskPlan, defaultNativeApiDir } from "../scripts/native-api-manager.mjs";

let assertions = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };

function windowsFixture({ aliasTarget, aliasType = "directory", symlinkPath, omitNominal = false } = {}) {
  const winPath = path.win32;
  const localAppData = "C:\\Users\\Fixture\\AppData\\Local";
  const packageLocal = winPath.join(localAppData, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Local");
  const nominal = winPath.join(localAppData, "sol-luna-deepseek-router", "native-api");
  const canonical = winPath.join(packageLocal, "sol-luna-deepseek-router", "native-api");
  const dirs = new Set();
  const addTree = (target) => {
    let cursor = target;
    while (cursor && !dirs.has(cursor.toLowerCase())) {
      dirs.add(cursor.toLowerCase());
      const parent = winPath.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  };
  if (omitNominal) addTree(winPath.dirname(nominal));
  else addTree(nominal);
  addTree(canonical);
  if (aliasTarget) addTree(aliasTarget);
  const fsApi = {
    lstatSync(target) {
      const key = target.toLowerCase();
      if (!dirs.has(key)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {
        isDirectory: () => aliasType !== "file",
        isFile: () => aliasType === "file",
        isSymbolicLink: () => aliasType === "symlink" || key === symlinkPath?.toLowerCase(),
      };
    },
    realpathSync(target) {
      return target.toLowerCase() === nominal.toLowerCase() && aliasTarget ? aliasTarget : target;
    },
  };
  return { localAppData, nominal, canonical, packageLocal, fsApi, winPath };
}

const resolve = (fixture) => defaultNativeApiDir(
  { LOCALAPPDATA: fixture.localAppData },
  { platform: "win32", pathApi: fixture.winPath, fsApi: fixture.fsApi },
);

const normal = windowsFixture();
equal(resolve(normal), normal.nominal, "normal default API path remains unchanged");

const missing = windowsFixture({ omitNominal: true });
equal(resolve(missing), missing.nominal, "a missing default API root keeps the nominal path without creating directories");

const msix = windowsFixture({ aliasTarget: "C:\\Users\\Fixture\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\sol-luna-deepseek-router\\native-api" });
equal(resolve(msix), msix.canonical, "matching Codex MSIX default alias resolves to its canonical API root");

const otherTarget = windowsFixture({ aliasTarget: "C:\\Users\\Fixture\\AppData\\Local\\Packages\\OtherApp_abcdefghijklm\\LocalCache\\Local\\sol-luna-deepseek-router\\native-api" });
equal(resolve(otherTarget), otherTarget.nominal, "an alias to another package target is not normalized");

const symlink = windowsFixture({ aliasTarget: "C:\\Users\\Fixture\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\sol-luna-deepseek-router\\native-api", aliasType: "symlink" });
equal(resolve(symlink), symlink.nominal, "a symbolic-link API root is not normalized");

const ancestorJunction = windowsFixture({
  aliasTarget: "C:\\Users\\Fixture\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\sol-luna-deepseek-router\\native-api",
  symlinkPath: "C:\\Users\\Fixture\\AppData\\Local\\Packages",
});
equal(resolve(ancestorJunction), ancestorJunction.nominal, "a symlink ancestor is not normalized");

const canonicalLocal = "C:\\Users\\Fixture\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local";
const canonicalApiDir = path.win32.join(canonicalLocal, "sol-luna-deepseek-router", "native-api");
const canonicalResolved = defaultNativeApiDir({ LOCALAPPDATA: canonicalLocal }, { platform: "win32", pathApi: path.win32, fsApi: {} });
equal(canonicalResolved, canonicalApiDir, "an already canonical MSIX LocalAppData root keeps its default API path");
if (process.platform === "win32") {
  const gatewayScriptPath = path.win32.join(canonicalApiDir, "native-api-serve.mjs");
  equal(apiTaskPlan({ apiDir: canonicalResolved, gatewayScriptPath }).name,
    apiTaskPlan({ apiDir: canonicalApiDir, gatewayScriptPath }).name,
    "an already canonical default API root keeps its Task name stable");
}

equal(defaultNativeApiDir({ LOCALAPPDATA: "C:\\Users\\Fixture\\AppData\\Local" }, { platform: "linux" }),
  path.join("C:\\Users\\Fixture\\AppData\\Local", "sol-luna-deepseek-router", "native-api"),
  "non-Windows default API path keeps the existing platform behavior");

console.log(JSON.stringify({ status: "passed", assertions }));
