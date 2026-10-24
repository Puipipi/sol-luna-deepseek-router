import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PICKER_SLUG } from "./native-routing.mjs";
import { ensureNativeDeepseekDispatch } from "./native-isolated-install.mjs";
import { defaultRouterSettingsPath, loadRouterSettings } from "./native-api-settings.mjs";
import { effectiveRouterEnabled } from "./native-api-settings.mjs";
import { ensureNativeApiDispatch } from "./native-api-install.mjs";
import { defaultNativeApiDir } from "./native-api-manager.mjs";
import { defaultModelsCachePath } from "./native-model-catalog.mjs";
import { resolveCurrentMainModel } from "./native-current-model.mjs";
import { enableOwnedExecutionsForDispatch, finalizePendingDisable } from "./native-execution-lifecycle.mjs";
import { readUpgradeGuardStatus } from "./native-upgrade-status.mjs";
import { assertGatewayBackendReady } from "./native-api-bootstrap-gate.mjs";
import { NativeTasks } from "./native-state.mjs";

export { defaultModelsCachePath, nativeModelOptionsFromCache, readNativeModelOptions } from "./native-model-catalog.mjs";

const LUNA_MAP = {
  "gpt-6.1-sol": "gpt-6-luna",
  "gpt-6-sol": "gpt-6-luna",
  "gpt-5.6-sol": "gpt-5.6-luna",
};

export function modelsFromCache(cache) {
  if (!cache || !Array.isArray(cache.models)) throw new Error("models_cache.json has no models");
  return cache.models.map((model) => model?.slug).filter((slug) => typeof slug === "string");
}

export function resolveNativeAgent({ executor, mainModel, models = [], apiProfiles = {} }) {
  if (executor === "same") {
    if (typeof mainModel !== "string" || !mainModel.trim()) throw new Error("same-model dispatch requires the trusted current chat model");
    return { executor: "same", model: mainModel, fork_turns: "none" };
  }
  if (typeof executor === "string" && executor.startsWith("native:")) {
    const model = executor.slice("native:".length);
    if (!model || !models.includes(model)) throw new Error(`Selected native model is not present in the current Codex catalog: ${model || "(empty)"}`);
    return { executor: "native", model, fork_turns: "none" };
  }
  if (executor === "deepseek") {
    return {
      executor: "deepseek",
      agent_type: "native_deepseek",
      fork_turns: "none",
      resolved_model: PICKER_SLUG,
    };
  }
  if (executor !== "luna" && executor !== "deepseek") {
    if (typeof executor !== "string" || !executor.trim()) {
      throw new Error("executor must be luna, deepseek, or a configured API profile; same and native:<model> are also supported");
    }
    const profile = apiProfiles[executor]
      || Object.values(apiProfiles).find((candidate) => candidate.aliases?.includes(executor));
    if (!profile) throw new Error("unknown API profile; refusing executor fallback");
    return {
      executor: "api",
      profile_id: profile.profileId,
      provider_id: `api-native-${profile.profileId}`,
      agent_type: `native_api_${profile.profileId}`,
      resolved_model: profile.model,
      fork_turns: "none",
    };
  }
  const available = new Set(models);
  const preferred = LUNA_MAP[mainModel];
  const lunaModels = models.filter((slug) => /luna/i.test(slug));
  const model = (preferred && available.has(preferred) ? preferred : null)
    || lunaModels.find((slug) => /^gpt-6-luna$/i.test(slug))
    || lunaModels[0];
  if (!model) throw new Error("No supported native Luna model is present in the current catalog; do not invent one");
  return {
    executor: "luna",
    model,
    fork_turns: "none",
  };
}

export async function prepareGatewayDispatch({
  result,
  executor,
  profileId = null,
  taskNonce,
  reuseChildThreadId = null,
  parentThreadId,
  tasks,
  assertEnabled = async () => {},
  ensureReady = async () => {},
  onCancelled = async () => {},
} = {}) {
  if (!tasks || !['api', 'deepseek'].includes(executor)) throw new Error('gateway dispatch requires a native task store and API/DeepSeek executor');
  const model = result?.resolved_model || result?.model;
  await tasks.reserveDispatch({parentThreadId, taskNonce, executor, profileId, model, reuseChildThreadId});
  try {
    await assertEnabled();
    await ensureReady();
    await assertEnabled();
    const route = {...result};
    if (reuseChildThreadId) {
      delete route.agent_type;
      delete route.fork_turns;
    }
    return {...route, dispatch_reservation: {task_nonce: taskNonce, executor, profile_id: profileId},
      ...(reuseChildThreadId ? {spawn: false, reuse_child: true, child_thread_id: reuseChildThreadId} : {})};
  } catch (error) {
    await tasks.cancelDispatch({parentThreadId, taskNonce}).catch(() => {});
    await onCancelled().catch(() => {});
    throw error;
  }
}

