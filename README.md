# Sol 主控 · 多模型峰谷子代理

Canonical skill: `$sol-luna-deepseek-router`.

This repository contains one routing skill and an optional Codex plugin. Sol stays in charge of the current conversation, then routes repository file search and reading, code or document edits, debugging, and tests to native Luna during DeepSeek's official weekday peak windows or to a native DeepSeek child during valley hours. A deterministic Node.js helper evaluates the schedule; Sol interprets user intent and does not send ordinary Q&A through the router. The formal native DeepSeek route uses the isolated `native_deepseek` child role, its own `deepseek-native` provider, and a child-only model catalog. Sol and native Luna continue using their normal provider and live model catalog. DSH remains explicit legacy compatibility. Sol stays responsible for decisions and review. Users can explicitly ask Sol to work directly.

The standalone root `SKILL.md` is the canonical routing policy. The optional plugin adds the native gateway helpers, a guarded legacy DSH MCP wrapper, real DSH event access, and local lifecycle hooks; it does not add a second scheduler, a second DeepSeek client, another agent loop, or any bundled skill. Install and enable exactly one routing skill: the root standalone scheduler.

The optional API panel adds user-configured OpenAI-compatible child profiles. Profiles are immutable; editing creates a new profile ID while existing children keep their original binding. Credentials may use the official DeepSeek account automatically or manual environment/file references, with no fallback to another account or provider. A single API profile is fixed and does not consult the clock; an explicit scheduled plan can assign separate API/Luna/DeepSeek choices to peak and valley. Saving JSON is separate from the explicit Apply action, and a newly applied role requires a full Codex restart. The 0.11.1 MSIX binding and 0.11.2 role registration are recorded in their [installation record](docs/native-api-msix-path-fix-0.11.1-2026-10-19.md) and [fix record](docs/native-api-role-registration-0.11.2-2026-10-19.md). The 0.11.2 catalog failure and 0.11.3 repair/Apply are documented in the [0.11.3 record](docs/native-api-catalog-instructions-0.11.3-2026-10-19.md). The 0.11.3 API child was created, but it returned a generic English response without invoking tools, so the task failed. The 0.11.4 wire-format correction and evidence are in the [agent-message repair record](docs/native-api-agent-message-0.11.4-2026-10-19.md). The one-time API authorization has been consumed; a fresh real acceptance attempt needs new authorization. First-version API children disable Codex built-in web search.

## Schedule

The schedule follows the [official DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing/): peak windows are UTC 01:00–04:00 and 06:00–10:00 on weekdays, excluding Chinese public holidays. In China time this is 09:00–12:00 and 14:00–18:00. Weekend make-up workdays remain valley. The bundled 2026 holiday dates follow the [State Council notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html). Unknown calendar years conservatively route candidate weekday peak hours to Luna; known valley hours remain DeepSeek.

The route helper supports one-task executor overrides and chat-scoped sticky overrides. One-task choice outranks a chat override, which outranks the schedule. It stores only a hashed session ID, the selected executor, and an update timestamp in the current user's LocalAppData. Use Codex's `CODEX_THREAD_ID` as the session key when available; without it, keep a persistent preference in the current Sol chat and pass it as a one-task override instead of creating shared disk state.

## One routing skill, optional plugin

- **Canonical skill:** install the root `SKILL.md` once as `sol-luna-deepseek-router`. It remains the single routing policy.
- **Plugin additions:** the plugin supplies the MCP wrapper, `dsh_trace`, and the active-chat notification hooks. Codex plugin packaging auto-discovers `hooks/hooks.json`; no manifest `hooks` pointer is required.
- **No bundled skill:** the plugin package has no `skills/` directory and declares no `skills` entry. Its job is MCP and hooks only; the root standalone scheduler remains the one routing skill. There is no second copy to enable or deduplicate.
- **Prefer the wrapper:** when the plugin MCP tools are loaded, use them. Use the PowerShell shell helper only when those tools are unavailable and only for the current old chat; do not invent a shared identity or silently move work between chats.

## Active-chat peak/valley notices

