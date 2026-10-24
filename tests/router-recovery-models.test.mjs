import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decideRoute } from '../scripts/route.mjs';
import * as nativeAgent from '../scripts/native-agent.mjs';
import { createDefaultRouterSettings, validateRouterSettings } from '../scripts/native-api-settings.mjs';
import { API_PROVIDER_PRESETS, createRouterSettingsService, ROUTER_SETTINGS_TOOLS, selectorOptions } from '../scripts/router-settings-mcp.mjs';
import { handleHook } from '../scripts/route-hook.mjs';
import { NativeTasks } from '../scripts/native-state.mjs';

const priorCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(os.tmpdir(), `router-recovery-isolated-codex-home-${process.pid}`);

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function ok(actual, message) { assert.ok(actual, message); checks += 1; }

const legacy = {
  schemaVersion: 1,
  mode: 'fixed',
  fixedExecutor: 'deepseek',
  schedule: {peak: 'luna', valley: 'deepseek'},
  profiles: {},
};
equal(validateRouterSettings(legacy).enabled, true, 'older settings default to enabled');

const settings = {...createDefaultRouterSettings(), mode: 'fixed', fixedExecutor: 'same'};
settings.enabled = false;
const disabled = validateRouterSettings(settings);
equal(disabled.enabled, false, 'global disabled state survives validation');

const stateDir = await mkdtemp(path.join(os.tmpdir(), 'router-recovery-disabled-'));
try {
  const route = await decideRoute({
    at: '2026-10-19T10:30:00+08:00',
    executor: 'deepseek',
    setSessionExecutor: 'luna',
    sessionId: 'disabled-chat',
    stateDir,
    routerSettings: settings,
  });
  equal(route.executor, 'off', 'disabled takes precedence over a one-time override');
  equal(route.source, 'disabled', 'disabled route identifies its source');
  equal(Object.hasOwn(route, 'native_spawn'), false, 'disabled route has no child spawn parameters');
} finally {
  await rm(stateDir, {recursive: true, force: true});
}

const same = nativeAgent.resolveNativeAgent({executor: 'same', mainModel: 'gpt-6.1-sol', models: ['gpt-6.1-sol']});
equal(same.model, 'gpt-6.1-sol', 'same child uses the actual parent model exactly');
equal(same.fork_turns, 'none', 'same creates a separate child without inherited turns');
const selected = nativeAgent.resolveNativeAgent({executor: 'native:gpt-5.6-luna', models: ['gpt-5.6-luna']});
equal(selected.model, 'gpt-5.6-luna', 'native selector resolves its exact catalog model');
equal(selected.fork_turns, 'none', 'native selector creates an independent child');
assert.throws(
  () => nativeAgent.resolveNativeAgent({executor: 'native:stale-model', models: ['gpt-6-luna']}),
  /not present in the current Codex catalog/,
  'stale native model selection fails without substituting a model',
);
checks += 1;

equal(nativeAgent.resolveNativeAgent({executor: 'same', mainModel: 'gpt-6.1-astra'}).model, 'gpt-6.1-astra', 'same follows a changed parent model');

