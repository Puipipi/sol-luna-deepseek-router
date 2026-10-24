# Sol 主控 · 多模型峰谷子代理

Canonical skill: `$sol-luna-deepseek-router`.

This repository contains the canonical standalone routing skill and an optional Codex plugin. The formal native DeepSeek path uses the patched, versioned CLI with an isolated `native_deepseek` role, dedicated `deepseek-native` provider, and child-only catalog; Sol and Luna retain their normal provider/catalog. The published `dsh-subagent-mcp@0.7.0` bridge remains explicit legacy compatibility. The older shared-root gateway, global catalog, and GPT relay are historical compatibility only, not the formal isolated setup path.

The 0.11.1 MSIX binding and formal Apply are recorded in the [installation record](docs/native-api-msix-path-fix-0.11.1-2026-10-19.md), including the user's report of settings-panel controls, route save, and local credential availability. Profiles remain immutable; existing children keep their original profile, and saving JSON is not installation. First-version API children disable Codex built-in web search for both Responses and Chat Completions. The plugin package version is independent of the MCP server protocol version, which follows the plugin release version. The 0.11.2 role registration and 0.11.3 catalog repair/Apply are documented in their [records](docs/native-api-role-registration-0.11.2-2026-10-19.md) and [record](docs/native-api-catalog-instructions-0.11.3-2026-10-19.md). The 0.11.3 API child was created but returned a generic response without invoking tools; the task failed. The 0.11.4 wire correction is in [its repair record](docs/native-api-agent-message-0.11.4-2026-10-19.md). The one-time API authorization has been consumed, and `apiVerified` remains false.

The formal gateway lifecycle is an owned current-user Task Scheduler task started and health-checked at DeepSeek dispatch. A private Windows PowerShell 7 probe passed for a self-owned Job teardown with a mock loopback service: the direct helper/gateway died with the Job, while the scheduled gateway survived and remained hidden. This did not close a real DSH tree or validate the installed gateway or desktop child UI; see the [lifecycle test receipt](docs/native-gateway-lifecycle-2026-10-18.md). The native route does not create DSH sessions, agents, or workspaces. `native-autostart.mjs` is retained only as an optional legacy Startup launcher.

The formal Task starts `native-gateway.mjs --serve --deepseek-only`. Strict mode rejects GPT/unknown models and encrypted collaboration inputs, performs no GPT relay, and is accepted by dispatch only when health reports `deepseek_only=true` and `relay_allowed=false` while the owned Task is Running. This source/test contract does not claim that real API or desktop acceptance has completed.

## Components

| Path | Purpose |
| :--- | :--- |
| `.codex-plugin/plugin.json` | Codex plugin manifest. Declares the MCP companion; it does not declare a second skill. |
| `.agents/plugins/marketplace.json` | Portable repo marketplace. Its `source.path` is `./`, inside the marketplace root, so local and GitHub clone installs resolve without an absolute path. |
| `.mcp.json` | Starts `scripts/plugin-mcp.mjs` with `cwd: "."` (the plugin root), a long tool timeout for unbounded waits, and a minimal environment allowlist. |
| `scripts/native-isolated-install.mjs`, `native-isolated-files.mjs`, `native-isolated-smoke.mjs` | Prepare, smoke-test, activate, inspect, and roll back the isolated runtime/configuration transaction. |
| `scripts/native-runtime.mjs`, `native-runtime-env.mjs` | Verify/stage the pinned CLI runtime and transactionally manage its user environment variables. |
| `scripts/native-gateway-manager.mjs`, `native-gateway-task.mjs` | Manage the isolated gateway and its owned Task Scheduler task. The task runs a hidden synchronous launcher so the gateway lifecycle is independent of the DSH/Codex child tree; DeepSeek dispatch checks task ownership and gateway health. |
| `scripts/native-autostart.mjs` | Optional legacy Startup VBS launcher; the formal isolated installer removes a previously managed instance after Task Scheduler health succeeds. |
| `scripts/native-catalog.mjs`, `native-install.mjs` | `native-catalog.mjs` builds the isolated child catalog; `native-install.mjs` retains the older shared-root transaction for historical compatibility. |
| `scripts/native-state.mjs`, `native-agent.mjs` | Parent/child ownership, reserve-before-spawn writer leases, and Luna catalog resolution plus the native DeepSeek role dispatch contract. |
| `scripts/plugin-mcp.mjs` | Legacy MCP stdio wrapper. Requires trusted `_meta.threadId`, enforces ownership, filters lists, leases writers, and exposes `dsh_trace`. |
| `scripts/plugin-state.mjs` | Durable hashed ownership store and canonical same-workspace writer leases. |
| `scripts/plugin-trace.mjs` | Escaped, read-only loopback HTML trace with single-use ticket exchange, per-view scoped cookies/paths, coexisting tabs, clickable details, and Simplified Chinese user-visible labels/help/errors. |
| `scripts/dsh-mcp-client.mjs` | Existing `runClient`, extended additively for `dsh_events`, `dsh_close`, `dsh_rename`, trusted `_meta` forwarding, and the per-message Chinese output instruction. It spawns an exact verified published `dsh-subagent-mcp@0.7.0` entrypoint from a trusted location, or falls back to the pinned npx transport. |