`hooks/hooks.json` registers `scripts/route-hook.mjs` for `UserPromptSubmit` and `PreToolUse` with the supported quoted command:

```json
"command": "node \"${PLUGIN_ROOT}/scripts/route-hook.mjs\""
```

The command resolves from the plugin root, so it does not depend on the user's workspace and works when the plugin path contains spaces. The hook imports `scripts/route.mjs` locally; it makes no network call, starts no child process, and calls no model.

The hook injects a concise `hookSpecificOutput.additionalContext` notice:

- once on the first observation for a chat;
- again only when the effective phase, executor, API profile, or override source changes;
- never repeatedly for the same phase, including across `UserPromptSubmit` and `PreToolUse`.

A manual one-task choice or sticky chat override wins over the schedule, and the notice reports the effective executor and source. The hook does not create a new chat, start an idle turn, poll in the background, or interrupt an executing task. An idle chat receives nothing until the user or a tool produces the next hook event. Only a new task should use the newly reported route; a running task can finish after a peak boundary.

Per-chat notification state is stored under `%LOCALAPPDATA%\sol-luna-deepseek-router\hook-state`. Filenames are SHA-256 hashes; the state contains only the notice key, timestamp, phase, executor, and source. Updates are atomic and protected by a short-lived lock so concurrent hooks for one chat emit at most one notice. If state is unavailable, the hook exits 0 silently and does not block the turn. Set `SOL_LUNA_ROUTE_HOOK_DEBUG=1` to surface hook errors on stderr. `additionalContext` is model-visible context, not a guaranteed UI banner.

### Model-role and identity limits

Codex hook payloads provide `session_id` and `model`, but not a reliable main-thread/subagent role. The hook suppresses turns whose model name contains `luna`, which covers native Luna child work in this host. A main chat intentionally running a Luna model is therefore also silent. If a host omits `model` or names a child model differently, a child session could receive a notice; notification state remains keyed by the hook `session_id`, so one session cannot consume another session's state.

Manual override lookup prefers an inherited `CODEX_THREAD_ID` and falls back to the hook `session_id`. Those two IDs are not proven identical on every Codex build. If a sticky override set with `CODEX_THREAD_ID` is not seen by a hook whose `session_id` differs, that is an identity limitation, not a schedule result. Ownership-critical work should use the plugin MCP path, which takes identity only from trusted request `_meta.threadId`.

The notice reports the router's schedule decision. It does not verify that the configured DSH provider is `deepseek-official` or that the selected model is a DeepSeek model; verify both before claiming valley pricing.

### Hook trust review and reload

Codex discovers both hooks from `hooks/hooks.json`, but it does not trust them automatically. Open `/hooks`, inspect each discovered command, source, and hash, and trust it explicitly only if you accept it. This repository does not mark hooks trusted, modify the trust store, or bypass that review. Until you approve them, hook notices stay inactive; the routing policy and plugin MCP tools remain usable.

After the initial plugin installation or a plugin update, Codex may need a plugin reload or app restart to discover the new MCP tools and hooks. Do not open a new chat merely to switch between Luna and DeepSeek at a peak/valley boundary. Keep the current conversation; the next new task uses the current route, and a task already running may finish after the boundary.

## Plugin MCP wrapper

The plugin exposes a guarded MCP surface over the published `dsh-subagent-mcp@0.7.0` bridge:

`dsh_start`, `dsh_status`, `dsh_wait`, `dsh_followup`, `dsh_list`, `dsh_interrupt`, `dsh_close`, `dsh_rename`, `dsh_events`, and `dsh_trace`.

Every tool call must carry Codex's trusted request `_meta.threadId`. Missing or blank identity fails before DSH is spawned. Identity values inside tool arguments are rejected. Ownership is durable and hashed; `dsh_list` removes other chats' rows before filtering. A write-capable start or follow-up holds a same-workspace writer lease until the agent is terminal or idle, while read-only agents may run in parallel. The wrapper does not implement an agent loop; it delegates to the published bridge through the existing client.

