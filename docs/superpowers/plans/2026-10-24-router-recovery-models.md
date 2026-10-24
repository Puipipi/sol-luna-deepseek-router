# Router Recovery and Model Selection Implementation Plan

> **For agentic workers:** Use the approved task owners and existing repository conventions. Every behavior change follows test-first red/green cycles.

**Goal:** Add a global routing disable switch, native model selection, and safe custom API provider presets/discovery while preserving existing routing and profile identity.

**Architecture:** Extend the current validated router settings and selector pipeline. Read native model options from the local Codex catalog and expose them through read-only MCP surfaces. Keep provider presets as UI defaults over existing immutable API profiles; isolate model discovery behind an explicit local/mockable request boundary.

**Tech Stack:** Node.js ESM, built-in `node:test`/assert-style scripts, MCP App self-contained HTML, local Codex `models_cache.json`, existing API gateway/profile and credential resolver.

**Spec:** `docs/superpowers/specs/2026-10-24-router-recovery-models-design.md`

## Global Constraints

- No new dependencies or version change in this work.
- No real OpenAI or DeepSeek API calls; provider model discovery uses a local mock server.
- Existing `luna`, `deepseek`, API profile IDs, aliases, credential references, and immutable child bindings remain valid.
- `enabled:false` wins over every route override and returns no native spawn; it never silently falls back.
- Same-model child dispatch uses the actual current chat model and `fork_turns:"none"`.
- Native model selection validates the exact slug against the current local Codex catalog.
- Never persist, log, or return credential values.

---

### Task 1: Settings, native routing, MCP/UI and API connection presets

**Files:**
- Modify: `scripts/native-api-settings.mjs`, `scripts/route.mjs`, `scripts/native-agent.mjs`, `scripts/route-hook.mjs`, `scripts/router-settings-mcp.mjs`, `scripts/native-api-protocol.mjs`, `scripts/native-credentials.mjs`, `scripts/plugin-mcp.mjs`, `ui/router-settings.html`, canonical `SKILL.md`, and routing/API focused tests.
- Create: `docs/superpowers/specs/2026-10-24-router-recovery-models-design.md`, `docs/superpowers/plans/2026-10-24-router-recovery-models.md`, `.superpowers/sdd/router-recovery-models/progress.md`.

**Interfaces:** Settings snapshots expose `enabled` and native model choices; selectors accept `same`, exact `native:<slug>`, existing built-ins, and profile selectors. A read-only model-list operation returns safe `{slug,label,reasoningEfforts}` metadata. Explicit API discovery accepts a saved profile identity and returns model IDs only.

- [x] Write failing behavior tests for off priority, same/native exact resolution, backward settings compatibility, model catalog lists, preset application, and mocked model discovery/redirect/error handling.
- [x] Run those focused tests and record the expected failures before production edits.
- [x] Implement the smallest production changes across settings, route, hook/native child guard, MCP, and UI.
- [x] Run focused regression tests with isolated `LOCALAPPDATA`; record red/green outcomes and inspect credential-safe outputs.
- [ ] Commit only Task 1 files.

### Task 2: Idle background lifecycle shutdown

**Files:** Own lifecycle manager/autostart/gateway stop seams and lifecycle tests; consume the Task 1 `enabled` setting/guard.

**Interfaces:** Settings changes to disabled prevent new startup and stop owned idle services; running work is not interrupted. Re-enable resumes only through explicit lifecycle policy.

- [ ] Write lifecycle tests proving disabled state prevents new background starts and shuts down owned idle services.
- [ ] Run tests red; implement the lifecycle guard and owned stop behavior.
- [ ] Run lifecycle and routing regressions; commit the Task 2 change separately.

### Task 3: Reconnect diagnostics

**Files:** Own reconnect/status diagnostics and their focused tests/UI details.

**Interfaces:** Report configured state separately from active connection/readiness; expose actionable local diagnostics without credentials or provider calls.

- [ ] Write mock/local tests for connected, disconnected, stale, and error states.
- [ ] Implement read-only diagnosis; preserve explicit apply/restart boundaries.
- [ ] Run diagnostics tests; commit the Task 3 change separately.

### Task 4: Integrated verification and installation

**Files:** Own integration validation/evidence and explicitly authorized installation artifacts only.

**Interfaces:** Combine Task 1-3 behavior with existing install/apply lifecycle. Never send a real provider request during mock verification.

- [ ] Run the full relevant local test suite with isolated user settings and capture command/exit evidence.
- [ ] Check exact source diff, settings migration, disabled precedence, child identity, and secret-safe outputs.
- [ ] Follow the established installation/apply/restart path only after local integration passes; record runtime state separately from mocked evidence.
- [ ] Commit evidence/installation changes separately from implementation commits.
