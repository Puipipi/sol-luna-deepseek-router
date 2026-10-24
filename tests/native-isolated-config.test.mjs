import assert from "node:assert/strict";
import {
  composeIsolatedConfig,
  hasOnlyAddedForeignSkillTables,
  isolatedAgentToml,
  removeIsolatedConfig,
  rootRoutesThroughIsolatedProvider,
  withTemporaryRootModelCatalog,
} from "../scripts/native-isolated-config.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const throws = (fn, pattern, message) => { assert.throws(fn, pattern, message); checks += 1; };

const opts = {
  baseUrl: "http://127.0.0.1:1234/v1",
  agentConfigPath: "C:\\Users\\23825\\.codex\\agents\\native_deepseek.toml",
};
equal(rootRoutesThroughIsolatedProvider('model = "gpt-6.1-sol"\nmodel_provider = "deepseek-native"\n', opts), true, "root provider selection is recognized as depending on the isolated provider");
equal(rootRoutesThroughIsolatedProvider(`openai_base_url = "${opts.baseUrl}"\n`, opts), true, "root base URL is recognized as depending on the private gateway");
const routeUrl = new URL(opts.baseUrl);
equal(rootRoutesThroughIsolatedProvider(`openai_base_url = "http://localhost:${routeUrl.port}${routeUrl.pathname}/"\n`, opts), true, "localhost alias and trailing slash still identify the private gateway");
equal(rootRoutesThroughIsolatedProvider(`openai_base_url = "http://localhost:${routeUrl.port}/${routeUrl.pathname.split("/").filter(Boolean)[0]}"\n`, opts), true, "the token-root path still identifies the private gateway");
equal(rootRoutesThroughIsolatedProvider(`openai_base_url = "http://127.0.0.1:${routeUrl.port}/another-token/v1"\n`, opts), false, "a different first token segment is an independent route");
equal(rootRoutesThroughIsolatedProvider(`[mcp_servers.user]\nopenai_base_url = "${opts.baseUrl}"\n`, opts), false, "nested server configuration is not mistaken for root routing");
equal(rootRoutesThroughIsolatedProvider('model_provider = "other"\nopenai_base_url = "https://api.example/v1"\n', opts), false, "unrelated root routing is preserved without a false dependency");
throws(() => rootRoutesThroughIsolatedProvider('openai_base_url = "http://[invalid"\n', opts), /cannot be safely checked/i, "an unparseable root URL fails closed rather than being treated as independent");
const marker = (body) => `# sol-luna-native-gateway begin\n${body}\n# sol-luna-native-gateway end\n`;

