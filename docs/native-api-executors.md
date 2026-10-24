# Native API executors: lifecycle and dispatch gate

This document describes the generic OpenAI-compatible API executor backend. It
does not change the Sol root provider, the default peak-Luna/valley-DeepSeek
route, the strict DeepSeek gateway, or the plugin's MCP/UI surface.

## Settings and immutable profiles

Settings live in the plugin-owned `native-api/router.json` under
`LOCALAPPDATA/sol-luna-deepseek-router` (or the platform equivalent). The
existing `schemaVersion: 1` shape is unchanged. A profile may now carry an
optional `contextWindow` integer from `1024` to `2000000`.

`contextWindow` participates in the canonical profile definition only when it
is explicitly present. A profile without the field keeps its previous 24-hex
profile ID. When an installed profile omits it, artifact generation uses the
plugin default working budget of `128000` tokens. That default is a plugin
input budget, not a probe or claim about the selected model's real context
limit; users should set a budget appropriate for the model and their tool
payloads, and some models may not fit the current tool context at all.

The generated catalog records `context_window` and `max_context_window` with
the configured budget and `effective_context_window_percent: 85`. It advertises
only the profile's declared reasoning efforts and the profile default. It does
not inherit DeepSeek's 1M-token window or claim a web/search capability.

Settings additions, validation, compare-and-swap writes, and immutable
profiles are implemented in `scripts/native-api-settings.mjs`.

The canonical `.mcp.json` forwards the non-secret locator variables
`CODEX_HOME`, `SOL_LUNA_NATIVE_INSTALL_JOURNAL`, and
`SOL_LUNA_NATIVE_API_VERSION_DIR` in addition to the existing state/runtime
variables. It never forwards API key values or the root OpenAI OAuth token.
The filtered-env stdio regression starts the real MCP entry with this allowlist
and verifies that the status path can find the staged runtime.

## Generated artifacts

For profile ID `<24hex>`, the installer owns:

- `agents/native_api_<24hex>.toml`: `name`, exact `model`, configured reasoning
  effort, and `unbounded_connection_retries = false`. It carries no credential,
  base URL, provider, catalog, or developer instructions.
- `sol-luna-native-models-<24hex>.json`: exactly one model entry for the exact
  wire model.
- one `[model_providers.api-native-<24hex>]` table inside the owned
  `# sol-luna-native-api` config block. Its base URL is the profile-specific
  loopback URL, it uses `wire_api = "responses"`, and it has no OpenAI auth,
  environment key, embedded headers, query parameters, WebSockets, or retries.

The role provider and catalog are derived from the profile ID by the patched
CLI. A profile edit creates a new ID; old role and catalog files are never
rewritten in place. Installed profiles are recorded in
`native-api/installed-profiles.json`. Installing a new profile preserves every
previous profile artifact.

## Install and service lifecycle

The commands use explicit paths; they do not discover or modify a task by
guessing. `prepare` verifies the runtime, stages a content-addressed API source
bundle, prepares a private gateway identity, snapshots config/role/catalog/
registry/task state, and writes a journal. `activate` writes only the
snapshotted files and registers the independently owned API Task. It does not
start the gateway.

```text
node scripts/native-api-install.mjs prepare \
  --profile-id <24hex> --settings <router.json> --api-dir <native-api> \
  --codex-home <CODEX_HOME> --version-dir <verified-runtime-version> \
  --plugin-root <installed-plugin-root> --journal-path <journal.json>
node scripts/native-api-install.mjs activate --journal-path <journal.json>
node scripts/native-api-install.mjs status --journal-path <journal.json>
node scripts/native-api-install.mjs rollback --journal-path <journal.json>
```

`activate` reports `restartNeeded: true`. New native role/catalog discovery is
not proven hot-reloadable; fully exit and restart the Codex application before
claiming the role is visible. Existing chats are not changed by this install.

Profiles share one demand-only API Task. The first install records the
pre-plugin Task/launcher baseline in `gateway-origin.json`; when the last
profile is rolled back, the installer restores that origin regardless of which
profile is removed last. Removing A while B remains, or the reverse, therefore
ends at the same user/absent Task state. The launcher is written as UTF-16LE
with BOM and its `--api-only` command and `--settings` path are covered by the
Task fingerprint. The Task must have exactly one logon trigger for the existing
DeepSeek policy and zero triggers for the API demand-only policy.

