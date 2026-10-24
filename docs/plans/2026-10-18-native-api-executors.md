# Native API executors and explicit mixed schedule

## Goal and boundaries

Add user-configured OpenAI-compatible API child executors (for example MiMo) without changing the Sol conversation or its provider connection. The default remains peak Luna / valley DeepSeek. A manually selected non-DeepSeek API uses fixed mode unless the user explicitly selects a mixed schedule. Existing children keep their original executor/profile. A selected executor failure is surfaced; it never silently falls back to Luna, DeepSeek, or another API.

This spec covers plugin-owned settings, profile validation, routing and lifecycle seams. The Rust role loader and protocol transport require the separately assigned generic-role/API work. Do not add another scheduler, agent loop, public relay, secret vault, or UI platform.

## Locked settings interface

Store settings at `${LOCALAPPDATA}/sol-luna-deepseek-router/native-api/router.json`. Do not add an unknown namespace to Codex `config.toml`. Keep existing DeepSeek-owned tables and ownership/removal rules unchanged. Root-level Sol model, provider, base URL, and catalog are outside this file and must remain unchanged.

The v1 JSON shape is the interface shared by settings, route, native-agent, role generation, and installer:

```json
{
  "schemaVersion": 1,
  "mode": "auto",
  "fixedExecutor": null,
  "schedule": { "peak": "luna", "valley": "deepseek" },
  "profiles": {
    "<24-lowercase-hex-profile-id>": {
      "profileId": "<same-id>",
      "protocol": "responses",
      "baseUrl": "https://api.example.invalid/v1",
      "model": "exact-wire-model",
      "reasoning": { "supported": ["low", "medium"], "default": "medium", "parameter": "reasoning_effort" },
      "credential": { "type": "env", "name": "MIMO_API_KEY" },
      "label": "MiMo",
      "aliases": ["mimo"]
    }
  }
}
```

`mode` is `auto`, `fixed`, or `scheduled`. `protocol` is `responses` or `chat_completions`; `reasoning.parameter` is `none`, `reasoning_effort`, or `reasoning`. `credential` is exactly one of `{ "type": "env", "name": "..." }`, `{ "type": "file", "path": "..." }`, or `{ "type": "dsh_account" }`. `label` and `aliases` are optional human-facing metadata, never executor IDs.

`auto` ignores `fixedExecutor` and uses the existing peak-Luna / valley-DeepSeek behavior. `fixed` requires one valid `fixedExecutor` and does not consult the clock. `scheduled` requires both `schedule.peak` and `schedule.valley`; each selector is `luna`, `deepseek`, or a profile ID. API selectors must resolve in `profiles`. Single non-DeepSeek API selection defaults to `fixed`; `scheduled` is explicit opt-in and uses the existing DS calendar even when peak is an API profile and valley is DeepSeek. Do not infer a schedule from API price or branding.

Compute `profileId` as the first 24 lowercase hex characters of SHA-256 over canonical JSON for `{protocol,baseUrl,model,reasoning,credential}` (sorted object keys, normalized UTF-8, no insignificant whitespace); exclude `profileId`, `label`, and `aliases`. Reject a collision if two distinct canonical definitions have the same ID. After activation, a definition is immutable; edits create a new profile ID. Generate identifiers `native_api_<profileId>`, `api-native-<profileId>`, and `sol-luna-native-models-<profileId>.json`. The generated role contains only exact model/reasoning settings and retry disabled. Keep old profile files/catalog entries while any child may need continuation or cold recovery.

The `dsh_account` credential form is allowed only for the official DeepSeek origin and an explicitly granted account; never send an account token to a third-party origin. Other credentials are references to a process environment variable or local key file. Validate presence without printing or serializing the value. Never put a credential in config, role/catalog, journal, command arguments, child prompt, notification, error, test output, or public receipt.

The settings module exposes reusable `readRouterSettingsSnapshot` (`settings` and the SHA-256 revision from one byte read), `loadRouterSettings`, `saveRouterSettings`, and `createApiProfile` operations. A separate UI integration should expose read/update settings tools through the documented `capabilities.experimental["openai/settings"]` metadata and attach its clickable UI resource with tool `_meta.ui.resourceUri` and `openai/ui.entrypoints`. UI code must use the snapshot revision for compare-and-swap updates and call the same validation, immutable-profile, locking, and CAS path. The current Security plugin's local manifest does not declare that settings UI; its presence there is not evidence that the host lacks this documented extension. This plan implements the backend only; the UI worker owns the MCP metadata and panel.

## Routing and child binding

Resolve executor once when starting a child, in this order: (1) explicit one-time executor, (2) sticky session executor, (3) configured plan. An API route result carries the safe profile ID, generated native role, provider ID, exact resolved model, and `fork_turns: "none"`; do not forward credentials or override the Sol root provider.

