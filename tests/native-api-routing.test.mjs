import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decideRoute } from "../scripts/route.mjs";
import { resolveNativeAgent } from "../scripts/native-agent.mjs";
import { createApiProfile, createDefaultRouterSettings } from "../scripts/native-api-settings.mjs";
import { buildNotification, isChildExecutor, notificationKey } from "../scripts/route-hook.mjs";

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function ok(actual, message) { assert.ok(actual, message); checks += 1; }

const profile = createApiProfile({
  protocol: "responses",
  baseUrl: "https://api.mimo.example/v1",
  model: "mimo-v2-pro",
  reasoning: { supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort" },
  credential: { type: "env", name: "MIMO_API_KEY" },
}, { label: "MiMo", aliases: ["mimo"] });

const fixed = {
  schemaVersion: 1,
  mode: "fixed",
  fixedExecutor: profile.profileId,
  profiles: { [profile.profileId]: profile },
};
const scheduled = {
  schemaVersion: 1,
  mode: "scheduled",
  fixedExecutor: null,
  schedule: { peak: profile.profileId, valley: "deepseek" },
  profiles: { [profile.profileId]: profile },
};

const defaultRoute = await decideRoute({ at: "2026-10-19T10:00:00+08:00" });
equal(defaultRoute.executor, "luna", "no API settings keeps the existing peak-Luna default");

const fixedRoute = await decideRoute({ at: "2026-10-17T10:00:00+08:00", routerSettings: fixed });
equal(fixedRoute.executor, "api", "fixed API profile routes as native API executor");
equal(fixedRoute.profileId, profile.profileId, "route binds the immutable profile ID");
equal(fixedRoute.phase, "fixed", "fixed profile does not resolve a calendar slot");
equal(fixedRoute.native_spawn.agent_type, `native_api_${profile.profileId}`, "route selects generated profile role");
equal(fixedRoute.native_spawn.provider_id, `api-native-${profile.profileId}`, "route identifies generated provider");
equal(fixedRoute.native_spawn.resolved_model, profile.model, "route records the exact profile model");
equal(fixedRoute.native_spawn.fork_turns, "none", "API child does not inherit parent turns");
equal(Object.hasOwn(fixedRoute.native_spawn, "model"), false, "API model comes from its generated native role");

const peak = await decideRoute({ at: "2026-10-19T10:00:00+08:00", routerSettings: scheduled });
equal(peak.executor, "api", "explicit schedule can route peak to an API profile");
equal(peak.phase, "peak", "API peak follows the established calendar");
const valley = await decideRoute({ at: "2026-10-19T12:00:00+08:00", routerSettings: scheduled });
equal(valley.executor, "deepseek", "API peak does not disable DeepSeek valley");
equal(valley.phase, "valley", "mixed schedule preserves valley phase");
equal(valley.native_spawn.agent_type, "native_deepseek", "DeepSeek valley keeps the isolated DS role");
const candidatePeak = await decideRoute({ at: "2027-10-04T10:00:00+08:00", routerSettings: scheduled });
equal(candidatePeak.phase, "unknown", "missing future holiday calendar stays explicitly unknown");
equal(candidatePeak.source, "calendar_missing", "candidate peak records missing-calendar source");
equal(candidatePeak.executor, "api", "unknown candidate peak conservatively uses configured peak slot");
equal(candidatePeak.profileId, profile.profileId, "unknown phase never silently selects the valley profile");

const secondProfile = createApiProfile({
  protocol: "chat_completions",
  baseUrl: "https://api.other.example/v1",
  model: "other-model",
  reasoning: { supported: ["none"], default: "none", parameter: "none" },
  credential: { type: "env", name: "OTHER_API_KEY" },
}, { label: "Other" });
const apiToApi = { ...scheduled, schedule: { peak: profile.profileId, valley: secondProfile.profileId }, profiles: {
  [profile.profileId]: profile, [secondProfile.profileId]: secondProfile,
} };
const secondApiSlot = await decideRoute({ at: "2026-10-19T12:00:00+08:00", routerSettings: apiToApi });
equal(secondApiSlot.executor, "api", "both scheduled slots may be API profiles");
equal(secondApiSlot.profileId, secondProfile.profileId, "valley can select a distinct API profile");

const stateDir = await mkdtemp(path.join(os.tmpdir(), "native-api-route-state-"));
try {
  await decideRoute({ at: "2026-10-19T12:00:00+08:00", routerSettings: scheduled,
    setSessionExecutor: profile.profileId, sessionId: "api-session", stateDir });
  const sticky = await decideRoute({ at: "2026-10-19T12:00:00+08:00", routerSettings: scheduled,
    sessionId: "api-session", stateDir });
  equal(sticky.executor, "api", "sticky API selection takes precedence over the scheduled slot");
  equal(sticky.profileId, profile.profileId, "sticky route retains the exact profile");
  equal(sticky.source, "session_override", "sticky route is identified as explicit");
  const oneTime = await decideRoute({ at: "2026-10-19T12:00:00+08:00", routerSettings: scheduled,
    executor: "luna", sessionId: "api-session", stateDir });
  equal(oneTime.executor, "luna", "one-time executor outranks sticky API selection");
  equal(oneTime.source, "one_time_override", "one-time choice remains explicit");
  await assert.rejects(() => decideRoute({ routerSettings: scheduled, executor: "missing-profile" }), /configured API profile/);
  checks += 1;
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

const agent = resolveNativeAgent({ executor: profile.profileId, apiProfiles: fixed.profiles });
equal(agent.executor, "api", "native-agent resolves a configured API profile");
equal(agent.agent_type, `native_api_${profile.profileId}`, "native-agent selects the profile-specific role");
equal(agent.provider_id, `api-native-${profile.profileId}`, "native-agent preserves the profile-specific provider");
equal(agent.resolved_model, profile.model, "native-agent resolves the exact wire model");
equal(agent.fork_turns, "none", "native-agent API child has no inherited turns");
equal(Object.hasOwn(agent, "model"), false, "native-agent leaves model selection to the role config");
assert.throws(() => resolveNativeAgent({ executor: profile.profileId, apiProfiles: {} }), /unknown API profile/);
checks += 1;
const otherRoute = { phase: "peak", executor: "api", profileId: secondProfile.profileId, profileLabel: "Other", source: "schedule", reason: "peak" };
const firstRoute = { ...otherRoute, profileId: profile.profileId, profileLabel: "MiMo" };
equal(notificationKey(firstRoute) === notificationKey(otherRoute), false, "hook notice dedup tracks the selected API profile");
const apiNotice = buildNotification(firstRoute, new Date("2026-10-19T02:00:00Z"));
ok(apiNotice.includes("MiMo"), "hook notice names the selected API profile");
equal(apiNotice.includes("MIMO_API_KEY"), false, "hook notice never exposes credential references");
equal(isChildExecutor({ agent_type: `native_api_${profile.profileId}` }), true, "hook suppresses profile-specific native API child turns");

const withoutApi = createDefaultRouterSettings();
equal((await decideRoute({ at: "2026-10-19T12:00:00+08:00", routerSettings: withoutApi })).executor,
  "deepseek", "empty v1 settings preserve the default valley route");

console.log(`PASS native API routing assertions: ${checks}`);
