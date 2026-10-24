import assert from "node:assert/strict";
import path from "node:path";
import {
  API_CONFIG_BEGIN,
  API_CONFIG_END,
  DEFAULT_API_CONTEXT_WINDOW,
  apiIdentifiers,
  buildApiCatalog,
  buildApiRoleToml,
  composeApiConfig,
  hasModelInstructions,
  renderApiArtifacts,
  resolveApiModelInstructions,
} from "../scripts/native-api-artifacts.mjs";
import { createApiProfile } from "../scripts/native-api-settings.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const definition = {
  protocol: "responses",
  baseUrl: "https://api.example.invalid/v1",
  model: "exact/wire-model",
  reasoning: { supported: ["low", "medium", "high"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "env", name: "EXAMPLE_API_KEY" },
};
const profile = createApiProfile(definition, { label: "Example API", aliases: ["example"] });
const codexHome = path.resolve("C:/codex-home-fixture");
const token = "local-token-1234567890";
const gatewayBaseUrl = `http://127.0.0.1:42123/${token}`;
const baseUrl = `http://127.0.0.1:42123/${token}/profiles/${profile.profileId}/v1`;
const ids = apiIdentifiers(profile.profileId);
const modelMessages = {
  instructions_template: "You are Codex, an AI coding assistant. Follow the user's request and work in the shared workspace.",
  persistent_instructions: "Keep the coding task focused.",
  approvals: { policy: "never" },
};
const nativeCache = { models: [{ slug: "native-model", visibility: "list", model_messages: modelMessages }] };
assert.deepEqual(resolveApiModelInstructions(nativeCache), { model_messages: modelMessages });
checks += 1;
const baseInstructions = "Native base instructions";
assert.deepEqual(resolveApiModelInstructions({ models: [{ visibility: "list", base_instructions: baseInstructions }] }), {
  base_instructions: baseInstructions,
});
equal(buildApiCatalog(profile, { base_instructions: baseInstructions }).models[0].base_instructions,
  baseInstructions, "API catalogs preserve the valid base_instructions schema alternative");
ok(hasModelInstructions({ base_instructions: "Base model instructions" }), "a non-empty base_instructions field satisfies the native catalog schema");
ok(hasModelInstructions({ model_messages: { instructions_template: modelMessages.instructions_template } }), "a non-empty model_messages template satisfies the native catalog schema");
equal(hasModelInstructions({ model_messages: { instructions_template: "  " } }), false, "empty instruction fields do not satisfy the native catalog schema");

equal(ids.roleName, `native_api_${profile.profileId}`, "role name derives from the profile id");
equal(ids.providerId, `api-native-${profile.profileId}`, "provider id derives from the profile id");
equal(ids.catalogFile, `sol-luna-native-models-${profile.profileId}.json`, "catalog file derives from the profile id");

const role = buildApiRoleToml(profile);
assert.match(role, new RegExp(`name = "native_api_${profile.profileId}"`));
assert.match(role, /model = "exact\/wire-model"/);
assert.match(role, /model_reasoning_effort = "high"/);
assert.match(role, /unbounded_connection_retries = false/);
assert.doesNotMatch(role, /baseUrl|credential|EXAMPLE_API_KEY|developer_instructions|context_window|web_search/);
checks += 1;

const catalog = buildApiCatalog(profile, { model_messages: modelMessages });
ok(typeof catalog.models[0].model_messages?.instructions_template === "string"
  && catalog.models[0].model_messages.instructions_template.trim().length > 0,
"API catalog carries non-empty instructions through the native model_messages schema");
equal(catalog.models.length, 1, "API catalog contains exactly the profile model");
equal(catalog.models[0].slug, profile.model, "catalog uses the exact wire model");
equal(catalog.models[0].context_window, DEFAULT_API_CONTEXT_WINDOW, "omitted contextWindow uses the documented plugin working budget");
equal(catalog.models[0].max_context_window, DEFAULT_API_CONTEXT_WINDOW, "max context matches the configured budget");
equal(catalog.models[0].effective_context_window_percent, 85, "unknown APIs reserve more headroom than the DeepSeek catalog");
equal(catalog.models[0].default_reasoning_level, "high", "catalog advertises the profile default effort");
equal(catalog.models[0].supported_reasoning_levels.map((item) => item.effort).join(","), "low,medium,high", "catalog advertises only declared efforts");
equal(catalog.models[0].supports_search_tool, false, "API catalog does not claim a search tool");
equal(catalog.models[0].web_search_tool_type, "text", "catalog uses the schema-defined web search type");
equal(catalog.models[0].multi_agent_version, "v2", "API model can be spawned by the native multi-agent layer");
equal(catalog.models[0].comp_hash, `sol-luna-native-api-${profile.profileId}`, "compaction identity is profile-specific");

const small = createApiProfile({ ...definition, contextWindow: 2_048 });
equal(buildApiCatalog(small, { model_messages: modelMessages }).models[0].context_window, 2_048, "small explicit context windows are supported");
assert.throws(() => createApiProfile({ ...definition, contextWindow: 1_023 }), /1024/);
assert.throws(() => createApiProfile({ ...definition, contextWindow: 2_000_001 }), /2000000/);
checks += 2;

