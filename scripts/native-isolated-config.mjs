const LEGACY_BEGIN = "# sol-luna-native-gateway begin";
const LEGACY_END = "# sol-luna-native-gateway end";
const ISOLATED_BEGIN = "# sol-luna-native-isolated begin";
const ISOLATED_END = "# sol-luna-native-isolated end";
const LEGACY_ROOT_KEYS = ["openai_base_url", "model_catalog_json"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanTomlLines(content) {
  const lines = [];
  let offset = 0;
  let multiline = null;
  while (offset < content.length) {
    const nl = content.indexOf("\n", offset);
    const end = nl < 0 ? content.length : nl + 1;
    const contentEnd = nl < 0 ? end : (content[nl - 1] === "\r" ? nl - 1 : nl);
    const raw = content.slice(offset, contentEnd);
    const insideAtStart = multiline !== null;
    let quote = "";
    let escaped = false;
    let visible = "";
    for (let i = 0; i < raw.length; i += 1) {
      const char = raw[i];
      if (multiline) {
        if (multiline === '"""' && char === "\\") {
          i += 1;
        } else if (raw.startsWith(multiline, i)) {
          i += 2;
          multiline = null;
        }
        visible += " ";
        continue;
      }
      if (quote === '"') {
        visible += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quote = "";
      } else if (quote === "'") {
        visible += char;
        if (char === "'") quote = "";
      } else if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) {
        multiline = raw.slice(i, i + 3);
        visible += multiline;
        i += 2;
      } else if (char === '"' || char === "'") {
        quote = char;
        visible += char;
      } else if (char === "#") {
        break;
      } else {
        visible += char;
      }
    }
    lines.push({ start: offset, contentEnd, end, raw, visible, insideAtStart });
    offset = end;
  }
  if (content.length === 0) return lines;
  return lines;
}

function splice(content, start, end, replacement = "") {
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

function matches(content, begin, end) {
  const beginLines = [];
  const endLines = [];
  for (const line of scanTomlLines(content)) {
    if (line.insideAtStart) continue;
    if (line.raw.trim() === begin) beginLines.push(line);
    if (line.raw.trim() === end) endLines.push(line);
  }
  if (beginLines.length === 0 && endLines.length === 0) return [];
  if (beginLines.length !== 1 || endLines.length !== 1 || endLines[0].start <= beginLines[0].start) {
    throw new Error(`invalid or duplicate ${begin} block`);
  }
  const first = beginLines[0];
  const last = endLines[0];
  return [{
    body: content.slice(first.end, last.start),
    startAt: first.start,
    endAt: last.contentEnd,
    bodyStartAt: first.end,
    bodyEndAt: last.start,
  }];
}

function removeBlock(content, block) {
  return splice(content, block.startAt, block.endAt);
}

function parseDottedKeys(source) {
  const parts = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] || "")) index += 1;
    if (source[index] === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < source.length; end += 1) {
        if (escaped) escaped = false;
        else if (source[end] === "\\") escaped = true;
        else if (source[end] === '"') break;
      }
      if (end >= source.length) return null;
      try { parts.push(JSON.parse(source.slice(index, end + 1))); } catch { return null; }
      index = end + 1;
    } else if (source[index] === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) return null;
      parts.push(source.slice(index + 1, end));
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return null;
      parts.push(match[0]);
      index += match[0].length;
    }
    while (/\s/.test(source[index] || "")) index += 1;
    if (index === source.length) break;
    if (source[index] !== ".") return null;
    index += 1;
  }
  return parts;
}

function hasTargetConfig(content, target) {
  let table = [];
  for (const record of scanTomlLines(content)) {
    if (record.insideAtStart) continue;
    const line = record.visible.trim();
    if (!line) continue;
    const tableMatch = /^\[\[?\s*(.*?)\s*\]\]?$/.exec(line);
    if (tableMatch) {
      table = parseDottedKeys(tableMatch[1]);
      if (!table) continue;
      if (startsWithPath(table, target)) return true;
      continue;
    }
    const equalsAt = findUnquotedEquals(line);
    if (equalsAt < 0) continue;
    const key = parseDottedKeys(line.slice(0, equalsAt));
    if (!key) continue;
    const fullPath = [...table, ...key];
    if (startsWithPath(fullPath, target)) return true;
    const isAncestorInlineTable = fullPath.length < target.length
      && startsWithPath(target, fullPath)
      && line.slice(equalsAt + 1).trimStart().startsWith("{");
    if (isAncestorInlineTable) return true;
  }
  return false;
}

function findUnquotedEquals(line) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = "";
    } else if (quote === "'" && char === "'") quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === "=") return i;
  }
  return -1;
}

