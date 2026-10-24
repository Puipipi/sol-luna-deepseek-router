import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const lifecycle = await import("../scripts/native-gateway-task.mjs").catch(() => null);
assert.ok(lifecycle, "gateway Task Scheduler lifecycle module is available");

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const rejects = async (operation, pattern, message) => {
  await assert.rejects(operation, pattern, message);
  checks += 1;
};

const { gatewayTaskPlan, rebaseGatewayTaskSnapshot, registerOwnedGatewayTask, startOwnedGatewayTask, statusOwnedGatewayTask, unregisterOwnedGatewayTask, snapshotGatewayTask, installOwnedGatewayTask, restoreGatewayTask, windowsTaskSchedulerScript, windowsTaskTriggerPolicyScript, createWindowsTaskSchedulerAdapter } = lifecycle;
const paths = {
  dir: "C:\\Users\\Test User\\AppData\\Local\\Router\\native gateway",
  state: "C:\\Users\\Test User\\AppData\\Local\\Router\\native gateway\\gateway.json",
  identity: "C:\\Users\\Test User\\AppData\\Local\\Router\\native gateway\\identity.json",
  log: "C:\\Users\\Test User\\AppData\\Local\\Router\\native gateway\\gateway.log",
};
const plan = gatewayTaskPlan({
  paths,
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  wscriptPath: "C:\\Windows\\System32\\wscript.exe",
  gatewayScriptPath: "C:\\Plugin\\scripts\\native-gateway.mjs",
});