`dsh_trace` returns a clickable loopback URL to a read-only snapshot of real DSH events. The URL carries a short-lived access ticket, never a DSH, DeepSeek, Codex, or API credential. The ticket is exchanged for an HttpOnly SameSite cookie scoped to a per-view path such as `/trace/view/<view-id>/`, and each view uses its own cookie name, so trace tabs for different agents coexist without overwriting one another. Detail links are clickable (`查看详情`) and remain bound to the same owner/session. The browser labels, help, and error pages are Simplified Chinese; commands and code remain unchanged. It is a snapshot, not a live terminal, control channel, or Codex subagent panel. External DSH agents cannot appear as native Codex children. Call `dsh_trace` again for a fresh snapshot when a ticket expires; legacy unscoped `/trace/view` links return `410`.

## Chinese output contract

Every `dsh_start` and every `dsh_followup` message gets exactly one concise appended instruction:

```text
用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。
```

The original task text remains a verbatim prefix. A follow-up message receives its own marker even when the agent was started before this contract existed, so pre-existing conversations do not need to be restarted and their context is preserved. A marker already present in the task is not duplicated.

## Measured orchestration overhead and limits

The following read-only measurements used only `dsh_status` / `dsh_events` on the completed agent `ffbbbc39-f3c0-4d78-86cf-b1df492eed14`; no inference or new agent was started. Timings are Windows wall-clock milliseconds, with an already-populated npm cache, so “cold” is the first sample rather than an empty-cache/offline install.

| Path | Cold | Warm median | Samples |
| :--- | ---: | ---: | ---: |
| Old one-shot `runClient` through npx, status | 1314 | 1308 | 1 cold + 5 warm |
| Direct published 0.7 CLI, status | 272 | 298 | 1 + 5 |
| Direct bridge socket, status | 6 | 5 | 1 + 5 |
| Old plugin `dsh_status` through npx | 1403 | 1290 | 1 + 5 |
| New `runClient` with verified 0.7 entrypoint, status | 289 | 280 | 1 + 5 |
| New plugin `dsh_status` | 282 | 287 | 1 + 5 |
| New `runClient` / plugin `dsh_events` | 326 / 326 | 312 / 336 | 1 + 3 each |

The npx resolver was the dominant avoidable cost: about 1.0 s (roughly 77%) per one-shot call. The client now prefers an exact, verified `dsh-subagent-mcp@0.7.0` entrypoint from an explicit `SOL_LUNA_DSH_PACKAGE_ROOT`, an npm global prefix, or the trusted npm npx cache. It never searches the current working directory or its `node_modules`, never executes an implicit local package, and falls back to the pinned `npx --yes dsh-subagent-mcp@0.7.0 mcp` when no trusted copy is found. A different package name/version is rejected. No mutating call is retried automatically.

The plugin ownership hook adds about 5 ms per `dsh_status` call (5 warm samples; total 283 ms vs backend 278 ms median). Each helper call uses two node processes after the change (client + CLI) instead of three (client + npx + CLI); the plugin host is long-lived and adds one child per call instead of two. The remaining ~280 ms is fresh Node/MCP SDK/CLI startup. The direct bridge floor is 2–5 ms, but persistent transport reuse is deliberately not implemented because it would add cross-call lifecycle and mutating-replay risk. Concurrent workers, antivirus, and host load can add variance; these numbers are limits, not guarantees.

## Use

### Route script

Run the route script from the skill directory. The Windows DSH helper requires Node.js 24+, npm, and PowerShell 7.3+.

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

### Prefer plugin tools; shell fallback

When the plugin MCP tools are loaded, prefer `dsh_start`/`dsh_wait`/`dsh_trace` and the other wrapper tools. They bind each agent to the trusted Codex thread and isolate chats. If the MCP tools are not loaded, the PowerShell 7.3+ wrapper calls the published bridge over stdio for the current old chat:

```powershell
& .\scripts\dsh-agent.ps1 start --task "Implement the accepted task and run focused tests." --cwd (Get-Location).Path --permission workspace-write
& .\scripts\dsh-agent.ps1 wait AGENT_ID
& .\scripts\dsh-agent.ps1 followup AGENT_ID --task "Fix the reported test failure and rerun that test."
```

