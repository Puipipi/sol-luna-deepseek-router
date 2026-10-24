import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeApiGateway } from "./native-api-gateway.mjs";
import { readRouterSettingsSnapshot, resolveApiCredential } from "./native-api-settings.mjs";

const STATE_VERSION = 1;

function value(argv, name) {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
}

async function readIdentity(file) {
  const identity = JSON.parse(await readFile(file, "utf8"));
  if (!identity?.token || !Number.isInteger(identity?.port) || identity.port < 1 || identity.port > 65535) {
    throw new Error("native API gateway identity is invalid");
  }
  return identity;
}

async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(temp, { force: true })).catch(() => {});
  }
}

async function main(argv) {
  if (!argv.includes("--serve") || !argv.includes("--api-only")) {
    throw new Error("usage: native-api-serve.mjs --serve --api-only --state PATH --identity PATH --log PATH [--settings PATH]");
  }
  const statePath = value(argv, "state");
  const identityPath = value(argv, "identity");
  const logPath = value(argv, "log");
  if (![statePath, identityPath, logPath].every((item) => typeof item === "string" && path.isAbsolute(item))) {
    throw new Error("--state, --identity, and --log must be absolute paths");
  }
  const settingsPath = value(argv, "settings")
    || process.env.SOL_LUNA_NATIVE_API_SETTINGS
    || path.join(path.dirname(path.dirname(identityPath)), "router.json");
  const identity = await readIdentity(identityPath);

  const log = async (level, event) => {
    try {
      await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), level, event })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // A diagnostic log failure must not take down the local service.
    }
  };
  const logger = {
    info(event) { void log("info", event); },
    error(event) { void log("error", event); },
  };

  let gateway;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await gateway?.close(); } catch { /* shutdown still exits */ }
    process.exit(0);
  };
  gateway = createNativeApiGateway({
    token: identity.token,
    health: { api_only: true, relay_allowed: false },
    onShutdown: shutdown,
    logger,
    resolveProfile: async ({ profileId }) => {
      const { settings } = await readRouterSettingsSnapshot(settingsPath);
      return settings.profiles[profileId] || null;
    },
    resolveAuth: (profile) => resolveApiCredential(profile),
  });
  gateway.server.on("error", (error) => {
    logger.error({ phase: "server_error", code: error?.code || "UNKNOWN" });
    process.exitCode = 1;
  });
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  await gateway.start(identity.port);
  await writeState(statePath, {
    version: STATE_VERSION,
    pid: process.pid,
    port: identity.port,
    token: identity.token,
    started_at: new Date().toISOString(),
    log: logPath,
    api_only: true,
    relay_allowed: false,
  });
  await log("info", { phase: "started", port: identity.port, api_only: true, relay_allowed: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(async (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
