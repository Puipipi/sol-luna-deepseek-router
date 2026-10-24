import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

// Plugin default working budget when a profile does not set contextWindow.
// It is not a probe or claim about the selected model's real context limit;
// users should set the budget for their model and tool payloads.
export const DEFAULT_API_CONTEXT_WINDOW = 128_000;
export const MIN_API_CONTEXT_WINDOW = 1_024;
export const MAX_API_CONTEXT_WINDOW = 2_000_000;
export const API_CONFIG_BEGIN = "# sol-luna-native-api begin";
export const API_CONFIG_END = "# sol-luna-native-api end";

export function resolveApiModelInstructions(catalog) {
  if (!Array.isArray(catalog?.models)) throw new Error("native models catalog has no models for API instructions");
  const candidates = [
    ...catalog.models.filter((model) => model?.visibility === "list"),
    ...catalog.models.filter((model) => model?.visibility !== "list"),
  ];
  const template = candidates.find((model) => hasModelInstructions(model));
  if (!template) throw new Error("native models catalog has no non-empty base_instructions or model_messages.instructions_template");
  if (typeof template.model_messages?.instructions_template === "string" && template.model_messages.instructions_template.trim()) {
    return { model_messages: structuredClone(template.model_messages) };
  }
  return { base_instructions: template.base_instructions };
}

export function hasModelInstructions(model) {
  return (typeof model?.base_instructions === "string" && model.base_instructions.trim().length > 0)
    || (typeof model?.model_messages?.instructions_template === "string"
      && model.model_messages.instructions_template.trim().length > 0);
}

const EFFORT_DESCRIPTIONS = Object.freeze({
  none: "No reasoning effort parameter",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth",
  max: "Maximum reasoning depth",
});

export function apiIdentifiers(profileId) {
  if (typeof profileId !== "string" || !/^[a-f0-9]{24}$/.test(profileId)) {
    throw new Error("API profile id must be 24 lowercase hexadecimal characters");
  }
  return {
    profileId,
    roleName: `native_api_${profileId}`,
    providerId: `api-native-${profileId}`,
    roleFile: `agents/native_api_${profileId}.toml`,
    catalogFile: `sol-luna-native-models-${profileId}.json`,
  };
}