function startsWithPath(value, prefix) {
  return value.length >= prefix.length && prefix.every((part, index) => value[index] === part);
}

const ISOLATED_TABLES = [
  ["model_providers", "deepseek-native"],
  ["model_providers", "deepseek-native", "capabilities"],
  ["agents", "native_deepseek"],
];

function isolatedTableSegments(content, block) {
  const headers = [];
  for (const record of scanTomlLines(content)) {
    if (record.start < block.bodyStartAt || record.start >= block.bodyEndAt || record.insideAtStart) continue;
    const line = record.visible.trim();
    if (!line.startsWith("[") || !line.endsWith("]")) continue;
    const array = line.startsWith("[[") && line.slice(-2) === "]]";
    const normal = !array && line.startsWith("[") && line.endsWith("]");
    if (!array && !normal) throw new Error("invalid isolated table header");
    const source = line.slice(array ? 2 : 1, array ? -2 : -1).trim();
    const path = parseDottedKeys(source);
    if (!path?.length) throw new Error("invalid isolated table header");
    const exactIndex = ISOLATED_TABLES.findIndex((ownerPath) => path.length === ownerPath.length && startsWithPath(path, ownerPath));
    let ownerIndex = exactIndex;
    if (exactIndex >= 0 && array) throw new Error("invalid isolated table shape");
    if (exactIndex < 0 && ISOLATED_TABLES.some((ownerPath) => startsWithPath(path, ownerPath) || startsWithPath(ownerPath, path))) {
      throw new Error("invalid isolated table shape");
    }
    headers.push({ start: record.start, ownerIndex, path, array });
  }
  const owned = headers.filter((header) => header.ownerIndex >= 0);
  if (owned.length !== ISOLATED_TABLES.length
      || owned.some((header, index) => header.ownerIndex !== index)) {
    throw new Error("invalid isolated table layout");
  }
  return headers.map((header, index) => ({
    ...header,
    end: headers[index + 1]?.start ?? block.bodyEndAt,
  }));
}

function tableContentEnd(content, segment) {
  const lines = scanTomlLines(content).filter((record) => record.start >= segment.start && record.start < segment.end);
  let end = segment.end;
  for (const record of lines.reverse()) {
    if (record.insideAtStart || record.visible.trim()) break;
    end = record.start;
  }
  return end;
}

function removeOwnedIsolatedTables(content, block) {
  const segments = isolatedTableSegments(content, block);
  let result = content;
  for (const segment of segments.filter((item) => item.ownerIndex >= 0).reverse()) {
    result = splice(result, segment.start, tableContentEnd(content, segment));
  }
  return result;
}

function foreignIsolatedBody(content, block) {
  const segments = isolatedTableSegments(content, block);
  let result = content.slice(block.bodyStartAt, block.bodyEndAt);
  for (const segment of segments.filter((item) => item.ownerIndex >= 0).reverse()) {
    result = splice(result, segment.start - block.bodyStartAt, tableContentEnd(content, segment) - block.bodyStartAt);
  }
  return result;
}

function replaceOwnedIsolatedTables(content, block, replacements) {
  const segments = isolatedTableSegments(content, block);
  let result = content;
  for (const segment of segments.filter((item) => item.ownerIndex >= 0).reverse()) {
    result = splice(result, segment.start, tableContentEnd(content, segment), `${replacements[segment.ownerIndex]}\n`);
  }
  return result;
}

function validateLegacyBlock(body, legacyManifest) {
  if (!legacyManifest || !legacyManifest.prior_root || typeof legacyManifest.prior_root !== "object") {
    throw new Error("legacy gateway block requires a valid legacy manifest");
  }
  const assignments = scanTomlLines(body).map((line) => line.visible.trim()).filter(Boolean);
  if (assignments.length !== LEGACY_ROOT_KEYS.length) throw new Error("legacy gateway block does not contain only its two owned root keys");
  const found = new Map();
  for (const line of assignments) {
    const match = /^(openai_base_url|model_catalog_json)\s*=\s*(.+)$/.exec(line);
    if (!match || found.has(match[1])) throw new Error("legacy gateway block does not contain only its two owned root keys");
    try {
      const value = JSON.parse(match[2]);
      if (typeof value !== "string") throw new Error("not a string");
    } catch {
      throw new Error("legacy gateway block contains an invalid owned root value");
    }
    found.set(match[1], true);
  }
  if (LEGACY_ROOT_KEYS.some((key) => !found.has(key))
      || LEGACY_ROOT_KEYS.some((key) => !Object.hasOwn(legacyManifest.prior_root, key))) {
    throw new Error("legacy gateway block or manifest is incomplete");
  }
}

