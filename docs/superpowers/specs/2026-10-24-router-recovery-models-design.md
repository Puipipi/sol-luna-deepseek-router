# Router Recovery and Model Selection Design

## Scope

Task 1 adds an enable/disable switch, same-model and catalog-native child selectors, a native model list for the settings panel, and API provider presets with explicitly requested model discovery. Existing automatic peak/valley, fixed, scheduled, one-time, and sticky routing remain supported.

## User decisions

- `enabled` is a global boolean defaulting to `true`. Missing values in older settings mean enabled. `false` wins over every automatic route, schedule, one-time choice, and sticky choice. Disabled routing returns an explicit disabled result with no native spawn. The settings entry remains available. It does not clear saved settings, stop an active child, or silently choose another executor.
- The existing `mode` remains `auto`, `fixed`, or `scheduled`; do not encode off/same as modes. Fixed and scheduled choices can include `same`, `native:<exact-slug>`, existing `luna`/`deepseek`, and saved API profiles/aliases.
- `same` resolves from the trusted current chat model supplied for that dispatch. It creates a separate native child with exactly that model and `fork_turns: "none"`; never infer the chat model from a static global config default.
- `native:<exact-slug>` is accepted only when the exact slug occurs in the current Codex model catalog. Missing/stale entries fail clearly and never guess a replacement.
- API presets (`OpenAI`, `OpenAI-compatible`, `DeepSeek`) only prefill the existing protocol, base URL, and credential form. They do not create new runtimes or mutate already-saved immutable profiles. DeepSeek keeps its official endpoint, Responses protocol and existing `dsh_account` restrictions.
- Users can always type an exact API model. A separate, explicit “Get model list” action may query the selected profile's `<baseUrl>/models`; no automatic discovery on open/save. Use the profile credential resolver, reject redirects before forwarding authorization, enforce a timeout, and preserve typed model input on errors. No key value may enter settings, logs, tool output, or model-list results.
- Keep the existing DSH account auto-detection and manual environment/file credential references.

## Integrated lifecycle decisions (Task 4)

- Keep `enabled` separate from `mode`; a user-off value and an upgrade-guard `disabled` status both stop new automatic dispatch. Missing guard status means unmanaged, while malformed/unreadable status fails closed. Preserve history and let existing children finish.
- On disable, inspect only persisted owned API/DeepSeek journals and matching owned Task Scheduler tasks. Defer service shutdown while a gateway-backed native child or plugin-owned DSH task is active; Luna children do not keep an unrelated gateway alive. Disable owned scheduled triggers before stopping a verified idle local gateway. Retry after terminal callbacks, not by polling. Never kill Codex or DSH.
- Re-enabling an API/DeepSeek dispatch may re-enable only its journal-matched owned task, then it must pass the existing dispatch readiness checks. Native Luna/same/catalog models do not require a gateway.
- The user-off state is stored only in the router settings `enabled` field. Disabling may CAS-clear an exact owned `CODEX_CLI_PATH`; it does not rewrite the C-owned upgrade status. A guard-reported compatibility failure remains intact. API/DeepSeek runtime readiness must be proven from the running CLI image by the next runtime-gate task; an old healthy receipt/status alone is insufficient.
- `same` uses trusted caller thread metadata from `CODEX_THREAD_ID`/`CODEX_SESSION_ID`, or a trusted per-request MCP `_meta.threadId`; resolve only the model/provider metadata columns in Codex `state_5.sqlite`. Do not read conversation turns or fall back to `config.toml`. A verified database row wins; a conflicting hook or explicit model fails.
- The disable path may remove only an exact owned CLI override from the legacy isolated-install journal after compare-before-set; a later user-selected path is preserved. Current process is not killed or hot-swapped, and the next launch resolves the official app. No live environment change is applied here.

## Boundaries and non-goals

Task 1 provides the settings, routing, UI, and lifecycle guard seams only. Task 2 owns stopping idle background lifecycle work when disabled; the change must not claim that existing background services are already stopped. Task 3 owns reconnect diagnostics. Task 4 owns integrated verification and installation. No real provider request is allowed; discovery is tested with a local mock HTTP server.

The canonical `SKILL.md` must tell Sol to do file tasks itself while disabled, with no DSH workaround. Hook events must not inject delegation instructions when disabled; a single Simplified Chinese disabled notice is sufficient. Child hooks must use trusted recorded child identity or another proven child source to suppress recursive routing. Do not suppress a main chat merely because its model slug matches a child model.

Do not introduce provider runtime machinery, a second scheduler, polling, credential storage, child interruption, historical state cleanup, or unrelated SillyTavern character/prompt features.

## Acceptance behavior

1. Disabled routing beats auto, fixed, scheduled, one-time, and sticky selectors and emits no child spawn. Re-enabling preserves the saved route.
2. `same` creates a distinct child with the exact current parent model and no inherited turns; changing the parent model changes the next resolution.
3. Native model options come from the local Codex catalog and stale/missing exact slugs fail clearly.
4. Old settings and CAS behavior remain compatible; existing peak/valley and override precedence remain unchanged when enabled.
5. MCP/UI save and reload preserve enabled state, selectors, presets, and exact model inputs.
6. Preset selection fills form defaults only. Mock model-list success and failure are observable; auth is not exposed and typed input survives failure.
7. Disabling does not erase historical settings or interrupt an already-running child. Task 2 must separately prove idle background shutdown.
