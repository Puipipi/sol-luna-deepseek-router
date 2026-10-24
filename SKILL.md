---
name: sol-luna-deepseek-router
description: Use when Sol keeps the main conversation while delegating repository coding or file work to native Luna, an isolated native DeepSeek child, or a user-configured OpenAI-compatible API profile under the peak/valley schedule.
metadata:
  short-description: Sol 主控 · 多模型峰谷子代理
---

# Sol 主控 · 多模型峰谷子代理

Sol remains the user-facing lead and owns the conversation context. Handle ordinary Q&A directly. Delegate project search, edits, debugging, and verification by the deterministic route below unless the user asks Sol to work directly. The main model, main provider, and current chat are never changed by this skill.

## One routing skill, optional plugin

The root `SKILL.md` is the canonical routing policy. Install it once as `sol-luna-deepseek-router` and keep exactly one enabled routing skill.

The optional Codex plugin adds guarded DSH compatibility tools, real DSH event access, and `dsh_trace`, plus local lifecycle hooks. The plugin has no `skills/` directory and does not add a second scheduler, agent loop, or bundled skill; it declares no `skills` manifest entry. Codex auto-discovers `hooks/hooks.json`; no manifest `hooks` pointer is required. Hooks remain untrusted until a human reviews them in `/hooks`; never assume or fabricate trusted status. Do not open a new chat merely to switch at a peak boundary; preserve the current conversation.

The root standalone skill is the only routing policy. The plugin's DSH/MCP path is explicit legacy compatibility, never an automatic fallback from native DeepSeek.

## Isolated native backend prerequisites

The formal native DeepSeek route uses the patched, versioned Codex CLI backend described in [the isolated CLI build note](docs/native-isolated-cli-build.md). It gives the `native_deepseek` child role its own `deepseek-native` provider and its own `sol-luna-native-models.json` catalog. The parent session and native Luna continue using their normal provider and live model catalog; do not set root `openai_base_url` or a global `model_catalog_json` for this route.

The formal gateway is started with `--deepseek-only`: it accepts DeepSeek models only, rejects GPT/unknown models and encrypted collaboration inputs, and disables GPT relay even when a caller supplies OpenAI authentication. Health and dispatch checks require `deepseek_only=true`, `relay_allowed=false`, and the owned Task Scheduler task in `Running` state. These source-level behaviors are covered by loopback and mock tests; those tests alone do not establish real API or desktop acceptance. Host-specific 0.10.5 API and desktop observations are separately recorded in [the desktop acceptance record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md).

The source includes the installer orchestration entrypoints `native-isolated-install.mjs prepare`, `activate`, `rollback`, and `status`, documented in [the isolated installer guide](docs/native-isolated-install.md). They are a setup path only when the user explicitly asks to set up or activate the isolated backend; that request authorizes the documented steps without another approval prompt. Ordinary task routing must never run them, change global configuration or environment, install a runtime, or restart Codex. The host-specific installation and stable gateway source acceptance are recorded in [the installation record](docs/native-formal-install-2026-10-18.md) and [stable gateway acceptance](docs/native-stable-gateway-acceptance-2026-10-18.md). The later 0.10.5 full-restart and host-specific desktop evidence is in [the desktop acceptance record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md); other hosts require local verification. Package/skill synchronization and publication status are tracked separately from the observed desktop behavior. The older `native-install.mjs` shared-root gateway path is retained for historical compatibility only; it is not the formal native DeepSeek setup path.

## Route a task

The router has a global `enabled` switch, independent of `mode`. When it is
off, do not create or continue any automatic native or DSH delegation, even
for a one-task override or scheduled route. Sol handles repository file work
directly until the user turns routing back on. Do not bypass this switch through
the legacy DSH tools. The settings panel remains available while routing is
off. A guard-reported disabled state has the same effective behavior; a
missing/unmanaged guard does not disable native Luna routing.
The user-off setting lives only in router settings; never rewrite the C-owned
upgrade status to represent user intent. A guard-reported compatibility
failure remains intact. API/DeepSeek still require the later runtime gate to
prove that the running CLI image matches an approved receipt; a healthy old
status or same-version label is not enough. Re-enabling native-only routing
does not require a shim, while API remains unavailable until explicit Apply
has an approved runtime receipt.