A fully `rolled_back` journal may be prepared again. The old journal is copied
to a timestamped receipt before the new journal is written; it is not deleted
or silently reused. An installed profile is `alreadyInstalled` only when its
role, catalog, launcher, provider config, shared registry entry, Task, and the
selected compatible runtime all verify. A missing or changed artifact reports
rollback/reinstall instead of a false success. The shared
`installed-profiles.json` is checked by profile membership and exact artifact
paths, never by comparing an older journal's complete registry bytes.

The API service is started on demand for a selected profile by the dispatch
gate. The default `auto` plan remains Luna/DeepSeek and does not start an API
service. The API Task is registered without a logon trigger; only the explicit
selected-profile start path launches it. It has its own namespace, ownership
marker, hidden VBS launcher, and health contract:

```text
GET /<token>/_health
{ "ok": true, "pid": <pid>, "api_only": true, "relay_allowed": false }
```

The DeepSeek gateway's `deepseek_only=true` and `relay_allowed=false` contract
is unchanged. The API service is not a relay and does not accept the DeepSeek
identity or health contract.

```text
node scripts/native-api-manager.mjs start|ensure|stop|status \
  --api-dir <dir> --gateway-script <native-api-serve.mjs>
```

Normal dispatch uses the journal's exact Task plan.

## UI integration seam

`scripts/native-api-install.mjs` exports two production functions with these
exact first arguments; UI tests may inject dependencies but must not treat
those mocks as production API acceptance.

```js
const status = await getExecutorStatus({ settings, profileId });
// { installed, runtimeCompatible, restartRequired, gatewayRunning,
//   localHealthy, credentialAvailable, apiVerified: false, detail }

const applied = await applyApiConfiguration({ settings, expectedSha256 });
```

`getExecutorStatus` is read-only. It does not ensure/start the gateway, call a
model, download a runtime, or mutate settings. `gatewayRunning` and
`localHealthy` are local Task/health observations; `localHealthy` does not
prove provider authentication or model output. `apiVerified` stays `false`
until a separate real probe exists. When artifacts are installed,
`restartRequired` is `"unknown"`: a newly applied role needs a full restart,
but this backend has no reliable observation that the running application has
adopted it. Do not turn that unknown into a permanent “must restart” banner or
edit a journal to manufacture an accepted state.
The lower-level `status()` result uses the same `restartNeeded: "unknown"`
semantics for an active journal.

`applyApiConfiguration` is the explicit Apply-button path. It verifies that
the supplied settings were already saved (and the optional `expectedSha256`
still matches), requires an already staged compatible runtime, then applies
the owned role/catalog/provider/Task transaction for the saved profiles. It
does not download or replace the runtime, change the root Sol connection,
restart the application, or call a model. Its successful apply result reports
`restartRequired: true` for a newly applied role; a later status read reports
adoption as `"unknown"` because the application-restart observation is not
available.

Saving JSON never installs by itself. With the 6ec/old-patch runtime,
`runtimeCompatible` is `false` and Apply fails as unsupported rather than
claiming a ready generic API executor.

## Dispatch gate and child binding

`native-agent.mjs` accepts a profile ID or alias only after
`ensureNativeApiDispatch` verifies all of the following:

1. the approved runtime patch hash and staged runtime files;
2. the active API journal and its authoritative source bundle;
3. the immutable profile still matches its installed model/context definition;
4. a usable credential reference (the value is resolved in memory only);
5. the exact owned role and single-model catalog bytes;
6. the owned provider block and loopback URLs, with no root provider/API
   circular reference;
7. the independently owned Task is registered, enabled, and, for a spawn,
   `Running`;
8. live health reports `api_only=true` and `relay_allowed=false` with the
   expected PID.

Any mismatch fails closed. There is no fallback to Luna, DeepSeek, another API,
or the Sol root connection. The API spawn result uses
`agent_type=native_api_<24hex>`, `provider_id=api-native-<24hex>`, the exact
resolved model, and `fork_turns: "none"`; it sends no conflicting `model`
override.

New child state stores an immutable `{executor, profileId, model, role,
providerId}` binding. A follow-up or cold recovery reads that binding rather
than the latest global settings plan. The parent, profile ID, role, provider,
and model cannot be changed on an existing child. Luna/DeepSeek explicit or
sticky choices retain their existing precedence.

## Credentials and protocol limits