async function main(argv) {
  const get = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
  };
  const executor = get("executor");
  const mainModel = get("main-model");
  const taskNonce = get("task-nonce");
  const reuseChildThreadId = get("reuse-child");
  const stateDir = get("state-dir");
  if (typeof executor !== "string" || !executor.trim()) {
    throw new Error("executor must be luna, deepseek, or a configured API profile; same and native:<model> are also supported");
  }
  const reuseChildFlagAt = argv.indexOf("--reuse-child");
  if (reuseChildFlagAt >= 0) {
    const reuseValue = argv[reuseChildFlagAt + 1];
    if (typeof reuseValue !== "string" || !reuseValue.trim() || reuseValue.startsWith("--")) {
      throw new Error("--reuse-child requires an existing child thread ID");
    }
    if (executor === "luna" || executor === "same" || executor.startsWith("native:")) {
      throw new Error("--reuse-child is supported only for API or DeepSeek executors");
    }
  }
  const apiDir = get("api-dir") || defaultNativeApiDir();
  const settingsPath = get("settings") || (executor !== "luna" && executor !== "same" && !executor.startsWith("native:")
    ? path.join(apiDir, "router.json")
    : defaultRouterSettingsPath());
  const routerSettings = await loadRouterSettings(settingsPath);
  const guardStatus = routerSettings.enabled ? await readUpgradeGuardStatus() : null;
  if (!effectiveRouterEnabled(routerSettings, guardStatus)) throw new Error("Automatic child dispatch is disabled by router settings or the upgrade guard");
  async function reserveGatewayDispatch(result, dispatchExecutor, profileId = null) {
    const parentThreadId = process.env.CODEX_THREAD_ID?.trim() || process.env.CODEX_SESSION_ID?.trim();
    if (!parentThreadId) throw new Error("A trusted CODEX_THREAD_ID or CODEX_SESSION_ID is required before gateway dispatch");
    if (!taskNonce || !/^[A-Za-z0-9._:-]{8,200}$/.test(taskNonce)) throw new Error("--task-nonce is required for API/DeepSeek dispatch reservations");
    const tasks = new NativeTasks({stateDir});
    const assertStillEnabled = async () => {
        const latestSettings = await loadRouterSettings(settingsPath);
        const latestGuard = latestSettings.enabled ? await readUpgradeGuardStatus() : null;
        if (!effectiveRouterEnabled(latestSettings, latestGuard)) throw new Error("Automatic child dispatch was disabled during setup; no child was spawned");
    };
    const ready = async () => {
      if (dispatchExecutor === "deepseek") {
        const journalPath = get("install-journal") || process.env.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
        await assertGatewayBackendReady({executor: "deepseek", env: {...process.env, SOL_LUNA_NATIVE_INSTALL_JOURNAL: journalPath}});
        await enableOwnedExecutionsForDispatch({executor: "deepseek", env: {...process.env, SOL_LUNA_NATIVE_INSTALL_JOURNAL: journalPath}});
        await ensureNativeDeepseekDispatch({journalPath});
      } else {
        const apiJournal = get("api-journal");
        await assertGatewayBackendReady({executor: "api", profileId, apiDir, env: process.env});
        await enableOwnedExecutionsForDispatch({executor: "api", profileId, apiDir});
        await ensureNativeApiDispatch({profileId, apiDir, settingsPath, journalPath: apiJournal || undefined});
      }
    };
    const dispatch = await prepareGatewayDispatch({result, executor: dispatchExecutor, profileId, taskNonce, reuseChildThreadId, parentThreadId, tasks, assertEnabled: assertStillEnabled, ensureReady: ready, onCancelled: () => finalizePendingDisable({settingsPath, stateDir})});
    process.stdout.write(`${JSON.stringify(dispatch)}\n`);
  }
  if (executor === "deepseek") {
    const journalFlagAt = argv.indexOf("--install-journal");
    let journalPath;
    if (journalFlagAt >= 0) {
      journalPath = argv[journalFlagAt + 1];
      if (typeof journalPath !== "string" || !journalPath.trim() || journalPath.startsWith("--")) throw new Error("--install-journal must not be empty");
    } else {
      journalPath = process.env.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
      if (typeof journalPath !== "string" || !journalPath.trim()) throw new Error("an installed isolation journal path is required for native DeepSeek dispatch; activate the isolated installer first");
    }
    await reserveGatewayDispatch(resolveNativeAgent({ executor, mainModel, models: [] }), "deepseek");
    return;
  }
  if (executor !== "luna" && executor !== "same" && !executor.startsWith("native:")) {
    const result = resolveNativeAgent({ executor, mainModel, apiProfiles: routerSettings.profiles });
    await reserveGatewayDispatch(result, "api", result.profile_id);
    return;
  }
  if (executor === "same") {
    const current = await resolveCurrentMainModel({explicitModel: mainModel});
    process.stdout.write(`${JSON.stringify(resolveNativeAgent({ executor, mainModel: current.model }))}\n`);
    return;
  }
  const cacheAt = path.resolve(get("models-cache", defaultModelsCachePath()));
  if (!existsSync(cacheAt)) throw new Error(`models_cache.json is missing at ${cacheAt}; Luna resolution never substitutes a model`);
  const cache = JSON.parse(readFileSync(cacheAt, "utf8"));
  const result = resolveNativeAgent({ executor, mainModel, models: modelsFromCache(cache) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
