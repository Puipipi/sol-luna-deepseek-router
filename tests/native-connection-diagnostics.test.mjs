import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { withFileLock } from "../scripts/plugin-state.mjs";
import { collectConnectionDiagnostics, readConnectionDiagnosticsSnapshot } from "../scripts/native-connection-diagnostics.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "connection-diagnostics-"));
const eq = (a, b, msg) => assert.equal(a, b, msg);
const stateFile = (dir, parent = null) => path.join(dir, `connection-diagnostics-${parent ? createHash("sha256").update(parent).digest("hex") : "unbound"}.json`);
const dbPath = path.join(root, "logs_2.sqlite");
function createDb(home = root) {
  const db = new DatabaseSync(path.join(home, "logs_2.sqlite"));
  db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, message TEXT, feedback_log_body TEXT, thread_id TEXT)");
  return db;
}
function add(db, ts, target, feedback, message = "") {
  const thread = /thread_id=([^ ]+)/.exec(feedback)?.[1] ?? /thread_id=([^ ]+)/.exec(message)?.[1] ?? null;
  db.prepare("INSERT INTO logs(ts,ts_nanos,level,target,message,feedback_log_body,thread_id) VALUES(?,?,?,?,?,?,?)")
    .run(Math.floor(ts / 1000), (ts % 1000) * 1_000_000, "WARN", target, message, feedback, thread);
}
try {
  const stateDir = path.join(root, "plugin-state");
  const fixedNow = Date.UTC(2026, 9, 24, 8, 0, 0);
  const off = await collectConnectionDiagnostics({ codexHome: path.join(root, "missing"), stateDir, now: fixedNow, enabled: false });
  eq(off.available, false, "disabled short-circuits as unavailable");
  await assert.rejects(readFile(stateFile(stateDir)));

  const db = createDb();
  const base = fixedNow - 10_000;
  for (let n = 1; n <= 5; n++) {
    add(db, base + n * 500, "codex_core::client", `sampling request failed; retry ${n}/5 thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9 process_uuid=feedface-1234`);
    const metadata = n === 1 ? " (close_code=1009 request_bytes=12345)" : "";
    add(db, base + n * 500 + 100, "codex_api::endpoint::responses_websocket", `websocket closed by server before response.completed${metadata} thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9`);
  }
  add(db, base + 3_000, "codex_core::client", "falling back to HTTP thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9 https://secret.example/v1/responses?api_key=do-not-leak");
  add(db, base + 3_500, "codex_core::client", "sampling request failed; retry 1/5 websocket closed thread_id=other-thread process_uuid=other-process");
  add(db, base + 3_700, "codex_core::client", "falling back to HTTP thread_id=child-thread");
  add(db, base + 4_000, "codex_core::client", "sampling request failed; retry 7/5", "user text includes https://private.example/path?key=SECRET");
  add(db, base + 4_100, "codex_core::tools::exec", "websocket closed by server before response.completed");
  db.close();

  const parent = "01a1491e-cc5c-7743-8d1a-a935dcd54cb9";
  const result = await collectConnectionDiagnostics({ codexHome: root, stateDir, now: fixedNow, enabled: true, parentThreadId: parent, registeredChildThreadIds: ["child-thread"] });
  eq(result.available, true, "real SQLite store is read");
  eq(result.events.length, 12, "only classified response-network events from the parent and registered children are kept");
  eq(result.events.some(e => e.target === "codex_core::tools::exec"), false, "quoted WS text from tool logs is excluded");
  eq(result.events.some(e => e.errorClass === "sampling_retry" && e.retryNumber === 7), false, "rows without a trusted thread ID are excluded from a scoped read");
  eq(result.events.filter(e => e.errorClass === "sampling_retry").length, 5, "only retry rows from the parent thread are classified");
  eq(result.events.filter(e => e.errorClass === "websocket_closed_before_completed").length, 5, "five WS close events are classified");
  eq(result.events.find(e => e.closeCode === 1009)?.requestBytes, 12345, "explicit WS close code and serialized request byte count are retained");
  eq(result.events.find(e => e.errorClass === "http_fallback").correlation, "parent", "explicit matching parent ID is recognized");
  eq(result.events.find(e => e.threadHash && e.correlation === "registered_child")?.correlation, "registered_child", "registered child is explicitly recognized");
  eq(result.events.some(e => e.threadHash && e.correlation === "other_or_unknown"), false, "unregistered threads are excluded before classification");
  const serialized = JSON.stringify(result);
  for (const secret of ["secret.example", "api_key", "do-not-leak", "SUPERSECRET", "authorization", "feedface-1234", "other-thread", parent, "falling back to HTTP", "private.example", "SECRET"]) assert.ok(!serialized.includes(secret), "serialized result omits seeded sensitive markers");
  const snapshot = await readConnectionDiagnosticsSnapshot(stateDir, { parentThreadId: parent });
  eq(JSON.stringify(snapshot), JSON.stringify(result), "parent-specific state round-trips sanitized events");
  const rawState = await readFile(stateFile(stateDir, parent), "utf8");
  assert.ok(!rawState.includes("secret.example"), "persisted snapshot never stores raw URLs");

  const again = await collectConnectionDiagnostics({ codexHome: root, stateDir, now: fixedNow + 1_000, enabled: true, parentThreadId: parent });
  eq(again.events.length, 0, "cursor prevents duplicate rows");
  eq(again.rootCause, "uncertain", "missing terminal response never implies recovery or a root cause");
  const missing = await collectConnectionDiagnostics({ codexHome: path.join(root, "absent"), stateDir, now: fixedNow, enabled: true });
  eq(missing.available, false, "missing database is explicitly unavailable");

  const emptyHome = path.join(root, "empty"); await import("node:fs/promises").then(({ mkdir }) => mkdir(emptyHome));
  const empty = createDb(emptyHome); empty.close();
  const emptyResult = await collectConnectionDiagnostics({ codexHome: emptyHome, stateDir: path.join(root, "empty-state"), now: fixedNow, enabled: true });
  eq(emptyResult.available, true, "empty SQLite is a valid available source"); eq(emptyResult.events.length, 0, "empty store returns no events");
  const badHome = path.join(root, "bad"); await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(badHome));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(badHome, "logs_2.sqlite"), "not sqlite"));
  const bad = await collectConnectionDiagnostics({ codexHome: badHome, stateDir: path.join(root, "bad-state"), now: fixedNow, enabled: true });
  eq(bad.available, false, "unreadable database fails closed without throwing");
  const lockHome = path.join(root, "locked"); await import("node:fs/promises").then(({ mkdir }) => mkdir(lockHome));
  const lockDb = new DatabaseSync(path.join(lockHome, "logs_2.sqlite"));
  lockDb.exec("CREATE TABLE logs (ts INTEGER, ts_nanos INTEGER, target TEXT, message TEXT, thread_id TEXT); BEGIN EXCLUSIVE");
  const locked = await collectConnectionDiagnostics({ codexHome: lockHome, stateDir: path.join(root, "locked-state"), now: fixedNow, enabled: true });
  eq(locked.available, false, "exclusive lock is reported unavailable without throwing");
  lockDb.exec("ROLLBACK"); lockDb.close();

  const rotateHome = path.join(root, "rotate"); await import("node:fs/promises").then(({ mkdir }) => mkdir(rotateHome));
  const rotateDb = createDb(rotateHome);
  add(rotateDb, fixedNow - 4_000, "codex_core::client", "falling back to HTTP"); rotateDb.close();
  const rotateState = path.join(root, "rotate-state"); await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(rotateState));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(stateFile(rotateState), JSON.stringify({ cursor: { rowid: 100, maxTimestampMs: fixedNow - 1000 }, events: [] })));
  const afterRotation = await collectConnectionDiagnostics({ codexHome: rotateHome, stateDir: rotateState, now: fixedNow, enabled: true });
  eq(afterRotation.events.length, 1, "lower rowid after log rotation resets cursor to recent bounded window");
  const afterRotationAgain = await collectConnectionDiagnostics({ codexHome: rotateHome, stateDir: rotateState, now: fixedNow + 1_000, enabled: true });
  eq(afterRotationAgain.events.length, 0, "rotation timestamp baseline prevents repeat reset on the next collection");

  const largeHome = path.join(root, "large"); await import("node:fs/promises").then(({ mkdir }) => mkdir(largeHome));
  const largeDb = createDb(largeHome); largeDb.exec("BEGIN");
  const insertLarge = largeDb.prepare("INSERT INTO logs(ts,ts_nanos,level,target,message,feedback_log_body) VALUES(?,0,'WARN','codex_core::client','','sampling request failed; retry 1/5')");
  for (let n = 0; n < 701; n++) insertLarge.run(Math.floor((fixedNow - 70_000 + n * 100) / 1000));
  largeDb.exec("COMMIT"); largeDb.close();
  const latest = await collectConnectionDiagnostics({ codexHome: largeHome, stateDir: path.join(root, "large-state"), now: fixedNow, enabled: true });
  eq(latest.events.length, 500, "first collection is bounded to 500 recent rows");
  eq(latest.events.at(-1).timestampUtc, new Date(Math.floor((fixedNow - 70_000 + 700 * 100) / 1000) * 1000).toISOString(), "first batch starts at newest rows rather than oldest rows");

  const maskedHome = path.join(root, "masked"); await import("node:fs/promises").then(({ mkdir }) => mkdir(maskedHome));
  const maskedDb = createDb(maskedHome);
  const targetThread = "recent-failing-thread";
  add(maskedDb, fixedNow - 2_000, "codex_core::client", "websocket closed by server before response.completed thread_id=recent-failing-thread");
  maskedDb.exec("BEGIN");
  const noise = maskedDb.prepare("INSERT INTO logs(ts,ts_nanos,level,target,message,feedback_log_body,thread_id) VALUES(?,0,'WARN','codex_core::client','','falling back to HTTP thread_id=other-thread SECRET-OTHER','other-thread')");
  for (let n = 0; n < 501; n++) noise.run(Math.floor((fixedNow - 1_000 + n) / 1000));
  maskedDb.exec("COMMIT"); maskedDb.close();
  const masked = await collectConnectionDiagnostics({ codexHome: maskedHome, stateDir: path.join(root, "masked-state"), now: fixedNow, enabled: true, parentThreadId: targetThread });
  eq(masked.events.length, 1, "target thread failure survives more than 500 later rows from another thread");
  eq(masked.events[0].errorClass, "websocket_closed_before_completed", "target thread failure is classified after thread-scoped bounded read");
  assert.ok(!JSON.stringify(masked).includes("other-thread"), "other-thread rows are excluded before event serialization");
  assert.ok(!JSON.stringify(masked).includes("SECRET-OTHER"), "unrelated raw log content is never returned");
  const oldCursorHome = path.join(root, "old-cursor"); await import("node:fs/promises").then(({ mkdir }) => mkdir(oldCursorHome));
  const oldCursorDb = createDb(oldCursorHome);
  add(oldCursorDb, fixedNow - 2_000, "codex_core::client", "websocket closed by server before response.completed thread_id=old-cursor-target");
  add(oldCursorDb, fixedNow - 1_000, "codex_core::shell", "irrelevant row");
  const oldCursorMaxRow = Number(oldCursorDb.prepare("SELECT MAX(rowid) AS id FROM logs").get().id); oldCursorDb.close();
  const oldCursorState = path.join(root, "old-cursor-state"); await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(oldCursorState));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(stateFile(oldCursorState, "old-cursor-target"), JSON.stringify({ available: true, cursor: { rowid: oldCursorMaxRow, maxTimestampMs: fixedNow }, events: [] })));
  const recoveredOldCursor = await collectConnectionDiagnostics({ codexHome: oldCursorHome, stateDir: oldCursorState, now: fixedNow, enabled: true, parentThreadId: "old-cursor-target" });
  eq(recoveredOldCursor.events.length, 1, "old snapshot cursor triggers scoped time-window backfill for an earlier incident");
  eq(recoveredOldCursor.events[0].errorClass, "websocket_closed_before_completed", "old cursor incident is classified on first upgraded collection");
  const recoveredOldCursorAgain = await collectConnectionDiagnostics({ codexHome: oldCursorHome, stateDir: oldCursorState, now: fixedNow + 1_000, enabled: true, parentThreadId: "old-cursor-target" });
  eq(recoveredOldCursorAgain.events.length, 0, "upgraded cursor backfill is not duplicated on the next collection");
  const oldEventHome = path.join(root, "old-event"); await import("node:fs/promises").then(({ mkdir }) => mkdir(oldEventHome));
  const oldEventDb = createDb(oldEventHome);
  const oldEventTime = fixedNow - 3_000;
  add(oldEventDb, oldEventTime, "codex_core::client", "websocket closed by server before response.completed thread_id=old-event-target");
  const oldEventMaxRow = Number(oldEventDb.prepare("SELECT MAX(rowid) AS id FROM logs").get().id); oldEventDb.close();
  const oldEventState = path.join(root, "old-event-state"); await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(oldEventState));
  const oldEvent = { timestampUtc: new Date(Math.floor(oldEventTime / 1000) * 1000).toISOString(), target: "codex_core::client", errorClass: "websocket_closed_before_completed", retryNumber: null, httpStatus: null, closeCode: null, requestBytes: null, threadHash: createHash("sha256").update("old-event-target").digest("hex").slice(0, 16), processHash: null, correlation: "parent" };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(stateFile(oldEventState, "old-event-target"), JSON.stringify({ available: true, cursor: { rowid: oldEventMaxRow, maxTimestampMs: Math.floor(oldEventTime / 1000) * 1000 }, events: [oldEvent] })));
  const migratedOldEvent = await collectConnectionDiagnostics({ codexHome: oldEventHome, stateDir: oldEventState, now: fixedNow, enabled: true, parentThreadId: "old-event-target" });
  eq(migratedOldEvent.events.length, 1, "legacy event is re-collected during schema backfill");
  eq((await readConnectionDiagnosticsSnapshot(oldEventState, { parentThreadId: "old-event-target" })).events.length, 1, "schema backfill replaces the legacy snapshot event instead of duplicating it");
  const migratedOldEventAgain = await collectConnectionDiagnostics({ codexHome: oldEventHome, stateDir: oldEventState, now: fixedNow + 1_000, enabled: true, parentThreadId: "old-event-target" });
  eq(migratedOldEventAgain.events.length, 0, "migrated legacy event is not emitted again on the next collection");
  eq((await readConnectionDiagnosticsSnapshot(oldEventState, { parentThreadId: "old-event-target" })).events.length, 1, "subsequent collection keeps one migrated event in the snapshot");
  const sameThreadNoiseHome = path.join(root, "same-thread-noise"); await import("node:fs/promises").then(({ mkdir }) => mkdir(sameThreadNoiseHome));
  const sameThreadNoiseDb = createDb(sameThreadNoiseHome);
  add(sameThreadNoiseDb, fixedNow - 2_000, "codex_core::client::transport", "websocket closed by server before response.completed thread_id=same-thread-target");
  sameThreadNoiseDb.exec("BEGIN");
  const debugNoise = sameThreadNoiseDb.prepare("INSERT INTO logs(ts,ts_nanos,level,target,message,feedback_log_body,thread_id) VALUES(?,0,'DEBUG','codex_core::shell','','irrelevant debug row','same-thread-target')");
  for (let n = 0; n < 501; n++) debugNoise.run(Math.floor((fixedNow - 1_000 + n) / 1000));
  sameThreadNoiseDb.exec("COMMIT"); sameThreadNoiseDb.close();
  const sameThreadScopedState = path.join(root, "same-thread-noise-state");
  const sameThreadNoise = await collectConnectionDiagnostics({ codexHome: sameThreadNoiseHome, stateDir: sameThreadScopedState, now: fixedNow, enabled: true, parentThreadId: "same-thread-target" });
  eq(sameThreadNoise.events.length, 1, "target failure survives more than 500 same-thread rows with non-response targets");
  eq(sameThreadNoise.events[0].errorClass, "websocket_closed_before_completed", "response target whitelist is applied before the bounded read");

  const raceHome = path.join(root, "race"); await import("node:fs/promises").then(({ mkdir }) => mkdir(raceHome));
  const raceDb = createDb(raceHome); add(raceDb, fixedNow - 1_000, "codex_core::client", "falling back to HTTP thread_id=parent-a"); raceDb.close();
  const sharedState = path.join(root, "shared-state");
  const concurrent = await Promise.all([1, 2].map(() => collectConnectionDiagnostics({ codexHome: raceHome, stateDir: sharedState, now: fixedNow, enabled: true, parentThreadId: "parent-a" })));
  eq(concurrent.flatMap(x => x.events).length, 1, "same-parent concurrent collection is serialized and not duplicated");
  const parentA = await readConnectionDiagnosticsSnapshot(sharedState, { parentThreadId: "parent-a" });
  const parentB = await collectConnectionDiagnostics({ codexHome: raceHome, stateDir: sharedState, now: fixedNow, enabled: true, parentThreadId: "parent-b" });
  eq(parentB.events.length, 0, "different parent scope excludes another parent thread before classification");
  eq(parentB.events.some(e => e.threadHash), false, "other parent's thread is not exposed");
  eq(parentA.events.length, 1, "first parent's snapshot remains intact");
  const contendedParent = "contended-parent";
  const contendedLock = path.join(sharedState, `connection-diagnostics-${createHash("sha256").update(contendedParent).digest("hex")}.lock`);
  let releaseLock;
  let acquired;
  const lockAcquired = new Promise((resolve) => { acquired = resolve; });
  const hold = new Promise((resolve) => { releaseLock = resolve; });
  const holder = withFileLock(contendedLock, async () => { acquired(); await hold; });
  await lockAcquired;
  const started = performance.now();
  const contended = await collectConnectionDiagnostics({ codexHome: raceHome, stateDir: sharedState, now: fixedNow, enabled: true, parentThreadId: contendedParent });
  const lockWaitMs = performance.now() - started;
  eq(contended.available, false, "lock contention fails open without exposing another snapshot");
  eq(lockWaitMs < 1_000, true, "lock contention does not block the caller");
  releaseLock(); await holder;
  console.log("native connection diagnostics tests passed");
} finally {
  try { await rm(root, { recursive: true, force: true }); } catch (error) { if (error.code !== "EBUSY") throw error; }
}