When the user turns routing off, stop creating automatic children and do the
file work in Sol. Saving off asks the plugin to disable only its verified
owned scheduler tasks and stop idle local gateways. Existing native or DSH
children are allowed to finish; the last terminal callback retries deferred
cleanup. If cleanup cannot be verified, report the Chinese settings message
and let the user retry by saving the off setting again. Do not kill Codex or
DSH processes. If the user environment still points exactly at this plugin's
owned bootstrap, clear only that `CODEX_CLI_PATH` value so the next launch
resolves the official Codex app; preserve any later custom user value. The
current process does not hot-switch, so restart may be required to use that
official path. Applying an API profile remains a separate explicit action.
The settings panel's “连接诊断” action reads only bounded local error classes
when routing is enabled; it never runs on startup or contacts a provider.

Fixed and scheduled executors may select `same` or an exact `native:<slug>` in
addition to the existing Luna, DeepSeek, and API profile choices. `same` means
the exact model of the current parent chat and still creates an isolated child
with `fork_turns: "none"`; resolve it with the current chat model, never a
static config default. `native:<slug>` must exist in the current Codex
`CODEX_HOME/models_cache.json` catalog or dispatch fails explicitly. Never
substitute a different model. Native child chats must not recursively delegate.

Run the bundled `scripts/route.mjs` before dispatching a new coding task. By default it selects native Luna during DeepSeek weekday peak windows and native DeepSeek during valley time. `Asia/Shanghai` is the default timezone. Peak intervals are 09:00–12:00 and 14:00–18:00 China time on weekdays, excluding official Chinese public holidays. Weekends remain valley even on China make-up workdays. The bundled calendar covers 2026; for other years, known valley hours use DeepSeek and candidate weekday peaks conservatively use Luna.

An explicit one-task choice (`--executor luna|deepseek|<profileId>|<alias>`) wins. A saved chat override outranks the automatic schedule. Set it with `--set-session-executor luna|deepseek|<profileId>|<alias>`, clear it with `--set-session-executor auto` or `--reset-session`, and pass `--session $env:CODEX_THREAD_ID` only when that stable chat ID is available. If the host exposes no stable ID, keep the preference in Sol's current-chat context and pass a one-task override; do not invent shared identity. An ordinary one-task API choice does not change the global fixed configuration.

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

For an API profile or alias, resolve and gate it explicitly:

```powershell
node .\scripts\route.mjs --json --executor <profileId-or-alias>
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-agent.mjs --executor <profileId> --task-nonce $taskNonce --json
```

The gate must pass before spawn. The returned `native_spawn` supplies
`agent_type: native_api_<profileId>`, `provider_id: api-native-<profileId>`,
`fork_turns: "none"`, and the exact resolved model; omit `model` in
`spawn_agent`. If the gate fails because the runtime is the old 6ec build or
the profile is not installed, report that failure and stop. Do not replace it
with another executor or a hand-edited journal.

For a generic API profile, readiness also requires the generated role to be
registered in root `config.toml` as `[agents.native_api_<profileId>]` with its
exact `config_file`. A legacy active install with only the owned provider block
must remain not-ready until the user explicitly applies the registration
repair; never hand-edit its journal or dispatch fallback. A local
`config/read` check confirms parsed registration only. The 0.11.2 host restart
and role discovery succeeded, while real dispatch was rejected before child
creation by a missing catalog-instructions field. The 0.11.3 catalog repair was
applied successfully and created a child, but that child made no tool calls and
returned a generic reply. The 0.11.4 wire fix has only local/mock validation; a
newly authorized real retest is still required. See the
[0.11.2 role-registration fix record](docs/native-api-role-registration-0.11.2-2026-10-19.md) and [0.11.3 catalog instructions repair record](docs/native-api-catalog-instructions-0.11.3-2026-10-19.md).

