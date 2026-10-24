import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const match = (value, pattern, message) => { assert.match(value, pattern, message); checks += 1; };
const doesNotMatch = (value, pattern, message) => { assert.doesNotMatch(value, pattern, message); checks += 1; };

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
const mcp = JSON.parse(read('.mcp.json'));
const pluginDoc = read('PLUGIN.md');
const openaiYaml = read('agents/openai.yaml');
const wrapper = read('scripts/plugin-mcp.mjs');

equal(manifest.name, 'sol-luna-deepseek-router', 'the manifest name matches the plugin folder');
equal(marketplace.interface.displayName, 'Sol 主控 · 多模型峰谷子代理', 'the marketplace display name is unified');
equal(marketplace.name, 'sol-luna', 'the marketplace registry name is stable');
match(openaiYaml, /display_name: "Sol 主控 · 多模型峰谷子代理"/, 'the skill UI display name is unified');
match(openaiYaml, /default_prompt: "[^"]*\$sol-luna-deepseek-router/, 'the skill default prompt names the canonical skill');
match(openaiYaml, /policy:\s*\n\s*allow_implicit_invocation: true/, 'the existing skill invocation policy is preserved');
match(manifest.version, /^\d+\.\d+\.\d+$/, 'the manifest uses strict semver');
equal(manifest.version, '0.12.3', 'the plugin manifest is the 0.12.3 candidate');
for (const file of [
  'scripts/native-current-model.mjs',
  'scripts/native-execution-lifecycle.mjs',
  'scripts/native-upgrade-status.mjs',
  'scripts/native-connection-diagnostics.mjs',
  'scripts/native-bootstrap-install.mjs',
  'scripts/native-bootstrap-maintenance.mjs',
  'scripts/native-api-bootstrap-gate.mjs',
  'scripts/native-router-maintenance-lock.mjs',
  'scripts/native-upgrade-guard.mjs',
  'native/bootstrap/bootstrap.c',
  'native/bootstrap/codex-bootstrap.exe',
]) {
  ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is present in the installable plugin source tree`);
}
ok(manifest.description.length > 20, 'the manifest describes the plugin');
equal(manifest.author.name, 'Puipipi', 'the manifest names the author');
match(manifest.repository, /^https:\/\//, 'the repository is an https URL');
match(manifest.homepage, /^https:\/\//, 'the homepage is an https URL');
equal(manifest.mcpServers, './.mcp.json', 'the manifest points at the MCP companion');
ok(!Object.hasOwn(manifest, 'skills'), 'the plugin does not declare a second scheduling skill');
ok(!existsSync(new URL('../skills/', import.meta.url)), 'the duplicate bundled skills directory is absent');
ok(existsSync(new URL('../SKILL.md', import.meta.url)), 'the root canonical standalone skill remains');
equal(manifest.interface.displayName, 'Sol 主控 · 多模型峰谷子代理', 'the display name is unified');
ok(manifest.interface.shortDescription.length >= 25 && manifest.interface.shortDescription.length <= 64,
  'the short description is within the UI limit');
ok(manifest.interface.longDescription.length > 50, 'the long description is present');
match(manifest.interface.longDescription, /native_deepseek.*provider.*catalog/i, 'the manifest describes the isolated DeepSeek role');
match(manifest.interface.longDescription, /API profiles are immutable/i, 'the manifest describes immutable API profiles');
match(manifest.interface.longDescription, /DeepSeek account|manual env\/file/i, 'the manifest describes account and manual credential references');
match(manifest.interface.longDescription, /fixed|peak.*valley/i, 'the manifest describes fixed and scheduled API selection');
match(manifest.interface.longDescription, /explicit Apply|API panel/i, 'the manifest describes the explicit API panel Apply state');
match(manifest.interface.longDescription, /web search.*disabled|disable.*web search/i, 'the manifest states the first-version web search limitation');
doesNotMatch(manifest.interface.longDescription, /shared `openai` provider|transparently relays GPT traffic/i, 'the manifest does not describe shared-root GPT relay as the formal route');
doesNotMatch(manifest.interface.defaultPrompt.join(' '), /Start the native DeepSeek gateway/i, 'default prompts do not start the old gateway');
equal(manifest.interface.developerName, 'Puipipi', 'the developer name is present');
equal(manifest.interface.category, 'Developer Tools', 'the category is present');
ok(Array.isArray(manifest.interface.capabilities) && manifest.interface.capabilities.includes('Write'), 'the capabilities include write');
ok(Array.isArray(manifest.interface.defaultPrompt) && manifest.interface.defaultPrompt.length <= 3, 'at most three starter prompts are declared');
doesNotMatch(JSON.stringify(manifest), /\[TODO:/, 'the manifest has no placeholder');
doesNotMatch(JSON.stringify(manifest), /hooks/i, 'the manifest does not claim hooks owned by another worker');

const servers = mcp.mcpServers;
ok(servers && typeof servers === 'object', '.mcp.json declares mcpServers');
const server = servers['sol-luna-deepseek-router'];
ok(server, 'the expected MCP server is configured');
equal(server.command, 'node', 'the MCP server runs under node');
deepEqualArray(server.args, ['scripts/plugin-mcp.mjs'], 'the MCP server launches the plugin wrapper');
equal(server.cwd, '.', 'the MCP server resolves relative paths from the plugin root');
equal(server.tool_timeout_sec, 86400, 'unbounded waits are not cut off by a short tool timeout');
ok(server.env_vars.includes('LOCALAPPDATA'), 'the state directory environment is forwarded');
ok(server.env_vars.includes('PATH'), 'the node/npm lookup environment is forwarded');
ok(server.env_vars.includes('CODEX_HOME'), 'the Codex home locator is forwarded');
ok(server.env_vars.includes('SOL_LUNA_NATIVE_INSTALL_JOURNAL'), 'the installed native journal locator is forwarded');
ok(server.env_vars.includes('SOL_LUNA_NATIVE_API_VERSION_DIR'), 'the staged generic API runtime locator is forwarded');
doesNotMatch(JSON.stringify(mcp), /(?:api[_-]?key|authorization|bearer|sk-[A-Za-z0-9]{12,})/i, 'the MCP config contains no credential');

function deepEqualArray(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

match(wrapper, /from '\.\/dsh-mcp-client\.mjs'/, 'the wrapper reuses the existing runClient');
match(wrapper, /dsh-subagent-mcp@0\.7\.0/, 'the client pins the published DSH version');
match(wrapper, /_meta\.threadId/, 'the wrapper requires trusted request metadata');
match(wrapper, /not native Codex children/, 'the wrapper documents the native-child limitation');
match(wrapper, /dsh_trace/, 'the wrapper exposes the browser trace');
doesNotMatch(wrapper, /new Manager|session\/prompt/, 'the wrapper adds no DSH management loop');
match(pluginDoc, /native Codex child/, 'the deployment doc states the browser-trace limitation');
match(pluginDoc, /single-use (?:exchange )?ticket|short-lived/i, 'the deployment doc explains trace ticket exchange');
match(pluginDoc, /does \*\*not\*\* bundle a second scheduling skill|does not bundle a second scheduling skill/, 'the deployment doc records the single-skill rule');
match(pluginDoc, /no automatic release.integration script/i, 'the deployment doc records that skill and plugin synchronization remains separate');
match(pluginDoc, /does not mark them trusted/, 'the deployment doc preserves the human hook trust review');
doesNotMatch(pluginDoc, /[A-Za-z]:\\Users\\[^\\\s]+\\/i, 'the new docs contain no real Windows user path');
doesNotMatch(pluginDoc, /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/, 'the new docs contain no credential');

console.log(`PASS ${checks} plugin manifest assertions`);