New child state binds `{executor, profileId?, model, role}`. Follow-up turns and cold recovery read that binding, not the latest global plan. Profile/plan updates affect only newly started children. One-time/sticky Luna or DeepSeek selections remain explicit and retain precedence. Missing profile, missing credential, unsupported protocol/reasoning, HTTP failure, or invalid response fails that executor; no fallback or cross-provider retry occurs.

Route/hook notices may show a profile label/ID and selected executor, but no credential reference value. Hook child suppression must recognize generated `native_api_<profileId>` roles/models so API child turns do not receive parent routing notices.

## Native API and gateway boundary

API requests use only the selected profile's protocol, base URL, exact model, reasoning mapping, and resolved credential. They do not use the Sol/OpenAI root connection, DSH account by default, DeepSeek gateway, or a shared public relay.

The API gateway is independent from the DeepSeek gateway, with separate profile-bound identity, state, health, and owned Task. `createNativeApiGateway` receives `resolveProfile({ profileId })` and `resolveAuth(profile)` dependencies; the selected profile is explicit on every request. Its local route is `http://127.0.0.1:<port>/<token>/profiles/<profileId>/v1` and its health route is `/<token>/_health`. Do not change the existing DeepSeek URL, identity, strict `deepseek_only` health, or relay policy. Reuse existing manager/Task transaction primitives; start only for a selected API profile. If protocol work proves direct native transport is sufficient, do not create a gateway just for symmetry.

## Install and compatibility

Generate API role/provider/catalog artifacts as separately owned files in the existing file transaction. Rollback removes/restores only this transaction's API files and preserves root settings, DeepSeek tables/files, foreign tables, and unrelated user settings. Existing profile artifacts remain available for children already bound to them. Keep the current runtime CLI path and plaintext-mode value when runtime binaries are unchanged.

New native role discovery is not proven hot-reloadable. Require a full Codex application restart when first adding the role/catalog; do not claim file edits update existing chats. For API-only profile changes, select the new immutable profile for new children. If the transport cannot bind a child to its original profile, stop and add the smallest explicit binding to existing child-owned state rather than resolving from mutable global settings.

## Test-first implementation steps

1. **Schema/settings:** implement default path, JSON v1 validation, canonical profile IDs, collision rejection, immutable-profile update behavior, and safe read/write. RED/GREEN tests cover defaults, each mode, selectors, protocol/reasoning validation, all credential reference variants, official-origin restriction for `dsh_account`, and prove serialized output never contains a credential value.
2. **Role/catalog and native-agent resolution:** add profile-specific role/catalog generation and `native-agent` resolution. Tests assert exact role/provider/catalog/model, `fork_turns: none`, no model override that conflicts with the generated role, and no DeepSeek dispatch gate for API roles. Preserve the existing Luna/DeepSeek behavior.
3. **Route/hook and child binding:** add route tests for default auto, fixed API without clock dependence, explicit peak-API/valley-DeepSeek schedule, calendar boundaries, override precedence, invalid profile fail-closed, and generated child suppression in hooks. Add state tests proving old child follow-up keeps its profile after the global plan changes.
4. **Profile transaction:** add the API artifacts to installer snapshots and rollback ownership. Tests cover prepare/activate failure recovery, removing an API profile without deleting old child-bound artifacts, and preservation of root, DeepSeek, and foreign configuration. No real install/environment/Task operation in unit tests.
5. **Protocol/gateway integration:** coordinate with the protocol worker's `native-api-protocol.mjs` and `native-api-gateway.mjs`. Test both protocols, credential injection in memory only, profile isolation, auth/network failure with no fallback, bounded health/start/stop, and no interaction with the DeepSeek strict gateway. Keep this as a separate owned Task using the existing lifecycle primitives.

## Acceptance criteria

- With no API profile configured, default routing remains peak Luna / valley DeepSeek.
- A manually selected non-DS API is fixed by default; explicit `scheduled` supports API peak plus DeepSeek valley on the established DS calendar.
- One-time and sticky choices take precedence. New children bind a profile; existing children keep their original profile after plan edits.
- Invalid/missing API profile or auth fails closed with no silent fallback or retry through another provider.
- API child role/provider/catalog are profile-specific. Root Sol connection and the existing DS-only gateway and strict health contract remain unchanged.
- Credential values appear only in memory at request time and never in serialized settings/artifacts, argv, prompts, logs, or receipts.
- Install/rollback preserves unrelated root/DeepSeek/foreign state and old profiles. First role installation is verified only after a full app restart; no hot reload or desktop acceptance is claimed without separate evidence.