`env` and `file` credentials are references; `dsh_account` is allowed only for
the known official DeepSeek origin with the Responses protocol. The verified
acceptance path is the existing default `https://api.deepseek.com` →
`/responses`; a `/v1` account profile may remain loadable for compatibility,
but a known origin does not prove that path works. Local credential status is
not authentication proof. Credential values
are never written to settings, journals, config, roles, catalogs, argv,
prompts, logs, or public receipts. Existing account/manual-key precedence in
the DeepSeek path is unchanged, and no third-party probe is performed.

For official DeepSeek API profiles (account or manual env/file credentials),
reasoning is limited to the documented `none/low/high/max` levels. The
[official Responses API](https://api-docs.deepseek.com/api/create-response/)
and [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
list these effort values, and the
[thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode/)
states that `none` disables thinking while `xhigh` maps to `high` and `max` is
preserved. The API adapter therefore maps a requested `xhigh` to `high`,
preserves a valid `max`, and passes `none` through without inventing an
`off` value. Other API profiles retain their declared effort levels. The
historical DeepSeek gateway effort folding is a separate path and is not reused
for generic roles.

The profile's `reasoning.parameter` selects how an adapter expresses effort;
it is not a promise about whether a provider thinks. `parameter: "none"` sends
no reasoning field at all and leaves the provider default in effect. In
particular, official MiMo Chat defaults to thinking enabled, so a
`parameter: "none"` profile can still return `reasoning_content`. Turning
DeepSeek thinking off is the separate combination of
`parameter: "reasoning_effort"` (or `"reasoning"`) with `effort: "none"`.

The current official DeepSeek wire models (`deepseek-flash`,
`deepseek-v4-pro`) and the verified MiMo Chat models (`mimo-v2.5`,
`mimo-v2.5-pro`) return `reasoning_content` next to assistant content or tool
calls. The
[MiMo reasoning_content guide](https://platform.xiaomimimo.com/docs/en-US/usage-guide/passing-back-reasoning_content)
and [Chat compatibility page](https://platform.xiaomimimo.com/docs/api/chat/openai-api)
document the pass-back rule. While a request carries tools, the Chat adapter maps
every previously adapter-produced `reasoning_content` back onto the matching
assistant message, including assistant turns without tool calls. The
provenance marker lives in the Responses reasoning item id
(`rs_deepseek_...` / `rs_mimo_...`), so unrelated reasoning items or summaries
are never translated into vendor reasoning. The marker is stored in the Codex
rollout; a resumed process replays it. Opaque encrypted reasoning fails
explicitly, and unknown Chat vendors receive no guessed `reasoning_content`
field. Profile configuration is not limited to these known models; only the
documented models receive the vendor replay. Other or newer model names are
left to their declared vendor behavior; the adapter does not guess.

MiMo also offers a
[Responses endpoint](https://mimo.mi.com/docs/en-US/api/chat/responses).
Prefer it when available; the Chat path
above remains a supported adapter path and its documented pass-back
requirement is covered by the loopback smoke.

For a profile identified as the official DeepSeek Responses endpoint
(`https://api.deepseek.com`, model `deepseek-flash` or `deepseek-v4-pro`), the
gateway applies a narrow compatibility normalization before forwarding. It
keeps the exact model
and the documented `none/low/high/max` efforts, maps a requested `xhigh` to
`high`, and removes Codex-only or unsupported transport fields:
`store: false`, `include: ["reasoning.encrypted_content"]`, `client_metadata`,
`prompt_cache_key`, empty `metadata`, null `service_tier` / `stream_options` /
`access_programs`, and `reasoning.summary`. It fails closed when a
non-default value would lose real state or would include encrypted history:
`store: true`, non-empty `metadata`, `previous_response_id`, `conversation`,
`background: true`, non-null `service_tier`, non-empty `stream_options`,
non-empty `access_programs`, unsupported `include` entries, or any non-empty
`encrypted_content` in input. The official compatibility table currently says
unsupported parameters are silently ignored; the adapter still removes them so
the forwarded shape is the documented one. Unknown Responses vendors remain
unchanged. End-to-end use of a real DeepSeek credential still waits for the
matching runtime and a formal installation run.

These are documented wire rules. They do not prove that a real generic API
role, account credential, gateway, and model endpoint have completed
end-to-end acceptance.

Chat Completions profiles are adapted to a stateless Chat request. The first
version disables Codex built-in web search for all API children, for both
Responses and Chat Completions profiles; the gateway reports an explicit
unsupported-parameter error instead of forwarding an unavailable search tool.
Do not infer search support from the Responses wire shape. The local smoke
fixture disables web search explicitly.

## Verification and current limits

The current runtime approval hash is
`2a5d6310c76b992ef772e62410c593204b570ff20f6e8a967f43deeac42bc3e7`. Runtime
manifests built with the older `7a5c...` patch (including the installed 6ec
binary) are not accepted by the API dispatch gate. The old binary may still be
used as an adapter-level CLI smoke target, but it is not evidence that a new
native API role passed end-to-end.

The final patch is 109095 bytes. The first build run `39132413744` failed on a
test-only missing import, and its cache was saved. Run `39134187187` at head
`36d9f11ef3bbdc137215647c4ce4259b5646e558` completed as a FAILURE: the
native API suite reached eight running tests and two override/mismatch tests
passed before the none cold-resume test hit `STATUS_STACK_OVERFLOW`. The cache
step succeeded, but no release artifact was produced. Neither run is GREEN.
Run `39136590575` at head
`1155c51dcb64cd8ba3216b26639ed9b8878a3be2`, ref
`fix/native-deepseek-bounded-retries`, also completed as a FAILURE with cache
SUCCESS: eight native API tests were running, two lightweight tests passed,
and both the none cold-resume and `prepare_agent_spawn_config` tests hit
`STATUS_STACK_OVERFLOW`; no release artifact was produced. It is not GREEN.
The fourth run `39138841194` at head
`45a3bd343c4bf4fc99115e7d68ee74d685429c01` completed as a FAILURE with cache
SUCCESS: all eight native API tests ran, seven passed, and the only failure was
the none cold-resume fixture using an invalid native `task_name`
(`non-reasoning-worker`). The large-stack change resolved the earlier stack
problem; the separate correction uses `non_reasoning_worker`. No release
artifact binary was produced. The fifth and only new corrective build is run
`39140584735` at head
`51381b729d383beab91e778a6639f907e2f9ba7b`, branch
`fix/native-deepseek-bounded-retries`; at this checkpoint it was `in_progress`
and is not claimed GREEN. This is build evidence, not a local installation,
restart, or desktop API-role acceptance. No new runtime was installed in this
worktree.

The four same-source large-fixture tests now use a same-name `#[test]` wrapper
and `async_impl` through the pinned
`core_test_support::test_codex::run_test_with_large_stack` 8 MiB path. Test
bodies, the eight-test count, and assertions are unchanged. The corrected
patch also boxes the two cold-resume futures and handles the retry-role
`Feature` result with `.expect`; production remains at 16 MiB and is
unchanged.

Mocked/free tests cover artifacts, install/rollback, Task namespace, health,
gate failures, source-bundle stability, immutable state bindings, and CLI
failure without an install. Windows CI runs the lifecycle tests. Linux CI runs
the pure settings/routing/protocol/artifact tests. The real CLI adapter smoke is
opt-in:

```text
node tests/native-api-cli-smoke.mjs --binary <codex.exe> --sha256 <64-hex>
```

The binary and its SHA-256 are both required, and a mismatch fails before any
server or CLI starts. The default `all` scenarios cover an official DeepSeek
Chat tool round with `reasoning_content` replay, an official MiMo Chat
`parameter: "none"` round that still returns reasoning plus a cold resumed
process, and an official DeepSeek Responses round whose mock rejects
`store`/`include`/`metadata` and validates the normalized shape. It uses
temporary loopback servers, a fail-closed HTTP proxy, and `windowsHide: true`.
It makes no real provider request, reads no real credential, and does not
install, activate, or start a Task. The hosted workflow's opt-in step fails
rather than silently skipping when enabled without both values.

The smoke's private `CODEX_HOME` sets `web_search = "disabled"`. It therefore
proves the adapter paths with search off; it does not prove the root
`cached`/`auto` web-search inheritance case. Keeping that tool out of every API
child belongs to the runtime/provider boundary, not to this adapter smoke.

The matching runtime build `39140584735` succeeded and was reused for the
formal 0.11.1 installation (see [the 0.11.1 installation record](native-api-msix-path-fix-0.11.1-2026-10-19.md)).
New API-role end-to-end acceptance still awaits a full application restart and
a real desktop task. Paid tests remain paused under the user's Luna-only budget
instruction; this backend does not claim that UI or desktop acceptance is
complete.