If a wait times out or the caller disconnects, retain the returned agent ID and continue waiting or read the result. Do not dispatch a duplicate task merely because its result was delayed. The route is evaluated when each new task is dispatched; it does not gate every model request. A running task can finish after a peak boundary. A selected executor failure is reported; it is never silently substituted.

## DeepSeek executor and Windows patch

The DeepSeek executor is the external [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) project, pinned to published version 0.7.0 and distributed under [MIT](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/LICENSE). The helper and plugin are thin MCP stdio clients over its tools; they do not implement an LLM or coding-tool loop. The bridge defaults to provider `deepseek-official` and model `deepseek-flash`. The published DeepSeek price schedule may not apply to third-party compatible endpoints. Desktop completion callback support is not guaranteed; use `dsh_wait` when needed.

This repository also includes an optional idempotent Windows console-window patch, `scripts/patch-backend-windows.mjs`. It changes only the managed 0.7.0 runtime's `spawn(process.execPath, ...)` options by adding `windowsHide: true`; it does not touch the service lifecycle, `package.json`, or the license, and it keeps a verified backup. When that patch is applied, the managed install contains local changes beyond upstream 0.7.0. Run it only at a deliberate maintenance point, not while tasks are active.

## Native DeepSeek route (isolated path)

The formal native DeepSeek path uses the patched, versioned CLI and the `native_deepseek` child role. That role uses its own `deepseek-native` provider and `sol-luna-native-models.json` catalog. Sol's main session and native Luna retain their normal provider and live model catalog; this path does not set root `openai_base_url` or a global `model_catalog_json`. See [the isolated installer guide](docs/native-isolated-install.md) for the explicit `prepare`, `activate`, `status`, and `rollback` workflow. Do not run setup during ordinary task routing.

The formal gateway uses `--deepseek-only`: it rejects GPT/unknown models and encrypted collaboration input before any upstream call, and its relay cap is forced to zero. Dispatch accepts only a health response confirming `deepseek_only=true`, `relay_allowed=false`, and a Running owned Task. Legacy direct gateway mode retains its existing compatibility behavior.

The isolated installer runs an app-server smoke against a temporary Codex home before activation. A formal installation and stable gateway source switch passed on one host; see the [installation record](docs/native-formal-install-2026-10-18.md), [stable gateway acceptance](docs/native-stable-gateway-acceptance-2026-10-18.md), and [0.10.4 package update record](docs/native-plugin-update-0.10.4-2026-10-18.md). The [0.10.5 package update record](docs/native-plugin-update-0.10.5-2026-10-18.md) documents the plugin install and backend activation, and the [bounded retry candidate](docs/native-plugin-candidate-0.10.5-2026-10-18.md) records its GREEN build. This setup is a plugin plus its matching custom open-source Codex CLI, not a plugin-only change; the compressed plugin source archive is about 0.37 MiB and the Windows CLI is about 325.47 MiB. The CLI is based on upstream Codex source licensed under Apache-2.0; the router's MIT license applies to this repository and does not change the CLI's license. This custom CLI is not covered by an official compatibility guarantee.

The [0.10.5 desktop acceptance record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md) documents a full application restart, observation of the new CLI, native child continuation, readiness recovery after a gateway failure, and real DeepSeek tool execution in two main chats. This is host-specific partial acceptance, not a claim that every target is complete. The user confirmed native child discovery, opening the same child panel, same-child follow-up, and automatic progress/result text in the third historical turn; they later pasted the final messages from all three historical turns. The user expanded the new chat-A DeepSeek command card and confirmed its PowerShell script and output (50 bytes, matching SHA-256, exit 0). The first old-demo command card and output were also expanded and matched: its initial lookup targeted an absent old `package.json`, then fell back to the plugin manifest and completed. This is historical tool output, not a current 0.10.5 failure. The 0.10.5 runtime is now observed and the restart requirement was satisfied. The dated desktop record lists host-specific observed behavior and applicable limits; installed-package synchronization and public publication are tracked separately. Other hosts require local verification. The installer `status` fields `runtimeObserved=false` and `desktopAccepted=false` remain conservative static journal diagnostics; the dated desktop record contains the later read-only runtime observation and must not be rewritten into the historical journal.