function restoreLegacyRoot(content, priorRoot) {
  const lines = scanTomlLines(content);
  const firstTable = lines.find((line) => !line.insideAtStart && /^\s*\[/.test(line.visible));
  const rootEnd = firstTable?.start ?? content.length;
  const rootLines = lines.filter((line) => line.start < rootEnd && !line.insideAtStart).map((line) => line.visible);
  const additions = [];
  for (const key of LEGACY_ROOT_KEYS) {
    const value = priorRoot[key];
    const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    if (rootLines.some((line) => keyPattern.test(line))) throw new Error(`legacy migration root conflict: ${key} was added outside the old block`);
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`legacy manifest prior_root.${key} is not a TOML scalar`);
    }
    additions.push(`${key} = ${JSON.stringify(value)}`);
  }
  if (!additions.length) return content;
  const separator = rootEnd > 0 && !content.slice(0, rootEnd).endsWith("\n") ? "\n" : "";
  const beforeTable = firstTable ? `${additions.join("\n")}\n\n` : `${additions.join("\n")}\n`;
  return splice(content, rootEnd, rootEnd, `${separator}${beforeTable}`);
}

function escapeTomlString(value) {
  return JSON.stringify(String(value));
}

export function isolatedAgentToml() {
  return [
    'name = "native_deepseek"',
    'description = "DeepSeek Flash native collaboration child"',
    'model = "deepseek/deepseek-flash"',
    'model_reasoning_effort = "high"',
    'developer_instructions = """',
    "你是原生 DeepSeek 子代理。使用简体中文汇报进度与结果；遵守主任务明确的文件范围、权限和验证要求。只执行被分配的工作，不扩大范围；遇到缺少权限或信息时如实说明。",
    '"""',
    "",
    "[features]",
    "unbounded_connection_retries = false",
    "",
  ].join("\n");
}