const nativeCatalog = nativeAgent.nativeModelOptionsFromCache({models: [
  {slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', supported_reasoning_levels: ['low', 'high']},
  {slug: 'deepseek/deepseek-flash', display_name: 'DeepSeek'},
  {slug: '', display_name: 'invalid'},
]});
equal(nativeCatalog.length, 2, 'native model list excludes malformed entries');
equal(nativeCatalog[0].value, 'gpt-6-luna', 'native model option carries exact slug');
equal(nativeCatalog[0].title, 'GPT-6 Luna', 'native model option uses safe display label');
equal(nativeCatalog[0].reasoningEfforts.join(','), 'low,high', 'native model option exposes only supported reasoning efforts');
ok(selectorOptions(settings, nativeCatalog).some(option => option.value === 'same'), 'UI choices include same-model routing');
ok(selectorOptions(settings, nativeCatalog).some(option => option.value === 'native:gpt-6-luna'), 'UI choices include exact native catalog models');

const sameSettings = {...createDefaultRouterSettings(), mode: 'fixed', fixedExecutor: 'same'};
const sameRoute = await decideRoute({routerSettings: sameSettings, mainModel: 'gpt-6.1-sol', at: '2026-10-19T10:30:00+08:00'});
equal(sameRoute.native_spawn.model, 'gpt-6.1-sol', 'route carries the trusted current chat model for same');
equal(sameRoute.native_spawn.fork_turns, 'none', 'same-model route has no inherited turns');
const laterSameRoute = await decideRoute({routerSettings: sameSettings, mainModel: 'gpt-6.1-astra', at: '2026-10-19T10:30:00+08:00'});
equal(laterSameRoute.native_spawn.model, 'gpt-6.1-astra', 'same tracks the actual current model on the next dispatch');

const exactCatalogRoute = await decideRoute({
  routerSettings: {...createDefaultRouterSettings(), mode: 'fixed', fixedExecutor: 'native:gpt-6-luna'},
  readNativeModels: async () => [{value: 'gpt-6-luna', title: 'GPT-6 Luna', reasoningEfforts: ['low']}],
  at: '2026-10-19T10:30:00+08:00',
});
equal(exactCatalogRoute.native_spawn.model, 'gpt-6-luna', 'route checks native selectors against the actual catalog before returning spawn data');
await assert.rejects(
  decideRoute({
    routerSettings: {...createDefaultRouterSettings(), mode: 'fixed', fixedExecutor: 'native:stale-model'},
    readNativeModels: async () => [{value: 'gpt-6-luna', title: 'GPT-6 Luna', reasoningEfforts: []}],
    at: '2026-10-19T10:30:00+08:00',
  }),
  /not present in the current Codex catalog/,
  'route rejects a stale native selector instead of returning dispatch metadata',
);
checks += 1;
await assert.rejects(
  decideRoute({
    routerSettings: {...createDefaultRouterSettings(), mode: 'fixed', fixedExecutor: 'native:gpt-6-luna'},
    readNativeModels: async () => { throw new Error('models_cache.json is missing'); },
    at: '2026-10-19T10:30:00+08:00',
  }),
  /models_cache.json is missing/,
  'route fails explicitly when the catalog is unavailable',
);
checks += 1;
const disabledWithoutCatalog = await decideRoute({
  routerSettings: {...settings, enabled: false},
  readNativeModels: async () => { throw new Error('catalog must not be read while disabled'); },
  at: '2026-10-19T10:30:00+08:00',
});
equal(disabledWithoutCatalog.executor, 'off', 'disabled route returns before attempting catalog reads');

const snapshotToolSchema = ROUTER_SETTINGS_TOOLS.find(tool => tool.name === 'router_settings_snapshot').outputSchema;
const nativeModelItemSchema = snapshotToolSchema.properties.nativeModels.items;
equal(nativeModelItemSchema.additionalProperties, false, 'snapshot native model schema rejects undeclared fields');
equal(nativeModelItemSchema.required.join(','), 'value,title,reasoningEfforts', 'snapshot schema requires all safe catalog fields');
ok(nativeModelItemSchema.properties.reasoningEfforts.items.enum.includes('high'), 'snapshot schema limits reasoning efforts to known values');
const catalogService = createRouterSettingsService({
  settingsPath: path.join(os.tmpdir(), `router-catalog-schema-${process.pid}.json`),
  readNativeModels: async () => [{value: 'gpt-6-luna', title: 'GPT-6 Luna', reasoningEfforts: ['low', 'high']}],
});
const advertisedCatalog = (await catalogService.callTool('router_settings_snapshot')).payload.nativeModels;
deepStrictEqual(Object.keys(advertisedCatalog[0]).sort(), ['reasoningEfforts', 'title', 'value'], 'snapshot only emits fields declared by the native model schema');
equal(advertisedCatalog[0].value, 'gpt-6-luna', 'snapshot model payload matches the advertised exact selector slug');

function deepStrictEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }

const guardDisabled = await decideRoute({
  routerSettings: sameSettings,
  mainModel: 'gpt-6.1-sol',
  guardStatus: {state: 'disabled', reason: 'guard repair required'},
  at: '2026-10-19T10:30:00+08:00',
});
equal(guardDisabled.executor, 'off', 'a disabled lifecycle guard blocks dispatch without rewriting user settings');
equal(guardDisabled.source, 'guard_disabled', 'guard-driven disable remains distinguishable from the user setting');

const hookDir = await mkdtemp(path.join(os.tmpdir(), 'router-recovery-hook-off-'));
try {
  const first = await handleHook({
    input: {hook_event_name: 'UserPromptSubmit', session_id: 'off-parent', model: 'gpt-6.1-sol'},
    routerSettings: settings,
    hookStateDir: hookDir,
    now: '2026-10-19T10:30:00+08:00',
  });
  ok(first.output.hookSpecificOutput.additionalContext.includes('已关闭自动子代理分工'), 'disabled hook emits a concise Simplified Chinese notice');
  const second = await handleHook({
    input: {hook_event_name: 'PreToolUse', session_id: 'off-parent', model: 'gpt-6.1-sol'},
    routerSettings: settings,
    hookStateDir: hookDir,
    now: '2026-10-19T10:31:00+08:00',
  });
  equal(second.output, null, 'disabled status is announced once per chat');
} finally {
  await rm(hookDir, {recursive: true, force: true});
}