The formal gateway lifecycle uses an owned current-user Task Scheduler task, with a hidden synchronous launcher; `native-agent.mjs` checks the owned task and gateway health before each DeepSeek dispatch. The [stable gateway acceptance](docs/native-stable-gateway-acceptance-2026-10-18.md) separates a disposable Task-stop probe from the formal graceful source-switch restart and verifies the new process command line against the stable bundle. A later [partial fault acceptance](docs/native-formal-fault-acceptance-2026-10-18.md) records successful recovery and local TCP cases alongside an automatic Task restart that remains unaccepted. The host-specific [0.10.5 desktop record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md) separately documents later child UI and restart observations. See also the [lifecycle test receipt](docs/native-gateway-lifecycle-2026-10-18.md). `native-autostart.mjs` remains an optional legacy Startup launcher and is not the formal lifecycle. The native route uses no DSH agent/session/workspace; DSH remains an explicit legacy workflow.

The older `native-install.mjs` shared-root gateway, global catalog, and transparent GPT relay remain historical compatibility paths. They are not the formal isolated setup route and must not be used as its installation instructions. The old native acceptance record documents that earlier path only; it is not evidence of isolated-role or desktop acceptance.

The formal native child call uses `spawn_agent` with `task_name`, `agent_type: "native_deepseek"`, and `fork_turns: "none"`; omit `model` so the isolated role selects its configured model and fixed `high` reasoning effort. This native route does not inherit the Sol parent’s `xhigh` setting, so an `xhigh` parent request still runs this child at `high`. The current spawn path exposes no per-child effort control. If the role is unavailable, stop and report the setup failure. Do not fall back to the shared-root provider, an explicit model override, or another executor. Native writer coordination reserves the workspace before spawn, binds the real child, and releases explicitly; it is not tied to a short-lived CLI PID.

The evidence in `docs/native-deepseek-acceptance-2026-10-17.md` is historical and covers the earlier shared-provider contract. The host-specific [0.10.5 desktop record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md) establishes the observations listed there only; it does not establish acceptance on other hosts or completion of package/skill synchronization and publication.

The legacy DSH MCP/trace path remains explicit and is never an automatic fallback from native DeepSeek.

## Validate

```powershell
node .\tests\route.test.mjs
node .\tests\route-hook.test.mjs
node .\tests\plugin-state.test.mjs
node .\tests\plugin-cross-process.test.mjs
node .\tests\plugin-trace.test.mjs
node .\tests\plugin-mcp.test.mjs
node .\tests\plugin-client.test.mjs
node .\tests\plugin-manifest.test.mjs
node .\tests\plugin-router-settings.test.mjs
node .\tests\plugin-mcp-env.test.mjs
node .\tests\dsh-mcp-client.test.mjs
node .\tests\docs.test.mjs
node .\tests\native-routing.test.mjs
node .\tests\native-relay.test.mjs
node .\tests\native-gateway.test.mjs
node .\tests\native-state.test.mjs
node .\tests\native-agent.test.mjs
node .\tests\native-isolated-install.test.mjs
node .\tests\native-api-settings.test.mjs
node .\tests\native-api-routing.test.mjs
node .\tests\native-api-protocol.test.mjs
node .\tests\native-api-artifacts.test.mjs
node .\tests\native-api-install.test.mjs
node .\tests\native-api-lifecycle.test.mjs
node .\tests\native-api-origin.test.mjs
node .\tests\native-api-manager.test.mjs
node .\tests\native-install.test.mjs
node .\tests\native-manager.test.mjs
node .\tests\native-autostart.test.mjs
node .\tests\native-gateway-task.test.mjs
node .\tests\native-config-read.test.mjs
node .\scripts\patch-backend-windows.test.mjs
pwsh -NoProfile -File .\tests\dsh-agent-helper.test.ps1
```