Pass only `task_name`, `agent_type`, `fork_turns: "none"`, and `message` to
`spawn_agent`; do not pass the whole `native_spawn` object. `provider_id`,
`profile_id`, and `resolved_model` are metadata for state recording, not
spawn-schema arguments:

```json
{
  "task_name": "bounded_api_task",
  "agent_type": "native_api_<24hex>",
  "fork_turns": "none",
  "message": "<task and acceptance checks>"
}
```

For native subagents, `task_name` must use only lowercase ASCII letters,
digits, and underscores. Do not use hyphens in `task_name`; profile IDs,
models, and aliases are separate fields and may retain their own valid syntax.

For a follow-up to the same child, reuse its original workspace and task nonce;
do not create a new nonce or reassign the child. This applies to native Luna
and DeepSeek and does not change their model-selection policies.

## Shared native writer and child-message contract

For gateway-backed API and DeepSeek routes, generate one stable nonce and run `native-agent` with it first; the gate records a gateway intent before checking/starting the local service. For a write task, then reserve the workspace before `spawn_agent`, bind the real child immediately after spawn, and release only at explicit finish/terminal. A read-only gateway child uses `record` after spawn. Luna uses only the writer lease; it never reserves a gateway. Ownership comes from trusted `CODEX_THREAD_ID` or `CODEX_SESSION_ID`; `--parent` is rejected as a forgery path. If a spawn is conclusively rejected before a child exists, run `dispatch-cancel` with the same nonce. If the spawn result is uncertain, keep the reservation until child identity/status is reconciled; never cancel a potentially live child.

```powershell
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-state.mjs reserve --workspace (Get-Location).Path --task-nonce $taskNonce --model MODEL_SLUG
# spawn_agent now, then bind the real child
node .\scripts\native-state.mjs bind --workspace (Get-Location).Path --task-nonce $taskNonce --child CHILD_THREAD_ID --model MODEL_SLUG
node .\scripts\native-state.mjs finish --workspace (Get-Location).Path --task-nonce $taskNonce --child CHILD_THREAD_ID
```

Every `spawn_agent` and every `followup_task` message must end with exactly this instruction, appended once:

```text
用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。
```

Native children should not send unsolicited user-facing progress updates. Send a brief update only when blocked or when human action is needed. The final user-facing reply should usually be one to three Chinese lines with the result and whether the requested scope was followed; state failures and limits plainly. Send the parent one concise internal handoff with changed files, tests, and evidence/limits; do not repeat a long internal report in the user-facing final. Keep full evidence available to the parent and never hide failures to make the final shorter.

The selected role supplies backend, model, and reasoning configuration. This route fixes the native DeepSeek role at `high`; it does not inherit the Sol parent’s `xhigh` setting, so an `xhigh` parent request still runs this child at `high`. The current spawn path exposes no per-child effort control. The suffix above sets the output language; it does not require sending progress updates.

## If the route is a configured API profile

Use the immutable profile ID from the route/gate result, not a mutable label.
Before a gateway-backed API dispatch, create its stable task nonce and run the
native gate. The gate reserves a dispatch intent, verifies the generic owned
bootstrap journal and compatibility receipt, and asks that exact bootstrap to
observe the currently running Codex ancestor. Continue only when its executable
hash matches the approved runtime; stock, staged-only, missing-receipt, or
unobservable backends require restart/repair and must not spawn. The native
Luna, `same`, and `native:<slug>` routes do not use this API gateway gate.
For a write-capable API child, reserve and bind the full executor identity:

```powershell
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-agent.mjs --executor <profileId> --task-nonce $taskNonce --json
node .\scripts\native-state.mjs reserve --workspace (Get-Location).Path --task-nonce $taskNonce --model <exact-model>
# spawn_agent with task_name, agent_type, fork_turns:none, message; omit model
node .\scripts\native-state.mjs bind --workspace (Get-Location).Path --task-nonce $taskNonce `
  --child CHILD_THREAD_ID --model <exact-model> --executor api `
  --profile-id <24hex> --role native_api_<24hex> --provider-id api-native-<24hex>
```