const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'router-recovery-mcp-'));
try {
  let stopRequests = 0;
  let guardState = {state: 'disabled', reason: 'lifecycle guard stopped'};
  const service = createRouterSettingsService({
    settingsPath: path.join(settingsDir, 'router.json'),
    readNativeModels: async () => nativeCatalog,
    guardStatus: async () => guardState,
    onRoutingDisabled: async () => { stopRequests += 1; return {requested: true}; },
  });
  const initial = (await service.callTool('router_settings_snapshot', {})).payload;
  equal(initial.settings.enabled, true, 'MCP reads legacy default routing as enabled');
  equal(initial.capabilities.guardStatus.state, 'disabled', 'guard status remains separate from the user setting');
  equal(initial.providerPresets.deepseek.baseUrl, 'https://api.deepseek.com', 'DeepSeek preset uses the official API base');
  equal(initial.providerPresets.deepseek.credential.type, 'dsh_account', 'DeepSeek preset keeps automatic DSH account auth');
  ok(initial.selectors.some(option => option.value === 'native:gpt-6-luna'), 'snapshot exposes native catalog models to the UI');
  const disabledSave = await service.callTool('router_settings_update', {
    set: {enabled: false, mode: 'fixed', fixedExecutor: 'same'},
    expectedSha256: initial.sha256,
  });
  equal(disabledSave.payload.values.enabled, false, 'MCP saves the off switch through the existing CAS update');
  equal(stopRequests, 1, 'transitioning off calls the optional idle-stop lifecycle seam once');
  const refreshed = (await service.callTool('router_settings_snapshot', {})).payload;
  equal(refreshed.settings.enabled, false, 'MCP snapshot refresh preserves off');
  equal(refreshed.settings.fixedExecutor, 'same', 'off preserves the configured fixed executor');
  guardState = {state: 'healthy', reason: null};
  const enabledSave = await service.callTool('router_settings_update', {
    set: {enabled: true}, expectedSha256: refreshed.sha256,
  });
  equal(enabledSave.payload.values.enabled, true, 'MCP can explicitly re-enable routing');
  equal(stopRequests, 1, 're-enabling does not request a stop');
  const healthyReenable = await service.callTool('router_settings_update', {
    set: {enabled: true}, expectedSha256: enabledSave.payload.sha256,
  });
  equal(stopRequests, 1, 'healthy guard leaves explicitly enabled routing running');
  guardState = {state: 'disabled', reason: 'guard stopped again'};
  await service.callTool('router_settings_update', {set: {enabled: true}, expectedSha256: healthyReenable.payload.sha256});
  equal(stopRequests, 2, 'a disabled lifecycle guard continues to request idle stop on later updates');
} finally {
  await rm(settingsDir, {recursive: true, force: true});
}

equal((await import('../scripts/route-hook.mjs')).isChildExecutor({model: 'gpt-6.1-sol'}), false,
  'model name alone does not suppress a parent chat notice');
equal((await import('../scripts/route-hook.mjs')).isChildExecutor({agent_type: 'native_api_0123456789abcdef01234567'}), true,
  'explicit native child role suppresses recursive routing');

const childStateDir = await mkdtemp(path.join(os.tmpdir(), 'router-recovery-child-state-'));
const childHookDir = await mkdtemp(path.join(os.tmpdir(), 'router-recovery-child-hook-'));
try {
  const tasks = new NativeTasks({stateDir: childStateDir});
  await tasks.begin({parentThreadId: 'parent-thread', childThreadId: 'known-child-thread', model: 'gpt-6.1-sol'});
  const priorPluginState = process.env.SOL_LUNA_PLUGIN_STATE;
  process.env.SOL_LUNA_PLUGIN_STATE = childStateDir;
  try {
  const child = await handleHook({
    input: {hook_event_name: 'UserPromptSubmit', session_id: 'known-child-thread', model: 'gpt-6.1-sol'},
    routerSettings: sameSettings,
    hookStateDir: childHookDir,
    now: '2026-10-19T10:30:00+08:00',
  });
  equal(child.output, null, 'trusted native state suppresses the exact recorded child thread');
  const parent = await handleHook({
    input: {hook_event_name: 'UserPromptSubmit', session_id: 'parent-thread', model: 'gpt-6.1-sol'},
    routerSettings: sameSettings,
    hookStateDir: childHookDir,
    now: '2026-10-19T10:30:00+08:00',
  });
  ok(parent.output?.hookSpecificOutput.additionalContext, 'parent using the same model is not suppressed');
  } finally {
    if (priorPluginState === undefined) delete process.env.SOL_LUNA_PLUGIN_STATE;
    else process.env.SOL_LUNA_PLUGIN_STATE = priorPluginState;
  }
} finally {
  await rm(childStateDir, {recursive: true, force: true});
  await rm(childHookDir, {recursive: true, force: true});
}

console.log(`PASS ${checks} router recovery/model assertions`);
if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
else process.env.CODEX_HOME = priorCodexHome;