The plugin tests use a fake backend and fake MCP children. They do not require a DeepSeek account, a live DSH daemon, or network access. The cross-process suite launches hidden Node workers to prove that one workspace admits only one writer and that separate chat owners survive concurrent durable updates. CI runs hook tests in both jobs and runs plugin tests only when the corresponding files exist.

`native-config-read.test.mjs` is a local pre-install gate, not a default hosted-CI step: it starts the real Codex app-server and requires a local `codex` executable plus `models_cache.json`. CI exposes it only through the opt-in `RUN_NATIVE_CONFIG_READ=true` repository variable; the test fails closed instead of skipping green. The Windows-native gateway tests run in the Windows CI job; no model request is made.

## Installation

### Standalone skill

Copy the canonical skill bundle from this repository into `~/.codex/skills/sol-luna-deepseek-router`, or install it through your configured skill workflow. Keep `SKILL.md`, the bundled `scripts/` directory, and the referenced local `docs/` resources together; update the existing skill directory in place and keep exactly one routing-skill copy. The scripts use relative imports within `scripts/`, so copying only `SKILL.md` is incomplete.

### Plugin

Install from the repository marketplace:

```powershell
codex plugin marketplace add <repo-root>
codex plugin add sol-luna-deepseek-router@sol-luna
```

When the configured `sol-luna` marketplace points to a local repository, refresh an already installed plugin after updating the source by running `codex plugin add sol-luna-deepseek-router@sol-luna` again. This reinstalls the complete plugin package in the Codex plugin cache from that marketplace. `codex plugin marketplace upgrade` refreshes configured Git marketplace snapshots only; it is not the update command for this local source. Update the standalone skill bundle separately from the canonical root `SKILL.md`, `scripts/`, and referenced local `docs/` resources above.

`.agents/plugins/marketplace.json` is portable: its plugin source is `./`, inside the marketplace root, so both a local checkout and a GitHub clone resolve without an absolute path. The plugin manifest is `.codex-plugin/plugin.json`; the MCP companion is `.mcp.json`; hooks are auto-discovered from `hooks/hooks.json`. No manifest `hooks` pointer is required, and the plugin contributes no skill. Keep the standalone root skill as the only routing skill.

After this initial plugin installation or a plugin update, reload plugins or restart Codex so the new MCP tools and hooks are discovered. This reload only exposes the plugin package; it does not prepare or activate the isolated native CLI or gateway. Keep that separate lifecycle on the documented `native-isolated-install.mjs prepare` → `status` → `activate` path. The formal native DeepSeek dispatch follows the contract above, while Sol and Luna continue using their normal direct provider/catalog. Do not open a new chat merely to switch peak/valley routes; preserve the current conversation. Codex lists the hooks as untrusted until you review and approve them in `/hooks`.

### Isolated native DeepSeek setup

Only perform setup when explicitly requested. Follow [the isolated installer guide](docs/native-isolated-install.md) and its staged `prepare` → `status` → `activate` flow. The legacy `native-install.mjs` command is not the formal setup entrypoint. One host-specific installation and later 0.10.5 desktop observations are recorded in [the dated install record](docs/native-formal-install-2026-10-18.md) and [the 0.10.5 desktop acceptance](docs/native-desktop-acceptance-0.10.5-2026-10-18.md); other hosts require local verification. A prepared or configured state alone is not desktop acceptance.

The installer manages three user environment values, including `SOL_LUNA_NATIVE_INSTALL_JOURNAL`, which lets future DeepSeek chats find the active journal without an explicit CLI flag. Fully exit and restart Codex after activation so new chats inherit the updated environment; a running app does not refresh it. Generic runtime environment plans continue to manage only the original two keys, and older two-key journals remain supported.

### DSH bridge

At a deliberate setup point, install the upstream bridge with the companion skill disabled:

```powershell
npx --yes dsh-subagent-mcp@0.7.0 setup --no-skill --service background
```

This registers the upstream MCP server and may prepare its managed background service/dependencies. Reload Codex once after this MCP configuration change so the server is discovered; do not open a new chat just to change the route. Do not run the upstream installer with its default skill installation when this router is active. On Windows, apply the optional console-hide patch only at a maintenance point if you need it.

