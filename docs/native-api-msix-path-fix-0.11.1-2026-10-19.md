# Native API MSIX path fix 0.11.1 (2026-10-19)

## Scope and behavior

On Windows, Node's native realpath implementation resolves the default
`%LOCALAPPDATA%\sol-luna-deepseek-router\native-api` alias into the exact
Codex MSIX package's `LocalCache\Local` tree. The default API-root resolver now
recognizes only that package layout and returns its canonical path when the
existing directory has no symlink or junction components. It uses
`realpathSync.native`, matching the downstream gateway source guard; ordinary
`realpathSync` on this host returned the nominal alias instead.

During install preparation, a nominal default `router.json` path is bound to
the canonical file only after native realpath, same-file device/inode, file
type, and settings revision SHA-256 checks succeed. The prepared journal and
Task launcher then retain the canonical settings path. Explicit custom API
roots and settings paths remain unchanged. The shared gateway source guard
continues to reject reparse traversal, and no settings file is copied or
migrated.

## Verification evidence

- `native-api-manager.test.mjs`: 9 assertions passed.
- `native-api-install.test.mjs`: 69 assertions passed, including canonical
  settings binding and rejection before identity, Task, journal, registry, or
  role writes for realpath, file-ID, and revision mismatches.
- `native-gateway-source.test.mjs`: 20 assertions passed, including rejection
  of a real junction.
- `git diff --check` passed.
- The shared `native-gateway-source.mjs` source hash remains
  `9462CF7D87C457E97D03A061EAAB37D6CBA780128DA9EABB8FB2404BCD6C6230`.
- The prior 0.11.0 formal Apply attempt stopped after creating only the owned
  gateway identity. It created no Task, registry, journal, or role. This
  record does not change that observed state or the 0.11.0 acceptance record.
- When this source-fix record was first written, formal Apply and desktop
  acceptance for 0.11.1 were pending. Formal installation was subsequently
  recorded below; the later post-restart observations are recorded in
  [Post-restart observation](#post-restart-observation).

The runtime is reused from run `39140584735`, head `51381b…`, artifact
`12144790530`, binary SHA-256
`48d1d326…`. The Rust patch SHA-256 remains
`2a5d6310c76b992ef772e62410c593204b570ff20f6e8a967f43deeac42bc3e7`. No new
runtime build was launched, and the original provenance record was not edited
to imply a new build or source commit.

## Formal installation observation

The 0.11.1 plugin installed from immutable source commit
`c9686e724966a41ce977c66e732539cf3e30afed`. All 163 release files matched the
candidate bytes, and the 95 owned standalone skill files were installed while
the four preexisting foreign files and their hashes were preserved. The
matching CI run `39153706565` completed successfully for that source commit.

The settings snapshot verified the nominal and canonical settings paths as the
same file by device/inode, and the fixed router revision is
`5f5287d6ef7ebdc021843d542a8e2d907c3d53e411cad4a37d18a4fd6dc08fd6`. The
first confirmed Apply response reported success and required an app restart.
The install journal reached `active` with its file, launcher, and Task stages
complete. Read-only checks observed one healthy hidden API Task in `Running`
state with `api_only=true` and `relay_allowed=false`; a separate Task XML
inspection found no triggers. The root model remained `gpt-6.1-sol`, with no
root model-provider override or root base URL. The only reported config changes
were the marketplace source and the owned API provider entry.

A follow-on status-collection helper accidentally invoked Apply a second time.
That invocation returned an already-exists error while writing its safe
response file, so its Apply response was not captured. Subsequent read-only
checks confirmed the same active profile and revision, a healthy gateway, and
one running API Task. This does not establish that the second Apply was
idempotent, and this record does not claim to preserve its response.

The local API gate generated spawn metadata but did not spawn a child or make a
model-interface call; at that point `apiVerified` remained false. Full
application restart and desktop acceptance were then pending; their later
observations are recorded below. Paid model tests are paused under the user's
Luna-only instruction and were not run. The later documentation commit does
not change or reinstall the pinned 0.11.1 plugin source.

## Post-restart observation

At 09:34 China Standard Time on 2026-10-19, Codex was fully exited and
restarted. Sol independently observed the old process exit and verified that
the new running binary SHA-256, `48d1d326f2567cdc602c03337674d22da4d1933e36e84d5df229a93ff5ea174b`,
matches build `39140584735`. The installed 0.11.1 source remains pinned to
`c9686e724966a41ce977c66e732539cf3e30afed`; this observation did not reinstall
or rebuild it. The root model remained `gpt-6.1-sol`, with no provider or
base-URL override, and the route remained fixed to Luna.

The formal native-agent API gate exited successfully and parsed
`native_api_b313e8db39e5df95adabdf63` as `deepseek-flash`. The gate can launch
and inspect the local API gateway, but this run did not spawn a child or make a
model API request. The registered role/catalog has the four reasoning levels
`none`, `low`, `high`, and `max`, with `high` as default, and the DSH account
references. Consequently, the gate result does not establish a successful
model-interface call; `apiVerified` remains false.

The user reported that the MCP settings card appeared, that expanding it showed
the fixed/automatic peak-valley controls and fixed/peak/valley executor
choices, and that selecting Luna then saving the route displayed success.
Sol subsequently confirmed the route JSON still reported `fixed/luna`. These
UI observations come from the user's report: the automation interface exposed
no browser tabs, and no screenshot was captured, so this is not recorded as an
automated visual UI check. The user also reported that the settings panel's
local credential check says the credential is available and that no API
request was sent. This local check does not establish upstream authentication
or a successful model request.

A real generic API-role task remains unspawned. The restart and reported UI
controls/save are partial observations only; end-to-end API acceptance remains
incomplete. No paid role test was run, in accordance with the user's Luna-only
instruction.