For a read-only API child, gate first, then record the actual child without
taking a writer lease. `record` atomically consumes the pending gateway intent:

```powershell
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-agent.mjs --executor <profileId> --task-nonce $taskNonce --json
node .\scripts\native-state.mjs record --workspace (Get-Location).Path --task-nonce $taskNonce `
  --child CHILD_THREAD_ID --model <exact-model> --executor api `
  --profile-id <24hex> --role native_api_<24hex> --provider-id api-native-<24hex>
node .\scripts\native-state.mjs binding --child CHILD_THREAD_ID
node .\scripts\native-state.mjs complete --child CHILD_THREAD_ID --status completed
```

`record` and `complete` use the trusted `CODEX_THREAD_ID`; they never acquire or
release the workspace writer lease. A different parent is rejected, and a
different model/profile cannot overwrite the original binding. For every
API/DeepSeek follow-up, read `binding`, then run the gate against that original
profile and child:

```powershell
node .\scripts\native-agent.mjs --executor <profileId> --task-nonce $taskNonce `
  --reuse-child CHILD_THREAD_ID --json
# Require reuse_child:true and spawn:false; do not call spawn_agent.
# Send followup_task to CHILD_THREAD_ID.
```

For a write child, reacquire its writer reservation and bind the same child
before `followup_task`; for a read-only child, `record` the same child with the
same nonce and binding before `followup_task`. This consumes a fresh gateway
intent without creating a second child. A confirmed pre-follow-up rejection
can use `dispatch-cancel`; cancellation removes only the intent and preserves
the existing child status. An uncertain outcome keeps the intent. A global profile change affects only new children. Old
profiles cannot be removed by the settings schema; if the old profile gate
fails, report the failure and do not silently substitute the new profile.

Only when the user explicitly asks for a global fixed API configuration, update
`mode` and `fixedExecutor` in one CAS call:

```json
{
  "set": {"mode": "fixed", "fixedExecutor": "<24hex>"},
  "expectedSha256": "<snapshot revision>"
}
```

Use the MCP `router_settings_snapshot` revision and `router_settings_update`;
saving configuration is separate from an explicit Apply and a full Codex
restart. See [native API executors](docs/native-api-executors.md) and the
[router settings MCP panel](docs/router-settings-mcp.md).

## If the route is deepseek

Use native Codex collaboration, not DSH, for the formal task. Resolve the dedicated child role first:

```powershell
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-agent.mjs --executor deepseek --task-nonce $taskNonce --json
```

Before emitting initial native spawn parameters, this command verifies the active native-isolated install journal, its runtime and bootstrap path, and the root compatibility receipt, then asks the owned bootstrap to observe the running Codex ancestor. The observed executable must match the approved patched binary hash. A legacy install without a verifiable receipt, a stock/staged-only runtime, or an unobservable backend is not ready; do not re-enable its task or spawn. For each DeepSeek follow-up, rerun the gate with the same nonce and `--reuse-child CHILD_THREAD_ID`; require `reuse_child:true` and `spawn:false`, then send `followup_task` to that child without spawning another. A missing or unhealthy installation fails closed: do not register a task, start a DSH session, directly spawn the gateway, replay old work, or switch executors. Initial work returns `agent_type: "native_deepseek"`, `fork_turns: "none"`, and an informational `resolved_model: "deepseek/deepseek-flash"`. Call `spawn_agent` only for initial work, with the bounded `task_name`, `agent_type: "native_deepseek"`, and `fork_turns: "none"`; omit `model` so the child role selects its fixed DeepSeek model and `high` reasoning effort, regardless of the Sol parent’s effort setting. Keep the same child for corrections: use native `wait` for completion and `followup_task` for that child; never spawn a replacement just because an observation window ended. The installer uses a current-user Task Scheduler task to keep the gateway independent of the DSH/Codex child process tree; DSH remains only an explicit legacy workflow and does not create native Codex child sessions. After activation, fully exit and restart Codex for future chats to inherit the new user environment; an already running app does not refresh it.
For a private experiment, `--install-journal <path>` may select a different journal, but it must still prove the owned active install and exact runtime/bootstrap receipt; an empty value fails closed.

Apply the shared writer and child-message contract above before this spawn. For a write task, reserve after the gate and before spawn; bind immediately after. For a read-only task, consume the intent with `record` after spawn using `--executor deepseek --model deepseek/deepseek-flash`. On a confirmed pre-spawn refusal, cancel with `native-state.mjs dispatch-cancel --task-nonce $taskNonce`.

The default is one writer per workspace. Different workspaces may run in parallel. Read-only research may skip the writer lease, but a child, task, model, and parent chat must never be reassigned across chats. The native state file stores a hashed parent owner and the child thread ID; `who` filters to the trusted `CODEX_THREAD_ID`. A reservation is not auto-stolen when a short CLI exits: only an explicit `finish`/`release` or a verified terminal task clears it. If a host cannot expose enough native child identity to enforce the lease, say so and keep the task read-only rather than inventing a second scheduler.

## If the route is luna

Use the native Luna subagent supported by the current Codex host. Resolve the model from the actual catalog:

```powershell
node .\scripts\native-agent.mjs --executor luna --main-model $mainModel --json
```

Pass the actual current Sol model in `$mainModel`. The resolver reads the current `CODEX_HOME/models_cache.json`, chooses a listed Luna model, and fails explicitly if none is available. It never invents a model ID or changes Sol's main model. Pass the resolved Luna `model` with `fork_turns: "none"`, wait natively, and continue the same child for fixes. The same reserve → spawn → bind → finish writer lifecycle applies to a write-capable Luna child.

## Active-chat peak/valley notices

The plugin hook runs `scripts/route-hook.mjs` on `UserPromptSubmit` and `PreToolUse` with the supported quoted command `node "${PLUGIN_ROOT}/scripts/route-hook.mjs"`. It evaluates the route locally and injects a short `additionalContext` notice. It makes no network call, starts no child process, and calls no model.

The notice is sent once on the first observation for a chat and only when the effective phase, executor, API profile, or override source changes. A manual choice wins, and a sticky chat override outranks the schedule. The hook does not create a new chat, wake an idle chat, poll in the background, or interrupt a running task; only a new task uses the new route. `additionalContext` is model-visible context, not a UI banner. Per-chat state lives under LocalAppData, uses hashed filenames, and fails silently if unavailable. Set `SOL_LUNA_ROUTE_HOOK_DEBUG=1` only for local debugging.

Fixed mode is reported as a fixed executor selection. The same fixed selection stays silent across calendar boundaries, while a changed effective executor, API profile, or override source still triggers a notice.

Hook payloads expose `session_id` and `model`, not a reliable main/subagent role. A model name alone cannot identify a child, because `same` deliberately uses the parent's model. Suppress only a child identified by trusted native task state or explicit role metadata. For an unknown hook context, emit status information only; never instruct the model to start another child. Native child chats never recursively delegate.

## Legacy DSH compatibility

The plugin's MCP tools (`dsh_start`, `dsh_wait`, `dsh_followup`, `dsh_events`, `dsh_trace`, and related tools) remain available only when the user explicitly chooses the external DSH workflow. They use the published `dsh-subagent-mcp@0.7.0` bridge, provider `deepseek-official`, model `deepseek-flash`, and the guarded per-chat ownership/writer leases. They are not the native DeepSeek route and must not silently replace it.

`dsh_trace` is a read-only snapshot of real DSH events, protected by a short-lived ticket and per-view HttpOnly cookie. It is not a live terminal or control channel, and DSH agents cannot appear as native Codex child panels. The browser labels, help, and errors are Simplified Chinese while commands and code stay unchanged.

The DSH helper requires Node.js 24+ and PowerShell 7.3+. Keep credentials out of prompts, logs, the repository, and tool arguments. If the external provider or model is unavailable, report the exact limitation; do not fall back to Luna or another provider silently.

## Completion and evidence

Use native `wait` and `thread/read` for the same child. A timeout means the task may still be running; retain the child handle and never start a duplicate. For DSH legacy work, `dsh_wait` is the reliable completion path. Sol reviews the returned diff, actual test commands and exit codes, and the evidence; do not claim desktop-panel acceptance from an isolated app-server test.

The historical native evidence is recorded in `docs/native-deepseek-acceptance-2026-10-17.md`; it used the earlier shared-provider call contract and does not verify the isolated-role route. The current source includes prepare/activate/rollback/status orchestration, with one host-specific installation in `docs/native-formal-install-2026-10-18.md`, a stable gateway source switch in `docs/native-stable-gateway-acceptance-2026-10-18.md`, and later 0.10.5 desktop observations in `docs/native-desktop-acceptance-0.10.5-2026-10-18.md`. Those observations describe tested host-specific behavior and limits; other hosts require local verification. Package/skill synchronization and publication status are tracked separately from desktop behavior. Do not treat a prepared/configured journal or its static `runtimeObserved=false` diagnostic as the latest runtime observation; consult the dated desktop evidence. Do not treat preparation or configuration alone as desktop acceptance.

The generic OpenAI-compatible API executor backend is described in `docs/native-api-executors.md`. The 0.11.3 catalog repair was applied and the host created its authorized API child, but the child returned a generic response without invoking tools. The 0.11.4 `agent_message` wire correction has local loopback evidence only; the consumed authorization must not be retried. See the [0.11.4 repair and acceptance record](docs/native-api-agent-message-0.11.4-2026-10-19.md). Updating an active API gateway source requires the explicit owned rollback/prepare/activate maintenance path; ordinary active-profile Apply does not refresh the staged source.

默认路径仍是高峰 Luna、低谷 DeepSeek。用户显式选择的 API 配置使用 fixed 模式且不判断时段；只有显式 scheduled 才在既有的 DeepSeek 峰谷日历上使用两个 API 选择器。一次性/粘性显式选择优先；选中的执行器失败时明确报告，不静默回退到 Luna、DeepSeek、另一个 API 或另一个账号。DSH 账号或本地 refs 的既有解析规则保留，失败不会试探其他账号或 provider。保存 JSON 只保存配置；路由关闭时点击“应用 API 配置”保持未应用，也不会写全局环境。启用后，显式 Apply 只接受已批准并位于 `CODEX_HOME/router-runtime/versions` 的 runtime，验证兼容性后才将本插件拥有的持久 bootstrap 作为 `CODEX_CLI_PATH`；Apply 报告需完整重启，当前桌面只有真实祖先 hash 匹配后才可派发 API/DeepSeek。普通路由不会 arm bootstrap 或改全局环境。已有 child 继续使用其不可变 profile。首版所有 API child（Responses 与 Chat Completions）都禁用 Codex 内建 web_search，适配器也不声称强制 provider grammar。状态里的本地网关/凭据可用不等于认证或模型调用通过；旧 6ec runtime 为 `runtimeCompatible:false`，generic API role 仍需角色注册、完整重启和实际派发证据。

官方 DeepSeek API profile（自动账号或手工 env/file）使用官方文档列出的 `none/low/high/max`；官方说明 `none` 会关闭 thinking。`xhigh` 在 API adapter 局部规范为 `high`，有效 `max` 保留；`none` 原样传递，不另造 `off`。非 DeepSeek API 保持其声明的档位，历史 DS 路由行为不变。这里只是官方 wire 规则依据，不代表真实 generic API role 已完成端到端验收。

保持唯一的 canonical skill：`sol-luna-deepseek-router`。后续正式打包的可见显示名统一为“Sol 主控 · 多模型峰谷子代理”；不要另建第二个 skill，不要物理删除旧 cache/backup，保持 registry ID 和目录稳定，避免出现两个 enabled skills。

## Price and calendar sources

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [2026 State Council public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- Legacy DSH executor: [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp), published 0.7.0 under the MIT license.