const noReasoning = createApiProfile({
  ...definition,
  reasoning: { supported: ["none"], default: "none", parameter: "none" },
});
const noReasoningRole = buildApiRoleToml(noReasoning);
assert.doesNotMatch(noReasoningRole, /model_reasoning_effort/);
equal(buildApiCatalog(noReasoning, { model_messages: modelMessages }).models[0].supported_reasoning_levels.length, 0, "parameter=none advertises no reasoning levels");
checks += 2;

const rendered = renderApiArtifacts(profile, { codexHome, baseUrl, modelInstructions: { model_messages: modelMessages } });
equal(rendered.rolePath, path.join(codexHome, "agents", `native_api_${profile.profileId}.toml`), "role path is profile-specific");
equal(rendered.catalogPath, path.join(codexHome, `sol-luna-native-models-${profile.profileId}.json`), "catalog path is profile-specific");
assert.match(rendered.providerTable, new RegExp(`\\[model_providers\\.api-native-${profile.profileId}\\]`));
assert.match(rendered.providerTable, /wire_api = "responses"/);
assert.match(rendered.providerTable, /requires_openai_auth = false/);
assert.match(rendered.providerTable, /supports_websockets = false/);
assert.doesNotMatch(rendered.providerTable, /env_key|experimental_bearer_token|http_headers|query_params|authorization/i);
checks += 1;

const root = [
  'model = "gpt-6.1-sol"',
  'model_provider = "openai"',
  'web_search = "disabled"',
  "",
  "[model_providers.deepseek-native]",
  'base_url = "http://127.0.0.1:1/token/v1"',
].join("\n");
const composed = composeApiConfig(root, { profileIds: [profile.profileId], gatewayBaseUrl, codexHome });
assert.match(composed, /^model = "gpt-6\.1-sol"/m);
assert.match(composed, /\[model_providers\.deepseek-native\]/);
assert.match(composed, new RegExp(`\\[agents\\.${ids.roleName}\\]`));
assert.ok(composed.includes(`config_file = ${JSON.stringify(rendered.rolePath)}`), "registration points to the precise generated role file");
equal(composeApiConfig(composed, { profileIds: [profile.profileId], gatewayBaseUrl, codexHome }), composed, "compose is idempotent");
equal(composeApiConfig(composed, { profileIds: [], gatewayBaseUrl, codexHome }), `${root}\n`, "removing the API block preserves foreign configuration");
const two = composeApiConfig(composed, {
  profileIds: [profile.profileId, small.profileId],
  gatewayBaseUrl,
  codexHome,
});
ok(two.includes(`[model_providers.api-native-${small.profileId}]`), "additional profiles are added to the owned block");
ok(two.includes(`[agents.native_api_${small.profileId}]`), "additional profiles register their native agent role");
ok(two.indexOf(API_CONFIG_BEGIN) < two.indexOf(API_CONFIG_END), "owned block has ordered markers");

assert.throws(() => composeApiConfig(`${root}\n\n[model_providers.${ids.providerId}]\nbase_url = "https://foreign.invalid"\n`, {
  profileIds: [profile.profileId],
  gatewayBaseUrl,
  codexHome,
}), /conflicts/);
checks += 1;
assert.throws(() => composeApiConfig(`${root}\nmodel_providers.${ids.providerId}.base_url = "https://foreign.invalid"\n`, {
  profileIds: [profile.profileId],
  gatewayBaseUrl,
  codexHome,
}), /conflicts/);
checks += 1;
assert.throws(() => composeApiConfig(`${root}\n\n[agents.${ids.roleName}]\nconfig_file = "C:/owned-by-user.toml"\n`, {
  profileIds: [profile.profileId],
  gatewayBaseUrl,
  codexHome,
}), /conflicts/);
checks += 1;
assert.throws(() => composeApiConfig(`${root}\n\n["agents"."${ids.roleName}"]\nconfig_file = "C:/owned-by-user.toml"\n`, {
  profileIds: [profile.profileId],
  gatewayBaseUrl,
  codexHome,
}), /conflicts/);
checks += 1;
assert.throws(() => composeApiConfig(`${root}\n\n[agents]\n"${ids.roleName}" = { config_file = "C:/owned-by-user.toml" }\n`, {
  profileIds: [profile.profileId],
  gatewayBaseUrl,
  codexHome,
}), /conflicts/);
checks += 1;
assert.throws(() => composeApiConfig(`${root}\n\n[agents]\n${ids.roleName}.description = "user role"\n`, {
  profileIds: [profile.profileId],
  gatewayBaseUrl,
  codexHome,
}), /conflicts/);
checks += 1;
assert.throws(() => composeApiConfig(`${root}\n\n[agents]\n"${ids.roleName}".description = "user role"\n`, {
  profileIds: [profile.profileId],
  gatewayBaseUrl,
  codexHome,
}), /conflicts/);
checks += 1;
const foreignInside = composed.replace(API_CONFIG_END, `[foreign.inside]\nvalue = "preserve"\n${API_CONFIG_END}`);
assert.throws(() => composeApiConfig(foreignInside, { profileIds: [profile.profileId], gatewayBaseUrl, codexHome }), /foreign table/);
checks += 1;

console.log(`PASS ${checks} native API artifact assertions`);