ok(plan.name.startsWith("SolLunaNativeGateway-"), "task name is namespaced");
equal(plan.name, gatewayTaskPlan({ paths: { ...paths } }).name, "task name is stable for the gateway directory");
ok(plan.marker.includes(plan.name.slice("SolLunaNativeGateway-".length)), "ownership marker is bound to the directory hash");
equal(JSON.stringify(plan.restartPolicy), JSON.stringify({ count: 3, intervalSeconds: 60 }), "task plan pins a bounded three-restart policy at one-minute intervals");
ok(plan.launcher.content.includes(", 0, True)"), "launcher hides Node and synchronously waits for its full lifetime");
ok(plan.launcher.content.includes("exitCode = shell.Run(command, 0, True)") && plan.launcher.content.includes("WScript.Quit exitCode"), "launcher propagates the gateway child exit code to Task Scheduler");
ok(plan.launcher.content.includes("native-gateway.mjs") && plan.launcher.content.includes("--serve") && plan.launcher.content.includes("--deepseek-only"), "launcher runs the formal DeepSeek-only gateway server entry point");
ok(plan.launcher.content.includes("gateway.json") && plan.launcher.content.includes("identity.json") && plan.launcher.content.includes("gateway.log"), "launcher passes only gateway paths to the server");
ok(plan.launcher.content.includes('""C:\\Program Files\\nodejs\\node.exe""'), "launcher escapes Windows paths with spaces and quotes");
ok(!/api[_-]?key|token|secret|password/i.test(plan.launcher.content), "launcher contains no credential fields");
const relocatedPlan = gatewayTaskPlan({
  paths,
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  wscriptPath: "C:\\Windows\\System32\\wscript.exe",
  gatewayScriptPath: "C:\\Users\\Test User\\AppData\\Local\\Router\\native-isolated\\gateway-source\\digest\\scripts\\native-gateway.mjs",
});
const relocationSnapshot = await snapshotGatewayTask(plan, {
  async status() { return { exists: true, owned: true, specMatches: true, enabled: true }; },
});
const rebasedSnapshot = rebaseGatewayTaskSnapshot(relocationSnapshot, plan, relocatedPlan, {
  fromScriptPath: "C:\\Plugin\\scripts\\native-gateway.mjs",
  toScriptPath: "C:\\Users\\Test User\\AppData\\Local\\Router\\native-isolated\\gateway-source\\digest\\scripts\\native-gateway.mjs",
});
equal(rebasedSnapshot.planFingerprint === relocationSnapshot.planFingerprint, false, "relocation rebases only the snapshot fingerprint for the updated launcher script");
equal(rebasedSnapshot.priorExists, relocationSnapshot.priorExists, "snapshot rebase preserves prior task existence");
equal(rebasedSnapshot.priorOwned, relocationSnapshot.priorOwned, "snapshot rebase preserves prior ownership");
assert.throws(() => rebaseGatewayTaskSnapshot(relocationSnapshot, plan, { ...relocatedPlan, action: { ...relocatedPlan.action, execute: "C:\\\\malicious.exe" } }, {
  fromScriptPath: "C:\\Plugin\\scripts\\native-gateway.mjs",
  toScriptPath: "C:\\Users\\Test User\\AppData\\Local\\Router\\native-isolated\\gateway-source\\digest\\scripts\\native-gateway.mjs",
}), /task plan changed outside the gateway script/i);
checks += 1;
ok(windowsTaskSchedulerScript.includes("[Console]::InputEncoding") && windowsTaskSchedulerScript.includes("[Console]::OutputEncoding"), "PowerShell adapter sets UTF-8 stdin and stdout");
ok(windowsTaskSchedulerScript.includes("IgnoreNew") && windowsTaskSchedulerScript.includes("TimeSpan]::Zero") && windowsTaskSchedulerScript.includes("Interactive"), "task definition is single-instance, interactive, and has no execution limit");
ok(windowsTaskSchedulerScript.includes("AllowDemandStart") && windowsTaskSchedulerScript.includes("Hidden"), "task allows on-demand startup and hides task UI entry");
ok(windowsTaskSchedulerScript.includes("$task.Settings.MultipleInstances") && windowsTaskSchedulerScript.includes("XmlConvert]::ToTimeSpan"), "ownership status validates concurrency policy and the no-limit duration");
ok(windowsTaskSchedulerScript.includes("-RestartCount 3") && windowsTaskSchedulerScript.includes("-RestartInterval (New-TimeSpan -Minutes 1)"), "registered gateway task uses three restarts at one-minute intervals");
ok(windowsTaskSchedulerScript.includes("$restartCount -eq 3 -and $restartIntervalSeconds -eq 60"), "ownership status validates the bounded restart count and interval");
ok(windowsTaskSchedulerScript.includes("restartCount = $restartCount; restartIntervalSeconds = $restartIntervalSeconds"), "task query returns the observed restart policy");
ok(windowsTaskSchedulerScript.includes("$taskPrincipalSid -ceq $expectedSid") && windowsTaskSchedulerScript.includes("Principal.LogonType") && windowsTaskSchedulerScript.includes("Principal.RunLevel"), "ownership status validates current-user interactive limited principal");
ok(windowsTaskSchedulerScript.includes("lastTaskResult = [long]$info.LastTaskResult"), "status preserves unsigned scheduler result codes without Int32 overflow");
ok(windowsTaskSchedulerScript.includes("$request.autoStart") && windowsTaskSchedulerScript.includes("$triggerCount -eq 0"), "status requires zero triggers for demand-only tasks");
ok(windowsTaskSchedulerScript.includes("$task.Triggers | Where-Object { $null -ne $_ }"), "status filters nullable CIM triggers before counting");
if (process.platform === "win32") {
  const runTriggerPolicy = (autoStart, triggerCount) => spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$task=[pscustomobject]@{Triggers=${triggerCount === null ? "$null" : triggerCount === 0 ? "@()" : `@(${Array.from({ length: triggerCount }, () => "[pscustomobject]@{}").join(",")})`}}; $request=[pscustomobject]@{autoStart=$${autoStart}}; ${windowsTaskTriggerPolicyScript}; if ($triggerMatches) { exit 0 } else { exit 1 }`,
  ], { windowsHide: true, encoding: "utf8" }).status;
  equal(runTriggerPolicy("false", null), 0, "PowerShell treats a null Triggers collection as zero for API tasks");
  equal(runTriggerPolicy("false", 0), 0, "PowerShell accepts an API demand-only task with no triggers");
  equal(runTriggerPolicy("false", 1), 1, "PowerShell rejects an external logon trigger on an API task");
  equal(runTriggerPolicy("false", 2), 1, "PowerShell rejects multiple external triggers on an API task");
  equal(runTriggerPolicy("true", 1), 0, "PowerShell preserves the DeepSeek logon task policy");
  equal(runTriggerPolicy("true", 0), 1, "PowerShell rejects a DeepSeek task without its logon trigger");
  equal(runTriggerPolicy("true", null), 1, "PowerShell treats null as no DeepSeek logon trigger");
  equal(runTriggerPolicy("true", 2), 1, "PowerShell rejects an extra DeepSeek trigger");
}
ok(windowsTaskSchedulerScript.includes("TASK_SCHEDULER_ACCESS_DENIED") && windowsTaskSchedulerScript.includes("TASK_SCHEDULER_OPERATION_FAILED"), "PowerShell failures produce minimal structured error codes");

let scheduler = { exists: false, owned: false, state: "missing", lastTaskResult: null };
const calls = [];
const adapter = {
  async status(receivedPlan) { calls.push(["status", receivedPlan.name]); return { ...scheduler }; },
  async register(receivedPlan) { calls.push(["register", receivedPlan.name]); scheduler = { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready", lastTaskResult: 0 }; return { ...scheduler }; },
  async start(receivedPlan) { calls.push(["start", receivedPlan.name]); if (!scheduler.exists || !scheduler.owned) throw new Error("owned task required"); scheduler.state = "Running"; return { started: true }; },
  async unregister(receivedPlan) { calls.push(["unregister", receivedPlan.name]); if (!scheduler.exists || !scheduler.owned) throw new Error("owned task required"); scheduler = { exists: false, owned: false, state: "missing", lastTaskResult: null }; return { removed: true }; },
};

await rejects(() => startOwnedGatewayTask(plan, adapter), /not registered/i, "start refuses to register a missing task implicitly");
await registerOwnedGatewayTask(plan, adapter);
equal((await statusOwnedGatewayTask(plan, adapter)).owned, true, "status reports the exact owned task");
equal((await startOwnedGatewayTask(plan, adapter)).started, true, "start runs the registered task");
equal(calls.filter(([name]) => name === "register").length, 1, "on-demand start never silently registers the task");
equal((await unregisterOwnedGatewayTask(plan, adapter)).removed, true, "unregister removes the owned task");

const absentSnapshot = await snapshotGatewayTask(plan, adapter);
equal(absentSnapshot.priorExists, false, "snapshot records that no same-name task existed");
equal(absentSnapshot.planFingerprint.length, 64, "snapshot is bound to the full task plan fingerprint");
const installSnapshot = await installOwnedGatewayTask(plan, adapter);
equal(installSnapshot.priorExists, false, "install returns a prior-state snapshot before registration");
equal(scheduler.owned, true, "install registers and verifies only the owned task");
equal((await restoreGatewayTask(installSnapshot, plan, adapter)).removed, true, "restore removes the task created by this transaction");
equal(scheduler.exists, false, "restore leaves the task absent when it was absent before");

await registerOwnedGatewayTask(plan, adapter);
const ownedSnapshot = await snapshotGatewayTask(plan, adapter);
equal(ownedSnapshot.priorOwned, true, "snapshot marks a pre-existing exact owned task");
equal((await restoreGatewayTask(ownedSnapshot, plan, adapter)).preserved, true, "restore preserves a task that already existed in the snapshot");
scheduler.specMatches = false;
await rejects(() => restoreGatewayTask(ownedSnapshot, plan, adapter), /specification changed/i, "restore refuses to overwrite a previously owned task after scheduler settings drift");
scheduler.specMatches = true;
const changedPlan = gatewayTaskPlan({ ...{ paths }, nodePath: "C:\\Other\\node.exe", wscriptPath: "C:\\Windows\\System32\\wscript.exe", gatewayScriptPath: "C:\\Plugin\\scripts\\native-gateway.mjs" });
await rejects(() => restoreGatewayTask(ownedSnapshot, changedPlan, adapter), /snapshot does not match/i, "restore rejects snapshots from a different executable plan");
await rejects(() => restoreGatewayTask(ownedSnapshot, { ...plan, restartPolicy: { count: 2, intervalSeconds: 60 } }, adapter), /snapshot does not match/i, "restore rejects snapshots with a different restart policy");
await unregisterOwnedGatewayTask(plan, adapter);

scheduler = { exists: true, owned: false, enabled: true, state: "Ready", lastTaskResult: 0 };
await rejects(() => registerOwnedGatewayTask(plan, adapter), /ownership conflict/i, "registration refuses a same-name unowned task");
await rejects(() => startOwnedGatewayTask(plan, adapter), /ownership conflict/i, "start refuses a same-name unowned task");
await rejects(() => unregisterOwnedGatewayTask(plan, adapter), /ownership conflict/i, "unregister never deletes a same-name unowned task");

scheduler = { exists: true, owned: true, specMatches: false, enabled: true, state: "Ready", lastTaskResult: 0 };
equal((await statusOwnedGatewayTask(plan, adapter)).specMatches, false, "status reports an owned task whose scheduler settings drifted");
await rejects(() => registerOwnedGatewayTask(plan, adapter), /specification changed/i, "registration refuses an owned task with changed scheduler settings");
await rejects(() => startOwnedGatewayTask(plan, adapter), /specification changed/i, "dispatch refuses an owned task with changed scheduler settings");
await rejects(() => unregisterOwnedGatewayTask(plan, adapter), /specification changed/i, "unregister refuses an owned task with changed scheduler settings");
scheduler = { exists: false, owned: false, state: "missing", lastTaskResult: null };

for (const [label, restartPolicy] of [
  ["missing restart policy", { restartCount: null, restartIntervalSeconds: null }],
  ["different restart count", { restartCount: 2, restartIntervalSeconds: 60 }],
  ["different restart interval", { restartCount: 3, restartIntervalSeconds: 30 }],
]) {
  const rejectedStarts = [];
  const changedRestartAdapter = {
    async status() { return { exists: true, owned: true, enabled: true, state: "Ready", specMatches: false, ...restartPolicy }; },
    async start() { rejectedStarts.push(true); return { started: true }; },
  };
  await rejects(() => startOwnedGatewayTask(plan, changedRestartAdapter), /specification changed/i, `start refuses ${label}`);
  equal(rejectedStarts.length, 0, `start never dispatches a task with ${label}`);
}

let invocation;
const fakeRunner = (exe, args, options) => {
  invocation = { exe, args, options };
  return { status: 0, stdout: JSON.stringify({ exists: true, owned: true, specMatches: true, restartCount: 3, restartIntervalSeconds: 60, state: "Ready", lastTaskResult: 0 }), stderr: "" };
};
const windowsAdapter = createWindowsTaskSchedulerAdapter({ runner: fakeRunner, powershellPath: "powershell.exe" });
const observedTask = await windowsAdapter.status(plan);
equal(observedTask.owned, true, "Windows adapter parses only the minimal task status");
equal(observedTask.restartCount, 3, "Windows task query exposes the observed restart count");
equal(observedTask.restartIntervalSeconds, 60, "Windows task query exposes the observed restart interval");
equal(invocation.exe, "powershell.exe", "adapter uses the injected PowerShell executable");
ok(invocation.args.includes("-EncodedCommand"), "PowerShell receives the static script as UTF-16LE encoded command");
const encodedScript = invocation.args[invocation.args.indexOf("-EncodedCommand") + 1];
equal(Buffer.from(encodedScript, "base64").toString("utf16le"), windowsTaskSchedulerScript, "encoded PowerShell script is the exact static script");
ok(windowsTaskSchedulerScript.includes("[Console]::In.ReadToEnd() | ConvertFrom-Json"), "request JSON remains on stdin, separate from the static command");
equal(JSON.parse(invocation.options.input).operation, "status", "operation data is delivered as JSON stdin");
equal(invocation.options.windowsHide, true, "PowerShell is started without a window");
equal(invocation.options.timeout, 10_000, "PowerShell calls have a bounded timeout");
ok(!JSON.stringify(invocation).includes("token"), "adapter call output contains no gateway capability");

const deniedAdapter = createWindowsTaskSchedulerAdapter({
  runner: () => ({ status: 1, stdout: JSON.stringify({ errorCode: "TASK_SCHEDULER_ACCESS_DENIED", errorCategory: "PermissionDenied" }), stderr: "secret stdout must not leak" }),
});
await rejects(() => deniedAdapter.status(plan), /TASK_SCHEDULER_ACCESS_DENIED/, "adapter reports a structured sanitized Windows access-denied code");
await assert.rejects(() => deniedAdapter.status(plan), (error) => error.code === "TASK_SCHEDULER_ACCESS_DENIED");
checks += 1;

console.log(`PASS ${checks} native gateway task assertions`);