The generic OpenAI-compatible API executor backend is documented in [docs/native-api-executors.md](docs/native-api-executors.md). The historical 0.10.5/6ec runtime predates generic API support; the matching 48d runtime and 0.11.1/0.11.2 installation records are linked [here](docs/native-api-msix-path-fix-0.11.1-2026-10-19.md) and [here](docs/native-api-role-registration-0.11.2-2026-10-19.md). The 0.11.3 catalog repair and failed real child result are documented [here](docs/native-api-catalog-instructions-0.11.3-2026-10-19.md) and [here](docs/native-api-agent-message-0.11.4-2026-10-19.md). The 0.11.4 wire correction has local tests only; no additional API call is authorized, and `apiVerified` remains false. The earlier `model/list` check did not parse the custom catalog and is not acceptance evidence.

Native children should not send unsolicited user-facing progress updates; only send a short update when blocked or when a human action is needed. Their final reply should be brief, in Simplified Chinese, and state the outcome without hiding failures. Send the parent one concise internal handoff with the diff, tests, and limits rather than duplicating it in the user-facing final. The required Chinese suffix sets language; it does not require progress updates. Refreshing an active API gateway source requires the explicit owned rollback/prepare/activate maintenance path; ordinary profile Apply does not replace the staged source.

The default remains peak Luna / valley DeepSeek. A user-selected API profile is fixed and does not consult the clock; an explicit scheduled plan may use API peak and DeepSeek valley or two API profiles. One-time and sticky selections take precedence, and a failed selected executor is reported without falling back to Luna, DeepSeek, another API, or another DeepSeek account. Local credential availability is not authentication proof.

Saving an API profile only writes router JSON. A compatible, already-staged runtime must be present before the explicit Apply action can install the owned role/provider/catalog/Task transaction; a newly applied role requires a full Codex restart. Existing children keep their original immutable profile. First-version API children disable Codex's built-in web search for both Responses and Chat Completions, and the adapter does not claim to enforce a provider grammar. The historical 6ec runtime reports `runtimeCompatible:false`; generic API readiness requires root role registration, a full restart, and actual child-spawn evidence.

Official DeepSeek API profiles (account or manual env/file credentials) use the documented `none/low/high/max` reasoning levels; the official API docs state that `none` disables thinking. `xhigh` is normalized to `high` in the API adapter and a valid `max` is preserved. The adapter passes `none` through and does not invent a separate `off` value; non-DeepSeek profiles keep their declared efforts. Historical DeepSeek routing behavior is unchanged. This is wire-rule evidence, not a claim that a real generic API role has completed end-to-end acceptance.

The canonical routing skill remains `sol-luna-deepseek-router`; do not add a second skill or delete old cache/backup directories. The agreed visible display name for the next package is “Sol 主控 · 多模型峰谷子代理”; keep the stable registry IDs and folders so a display-name update does not create two enabled skills.

## Privacy and state

- Route override state: `%LOCALAPPDATA%\sol-luna-deepseek-router\session-overrides`; hook state: `%LOCALAPPDATA%\sol-luna-deepseek-router\hook-state`; plugin state: `%LOCALAPPDATA%\sol-luna-deepseek-router\plugin`.
- Native gateway identity/state/logs: `%LOCALAPPDATA%\sol-luna-deepseek-router\native-gateway`. The stable token stays in the private identity file and is never printed.
- Raw session/thread IDs are not persisted in hook or plugin state; hashes are used.
- Never put API keys, DSH credentials, user paths, logs, local configuration backups, or trace tickets in this repository.
- Never print or copy API credentials. A selected executor failure is reported, never silently substituted.

The original Sol/Luna delegation skill drew on [madman8228/sol-luna-delivery](https://github.com/madman8228/sol-luna-delivery) and [dy0000/sol-plan-luna-execute](https://github.com/dy0000/sol-plan-luna-execute); this router preserves the Sol-led delegation pattern while adding an explicit schedule and DeepSeek execution route.

## Sources

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [2026 State Council public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [dsh-subagent-mcp 0.7.0](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) and its [license](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/LICENSE)