export function effectiveContextWindow(profile) {
  const value = profile?.contextWindow ?? DEFAULT_API_CONTEXT_WINDOW;
  if (!Number.isSafeInteger(value) || value < MIN_API_CONTEXT_WINDOW || value > MAX_API_CONTEXT_WINDOW) {
    throw new Error(`contextWindow must be an integer from ${MIN_API_CONTEXT_WINDOW} to ${MAX_API_CONTEXT_WINDOW}`);
  }
  return value;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function buildApiRoleToml(profile) {
  const ids = apiIdentifiers(profile.profileId);
  const lines = [
    `name = ${tomlString(ids.roleName)}`,
    `model = ${tomlString(profile.model)}`,
  ];
  if (profile.reasoning.parameter !== "none") lines.push(`model_reasoning_effort = ${tomlString(profile.reasoning.default)}`);
  lines.push(
    "",
    "[features]",
    "unbounded_connection_retries = false",
    "",
  );
  return lines.join("\n");
}

export function buildApiCatalog(profile, modelInstructions) {
  if (!hasModelInstructions(modelInstructions)) {
    throw new Error("non-empty native model instructions are required for the API catalog");
  }
  const ids = apiIdentifiers(profile.profileId);
  const contextWindow = effectiveContextWindow(profile);
  const noReasoning = profile.reasoning.parameter === "none";
  const supported = noReasoning ? [] : profile.reasoning.supported.map((effort) => ({
    effort,
    description: EFFORT_DESCRIPTIONS[effort] || "Configured reasoning effort",
  }));
  const model = {
    slug: profile.model,
    display_name: profile.label || profile.model,
    description: "User-configured OpenAI-compatible API model through the local native API gateway.",
    supported_reasoning_levels: supported,
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    comp_hash: `sol-luna-native-api-${profile.profileId}`,
    effective_context_window_percent: 85,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    node_repl_auto_review_required: false,
    tool_mode: null,
    multi_agent_version: "v2",
    ...structuredClone(modelInstructions),
  };
  if (!noReasoning) model.default_reasoning_level = profile.reasoning.default;
  if (!noReasoning && profile.reasoning.supported.includes(profile.reasoning.default) && profile.reasoning.default !== "none") {
    model.multi_agent_reasoning_effort = profile.reasoning.default;
  }
  return { models: [model] };
}

export function buildApiProviderTable(profileId, baseUrl) {
  const ids = apiIdentifiers(profileId);
  const url = new URL(baseUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
      || url.search || url.hash || segments.length !== 4 || !segments[0]
      || segments[1] !== "profiles" || segments[2] !== profileId || segments[3] !== "v1") {
    throw new Error("API provider baseUrl must be the profile-specific loopback gateway URL");
  }
  return [
    `[model_providers.${ids.providerId}]`,
    `name = ${tomlString(`Native API ${profileId}`)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
  ].join("\n");
}

export function apiGatewayBaseUrl(identity) {
  if (!identity?.token || !Number.isInteger(identity?.port) || identity.port < 1 || identity.port > 65535) {
    throw new Error("a prepared API gateway identity is required");
  }
  return `http://127.0.0.1:${identity.port}/${identity.token}`;
}

export function apiProfileBaseUrl(gatewayBaseUrl, profileId) {
  apiIdentifiers(profileId);
  return `${gatewayBaseUrl.replace(/\/$/, "")}/profiles/${profileId}/v1`;
}

function markerLines(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const begins = [];
  const ends = [];
  for (let index = 0; index < lines.length; index += 1) {
    const visible = lines[index].replace(/\s+#.*$/, "").trim();
    if (visible === API_CONFIG_BEGIN) begins.push(index);
    if (visible === API_CONFIG_END) ends.push(index);
  }
  return { lines, begins, ends };
}

function blockRange(content) {
  const { lines, begins, ends } = markerLines(content);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] <= begins[0]) throw new Error("invalid or duplicate native API config block");
  return { lines, start: begins[0], end: ends[0] };
}

function stripBlock(content) {
  const block = blockRange(content);
  if (!block) return content;
  return [...block.lines.slice(0, block.start), ...block.lines.slice(block.end + 1)].join("\n");
}

function hasForeignProvider(content, providerId) {
  const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const table = new RegExp(`^\\s*\\[model_providers\\.${escaped}(?:\\]|\\.)`);
  const dotted = new RegExp(`^\\s*model_providers\\.${escaped}\\.`);
  return content.replace(/\r\n/g, "\n").split("\n").some((line) => table.test(line) || dotted.test(line));
}

function hasForeignAgent(content, roleName) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const key = (value) => `(?:${escape(value)}|"${escape(value)}"|'${escape(value)}')`;
  const agentsKey = key("agents");
  const roleKey = key(roleName);
  const directTable = new RegExp(`^\\s*\\[{1,2}\\s*${agentsKey}\\s*\\.\\s*${roleKey}(?:\\s*\\.|\\s*\\])`);
  const agentsTable = new RegExp(`^\\s*\\[{1,2}\\s*${agentsKey}\\s*\\]{1,2}`);
  const dotted = new RegExp(`^\\s*${agentsKey}\\s*\\.\\s*${roleKey}(?:\\s*\\.|\\s*=)`);
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let insideAgentsTable = false;
  let insideRootInlineAgents = false;
  for (const line of lines) {
    const visible = line.replace(/\s+#.*$/, "").trim();
    if (/^\s*\[/.test(visible)) {
      insideAgentsTable = agentsTable.test(visible);
      insideRootInlineAgents = false;
      if (directTable.test(visible)) return true;
      continue;
    }
    if (insideAgentsTable && new RegExp(`^\\s*${roleKey}(?:\\s*\\.|\\s*=)`).test(visible)) return true;
    if (new RegExp(`^\\s*${agentsKey}\\s*=\\s*\\{`).test(visible)) insideRootInlineAgents = true;
    if (insideRootInlineAgents && new RegExp(`(?:^|[,\\s{])${roleKey}\\s*=`).test(visible)) return true;
    if (dotted.test(visible)) return true;
  }
  return false;
}

export function composeApiConfig(content, { profileIds = [], gatewayBaseUrl, codexHome, registerAgentRoles = true } = {}) {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  const ids = [...new Set(profileIds)].sort();
  for (const id of ids) apiIdentifiers(id);
  if (ids.length && registerAgentRoles && (typeof codexHome !== "string" || !path.isAbsolute(codexHome))) {
    throw new Error("codexHome must be absolute to register native API roles");
  }
  const existingBlock = blockRange(content);
  if (existingBlock) {
    for (const line of existingBlock.lines.slice(existingBlock.start + 1, existingBlock.end)) {
      const visible = line.replace(/\s+#.*$/, "").trim();
      if (visible.startsWith("[")
          && !/^\[model_providers\.api-native-[a-f0-9]{24}\]$/.test(visible)
          && !/^\[agents\.native_api_[a-f0-9]{24}\]$/.test(visible)) {
        throw new Error("the native API config block contains a foreign table; refusing to replace it");
      }
    }
  }
  const base = stripBlock(content);
  for (const id of ids) {
    const providerId = apiIdentifiers(id).providerId;
    if (hasForeignProvider(base, providerId)) throw new Error(`user-owned provider config conflicts with ${providerId}`);
    const roleName = apiIdentifiers(id).roleName;
    if (registerAgentRoles && hasForeignAgent(base, roleName)) throw new Error(`user-owned agent config conflicts with ${roleName}`);
  }
  if (ids.length === 0) {
    const trimmed = base.replace(/\n{3,}/g, "\n\n").trimEnd();
    return trimmed ? `${trimmed}\n` : "";
  }
  if (typeof gatewayBaseUrl !== "string" || !gatewayBaseUrl) throw new Error("gatewayBaseUrl is required to compose native API providers");
  const tables = ids.map((id) => buildApiProviderTable(id, apiProfileBaseUrl(gatewayBaseUrl, id)));
  if (registerAgentRoles) {
    for (const id of ids) {
      const identifiers = apiIdentifiers(id);
      const rolePath = path.join(codexHome, ...identifiers.roleFile.split("/"));
      tables.push(
        `[agents.${identifiers.roleName}]`,
        `description = ${tomlString(`Native API profile ${id}`)}`,
        `config_file = ${tomlString(rolePath)}`,
      );
    }
  }
  const block = [API_CONFIG_BEGIN, ...tables, API_CONFIG_END].join("\n");
  return `${base.trimEnd()}${base.trimEnd() ? "\n\n" : ""}${block}\n`;
}

export function renderApiArtifacts(profile, { codexHome, baseUrl, modelInstructions } = {}) {
  if (typeof codexHome !== "string" || !path.isAbsolute(codexHome)) throw new Error("codexHome must be absolute");
  const ids = apiIdentifiers(profile.profileId);
  return {
    ids,
    rolePath: path.join(codexHome, ...ids.roleFile.split("/")),
    catalogPath: path.join(codexHome, ids.catalogFile),
    roleBytes: Buffer.from(buildApiRoleToml(profile), "utf8"),
    catalogBytes: Buffer.from(`${JSON.stringify(buildApiCatalog(profile, modelInstructions), null, 2)}\n`, "utf8"),
    providerTable: buildApiProviderTable(profile.profileId, baseUrl),
  };
}

export async function readRegularOrAbsent(file, label = "managed file") {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
