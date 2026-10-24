import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDeepSeekAuth } from "./native-credentials.mjs";
import { withFileLock, writeJsonAtomic } from "./plugin-state.mjs";

const PROFILE_ID = /^[a-f0-9]{24}$/;
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const DEEPSEEK_ACCOUNT_EFFORTS = new Set(["none", "low", "high", "max"]);
const DEEPSEEK_WIRE_MODELS = new Set(["deepseek-flash", "deepseek-v4-pro"]);
const PROFILE_FIELDS = new Set(["profileId", "protocol", "baseUrl", "model", "reasoning", "credential", "label", "aliases", "contextWindow"]);
const ROOT_FIELDS = new Set(["schemaVersion", "enabled", "mode", "fixedExecutor", "schedule", "profiles"]);
const SELECTORS = new Set(["luna", "deepseek", "same"]);

export function defaultRouterSettingsPath(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "sol-luna-deepseek-router", "native-api", "router.json");
}

export function createDefaultRouterSettings() {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "auto",
    fixedExecutor: null,
    schedule: { peak: "luna", valley: "deepseek" },
    profiles: {},
  };
}

export function effectiveRouterEnabled(settings, guardStatus = null) {
  return settings?.enabled !== false && guardStatus?.state !== 'disabled';
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

function canonicalProfile(profile) {
  return {
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    reasoning: profile.reasoning,
    credential: profile.credential,
    ...(profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow }),
  };
}

export function profileIdForDefinition(profile) {
  return createHash("sha256").update(JSON.stringify(sorted(canonicalProfile(profile))), "utf8").digest("hex").slice(0, 24);
}

