import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const readme = read('README.md');
const skill = read('SKILL.md');
const pluginDoc = read('PLUGIN.md');
const pluginManifest = JSON.parse(read('.codex-plugin/plugin.json'));
const nativePluginCandidate = read('docs/native-plugin-candidate-0.10.5-2026-10-18.md');
const nativeBuild = read('docs/native-isolated-cli-build.md');
const nativeApiRoleFix = read('docs/native-api-role-registration-0.11.2-2026-10-19.md');
const nativeApiInstructionsFix = read('docs/native-api-catalog-instructions-0.11.3-2026-10-19.md');
const nativeApiAgentMessageFix = read('docs/native-api-agent-message-0.11.4-2026-10-19.md');
const nativeInstaller = read('docs/native-isolated-install.md');
const nativeLifecycleText = read('docs/native-gateway-lifecycle-2026-10-18.json');
JSON.parse(nativeLifecycleText);
const nativeAcceptance = read('docs/native-deepseek-acceptance-2026-10-17.md');
const client = read('scripts/dsh-mcp-client.mjs');
const hooks = JSON.parse(read('hooks/hooks.json'));
const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));

assert.equal(marketplace.name, 'sol-luna', 'the repo marketplace has a stable portable name');
assert.equal(marketplace.plugins.length, 1, 'the repo marketplace lists one routing plugin');
assert.equal(marketplace.plugins[0].name, 'sol-luna-deepseek-router', 'the marketplace plugin matches the manifest name');
assert.equal(marketplace.plugins[0].source.source, 'local', 'the marketplace plugin is local');
assert.equal(marketplace.plugins[0].source.path, './', 'the plugin source stays inside the marketplace root');
assert.doesNotMatch(marketplace.plugins[0].source.path, /^(?:[A-Za-z]:[\\/]|\\\\)/, 'the marketplace source is not an absolute path');
assert.equal(marketplace.plugins[0].policy.installation, 'AVAILABLE', 'the marketplace installation policy is explicit');
assert.equal(marketplace.plugins[0].policy.authentication, 'ON_INSTALL', 'the marketplace auth policy is explicit');
assert.equal(marketplace.plugins[0].category, 'Developer Tools', 'the marketplace category is explicit');
assert.match(pluginManifest.version, /^\d+\.\d+\.\d+$/, 'the canonical plugin manifest carries a valid release version');
assert.match(nativeApiRoleFix, /0\.11\.1/i, 'the 0.11.2 fix record identifies the affected version');
assert.match(nativeApiRoleFix, /unknown agent_type/i, 'the 0.11.2 fix record captures the failed first real role dispatch');
assert.match(nativeApiRoleFix, /config\/read/i, 'the fix record limits loader evidence to config/read');
assert.match(readme, /native-api-role-registration-0\.11\.2-2026-10-19/);
assert.match(pluginDoc, /native-api-role-registration-0\.11\.2-2026-10-19/);
assert.match(readme, /native-api-catalog-instructions-0\.11\.3-2026-10-19/);
assert.match(pluginDoc, /native-api-catalog-instructions-0\.11\.3-2026-10-19/);
assert.match(pluginDoc, /native-api-agent-message-0\.11\.4-2026-10-19/);
assert.match(skill, /native-api-catalog-instructions-0\.11\.3-2026-10-19/);
assert.match(nativeApiInstructionsFix, /before child creation/i);
assert.match(nativeApiInstructionsFix, /model\/list.*not parse/i);
assert.match(nativeApiInstructionsFix, /apiVerified.*false/i);
assert.match(readme, /native-api-agent-message-0\.11\.4-2026-10-19/);
assert.match(pluginDoc, /native-api-agent-message-0\.11\.4-2026-10-19/);
assert.match(skill, /native-api-agent-message-0\.11\.4-2026-10-19/);
assert.match(skill, /should not send unsolicited user-facing progress/i);
assert.match(skill, /one concise internal handoff/i);
assert.match(nativeApiAgentMessageFix, /task execution did not pass/i);
assert.match(nativeApiAgentMessageFix, /apiVerified.*false/i);
assert.doesNotMatch(readme, /currently installed 0\.10\.5\/6ec/i, 'README does not describe the historical runtime as current');
assert.doesNotMatch(pluginDoc, /actual isolated CLI installation has not been run/i, 'PLUGIN reflects the recorded formal installation');
assert.match(readme, /^# Sol 主控 · 多模型峰谷子代理$/m, 'README uses the unified display name');
assert.match(skill, /^# Sol 主控 · 多模型峰谷子代理$/m, 'SKILL.md uses the unified display name');
assert.match(pluginDoc, /^# Sol 主控 · 多模型峰谷子代理$/m, 'PLUGIN.md uses the unified display name');
assert.match(readme, /\$sol-luna-deepseek-router/, 'README names the canonical skill');
assert.match(skill, /\$sol-luna-deepseek-router|name: sol-luna-deepseek-router/, 'SKILL.md keeps the canonical skill name');
assert.match(pluginDoc, /\$sol-luna-deepseek-router/, 'PLUGIN.md names the canonical skill');
assert.match(nativePluginCandidate, /0\.10\.5/);
assert.match(nativePluginCandidate, /bounded.*retry/i);
assert.match(nativePluginCandidate, /GREEN/i, 'the candidate note must keep runtime build status explicit');

const hookCommand = 'node "${PLUGIN_ROOT}/scripts/route-hook.mjs"';
assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, hookCommand, 'UserPromptSubmit must use the quoted plugin root');
assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, hookCommand, 'PreToolUse must use the quoted plugin root');

const pinned = [...`${readme}\n${client}`.matchAll(/dsh-subagent-mcp@(\d+\.\d+\.\d+)/g)].map(match => match[1]);
assert.deepEqual([...new Set(pinned)], ['0.7.0'], 'install and client commands must pin the same published version');
assert.match(readme, /0\.7\.0/, 'README must state the pinned version');
assert.match(skill, /0\.7\.0/, 'SKILL.md must state the pinned version');
assert.match(readme, /--no-skill/, 'installation must disable the upstream skill');
assert.match(readme, /Node\.js 24\+/, 'README must state the Node.js prerequisite');
assert.match(readme, /PowerShell 7\.3\+/, 'README must state the PowerShell prerequisite');
assert.match(skill, /PowerShell 7\.3\+/, 'SKILL.md must state the PowerShell prerequisite');
assert.match(skill, /Node\.js 24\+/, 'SKILL.md must state the Node.js prerequisite');
assert.match(readme, /deepseek-official/, 'README must document the official provider');
assert.match(readme, /deepseek-flash/, 'README must document the default model');
assert.match(skill, /deepseek-official/, 'SKILL.md must document the official provider');
assert.match(skill, /deepseek-flash/, 'SKILL.md must document the default model');

for (const [name, text] of [['README.md', readme], ['SKILL.md', skill]]) {
  assert.match(text, /auto-discovers? `hooks\/hooks\.json`|auto-discovered from `hooks\/hooks\.json`/i, `${name} must document hook auto-discovery`);
  assert.match(text, /no manifest `hooks` pointer is required/i, `${name} must not require a manifest hooks pointer`);
  assert.match(text, /exactly one routing skill|one routing skill copy|install it once/i, `${name} must preserve one routing skill`);
  assert.match(text, /does not create a new chat|no new chat/i, `${name} must state that the hook creates no chat`);
  assert.match(text, /idle/i, `${name} must state the no-idle-inference limitation`);
  assert.match(text, /manual .* wins|manual one-task choice/i, `${name} must state that manual choice wins`);
  assert.match(text, /snapshot/i, `${name} must describe the trace as a snapshot`);
  assert.match(text, /native Codex child/i, `${name} must state the native-child trace limitation`);
  assert.match(text, /PLUGIN_ROOT/, `${name} must document the supported plugin-root command`);
  assert.match(text, /no bundled skill|has no `skills\/` directory|does not add a second scheduler, agent loop, or bundled skill/i,
    `${name} must state that the plugin contributes no bundled skill`);
  assert.doesNotMatch(text, /plugin-local (?:copy|skill)|plugin loader also exposes the plugin-local/i,
    `${name} must not claim a plugin-local routing skill copy`);
  assert.match(text, /\/hooks/, `${name} must document the official hook trust review path`);
  assert.match(text, /untrusted|does not trust them automatically/i, `${name} must not claim hooks are pre-trusted`);
  assert.match(text, /do not open a new chat merely|preserve the current conversation/i,
    `${name} must not require a new chat for peak switching`);
}

assert.match(skill, /用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。/,
  'SKILL.md must put the Chinese child-output instruction in every spawn/followup message');
assert.match(skill, /agent_type: "native_deepseek"/i, 'SKILL.md must select the isolated DeepSeek role');
assert.match(skill, /omit `model`/i, 'SKILL.md must not send an explicit DeepSeek model override');
assert.match(skill, /current `CODEX_HOME\/models_cache\.json`/, 'SKILL.md must resolve Luna from the live catalog');
assert.doesNotMatch(skill, /shared-root gateway path is the formal|root `openai_base_url`[^\n]*formal route/i, 'SKILL.md must not use shared root routing as the formal path');
assert.match(skill, /native-isolated-install\.mjs/);
assert.match(skill, /--deepseek-only/);
assert.match(skill, /relay_allowed=false/);
assert.match(readme, /rejects GPT\/unknown models and encrypted collaboration input before any upstream call/i);
assert.match(readme, /relay cap is forced to zero/i);
assert.match(pluginDoc, /--deepseek-only/);
assert.match(nativeInstaller, /Task 状态为 `Running`/);
assert.match(skill, /--install-journal/);
assert.match(skill, /For each DeepSeek follow-up, rerun the gate/);
assert.match(skill, /observed executable must match the approved patched binary hash/);
assert.match(skill, /路由关闭时点击“应用 API 配置”保持未应用/);
assert.match(skill, /does not create native Codex child sessions/);
for (const command of ['prepare', 'activate', 'rollback', 'status']) assert.match(skill, new RegExp(`\\b${command}\\b`), `SKILL.md must list installer command ${command}`);
assert.match(skill, /ordinary task routing.*never run them/i, 'SKILL.md must keep ordinary routing separate from setup');
assert.match(skill, /explicitly asks to set up or activate.*authorizes.*without another approval prompt/i, 'SKILL.md must avoid redundant approval for an explicitly requested setup');
assert.match(skill, /native-formal-install-2026-10-18\.md.*other hosts require local verification/i, 'SKILL.md must link the host-specific install record and require local verification elsewhere');
assert.match(skill, /host-specific desktop evidence is in.*desktop acceptance record/i, 'SKILL.md must link tested host-specific desktop evidence');
assert.doesNotMatch(skill, /ACL file lock|blocks the intended UI check/i, 'SKILL.md must not preserve the obsolete UI blocker claim');
assert.doesNotMatch(skill, /node \.\\scripts\\native-install\.mjs install/i, 'SKILL.md must not present the old shared-root installer as the setup path');
assert.match(readme, /formal native DeepSeek route.*native_deepseek.*provider/i, 'README must present the isolated role/provider as the formal route');
assert.match(readme, /native Luna.*normal provider.*live model catalog/i, 'README must state that Sol and Luna keep their normal provider/catalog');
assert.match(readme, /docs\/native-isolated-install\.md/, 'README must link the isolated installer guide');
assert.match(readme, /dated desktop record lists host-specific observed behavior/i, 'README must point to dated desktop observations');
assert.doesNotMatch(readme, /formal DeepSeek path uses a shared `openai` provider/i, 'README must not present the shared-root path as formal');
assert.doesNotMatch(readme, /Native gateway \(current path\)|Do not pass `agent_type`|ACL file lock.*blocks the intended UI check/i, 'README must not retain obsolete native route or UI blocker claims');
assert.match(pluginDoc, /formal native DeepSeek path.*isolated.*native_deepseek/i, 'PLUGIN.md must describe the isolated route as formal');
assert.match(pluginDoc, /skill.*separately.*plugin.*Codex CLI/i, 'PLUGIN.md must distinguish standalone skill sync from plugin refresh');
assert.match(pluginDoc, /no automatic release.integration script/i, 'PLUGIN.md must not claim a nonexistent skill sync automation');
assert.doesNotMatch(pluginDoc, /current formal path is native collaboration through the hidden loopback gateway|Native child spawning uses `spawn_agent` with `task_name`, `model:/i, 'PLUGIN.md must not describe the shared-root spawn contract as current');
assert.doesNotMatch(pluginDoc, /ACL file lock.*blocks the interface check/i, 'PLUGIN.md must not retain the obsolete UI blocker claim');
assert.match(pluginManifest.interface.longDescription, /native_deepseek.*provider.*catalog/i, 'plugin manifest must describe the isolated DeepSeek role');
assert.doesNotMatch(pluginManifest.interface.longDescription, /shared `openai` provider|transparently relays GPT traffic/i, 'plugin manifest must not sell the shared-root relay as formal');
assert.doesNotMatch(pluginManifest.interface.defaultPrompt.join(' '), /Start the native DeepSeek gateway/i, 'plugin examples must not start the old default gateway');
assert.match(nativeBuild, /native-isolated-install\.mjs/, 'build note must name the installer entrypoint');
assert.match(nativeBuild, /native-isolated-install\.md/, 'build note must link the installer orchestration');
assert.match(nativeBuild, /no real installation or desktop acceptance has been performed/i, 'build note must distinguish source implementation from actual acceptance');
assert.doesNotMatch(nativeLifecycleText, /"(?:pid|port|root_session)"\s*:/i, 'published lifecycle JSON must omit process IDs, ports, and session identifiers');
assert.doesNotMatch(nativeLifecycleText, /[A-Za-z]:\\Users\\|runUUID|run_uuid/i, 'published lifecycle JSON must omit user paths and run UUIDs');
assert.match(nativeInstaller, /--expected-main-model/);
assert.match(nativeInstaller, /--expected-main-provider null/);
assert.match(nativeInstaller, /--expected-root-base-url null/);
assert.match(nativeInstaller, /prepare[\s\S]*activate[\s\S]*desktop/i);
assert.match(nativeInstaller, /configured=true.*restartNeeded=true/);
assert.match(nativeInstaller, /runtimeObserved=false.*desktopAccepted=false/);
assert.match(nativeInstaller, /native-formal-install-2026-10-18\.md/);
assert.match(nativeInstaller, /其他主机须独立核验.*不等于桌面接受验收/, 'installer guide must require other-host verification and keep desktop acceptance separate');
assert.match(nativeAcceptance, /Historical acceptance record for the earlier shared-provider route/i, 'old acceptance evidence must be labeled historical');
assert.doesNotMatch(nativeAcceptance, /ACL file lock|blocked the intended UI check/i, 'acceptance record must not claim the obsolete ACL blocker');
assert.doesNotMatch(skill, /at most one shell(?:\/exec)? attempt/i,
  'SKILL.md must not generalize the one-attempt P3 test cap to product work');

for (const [name, text] of [['README.md', readme], ['SKILL.md', skill]]) {
  assert.doesNotMatch(text, /[A-Za-z]:\\Users\\/i, `${name} must not contain a Windows user path`);
  assert.doesNotMatch(text, /\/(?:Users|home)\/[^/\s]+\//, `${name} must not contain a local Unix home path`);
  assert.doesNotMatch(text, /AppData[\\/]Local[\\/]Temp/i, `${name} must not contain a temporary artifact path`);
  assert.doesNotMatch(text, /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/, `${name} must not contain a credential`);
}

const testScripts = [
  'route.test.mjs', 'route-hook.test.mjs', 'dsh-mcp-client.test.mjs', 'docs.test.mjs',
  'plugin-state.test.mjs', 'plugin-cross-process.test.mjs', 'plugin-trace.test.mjs',
  'plugin-mcp.test.mjs', 'plugin-client.test.mjs', 'plugin-manifest.test.mjs',
  'plugin-router-settings.test.mjs', 'plugin-mcp-env.test.mjs',
  'native-api-settings.test.mjs', 'native-api-routing.test.mjs', 'native-api-protocol.test.mjs',
  'native-api-artifacts.test.mjs', 'native-api-install.test.mjs', 'native-api-lifecycle.test.mjs',
  'native-api-origin.test.mjs', 'native-api-manager.test.mjs',
  'patch-backend-windows.test.mjs',
];
for (const script of testScripts) assert.match(readme, new RegExp(script.replaceAll('.', '\\.')), `README must list ${script}`);
assert.match(readme, /dsh-agent-helper\.test\.ps1/, 'README must list the PowerShell helper test');

console.log('PASS docs/version consistency');