const fresh = [
  'model = "gpt-6.1-sol"',
  'model_provider = "openai"',
  'model_catalog_json = "https://user.example/catalog.json"',
  'openai_base_url = "https://user.example/v1"',
  'approval_policy = "never"',
  "",
  "[features]",
  "multi_agent = true",
  "unbounded_connection_retries = true",
  "",
].join("\n");
const first = composeIsolatedConfig(fresh, opts);
ok(first.includes('model = "gpt-6.1-sol"'), "fresh config retains user's selected model");
ok(first.includes('openai_base_url = "https://user.example/v1"'), "fresh config retains user root routing");
ok(first.includes('model_catalog_json = "https://user.example/catalog.json"'), "fresh config retains user catalog");
ok(first.includes("unbounded_connection_retries = true"), "isolated config preserves the user's root retry feature");
ok(!/# sol-luna-native-isolated begin[\s\S]*?openai_base_url\s*=/.test(first), "owned block does not set root routing");
ok(first.includes("[model_providers.deepseek-native]"), "isolated provider is added");
ok(first.includes('wire_api = "responses"'), "provider uses Responses wire API");
ok(first.includes("request_max_retries = 0"), "isolated provider disables request retries");
ok(first.includes("stream_max_retries = 0"), "isolated provider disables stream retries");
ok(first.includes("remote_compaction = \"unsupported\""), "provider disables remote compaction");
ok(first.includes("[agents.native_deepseek]"), "child agent config path is registered");
ok(first.includes('config_file = "C:\\\\Users\\\\23825\\\\.codex\\\\agents\\\\native_deepseek.toml"'), "Windows path is TOML-escaped");
equal(composeIsolatedConfig(first, opts), first, "reapplying config is idempotent");

const multiline = [
  'developer_instructions = """',
  "keep three blank lines exactly:",
  "",
  "",
  "",
  "# sol-luna-native-isolated begin",
  "[model_providers.deepseek-native]",
  '"""',
  'model = "gpt-6.1-sol"',
  "",
].join("\n");
const multilineWithBlock = composeIsolatedConfig(multiline, opts);
ok(multilineWithBlock.includes(multiline.slice(0, multiline.indexOf('model = "gpt-6.1-sol"'))), "multiline TOML string contents and blank lines are byte-for-byte retained");
equal(composeIsolatedConfig(multilineWithBlock, opts), multilineWithBlock, "reapply ignores markers and table-like text inside multiline strings");
const multilineRemoved = removeIsolatedConfig(multilineWithBlock);
ok(multilineRemoved.startsWith(multiline), "remove preserves multiline TOML and fake marker text exactly");
const tempCatalogSource = [
  'developer_instructions = """',
  'fake model_catalog_json = "do-not-touch"',
  '[fake.table]',
  '"""',
  'model = "gpt-6.1-sol"',
  '',
  '[features]',
  'multi_agent = true',
  '',
].join("\n");
const tempCatalog = withTemporaryRootModelCatalog(tempCatalogSource, "C:\\Temp\\smoke-main-cache.json");
ok(tempCatalog.includes('model_catalog_json = "C:\\\\Temp\\\\smoke-main-cache.json"'), "temporary catalog helper adds a TOML-escaped root catalog path");
ok(tempCatalog.includes(tempCatalogSource.slice(0, tempCatalogSource.indexOf('model = "gpt-6.1-sol"'))), "temporary catalog helper preserves multiline instruction contents exactly");
equal(withTemporaryRootModelCatalog('model = "main"\nmodel_catalog_json = "old.json"\n', "C:\\Temp\\cache.json").match(/^model_catalog_json =/gm).length, 1, "temporary catalog helper replaces rather than duplicates the root key");

const legacyBase = [
  'model = "gpt-6.1-sol"',
  'model_provider = "openai"',
  'approval_policy = "never"',
  "",
  "[features]",
  "multi_agent = true",
  "",
].join("\n");
const legacy = `${marker('openai_base_url = "http://127.0.0.1:7777/v1"\nmodel_catalog_json = "old-catalog.json"')}\n${legacyBase}`;
const migrated = composeIsolatedConfig(legacy, {
  ...opts,
  legacyManifest: { prior_root: { openai_base_url: "https://prior.example/v1", model_catalog_json: null } },
});
ok(!migrated.includes("sol-luna-native-gateway begin"), "valid legacy owned block is removed");
ok(migrated.includes('openai_base_url = "https://prior.example/v1"'), "legacy prior root value is restored");
ok(!/^model_catalog_json\s*=/m.test(migrated), "legacy null root value remains absent");
throws(() => composeIsolatedConfig(legacy, opts), /valid legacy manifest/i, "legacy block without valid manifest is refused");

const userAdded = `${first.replace("\n[features]", '\nadded_after_install = "keep"\n\n[features]')}\n[user.added]\nkey = 7\n`;
const updated = composeIsolatedConfig(userAdded, opts);
ok(updated.includes('added_after_install = "keep"'), "later root key is retained");
ok(updated.includes("[user.added]\nkey = 7"), "later user table is retained");
const removed = removeIsolatedConfig(updated);
ok(removed.includes('model = "gpt-6.1-sol"'), "removal keeps original user model");
ok(removed.includes('openai_base_url = "https://user.example/v1"'), "removal keeps original user root config");
ok(removed.includes('added_after_install = "keep"'), "removal keeps later user root key");
ok(removed.includes("[user.added]\nkey = 7"), "removal keeps later user table");
ok(!removed.includes("sol-luna-native-isolated begin"), "removal deletes only isolated owned block");
ok(!removed.includes("sol-luna-native-gateway begin"), "removal does not recreate removed legacy block");

const foreignSkillTables = [
  "[[skills.config]]",
  'path = "fixture-alpha"',
  "enabled = true",
  "",
  "[[skills.config]]",
  'path = "fixture-beta"',
  "enabled = false",
].join("\n");
const foreignBeforeMarkerEnd = first.replace(
  "[model_providers.deepseek-native.capabilities]",
  `${foreignSkillTables}\n[model_providers.deepseek-native.capabilities]`,
).replace(
  "[agents.native_deepseek]",
  `[[skills.config]]\npath = "fixture-gamma"\nenabled = true\n\n[agents.native_deepseek]`,
);
const preservesForeignTablesInOrder = (value) => {
  const positions = ["fixture-alpha", "fixture-beta", "fixture-gamma"].map((name) => value.indexOf(name));
  return positions.every((position) => position >= 0)
    && positions[0] < positions[1] && positions[1] < positions[2]
    && (value.match(/\[\[skills\.config\]\]/g) || []).length === 3;
};
equal(
  composeIsolatedConfig(foreignBeforeMarkerEnd, opts),
  foreignBeforeMarkerEnd,
  "gate comparison accepts foreign array tables inserted between owned tables",
);
equal(
  hasOnlyAddedForeignSkillTables(foreignBeforeMarkerEnd, first, opts),
  true,
  "rollback classification recognizes only newly added foreign skill array tables",
);
equal(
  hasOnlyAddedForeignSkillTables(foreignBeforeMarkerEnd.replace('model = "gpt-6.1-sol"', 'model = "changed-main"'), first, opts),
  false,
  "rollback classification rejects unrelated changes outside the marker",
);
equal(
  hasOnlyAddedForeignSkillTables(foreignBeforeMarkerEnd.replace("[[skills.config]]", "[[other.config]]"), first, opts),
  false,
  "rollback classification does not broaden to other foreign array tables",
);
const triviaBeforeForeignTable = first.replace(
  "[model_providers.deepseek-native.capabilities]",
  '\n# application-added comment before foreign table\n[[skills.config]]\npath = "fixture-trivia"\nenabled = true\n\n[model_providers.deepseek-native.capabilities]',
);
equal(
  composeIsolatedConfig(triviaBeforeForeignTable, opts),
  triviaBeforeForeignTable,
  "compose preserves blank-line and comment trivia immediately before a foreign table",
);
ok(
  removeIsolatedConfig(triviaBeforeForeignTable).includes('\n# application-added comment before foreign table\n[[skills.config]]'),
  "remove preserves comment trivia immediately before a foreign table",
);
const removedWithForeignTables = removeIsolatedConfig(foreignBeforeMarkerEnd);
ok(
  removedWithForeignTables.includes(foreignSkillTables)
    && removedWithForeignTables.includes('path = "fixture-gamma"\nenabled = true')
    && preservesForeignTablesInOrder(removedWithForeignTables),
  "removing isolated tables preserves all foreign array tables byte-for-byte and in order",
);
for (const [label, before, after] of [
  ["provider URL", `base_url = ${JSON.stringify(opts.baseUrl)}`, 'base_url = "http://127.0.0.1:9999/v1"'],
  ["agent role path", `config_file = ${JSON.stringify(opts.agentConfigPath)}`, 'config_file = "fixture-other-agent.toml"'],
  ["request retries", "request_max_retries = 0", "request_max_retries = 1"],
  ["stream retries", "stream_max_retries = 0", "stream_max_retries = 1"],
  ["compaction capability", 'remote_compaction = "unsupported"', 'remote_compaction = "enabled"'],
]) {
  const drift = foreignBeforeMarkerEnd.replace(before, after);
  equal(
    hasOnlyAddedForeignSkillTables(drift, first, opts),
    false,
    `rollback classification rejects owned ${label} drift`,
  );
  const recomposed = composeIsolatedConfig(drift, opts);
  ok(recomposed !== drift, `gate comparison rejects owned ${label} drift`);
  ok(preservesForeignTablesInOrder(recomposed), `owned ${label} repair preserves foreign tables in order`);
}
const fakeHeadersInString = foreignBeforeMarkerEnd.replace(
  'path = "fixture-alpha"',
  'note = """\n[[skills.config]]\npath = "fake"\n"""\npath = "fixture-alpha"',
);
equal(
  composeIsolatedConfig(fakeHeadersInString, opts),
  fakeHeadersInString,
  "table-like text inside a string is not treated as a foreign array table",
);
for (const malformedOwnedHeader of [
  "[model_providers.deepseek-native.extra]",
  "[[model_providers.deepseek-native]]",
  "[agents.native_deepseek.extra]",
  "[[agents.native_deepseek]]",
]) {
  const malformed = foreignBeforeMarkerEnd.replace(
    "# sol-luna-native-isolated end",
    `${malformedOwnedHeader}\nfixture_key = true\n# sol-luna-native-isolated end`,
  );
  throws(
    () => composeIsolatedConfig(malformed, opts),
    /invalid.*isolated|isolated.*invalid/i,
    `malformed owned namespace header ${malformedOwnedHeader} is rejected`,
  );
}

for (const conflict of [
  `${fresh}\n[model_providers.deepseek-native]\nname = "user"\n`,
  `${fresh}\n[model_providers."deepseek-native"]\nname = "user"\n`,
  `${fresh}\n[model_providers]\n"deepseek-native" = { name = "user" }\n`,
  `${fresh}\n[model_providers]\ndeepseek-native = { name = "user" }\n`,
  `${fresh}\n[agents.native_deepseek]\ndescription = "user"\n`,
  `${fresh}\n[agents]\n'native_deepseek' = { description = "user" }\n`,
]) {
  throws(() => composeIsolatedConfig(conflict, opts), /user-owned.*(provider|agent)|conflict/i, "unowned provider or agent config is refused");
}
const rootOnly = fresh.slice(0, fresh.indexOf("\n[features]"));
for (const conflict of [
  `${rootOnly}\nmodel_providers = { "other" = { name = "user" } }\n`,
  `${rootOnly}\nagents = { max_threads = 6 }\n`,
]) {
  throws(() => composeIsolatedConfig(conflict, opts), /user-owned.*(provider|agent)|conflict/i, "ancestor inline table conflicts with adding nested configuration");
}
const legacyConflict = `${marker('openai_base_url = "127.0.0.1"\nmodel_catalog_json = "old.json"')}\nopenai_base_url = "https://user-added.example/v1"\n`;
throws(() => composeIsolatedConfig(legacyConflict, {
  ...opts,
  legacyManifest: { prior_root: { openai_base_url: "https://prior.example/v1", model_catalog_json: null } },
}), /root.*conflict/i, "legacy migration does not overwrite a root key added by the user");

const role = isolatedAgentToml();
const developerInstructionsStart = role.indexOf('developer_instructions = """');
const developerInstructionsEnd = role.indexOf('\n"""', developerInstructionsStart);
const retryFeaturesStart = role.indexOf("\n[features]\n");
ok(developerInstructionsStart >= 0 && developerInstructionsEnd > developerInstructionsStart && retryFeaturesStart > developerInstructionsEnd,
  "developer instructions close as a root-level multiline string before the retry feature table");
ok(role.includes('model = "deepseek/deepseek-flash"'), "role fixes the exact DeepSeek model slug");
ok(role.includes('model_reasoning_effort = "high"'), "role sets high reasoning effort");
ok(role.includes("[features]\nunbounded_connection_retries = false"), "dedicated DeepSeek role disables unbounded connection retries");
ok(!/^unbounded_connection_retries\s*=\s*true$/m.test(role), "dedicated DeepSeek role does not inherit an enabled retry override");
ok(role.includes('name = "native_deepseek"') && role.includes("description ="), "role remains discoverable by the agent loader");
ok(role.includes("developer_instructions = \"\"\""), "role contains developer instructions");
ok(role.includes("中文"), "role instructions are Chinese");
ok(!/^model_provider\s*=/m.test(role), "role does not attempt an unsupported provider override");
ok(!/^(sandbox_mode|approval_policy|approval_mode)\s*=/m.test(role), "role does not alter inherited execution permissions");

console.log(`PASS ${checks} isolated config assertions`);