export function createApiProfile(definition, { label, aliases } = {}) {
  const profile = { ...definition };
  if (label !== undefined) profile.label = label;
  if (aliases !== undefined) profile.aliases = aliases;
  const profileId = profileIdForDefinition(profile);
  return validateProfile({ ...profile, profileId }, profileId);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field`);
}

function validateCredential(credential, baseUrl, protocol) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) throw new Error("profile credential must be an object");
  if (credential.type === "env") {
    exactKeys(credential, new Set(["type", "name"]), "credential");
    if (typeof credential.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential.name)) throw new Error("credential.name must be an environment variable name");
  } else if (credential.type === "file") {
    exactKeys(credential, new Set(["type", "path"]), "credential");
    if (typeof credential.path !== "string" || !path.isAbsolute(credential.path) || credential.path.trim() !== credential.path) throw new Error("credential.path must be an absolute local file reference");
  } else if (credential.type === "dsh_account") {
    exactKeys(credential, new Set(["type"]), "credential");
    const url = new URL(baseUrl);
    if (url.origin !== "https://api.deepseek.com" || protocol !== "responses") {
      throw new Error("dsh_account is restricted to the official DeepSeek origin and Responses protocol; only the default path is verified");
    }
  } else {
    throw new Error("profile credential type must be env, file, or dsh_account");
  }
}

export function isOfficialDeepSeekProfile(profile) {
  if (!profile || typeof profile.baseUrl !== "string" || !DEEPSEEK_WIRE_MODELS.has(profile.model)) return false;
  try {
    return new URL(profile.baseUrl).origin === "https://api.deepseek.com";
  } catch {
    return false;
  }
}

function validateProfile(profile, key) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("API profile must be an object");
  exactKeys(profile, PROFILE_FIELDS, "API profile");
  if (profile.profileId !== key || !PROFILE_ID.test(key)) throw new Error("profileId does not match definition");
  if (!new Set(["responses", "chat_completions"]).has(profile.protocol)) throw new Error("profile protocol must be responses or chat_completions");
  if (typeof profile.baseUrl !== "string" || !profile.baseUrl.trim() || profile.baseUrl.trim() !== profile.baseUrl) throw new Error("profile baseUrl is required");
  let url;
  try { url = new URL(profile.baseUrl); } catch { throw new Error("profile baseUrl must be a valid URL"); }
  if (!new Set(["https:", "http:"]).has(url.protocol) || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("profile baseUrl must use HTTPS (HTTP is allowed only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("profile baseUrl must not contain credentials, query, or fragment");
  if (typeof profile.model !== "string" || !profile.model.trim() || profile.model.trim() !== profile.model) throw new Error("profile model must be a non-empty exact wire model");
  const reasoning = profile.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) throw new Error("profile reasoning must be an object");
  exactKeys(reasoning, new Set(["supported", "default", "parameter"]), "reasoning");
  if (!Array.isArray(reasoning.supported) || reasoning.supported.length === 0
      || reasoning.supported.some((effort) => !REASONING_EFFORTS.has(effort))
      || new Set(reasoning.supported).size !== reasoning.supported.length) {
    throw new Error("reasoning.supported must contain unique supported effort names");
  }
  if (!reasoning.supported.includes(reasoning.default)) throw new Error("reasoning.default must be in reasoning.supported");
  if (!new Set(["none", "reasoning_effort", "reasoning"]).has(reasoning.parameter)) throw new Error("reasoning.parameter is invalid");
  validateCredential(profile.credential, profile.baseUrl, profile.protocol);
  if ((profile.credential.type === "dsh_account" || isOfficialDeepSeekProfile(profile))
      && reasoning.supported.some((effort) => !DEEPSEEK_ACCOUNT_EFFORTS.has(effort))) {
    throw new Error("official DeepSeek API profiles support only none, low, high, and max reasoning; xhigh is normalized to high by the API adapter");
  }
  if (profile.contextWindow !== undefined
      && (!Number.isSafeInteger(profile.contextWindow) || profile.contextWindow < 1_024 || profile.contextWindow > 2_000_000)) {
    throw new Error("contextWindow must be an integer from 1024 to 2000000");
  }
  if (profile.label !== undefined && (typeof profile.label !== "string" || !profile.label.trim())) throw new Error("profile label must be non-empty text");
  if (profile.aliases !== undefined && (!Array.isArray(profile.aliases)
      || profile.aliases.some((alias) => typeof alias !== "string" || !alias.trim())
      || new Set(profile.aliases).size !== profile.aliases.length)) throw new Error("profile aliases must be unique non-empty strings");
  if (profileIdForDefinition(profile) !== key) throw new Error("profileId does not match canonical definition");
  return profile;
}

function validateSelector(selector, profiles, label) {
  if (typeof selector !== "string" || !selector) throw new Error(`${label} selector is required`);
  if (SELECTORS.has(selector)) return selector;
  if (/^native:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selector)) return selector;
  if (!PROFILE_ID.test(selector) || !profiles[selector]) throw new Error(`${label} references an unknown executor profile`);
  return selector;
}

export function validateRouterSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("router settings must be an object");
  exactKeys(settings, ROOT_FIELDS, "router settings");
  if (settings.schemaVersion !== 1) throw new Error("router settings schemaVersion must be 1");
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error("router settings enabled must be a boolean");
  if (!new Set(["auto", "fixed", "scheduled"]).has(settings.mode)) throw new Error("router settings mode must be auto, fixed, or scheduled");
  const profiles = settings.profiles ?? {};
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new Error("router settings profiles must be an object");
  for (const [id, profile] of Object.entries(profiles)) validateProfile(profile, id);
  let fixedExecutor = null;
  let schedule = { peak: "luna", valley: "deepseek" };
  if (settings.mode === "fixed") {
    fixedExecutor = settings.fixedExecutor;
    validateSelector(fixedExecutor, profiles, "fixedExecutor");
  }
  if (settings.mode === "scheduled") {
    schedule = settings.schedule;
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) throw new Error("scheduled mode requires peak and valley selectors");
    exactKeys(schedule, new Set(["peak", "valley"]), "schedule");
    schedule = {
      peak: validateSelector(schedule.peak, profiles, "schedule.peak"),
      valley: validateSelector(schedule.valley, profiles, "schedule.valley"),
    };
  }
  const aliases = new Set();
  for (const profile of Object.values(profiles)) for (const alias of profile.aliases || []) {
    if (SELECTORS.has(alias) || /^native:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(alias)) {
      throw new Error("API profile alias conflicts with a built-in native executor selector");
    }
    if (aliases.has(alias)) throw new Error("ambiguous profile alias");
    aliases.add(alias);
  }
  return { schemaVersion: 1, enabled: settings.enabled ?? true, mode: settings.mode, fixedExecutor, schedule, profiles };
}

async function requireRegularOrAbsent(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("router settings path must be a regular file");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function loadRouterSettings(file = defaultRouterSettingsPath()) {
  return (await readRouterSettingsSnapshot(file)).settings;
}

export async function readRouterSettingsSnapshot(file = defaultRouterSettingsPath()) {
  if (!await requireRegularOrAbsent(file)) return { settings: createDefaultRouterSettings(), sha256: null };
  const bytes = await readFile(file);
  let settings;
  try { settings = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("router settings JSON is invalid; refusing to change the active plan"); }
  return {
    settings: validateRouterSettings(settings),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function saveRouterSettings(file, settings, { expectedSha256 } = {}) {
  const validated = validateRouterSettings(settings);
  const lock = `${file}.lock`;
  return withFileLock(lock, async () => {
    const exists = await requireRegularOrAbsent(file);
    let current = null;
    let currentHash = null;
    if (exists) {
      const bytes = await readFile(file);
      currentHash = createHash("sha256").update(bytes).digest("hex");
      try { current = validateRouterSettings(JSON.parse(bytes.toString("utf8"))); }
      catch { throw new Error("existing router settings are invalid; refusing to replace them"); }
      if (expectedSha256 === undefined) throw new Error("expectedSha256 is required to update existing router settings");
      if (expectedSha256 !== currentHash) throw new Error("router settings changed since they were read; reload before updating");
      for (const [id, oldProfile] of Object.entries(current.profiles)) {
        const nextProfile = validated.profiles[id];
        if (!nextProfile) throw new Error("profiles are immutable and cannot be removed");
        const oldDefinition = JSON.stringify(sorted(canonicalProfile(oldProfile)));
        const nextDefinition = JSON.stringify(sorted(canonicalProfile(nextProfile)));
        if (oldDefinition !== nextDefinition) throw new Error("profile ID collision or immutable profile mutation");
      }
    } else if (expectedSha256 !== undefined && expectedSha256 !== null) {
      throw new Error("router settings were removed since they were read; reload before updating");
    }
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    await writeJsonAtomic(file, validated);
    return {
      settings: validated,
      previousSha256: currentHash,
      sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    };
  });
}

export async function resolveApiCredential(profile, {
  env = process.env,
  readSecretFile = (file) => readFile(file, "utf8"),
  resolveDeepSeekAuth: resolveAccount = resolveDeepSeekAuth,
} = {}) {
  const valid = validateProfile(profile, profile?.profileId);
  const credential = valid.credential;
  if (credential.type === "env") {
    const value = env[credential.name];
    if (typeof value !== "string" || !value.trim()) throw new Error("API credential is unavailable");
    return { headers: { authorization: `Bearer ${value}` } };
  }
  if (credential.type === "file") {
    let value;
    try { value = await readSecretFile(credential.path); } catch { throw new Error("API credential is unavailable"); }
    if (typeof value !== "string" || !value.trim()) throw new Error("API credential is unavailable");
    return { headers: { authorization: `Bearer ${value.trim()}` } };
  }
  let auth;
  try { auth = await resolveAccount(); } catch { throw new Error("DeepSeek account grant is unavailable"); }
  if (auth?.mode !== "account" || !auth.headers || typeof auth.headers !== "object") throw new Error("DeepSeek account grant is unavailable");
  return { headers: { ...auth.headers } };
}
