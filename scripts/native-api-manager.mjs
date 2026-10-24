import os from "node:os";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureGateway,
  gatewayHealth,
  gatewayPaths,
  gatewayStatus,
  readGatewayIdentity,
  readGatewayState,
  stopGateway,
} from "./native-gateway-manager.mjs";
import {
  createOwnedGatewayTaskLauncher,
  createWindowsTaskSchedulerAdapter,
  gatewayTaskPlan,
  statusOwnedGatewayTask,
} from "./native-gateway-task.mjs";

const CODEX_PACKAGE_FAMILY = "OpenAI.Codex_2p2nqsd0c76g0";
const normalizedPath = (value, platform) => platform === "win32" ? value.toLowerCase() : value;

function regularDirectoryTree(target, pathApi, fsApi) {
  const root = pathApi.parse(target).root;
  const relative = pathApi.relative(root, target);
  let current = root;
  for (const segment of relative.split(pathApi.sep).filter(Boolean)) {
    current = pathApi.join(current, segment);
    let info;
    try { info = fsApi.lstatSync(current); } catch { return false; }
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
  }
  return true;
}

export function defaultNativeApiDir(env = process.env, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const pathApi = dependencies.pathApi || path;
  const fsApi = dependencies.fsApi || { lstatSync, realpathSync: realpathSync.native };
  const base = env.LOCALAPPDATA || pathApi.join(os.homedir(), "AppData", "Local");
  const nominal = pathApi.join(base, "sol-luna-deepseek-router", "native-api");
  if (platform !== "win32") return nominal;

  // Windows MSIX apps can expose the user's LocalAppData name as an alias for
  // the package's private LocalCache\\Local directory. Normalize only the
  // exact Codex package layout, and only when both directory trees are regular.
  try {
    const packageLocal = pathApi.join(base, "Packages", CODEX_PACKAGE_FAMILY, "LocalCache", "Local");
    const canonical = pathApi.join(packageLocal, "sol-luna-deepseek-router", "native-api");
    if (pathApi.basename(base).toLowerCase() !== "local"
        || pathApi.basename(pathApi.dirname(base)).toLowerCase() !== "appdata"
        || !regularDirectoryTree(nominal, pathApi, fsApi)
        || !regularDirectoryTree(canonical, pathApi, fsApi)) return nominal;
    // Match native-gateway-source's fs/promises.realpath semantics for MSIX aliases.
    const actual = fsApi.realpathSync(nominal);
    const expected = fsApi.realpathSync(canonical);
    if (normalizedPath(actual, platform) !== normalizedPath(expected, platform)
        || normalizedPath(expected, platform) !== normalizedPath(canonical, platform)) return nominal;
    return expected;
  } catch {
    return nominal;
  }
}

export function apiServicePaths(apiDir = defaultNativeApiDir()) {
  return gatewayPaths(path.join(path.resolve(apiDir), "gateway"));
}

export function apiTaskPlan({ apiDir = defaultNativeApiDir(), gatewayScriptPath, nodePath = process.execPath, wscriptPath, settingsPath = path.join(path.resolve(apiDir), "router.json") } = {}) {
  return gatewayTaskPlan({
    paths: apiServicePaths(apiDir),
    gatewayScriptPath,
    nodePath,
    wscriptPath,
    service: "api",
    settingsPath,
  });
}

export async function verifyApiHealth(state) {
  const health = await gatewayHealth(state);
  if (health.reachable !== true || health.pid !== state?.pid) throw new Error("native API gateway is not healthy");
  if (health.api_only !== true || health.relay_allowed !== false) {
    throw new Error("native API gateway health is not api_only=true relay_allowed=false");
  }
  return health;
}

export async function ensureApiGateway({ apiDir = defaultNativeApiDir(), taskAdapter, gatewayScriptPath, settingsPath, paths = apiServicePaths(apiDir) } = {}) {
  if (typeof gatewayScriptPath !== "string" || !path.isAbsolute(gatewayScriptPath)) throw new Error("gatewayScriptPath must be absolute");
  const tasks = taskAdapter || createWindowsTaskSchedulerAdapter();
  const plan = apiTaskPlan({ apiDir, gatewayScriptPath, settingsPath });
  const task = await statusOwnedGatewayTask(plan, tasks);
  if (!task.exists || !task.owned || task.specMatches !== true || !task.enabled) {
    throw new Error("native API Task Scheduler task is missing, changed, or disabled");
  }
  const launchImpl = createOwnedGatewayTaskLauncher(plan, tasks);
  const ensured = await ensureGateway({ paths, launchImpl });
  const identity = await readGatewayIdentity(paths);
  const state = ensured.state;
  if (!state?.token || state.token !== identity?.token || state.port !== identity?.port || !Number.isInteger(state.pid)) {
    throw new Error("native API gateway state does not match its private identity");
  }
  await verifyApiHealth(state);
  const currentTask = await statusOwnedGatewayTask(plan, tasks);
  if (currentTask.state !== "Running") throw new Error("native API Task Scheduler task is not Running");
  return { state, started: ensured.started, taskName: plan.name, gatewayDir: paths.dir };
}

export async function stopApiGateway({ apiDir = defaultNativeApiDir(), paths = apiServicePaths(apiDir) } = {}) {
  return stopGateway({ paths });
}

export async function apiStatus({ apiDir = defaultNativeApiDir(), paths = apiServicePaths(apiDir) } = {}) {
  const state = await readGatewayState(paths);
  if (!state) return { running: false, state: null, api_only: null, relay_allowed: null };
  const health = await gatewayHealth(state);
  return {
    ...(await gatewayStatus({ paths })),
    api_only: health.api_only,
    relay_allowed: health.relay_allowed,
  };
}

async function main(argv) {
  const command = argv[0] || "status";
  const value = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const apiDir = value("api-dir") || defaultNativeApiDir();
  const gatewayScriptPath = value("gateway-script");
  const settingsPath = value("settings");
  if (command === "start" || command === "ensure") {
    const result = await ensureApiGateway({ apiDir, gatewayScriptPath, settingsPath });
    process.stdout.write(`${JSON.stringify({ started: result.started, pid: result.state.pid, port: result.state.port, task: result.taskName })}\n`);
    return;
  }
  if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopApiGateway({ apiDir }))}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await apiStatus({ apiDir }))}\n`);
    return;
  }
  throw new Error("usage: native-api-manager.mjs <start|ensure|stop|status> [--api-dir PATH] [--gateway-script PATH] [--settings PATH]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