export function composeIsolatedConfig(content, { baseUrl, agentConfigPath, legacyManifest } = {}) {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  if (typeof baseUrl !== "string" || !baseUrl) throw new TypeError("baseUrl is required");
  if (typeof agentConfigPath !== "string" || !agentConfigPath) throw new TypeError("agentConfigPath is required");

  let base = content;
  const legacy = matches(base, LEGACY_BEGIN, LEGACY_END);
  if (legacy.length) {
    validateLegacyBlock(legacy[0].body, legacyManifest);
    base = removeBlock(base, legacy[0]);
    base = restoreLegacyRoot(base, legacyManifest.prior_root);
  }
  const current = matches(base, ISOLATED_BEGIN, ISOLATED_END);
  const outsideOwnedBlock = current.length ? removeOwnedIsolatedTables(base, current[0]) : base;
  if (hasTargetConfig(outsideOwnedBlock, ["model_providers", "deepseek-native"])) {
    throw new Error("user-owned DeepSeek provider config conflicts with isolated provider");
  }
  if (hasTargetConfig(outsideOwnedBlock, ["agents", "native_deepseek"])) {
    throw new Error("user-owned native_deepseek agent config conflicts with isolated agent");
  }
  const ownedTables = [
    [
      "[model_providers.deepseek-native]",
      'name = "DeepSeek Native"',
      `base_url = ${escapeTomlString(baseUrl)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
    ].join("\n"),
    [
      "[model_providers.deepseek-native.capabilities]",
      'remote_compaction = "unsupported"',
    ].join("\n"),
    [
      "[agents.native_deepseek]",
      'description = "Native DeepSeek collaboration child"',
      `config_file = ${escapeTomlString(agentConfigPath)}`,
    ].join("\n"),
  ];
  const ownedBlock = [ISOLATED_BEGIN, ...ownedTables, ISOLATED_END].join("\n");
  if (current.length) return replaceOwnedIsolatedTables(base, current[0], ownedTables);
  const separator = base.length === 0 ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return `${base}${separator}${ownedBlock}\n`;
}

export function removeIsolatedConfig(content) {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  const isolated = matches(content, ISOLATED_BEGIN, ISOLATED_END);
  return isolated.length
    ? splice(content, isolated[0].startAt, isolated[0].endAt, foreignIsolatedBody(content, isolated[0]))
    : content;
}

export function rootRoutesThroughIsolatedProvider(content, { baseUrl, providerId = "deepseek-native" } = {}) {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  let rootProvider;
  let rootBaseUrl;
  let inRoot = true;
  for (const record of scanTomlLines(content)) {
    if (record.insideAtStart) continue;
    const line = record.visible.trim();
    if (!line) continue;
    if (/^\[/.test(line)) {
      inRoot = false;
      continue;
    }
    if (!inRoot) continue;
    const equalsAt = findUnquotedEquals(line);
    if (equalsAt < 0) continue;
    const key = parseDottedKeys(line.slice(0, equalsAt).trim());
    if (!key || key.length !== 1 || !["model_provider", "openai_base_url"].includes(key[0])) continue;
    const raw = line.slice(equalsAt + 1).trim();
    let value;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { throw new Error(`root ${key[0]} cannot be safely checked for isolated provider removal`); }
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) throw new Error(`root ${key[0]} cannot be safely checked for isolated provider removal`);
      value = raw.slice(1, -1);
    } else throw new Error(`root ${key[0]} cannot be safely checked for isolated provider removal`);
    if (key[0] === "model_provider") rootProvider = value;
    else rootBaseUrl = value;
  }
  if (rootProvider === providerId) return true;
  if (rootBaseUrl === undefined) return false;
  let current;
  let isolated;
  try {
    current = new URL(rootBaseUrl);
    isolated = new URL(baseUrl);
  } catch {
    throw new Error("root openai_base_url cannot be safely checked for isolated provider removal");
  }
  const loopbackAliases = new Set(["127.0.0.1", "localhost"]);
  const segments = (url) => url.pathname.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return null; }
  });
  const currentPath = segments(current);
  const isolatedPath = segments(isolated);
  return current.protocol === "http:" && isolated.protocol === "http:"
    && loopbackAliases.has(current.hostname.toLowerCase())
    && loopbackAliases.has(isolated.hostname.toLowerCase())
    && current.port === isolated.port
    && currentPath.length > 0 && isolatedPath.length > 0
    && currentPath[0] !== null && currentPath[0] === isolatedPath[0];
}

export function hasOnlyAddedForeignSkillTables(current, planned, options) {
  if (typeof current !== "string" || typeof planned !== "string") return false;
  try {
    const currentBlocks = matches(current, ISOLATED_BEGIN, ISOLATED_END);
    const plannedBlocks = matches(planned, ISOLATED_BEGIN, ISOLATED_END);
    if (currentBlocks.length !== 1 || plannedBlocks.length !== 1) return false;
    const currentSegments = isolatedTableSegments(current, currentBlocks[0]);
    const plannedSegments = isolatedTableSegments(planned, plannedBlocks[0]);
    const currentForeign = currentSegments.filter((item) => item.ownerIndex < 0);
    const plannedForeign = plannedSegments.filter((item) => item.ownerIndex < 0);
    if (currentForeign.length === 0 || plannedForeign.length !== 0
        || currentForeign.some((item) => !item.array || item.path.length !== 2
          || item.path[0] !== "skills" || item.path[1] !== "config")) return false;
    if (composeIsolatedConfig(planned, options) !== planned || composeIsolatedConfig(current, options) !== current) return false;
    return removeBlock(current, currentBlocks[0]) === removeBlock(planned, plannedBlocks[0]);
  } catch {
    return false;
  }
}

export function hasLegacyGatewayConfigMarker(content) {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  return matches(content, LEGACY_BEGIN, LEGACY_END).length === 1;
}

export function hasIsolatedConfigMarker(content) {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  return matches(content, ISOLATED_BEGIN, ISOLATED_END).length === 1;
}

// Smoke-only rewrite: point a disposable home at its copied main-model cache.
// This intentionally does not participate in the real install plan.
export function withTemporaryRootModelCatalog(content, catalogPath) {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  if (typeof catalogPath !== "string" || !catalogPath) throw new TypeError("catalogPath is required");
  const lines = scanTomlLines(content);
  const firstTable = lines.find((line) => !line.insideAtStart && /^\s*\[/.test(line.visible));
  const rootEnd = firstTable?.start ?? content.length;
  const root = lines.filter((line) => line.start < rootEnd && !line.insideAtStart);
  const keyLines = root.filter((line) => /^\s*model_catalog_json\s*=/.test(line.visible));
  if (keyLines.length > 1) throw new Error("temporary smoke config has duplicate root model_catalog_json keys");
  const assignment = `model_catalog_json = ${escapeTomlString(catalogPath)}`;
  if (keyLines.length === 1) {
    const line = keyLines[0];
    return splice(content, line.start, line.contentEnd, assignment);
  }
  const newline = content.slice(0, rootEnd).endsWith("\n") || rootEnd === 0 ? "" : "\n";
  const beforeTable = firstTable ? `${assignment}\n\n` : `${assignment}\n`;
  return splice(content, rootEnd, rootEnd, `${newline}${beforeTable}`);
}
