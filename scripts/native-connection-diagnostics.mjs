import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { withFileLock, writeJsonAtomic } from "./plugin-state.mjs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_ROWS = 500;
const MAX_EVENTS = 128;
const LOCK_TIMEOUT_MS = 120;
const RESPONSE_TARGET_PREFIXES = ["codex_core::responses_retry", "codex_core::client", "codex_api::endpoint::responses_websocket"];
const WINDOW_MS = 72 * 60 * 60 * 1000;
const sha = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
const ownerHash = (parentThreadId) => parentThreadId ? createHash("sha256").update(String(parentThreadId)).digest("hex") : "unbound";
const safeIso = (seconds, nanos = 0) => {
  const ms = Number(seconds) * 1000 + Math.floor(Number(nanos || 0) / 1e6);
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
};
const numericCapture = (text, patterns, max = Number.MAX_SAFE_INTEGER) => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n >= 0 && n <= max) return n;
  }
  return null;
};
function classify(text) {
  const s = text.toLowerCase();
  if (/compaction.{0,80}(retry|failed)|(?:retry|failed).{0,80}compaction/.test(s)) return "compaction_retry";
  if (/falling back to http|fallback.{0,40}http|http.{0,40}fallback/.test(s)) return "http_fallback";
  if (/payload.{0,40}too large|request body.{0,40}too large|request.{0,30}exceeds.{0,30}(?:limit|maximum)/.test(s)) return "payload_too_large";
  if (/\bhttp(?: status| code| response)?\s*[:=]?\s*5\d\d\b|\bstatus\s*[:=]\s*5\d\d\b/.test(s)) return "http_5xx";
  if (/retry(?:ing)?\s+(?:sampling|request)|sampling.{0,40}retry|retry\s+\d+\s*\/\s*\d+/.test(s)) return "sampling_retry";
  if (/websocket.{0,100}(?:closed|close)|(?:closed|close).{0,100}websocket|stream disconnected before completion/.test(s)) return "websocket_closed_before_completed";
  return null;
}
function isResponseTarget(target) {
  return RESPONSE_TARGET_PREFIXES.some((prefix) => target === prefix || target.startsWith(`${prefix}::`));
}
function makeEvent(row, parentThreadId, registeredChildThreadIds) {
  const target = typeof row.target === "string" ? row.target : "";
  if (!isResponseTarget(target)) return null;
  const raw = typeof row.event_body === "string" ? row.event_body : "";
  const text = `${target} ${raw}`;
  const errorClass = classify(text);
  if (!errorClass) return null;
  const tid = row.thread_id == null || row.thread_id === "" ? null : String(row.thread_id);
  const children = new Set(registeredChildThreadIds.map(String));
  let correlation = "other_or_unknown";
  if (tid && parentThreadId && tid === String(parentThreadId)) correlation = "parent";
  else if (tid && children.has(tid)) correlation = "registered_child";
  const process = /\bprocess_uuid\s*[:=]\s*["']?([0-9a-f-]{8,})/i.exec(raw)?.[1] ?? null;
  const retryNumber = numericCapture(text, [/\bretry(?:ing)?\s+(?:sampling|request)\D{0,12}(\d+)\s*\//i, /\bretry\s+(\d+)\s*\//i], 100);
  const httpStatus = numericCapture(text, [/\bhttp(?: status| code| response)?\s*[:=]?\s*(\d{3})\b/i, /\bstatus\s*[:=]\s*(\d{3})\b/i], 599);
  const closeCode = numericCapture(text, [/\bclose_code\s*[:=]\s*(\d{3,5})\b/i, /\b(?:websocket\s+)?close(?:d)?\s+code\s*[:=]\s*(\d{3,5})\b/i], 49999);
  const requestBytes = numericCapture(text, [/\b(?:request|body|payload)(?:_size|_bytes| size| bytes)?\s*[:=]\s*(\d+)\s*(?:bytes?)?\b/i, /\b(\d+)\s+bytes\b/i]);
  const timestampUtc = safeIso(row.ts, row.ts_nanos);
  if (!timestampUtc) return null;
  return {
    timestampUtc,
    target: /^[A-Za-z0-9_:.-]{1,96}$/.test(String(row.target ?? "")) ? String(row.target) : "unknown",
    errorClass,
    retryNumber,
    httpStatus: errorClass === "http_5xx" ? httpStatus : null,
    closeCode: errorClass === "websocket_closed_before_completed" ? closeCode : null,
    requestBytes: ["websocket_closed_before_completed", "payload_too_large"].includes(errorClass) ? requestBytes : null,
    threadHash: tid ? sha(tid) : null,
    processHash: process ? sha(process) : null,
    correlation,
  };
}
function sanitizeEvent(event) {
  const classes = ["websocket_closed_before_completed", "sampling_retry", "http_fallback", "payload_too_large", "http_5xx", "compaction_retry"];
  if (!event || !classes.includes(event.errorClass) || typeof event.timestampUtc !== "string" || !Number.isFinite(Date.parse(event.timestampUtc)) || typeof event.target !== "string" || !/^[A-Za-z0-9_:.-]{1,96}$/.test(event.target) || !["parent", "registered_child", "other_or_unknown"].includes(event.correlation)) return null;
  const bounded = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max ? n : null;
  const hash = (s) => typeof s === "string" && /^[a-f0-9]{16}$/.test(s) ? s : null;
  return { timestampUtc: new Date(event.timestampUtc).toISOString(), target: event.target, errorClass: event.errorClass, retryNumber: bounded(event.retryNumber, 100), httpStatus: bounded(event.httpStatus, 599), closeCode: bounded(event.closeCode, 49999), requestBytes: bounded(event.requestBytes, Number.MAX_SAFE_INTEGER), threadHash: hash(event.threadHash), processHash: hash(event.processHash), correlation: event.correlation };
}
function safeFailure() {
  return { available: false, rootCause: "uncertain", events: [] };
}
async function loadState(stateFile) {
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8"));
    return value && typeof value === "object" && Array.isArray(value.events) ? { available: true, collectorSchemaVersion: Number.isSafeInteger(value.collectorSchemaVersion) ? value.collectorSchemaVersion : null, cursor: { rowid: Number.isSafeInteger(value.cursor?.rowid) ? value.cursor.rowid : 0, maxTimestampMs: Number.isFinite(value.cursor?.maxTimestampMs) ? value.cursor.maxTimestampMs : 0 }, events: value.events.map((event) => sanitizeEvent(event)).filter(Boolean).slice(-MAX_EVENTS) } : null;
  } catch { return null; }
}
async function atomicWrite(stateFile, snapshot) {
  await writeJsonAtomic(stateFile, snapshot);
}

/** Read and classify a bounded batch of Rust log rows; raw log text never leaves this function. */
export async function collectConnectionDiagnostics({ codexHome, stateDir, now = Date.now(), enabled = false, parentThreadId = null, registeredChildThreadIds = [] } = {}) {
  if (!enabled) return safeFailure();
  if (!codexHome || !stateDir || !Number.isFinite(Number(now))) return safeFailure();
  const dir = path.resolve(stateDir);
  const stateFile = path.join(dir, `connection-diagnostics-${ownerHash(parentThreadId)}.json`);
  const lockFile = path.join(dir, `connection-diagnostics-${ownerHash(parentThreadId)}.lock`);
  try {
    return await withFileLock(lockFile, () => collectLocked({ codexHome, stateFile, now, parentThreadId, registeredChildThreadIds }), { timeoutMs: LOCK_TIMEOUT_MS, staleMs: 60_000 });
  } catch {
    return safeFailure();
  }
}

async function collectLocked({ codexHome, stateFile, now, parentThreadId, registeredChildThreadIds }) {
  const dbPath = path.join(codexHome, "logs_2.sqlite");
  const prior = await loadState(stateFile);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").all();
    if (!tables.length) return safeFailure();
    const columns = new Set(db.prepare("PRAGMA table_info(logs)").all().map((r) => String(r.name)));
    if (!columns.has("ts") || !columns.has("target") || (parentThreadId && !columns.has("thread_id"))) return safeFailure();
    const bodyCol = columns.has("feedback_log_body") ? "feedback_log_body" : (columns.has("message") ? "message" : null);
    if (!bodyCol) return safeFailure();
    const select = ["rowid AS _rowid", "ts", columns.has("ts_nanos") ? "ts_nanos" : "0 AS ts_nanos", "target", `${bodyCol} AS event_body`, columns.has("thread_id") ? "thread_id" : "NULL AS thread_id"].join(", ");
    const maxRow = db.prepare("SELECT COALESCE(MAX(rowid),0) AS id FROM logs").get().id;
    const previousCursor = Number(prior?.cursor?.rowid ?? 0);
    const previousTime = Number(prior?.cursor?.maxTimestampMs ?? 0);
    const latestTime = Number(db.prepare("SELECT COALESCE(MAX(ts),0) AS ts FROM logs").get().ts) * 1000;
    const rotated = Number(maxRow) < previousCursor || (previousTime > 0 && latestTime > 0 && latestTime < previousTime - 1000);
    const floorSec = Math.floor((Number(now) - WINDOW_MS) / 1000);
    const initializeFromRecent = !prior || prior.collectorSchemaVersion !== 2 || rotated;
    const scopedThreadIds = parentThreadId == null ? [] : [...new Set([String(parentThreadId), ...registeredChildThreadIds.map(String)])];
    const targetClause = RESPONSE_TARGET_PREFIXES.map(() => "(target = ? OR target GLOB ?)").join(" OR ");
    const targetParams = RESPONSE_TARGET_PREFIXES.flatMap((prefix) => [prefix, `${prefix}::*`]);
    const threadClause = scopedThreadIds.length ? ` AND thread_id IN (${scopedThreadIds.map(() => "?").join(",")})` : "";
    const rows = initializeFromRecent
      ? db.prepare(`SELECT ${select} FROM logs WHERE ts >= ? AND (${targetClause})${threadClause} ORDER BY rowid DESC LIMIT ${MAX_ROWS}`).all(floorSec, ...targetParams, ...scopedThreadIds).reverse()
      : db.prepare(`SELECT ${select} FROM logs WHERE rowid > ? AND ts >= ? AND (${targetClause})${threadClause} ORDER BY rowid ASC LIMIT ${MAX_ROWS}`).all(previousCursor, floorSec, ...targetParams, ...scopedThreadIds);
    const events = rows.map((row) => makeEvent(row, parentThreadId, registeredChildThreadIds)).filter(Boolean);
    const priorEvents = initializeFromRecent ? [] : (prior?.events ?? []).filter((event) => !scopedThreadIds.length || event.correlation !== "other_or_unknown");
    const allEvents = [...priorEvents, ...events].slice(-MAX_EVENTS);
    const nextCursor = initializeFromRecent || rows.length < MAX_ROWS
      ? Number(maxRow)
      : Number(rows.at(-1)._rowid);
    const snapshot = {
      available: true,
      collectorSchemaVersion: 2,
      rootCause: "uncertain",
      cursor: { rowid: nextCursor, maxTimestampMs: rotated ? latestTime : Math.max(previousTime, latestTime) },
      events: allEvents,
    };
    await atomicWrite(stateFile, snapshot);
    return { available: true, rootCause: "uncertain", events };
  } catch {
    return safeFailure();
  } finally {
    db?.close();
  }
}

export async function readConnectionDiagnosticsSnapshot(stateDir, { parentThreadId = null } = {}) {
  const value = await loadState(path.join(path.resolve(stateDir), `connection-diagnostics-${ownerHash(parentThreadId)}.json`));
  if (!value) return safeFailure();
  return { available: value.available === true, rootCause: "uncertain", events: Array.isArray(value.events) ? value.events.slice(-MAX_EVENTS) : [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const collect = process.argv.includes("--collect");
  const json = process.argv.includes("--json");
  let result = safeFailure();
  if (collect && json) {
    const codexHome = process.env.CODEX_HOME;
    const stateDir = process.env.CODEX_CONNECTION_DIAGNOSTICS_STATE;
    result = await collectConnectionDiagnostics({ codexHome, stateDir, enabled: true, parentThreadId: process.env.CODEX_THREAD_ID ?? null });
  } else if (json) {
    result = await readConnectionDiagnosticsSnapshot(process.env.CODEX_CONNECTION_DIAGNOSTICS_STATE ?? "", { parentThreadId: process.env.CODEX_THREAD_ID ?? null });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