This plugin deliberately does **not** bundle a second scheduling skill. The canonical standalone `SKILL.md` at the repository root remains the single scheduling skill and is managed separately. Loading both would create two competing routing instructions.

The plugin MCP server uses the same `runClient` as the PowerShell helper. Each call starts one verified published DSH 0.7 stdio transport, performs the MCP handshake, issues one tool call, and terminates the transport. The DSH daemon remains the owner of the actual agent and its conversation. The fast path only uses an explicit `SOL_LUNA_DSH_PACKAGE_ROOT`, an npm global prefix, or the trusted npm npx cache after verifying the exact package name/version and entrypoint; it never searches the current directory or `node_modules`. If no trusted 0.7.0 copy exists, it falls back to the pinned npx command. A different version or package name is rejected, and mutating calls are never retried automatically.

## Ownership

Every `tools/call` must carry Codex's trusted request metadata:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "dsh_start",
    "arguments": {"task": "...", "cwd": "..."},
    "_meta": {"threadId": "<Codex thread id>"}
  }
}
```

The wrapper reads only `params._meta.threadId`. It rejects `_meta`, `thread_id`, `threadId`, `owner`, `chat_id`, and similar keys inside `arguments`. Missing or blank identity fails before any DSH process is spawned. This is deliberate: there is no environment-variable fallback and no “default chat”.

Ownership is persisted in:

```text
%LOCALAPPDATA%\sol-luna-deepseek-router\plugin\ownership.json
```

Only `sha256(threadId)` is stored. The raw Codex thread ID is never written to disk. All ownership mutations use an on-disk lock plus an atomic temp-file rename, so two plugin processes cannot lose an update. An agent ID that is absent or owned by another chat produces the same message: `Agent <id> is not available to this chat.`

`dsh_list` requests the upstream page, removes every row whose agent ID is not owned by the caller, and only then applies `status`, `cwd`, `match`, `limit`, and `max_chars`. The returned `total` is the caller's owned count, not the global DSH store count. Other chats' names, paths, statuses, and counts never cross the MCP boundary. Agents created directly in DSH Web or by another MCP client have no plugin ownership record, so this plugin does not list or adopt them.

## Writer leases

A `workspace-write` or `danger-full-access` start takes a lease keyed by the **real canonical workspace**. The plugin resolves the path with `realpath` before hashing, so Windows case aliases, short names, trailing separators, symlinks, and junctions cannot create two independent locks for one directory.

```text
%LOCALAPPDATA%\sol-luna-deepseek-router\plugin\leases\<sha256(canonical-workspace)>.json
```

The lease records the hashed owner, agent ID, canonical workspace, a `bound` flag, and informational timestamps. A second write-capable start in the same workspace does **not** replace the lease based on PID death or elapsed time. The plugin calls the real DSH `dsh_status` for the bound agent and permits replacement only when DSH confirms `idle` or a terminal state (`completed`, `error`, `interrupted`, `context_exhausted`, `closed`).

- An active `starting`/`running`/`interrupting` agent keeps the workspace busy even if the plugin process is gone and every timestamp is old.
- If DSH is unavailable, times out, or returns an unknown status, the lease remains locked. It is never silently stolen. The error names the lease file; retry when DSH is reachable. Do not remove it while the task may still be running.
- A start whose outcome is unknown (timeout, transport exit, or no agent ID) leaves an **unbound reservation**. Reservations have no verified DSH agent ID and **never expire automatically**. The exact recovery limitation is reported: verify that no DSH task is running, then deliberately remove the named lease file and retry. This avoids a silent duplicate dispatch.
- A follow-up failure with an unknown outcome keeps the existing lease. The plugin does not release a writer because a transport failed.
- Read-only agents do not take the lease and may run in parallel.

`dsh_status`, `dsh_wait`, `dsh_list`, `dsh_trace`, `dsh_interrupt`, and `dsh_close` release the lease only when DSH returns a confirmed terminal state or a deliberate close/interrupt. The recorded PID is diagnostic only; no timestamp or PID can expire a lease.

`dsh_followup` reacquires the lease for a write-capable agent. If the lease is held by another chat, the follow-up fails before the follow-up DSH call; only the read-only status reconciliation runs.

## Trace

`dsh_trace` performs an ownership check, reads real DSH events through `dsh_events` (`include_progress`, `include_descendants`, `include_tool_events`), renders a snapshot, and returns a single-use exchange URL:

```text
http://127.0.0.1:<ephemeral-port>/trace/<43-character-base64url-ticket>
```

The actual DSH 0.7 `dsh_events` payload uses `events`, `has_more`, and `next_cursor` (not `items`). The wrapper extracts that schema and reports `event_count`, `has_more`, `next_cursor`, and `truncated` truthfully. Pass `after` to continue from a cursor. Pass `event_id` to request one selected tool event in full detail; the page labels the selected event.

Ticket exchange and browser access:

- The initial URL contains a 256-bit random single-use ticket. It is exchanged once.
- A successful `GET /trace/<ticket>` returns `303 Location: /trace/view/<view-id>/` and `Set-Cookie: dsh_trace_<view-id>=<random>; HttpOnly; SameSite=Strict; Path=/trace/view/<view-id>/; Max-Age=...`.
- The resulting page URL is `/trace/view/<view-id>/` and contains **no ticket**. The cookie is an HttpOnly, SameSite=Strict, short-lived capability scoped to that one view, not a DSH/DeepSeek/Codex/OpenAI credential.
- Each view has a different cookie name and path. Opening a trace for agent B does not overwrite the cookie for agent A, so two tabs can keep both detail pages usable. A detail request with another view's cookie is rejected before any event data is returned.
- Accessing a view without its cookie returns `401`. Reusing the exchanged ticket returns `410`. Legacy unscoped `/trace/view` and `/trace/event/...` links return `410`; request a fresh trace.
- The ticket is not placed in the redirect target, page body, or cookie value. The cookie value is a fresh random token.
- The HTTP server binds to `127.0.0.1` only.
- Tickets and sessions expire after two minutes; a session allows at most 20 views. Terminal observation revokes both tickets and sessions.
- Only `GET` and `HEAD` are accepted. There is no control endpoint.
- Every event field, agent ID, title, status, cursor, and JSON blob is HTML-escaped. A restrictive `Content-Security-Policy` disables scripts, framing, forms, and external resources.
- Obvious API-key and bearer-token patterns are redacted from rendered text.
- Browser labels, help text, and error pages are Simplified Chinese. Commands, event types, status values, and code remain unchanged.
- Events with an `event_id` expose a clickable `查看详情` link. The detail callback rechecks ownership and is bound to the same per-view session; it is not a control channel.

### Browser-trace limitation

DSH agents run inside the external DeepSeek Harness runtime. Codex's native subagent/child surface only knows about agents that Codex itself spawned. A DSH agent therefore **cannot** be displayed as a native Codex child, and this plugin does not pretend otherwise. The browser trace is a separate read-only snapshot of the external DSH event stream. It is not a Codex subagent panel, not a live terminal, and not a control channel. It is clickable only while the plugin process is alive and the per-view HttpOnly cookie is valid; separate views keep separate cookies and paths, so different agents' tabs can remain open together. Browser labels, help, and errors are Chinese; commands and code are unchanged.

## Chinese output contract

Every `dsh_start` and every `dsh_followup` message receives exactly one appended instruction:

```text
用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。
```

The original task remains a verbatim prefix. A follow-up to an agent created before this contract still gets the marker once, so its conversation does not need to be restarted or replaced. A marker already present is not duplicated. Code, commands, paths, and internal GPT-DeepSeek communication may remain in their original language.

## Measured performance limits

Read-only `dsh_status` / `dsh_events` measurements on completed agent `ffbbbc39-f3c0-4d78-86cf-b1df492eed14` (Windows, npm cache already populated; “cold” is the first sample, not an empty cache/offline install):

| Path | Cold | Warm median | Samples |
| :--- | ---: | ---: | ---: |
| Old one-shot `runClient` via npx | 1314 ms | 1308 ms | 1 + 5 |
| Direct published 0.7 CLI | 272 ms | 298 ms | 1 + 5 |
| Direct bridge socket | 6 ms | 5 ms | 1 + 5 |
| New verified-entrypoint `runClient` | 289 ms | 280 ms | 1 + 5 |
| New plugin `dsh_status` | 282 ms | 287 ms | 1 + 5 |

The npx resolver cost about 1.0 s per call (roughly 77%). The fast path removes it while keeping the exact published 0.7.0 backend. The ownership hook adds about 5 ms per call. The remaining ~280 ms is fresh Node/MCP SDK/CLI startup; the 2–5 ms bridge floor is not used because persistent reuse would add unsafe lifecycle and mutating-replay risk. Helper calls use two node processes instead of three; the plugin host adds one child instead of two. Concurrent work, antivirus, and host load can increase these times. No mutating call is retried automatically, and no backend/provider/model/effort is silently changed.

## Formal native DeepSeek path

The `native_deepseek` role has a dedicated `deepseek-native` provider and child-only `sol-luna-native-models.json`; the parent Sol session and native Luna keep their normal provider and live model catalog. The route does not add a root `openai_base_url` or global `model_catalog_json`. Setup is explicit through [`native-isolated-install.mjs`](docs/native-isolated-install.md): `prepare` runs a temporary-home app-server smoke and writes a journal, `activate` applies the prepared files/environment/startup, and `rollback` restores only unchanged managed values.

The formal isolated CLI installation and stable gateway source switch passed on one host. The [0.10.5 desktop record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md) documents host-specific native DeepSeek restart and child observations. These do not establish generic API acceptance: the 0.11.3 role was discovered and a child was created, but it returned a generic response without invoking tools. The 0.11.4 wire correction has only local loopback evidence and still needs a newly authorized real child test. Do not treat the historical shared-provider acceptance record as acceptance of the isolated role or generic API executor.

Native child spawning uses `spawn_agent` with `task_name`, `agent_type: "native_deepseek"`, and `fork_turns: "none"`; omit `model` so the role owns model selection. If the role is unavailable, report setup failure and stop. Do not fall back to the shared-root gateway, an explicit model override, or Luna. Writer ownership reserves the workspace before spawn, binds the real child, and releases only at explicit finish or verified terminal state. Child replies should be brief for the user: no unsolicited progress unless blocked or human action is needed, then a concise Simplified Chinese final. Send the parent one internal diff/test/evidence handoff, and state failures plainly.

## Failure behavior

- Missing identity: fails before spawning DSH.
- Unsupported field or identity in arguments: fails before spawning DSH.
- Agent owned by another chat: fails without an upstream call.
- Same-workspace writer lease busy: fails before the upstream start. The lease is retained unless DSH confirms `idle` or a terminal state.
- DSH unavailable or unknown during lease reconciliation: the workspace remains locked; the plugin never guesses that an independent DSH task stopped.
- Uncertain start: the unbound reservation remains until deliberate manual recovery; it never expires into a duplicate dispatch.
- Uncertain follow-up: the existing writer lease remains held.
- Upstream error or timeout: returned as an MCP tool error with common credential patterns redacted. A timed-out start is never retried. Inspect the same agent ID instead.
- Ownership write failure after a successful start: the plugin best-effort interrupts only an agent it does not know belongs to another chat, and retains the lease until DSH confirms idle/terminal or a human deliberately recovers it.
- Trace rendering failure: no ticket is returned. Unknown, expired, revoked, or already-exchanged tickets get `410`; a missing viewer cookie gets `401`.

## Deployment

The standalone routing skill and plugin are updated separately. There is no automatic release-integration script in this repository that synchronizes the canonical `SKILL.md` into the installed skill directory. Update the existing standalone skill in place through the configured skill workflow or by copying the root `SKILL.md`; do not create a second routing skill. To refresh the plugin cache from the marketplace, use the supported Codex CLI:

```powershell
codex plugin add sol-luna-deepseek-router@sol-luna --json
```

This refresh updates the installed plugin source/cache; it does not update the separately installed standalone skill, mark hooks trusted, change the main model/provider/base URL, or restart Codex. A running Codex host may need a plugin reload to discover new tools. Reopen `/hooks` after an update to review the hook hashes.

1. Install Node.js 24+ with npm. Confirm `node --version` and `npm --version`.
2. For isolated native DeepSeek setup, follow [the isolated installer guide](docs/native-isolated-install.md) only after an explicit setup request. Its `prepare`, `status`, `activate`, and `rollback` commands are the formal setup interface. Do not use `native-install.mjs install` or start the legacy default gateway as the new setup path. The guide distinguishes staged, configured, and desktop-accepted states; the dated records document the one-host formal installation and host-specific native DeepSeek observations. Other hosts require local verification. Updating an already active API gateway source requires the explicit owned rollback/prepare/activate maintenance path; ordinary active-profile Apply does not replace the staged source. A real API child acceptance attempt needs fresh authorization.
3. The DSH bridge below is legacy compatibility only. Install it at a deliberate setup point with the upstream companion skill disabled:

   ```powershell
   npx --yes dsh-subagent-mcp@0.7.0 setup --no-skill --service background
   ```

4. Install this repository as a Codex plugin through its portable repo marketplace:

   ```powershell
   codex plugin marketplace add <repo-root>
   codex plugin add sol-luna-deepseek-router@sol-luna
   ```

   `.agents/plugins/marketplace.json` points at `./`, inside the marketplace root, so a local checkout and a GitHub clone use the same entry. The manifest is `.codex-plugin/plugin.json`; the MCP companion is `.mcp.json`. Do not install a second routing skill from this plugin: the package has no bundled skill, and the canonical root `SKILL.md` remains the single standalone scheduling skill.

5. Reload plugins or restart Codex once after installation so the new MCP tools and hooks are discovered. Do not open a new chat merely to switch peak/valley routes; preserve the current conversation. A running session may need that plugin reload to pick up the new MCP tools.

6. Review the discovered hooks in `/hooks` before enabling them. Both hooks are untrusted until a human inspects their command, source, and hash and approves them. The plugin does not mark them trusted, edit the trust store, or bypass the review. Hook notices stay inactive until that approval; routing and MCP tools do not depend on the hooks.

7. Ask Codex to call `dsh_list` or `dsh_start`. Codex supplies `_meta.threadId` automatically. If a host build does not supply it, the plugin fails safely; use the PowerShell helper with an explicit local workflow instead of inventing an identity.

The manifest and MCP companion follow the Codex plugin contract described in the official OpenAI documentation: [Package your plugin](https://developers.openai.com/plugins/build/plugins) and [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server). The `.mcp.json` fields `cwd`, `env_vars`, and `tool_timeout_sec` match the shape used by bundled first-party plugins.

### State and privacy

- Plugin state: `%LOCALAPPDATA%\sol-luna-deepseek-router\plugin`.
- Native gateway identity/state/logs: `%LOCALAPPDATA%\sol-luna-deepseek-router\native-gateway`; the stable port/token identity is private and never printed.
- The plugin stores no API keys, tokens, or raw thread IDs on disk. The trace capability cookie lives only in the browser and expires quickly.
- Trace content is derived from DSH events. It can contain repository text, commands, and paths. Treat the single-use exchange URL and cookie as sensitive until they expire.
- The trace server is loopback-only and short-lived, but it is not a replacement for reviewing the repository and test evidence.

## Validation

```powershell
node .\tests\native-routing.test.mjs
node .\tests\native-relay.test.mjs
node .\tests\native-gateway.test.mjs
node .\tests\native-state.test.mjs
node .\tests\native-agent.test.mjs
node .\tests\native-isolated-install.test.mjs
node .\tests\native-install.test.mjs
node .\tests\native-manager.test.mjs
node .\tests\native-autostart.test.mjs
node .\tests\native-gateway-task.test.mjs
node .\tests\native-config-read.test.mjs
node .\tests\plugin-state.test.mjs
node .\tests\plugin-cross-process.test.mjs
node .\tests\plugin-trace.test.mjs
node .\tests\plugin-mcp.test.mjs
node .\tests\plugin-client.test.mjs
node .\tests\plugin-manifest.test.mjs
node .\tests\route.test.mjs
node .\tests\route-hook.test.mjs
node .\tests\dsh-mcp-client.test.mjs
node .\tests\docs.test.mjs
node .\scripts\patch-backend-windows.test.mjs
pwsh -NoProfile -File .\tests\plugin-live-events.ps1
pwsh -NoProfile -File .\tests\dsh-agent-helper.test.ps1
```

Manifest and skill validation:

```powershell
python "$env:USERPROFILE\.dsh\skills\plugin-creator\scripts\validate_plugin.py" .
python "$env:USERPROFILE\.dsh\skills\skill-creator\scripts\quick_validate.py" .
```

The plugin tests use a fake backend and fake MCP children. They do not require a DeepSeek account, a live DSH daemon, or network access. The cross-process suite starts hidden Node workers and proves that one workspace admits only one writer while separate chat owners survive concurrent durable updates. `tests/plugin-live-events.ps1` is the explicit live exception: it uses the installed published DSH 0.7 runtime to read `dsh_status` and `dsh_events` for the terminal legacy agent `ffbbbc39-f3c0-4d78-86cf-b1df492eed14`. It never calls `dsh_start`/`dsh_attach`/`dsh_watch` and never writes plugin ownership state.
