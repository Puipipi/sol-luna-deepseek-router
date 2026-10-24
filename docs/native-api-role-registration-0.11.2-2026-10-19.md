# Native API role registration fix 0.11.2 (2026-10-19)

## Failure and correction

During the first real generic API dispatch attempt on the installed 0.11.1
plugin, native spawn returned `unknown agent_type`. No child was spawned and no
model API call was made. The install had generated the API role file and
provider/catalog data, but its root Codex configuration lacked the
`[agents.native_api_<profileId>]` registration and exact `config_file`. The
Node dispatch/status gate checked those artifacts without checking the root
agent registration, so it could report a false ready state.

The 0.11.2 source candidate writes the root agent registration alongside the
owned provider block and validates it in status and dispatch. An active legacy
provider-only installation remains not-ready; explicit Apply can repair its
owned registration after validating the active journal and artifacts. It
preserves unrelated roles, profiles, and the root model/provider settings.
Role-key conflict tests cover table, quoted, inline, and dotted-key forms. A
config-byte compare-and-swap check prevents the legacy repair from overwriting
a concurrent user edit.

## Evidence and limits

The focused artifact, install, and lifecycle tests cover generated role
registration, legacy Apply repair, readiness rejection, multi-profile rollback,
conflict detection, and concurrent root-config edits. A local app-server
`config/read` gate confirms the parsed response exposes the registered role and
its `config_file`; it makes no model request and does not establish host menu
discovery or successful spawn.

The 0.11.1 installation was pinned to source `c9686e724966a41ce977c66e732539cf3e30afed`.
The 0.11.2 source `19339135e2d08cd21b368bfe1620fc85528b3268` is now formally installed
as `0.11.2-1933913`. Its release contains 165 files; the canonical owned set
contains 96 files, and four foreign files were preserved. One explicit Apply
completed successfully from `2026-10-19T02:24:42.058Z` through
`2026-10-19T02:24:47.947Z` UTC and reported `restartRequired: true`. The readiness
gate exited successfully with a safe dispatch descriptor only; it spawned no
model and sent no API request. The active route remains fixed to Luna. Root
model, provider, catalog, and base URL settings were unchanged.

The existing runtime build `39140584735` and binary SHA-256
`48d1d326f2567cdc602c03337674d22da4d1933e36e84d5df229a93ff5ea174b` remain
unchanged; the native patch provenance SHA-256 remains
`2a5d6310c76b992ef772e62410c593204b570ff20f6e8a967f43deeac42bc3e7`.
The matching 48d runtime was reused; no runtime was rebuilt.

The observed backend processes all predate the Apply, so they do not establish
a post-restart host state. A full Codex restart, host role discovery, the
authorized real native API child spawn, and usage evidence remain pending. The
paid API role was not spawned, and `apiVerified` remains false. The user reported
that the settings-panel local credential check succeeded and stated that it
sent no API request. This establishes local credential availability only; it
does not establish upstream authentication or a model response. Historical
DeepSeek desktop acceptance remains separate and is not generic API acceptance.
