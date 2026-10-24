# Router recovery and model routing plan

## Accepted behavior

- Keep `mode` as auto/fixed/scheduled; add backward-compatible `enabled` defaulting to true. Off wins before schedule, sticky, explicit override, native catalog lookup, and DSH start/followup. Keep settings accessible and retain history.
- Support Luna, DSH DeepSeek, `same`, exact `native:<slug>`, and saved immutable API profiles. Same resolves the active chat model from trusted thread metadata and spawns a separate `fork_turns:none` child. API provider presets only prefill existing fields; manual model entry remains available.
- Native catalog and model metadata are local read-only inputs. API model discovery is explicit user action only, bounded, redirect-safe, credential-safe, and tested only on loopback mocks.

## Work sequence

1. **Model routing/UI**: settings schema, selectors, catalog snapshot, API presets/model list, MCP caller context, same-model metadata resolution, off priority. Add red/green tests first.
2. **Upgrade/lifecycle protection**: persistent guard status and owned task lifecycle; effective-off when user disabled or guard disabled; defer stopping until gateway-backed native/DSH children terminate. Stop only journal-verified plugin-owned gateway tasks. Native/Luna routes need no gateway. Do not interrupt active work.
3. **Reconnect diagnosis**: integrate the reviewed explicit UI/MCP action; no startup polling, provider calls, body/key/full-URL logging, or assumptions that the issue occurs on every startup.
4. **Task 4 integration**: connect caller-specific model metadata, the reviewed diagnostics action, owned gateway lifecycle, and a pre-spawn gateway dispatch reservation. Update plugin source metadata/version and focused CI tests. Do not install, change user environment/services, or restart Codex.
5. **Runtime gate and Apply**: the actual native-agent CLI gate verifies owned bootstrap journals, the approved persistent runtime and compatibility receipt, then checks the current running Codex ancestor hash before API/DeepSeek dispatch. Explicit API Apply arms or reuses only an approved bootstrap under `CODEX_HOME/router-runtime/versions`; failure refuses dispatch and never silently substitutes Luna. Native Luna/same/catalog routes remain independent of this API gate. Off CAS-disarms a verified owned override; no process is killed or hot-switched.
   - Follow-up review fix: API and DeepSeek resolve only their own journal types. Apply and MCP settings mutations/off cleanup serialize through `CODEX_HOME/router-runtime/maintenance.lock`; Apply rechecks saved settings in-lock. Reused bootstrap always preserves the top-level restart requirement.
6. **Packaging and final acceptance**: the Windows ZIP packager, exact manifest SHA list and archive verification are implemented. Rebuild the package from the final reviewed clean commit, inspect the ZIP inventory, run the focused mock suites, and report desktop/restart/API acceptance separately. No real API request or install is part of this source task.

## Upgrade override maintenance plan (not applied)

The router JSON `enabled` value is the sole user-off marker. Do not write or clear `upgrade-status.json` to represent user intent: that file belongs to the C upgrade guard, and its fault-disabled state must remain intact. When turning off, a generic API journal takes precedence; only a true missing generic journal allows fallback to a legacy isolated-install journal. Each path authorizes compare-before-set removal of only its exact owned `CODEX_CLI_PATH`; preserve any changed/manual path and never restore an old WindowsApps path. Do not kill or hot-switch the running process; the next launch resolves the official app. API/DeepSeek dispatch requires that the actual running CLI image match an approved receipt. Re-enabling native-only routing needs no shim; API remains unavailable until explicit Apply has an approved artifact/receipt.

## Verification boundary

Use temporary `CODEX_HOME`, `LOCALAPPDATA`, SQLite fixtures, Task Scheduler fakes, gateway fakes, and loopback HTTP. Prove caller-thread isolation, disabled precedence/no-spawn, journal/task ownership, active-child deferral, and exact API discovery behavior. No real DeepSeek/OpenAI requests, no system settings/service changes, and no installation in this task.
