import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNERSHIP_PREFIX = "sol-luna-native-gateway-task:v1:";
const TASK_NAME_PREFIX = "SolLunaNativeGateway-";
const API_OWNERSHIP_PREFIX = "sol-luna-native-api-task:v1:";
const API_TASK_NAME_PREFIX = "SolLunaNativeApi-";
const POWERSHELL_TIMEOUT_MS = 10_000;
const RESTART_COUNT = 3;
const RESTART_INTERVAL_MINUTES = 1;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const windowsTaskTriggerPolicyScript = String.raw`$triggerCount = @($task.Triggers | Where-Object { $null -ne $_ }).Count
$triggerMatches = if ($request.autoStart) { $triggerCount -eq 1 } else { $triggerCount -eq 0 }`;

function taskError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const windowsTaskSchedulerScript = String.raw`$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json

function Get-TaskRecord($request) {
  $task = Get-ScheduledTask -TaskName $request.name -ErrorAction SilentlyContinue
  if (-not $task) { return @{ exists = $false; owned = $false; state = 'Missing'; enabled = $false; restartCount = $null; restartIntervalSeconds = $null; lastTaskResult = $null } }
  $actionMatches = $task.Actions.Count -eq 1 -and
    $task.Actions[0].Execute -ceq $request.execute -and
    $task.Actions[0].Arguments -ceq $request.arguments -and
    $task.Actions[0].WorkingDirectory -ceq $request.workingDirectory
  $expectedSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $taskPrincipalSid = $null
  try { $taskPrincipalSid = (New-Object Security.Principal.SecurityIdentifier([string]$task.Principal.UserId)).Value } catch {
    try { $taskPrincipalSid = (New-Object Security.Principal.NTAccount([string]$task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
  }
  $principalMatches = $taskPrincipalSid -ceq $expectedSid -and
    [string]$task.Principal.LogonType -eq 'Interactive' -and
    [string]$task.Principal.RunLevel -eq 'Limited'
  $executionLimit = [TimeSpan]::MaxValue
  try { $executionLimit = [System.Xml.XmlConvert]::ToTimeSpan([string]$task.Settings.ExecutionTimeLimit) } catch { }
  $restartCount = -1
  try { $restartCount = [int]$task.Settings.RestartCount } catch { }
  $restartIntervalSeconds = -1
  try { $restartIntervalSeconds = [int][System.Xml.XmlConvert]::ToTimeSpan([string]$task.Settings.RestartInterval).TotalSeconds } catch { }
  ${windowsTaskTriggerPolicyScript}
  $settingsMatches = [string]$task.Settings.MultipleInstances -eq 'IgnoreNew' -and
    $executionLimit -eq [TimeSpan]::Zero -and
    $restartCount -eq ${RESTART_COUNT} -and $restartIntervalSeconds -eq ${RESTART_INTERVAL_MINUTES * 60} -and
    [bool]$task.Settings.AllowDemandStart -and [bool]$task.Settings.Hidden -and $triggerMatches
  $owned = $task.Description -ceq $request.marker -and $actionMatches
  $info = Get-ScheduledTaskInfo -InputObject $task
  return @{
    exists = $true; owned = $owned; state = [string]$task.State
    specMatches = ($owned -and $principalMatches -and $settingsMatches)
    restartCount = $restartCount; restartIntervalSeconds = $restartIntervalSeconds
    enabled = [bool]$task.Settings.Enabled; lastTaskResult = [long]$info.LastTaskResult
  }
}

try {
$record = Get-TaskRecord $request
switch ($request.operation) {
  'status' { $result = $record }
  'register' {
    if ($record.exists -and -not $record.owned) { throw 'task ownership conflict' }
    $action = New-ScheduledTaskAction -Execute $request.execute -Argument $request.arguments -WorkingDirectory $request.workingDirectory
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount ${RESTART_COUNT} -RestartInterval (New-TimeSpan -Minutes ${RESTART_INTERVAL_MINUTES}) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $settings.AllowDemandStart = $true
    $settings.Hidden = $true
    $registerParams = @{ TaskName = $request.name; Description = $request.marker; Action = $action; Principal = $principal; Settings = $settings; Force = $true }
    if ($request.autoStart) { $registerParams.Trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name) }
    Register-ScheduledTask @registerParams | Out-Null
    $result = Get-TaskRecord $request
  }
  'start' {
    if (-not $record.exists) { throw 'owned task is not registered' }
    if (-not $record.owned) { throw 'task ownership conflict' }
    if (-not $record.enabled) { throw 'owned task is disabled' }
    Start-ScheduledTask -TaskName $request.name
    $result = @{ started = $true }
  }
  'disable' {
    if (-not $record.exists) { throw 'owned task is not registered' }
    if (-not $record.owned -or -not $record.specMatches) { throw 'task ownership or specification conflict' }
    if ($record.enabled) { Disable-ScheduledTask -TaskName $request.name | Out-Null }
    $result = Get-TaskRecord $request
  }
  'enable' {
    if (-not $record.exists) { throw 'owned task is not registered' }
    if (-not $record.owned -or -not $record.specMatches) { throw 'task ownership or specification conflict' }
    if (-not $record.enabled) { Enable-ScheduledTask -TaskName $request.name | Out-Null }
    $result = Get-TaskRecord $request
  }
  'unregister' {
    if (-not $record.exists) { $result = @{ removed = $false } }
    elseif (-not $record.owned) { throw 'task ownership conflict' }
    else { Unregister-ScheduledTask -TaskName $request.name -Confirm:$false; $result = @{ removed = $true } }
  }
  default { throw 'unsupported Task Scheduler operation' }
}
ConvertTo-Json -InputObject $result -Compress -Depth 4
} catch {
  $category = [string]$_.CategoryInfo.Category
  $code = if ($_.Exception -is [System.UnauthorizedAccessException] -or $_.Exception.HResult -eq -2147024891) { 'TASK_SCHEDULER_ACCESS_DENIED' } else { 'TASK_SCHEDULER_OPERATION_FAILED' }
  @{ errorCode = $code; errorCategory = $category } | ConvertTo-Json -Compress
  exit 1
}`;

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function windowsQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function taskHash(directory) {
  return createHash("sha256").update(path.resolve(directory).toLowerCase()).digest("hex").slice(0, 20);
}

export function gatewayTaskPlan({ paths, nodePath = process.execPath, wscriptPath, gatewayScriptPath, service = null, settingsPath } = {}) {
  if (!paths || typeof paths !== "object") throw new Error("gateway paths are required");
  const dir = absolutePath(paths.dir, "gateway directory");
  const state = absolutePath(paths.state, "gateway state path");
  const identity = absolutePath(paths.identity, "gateway identity path");
  const log = absolutePath(paths.log, "gateway log path");
  const node = absolutePath(nodePath, "Node executable");
  const wscript = absolutePath(wscriptPath || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"), "wscript executable");
  const gateway = absolutePath(gatewayScriptPath || path.join(SCRIPT_DIRECTORY, "native-gateway.mjs"), "gateway script");
  const api = service === "api";
  if (service !== null && !api) throw new Error("unsupported native gateway service");
  const hash = taskHash(dir);
  const name = `${api ? API_TASK_NAME_PREFIX : TASK_NAME_PREFIX}${hash}`;
  const marker = `${api ? API_OWNERSHIP_PREFIX : OWNERSHIP_PREFIX}${hash}`;
  const launcherPath = path.join(dir, api ? "api-task.vbs" : "gateway-task.vbs");
  const serveArgs = api ? ["--serve", "--api-only"] : ["--serve", "--deepseek-only"];
  if (api && settingsPath) serveArgs.push("--settings", windowsQuote(absolutePath(settingsPath, "API settings path")));
  const command = [
    windowsQuote(node), windowsQuote(gateway), ...serveArgs,
    "--state", windowsQuote(state), "--identity", windowsQuote(identity), "--log", windowsQuote(log),
  ].join(" ");
  const launcherContent = [
    `' ${marker}`,
    "Option Explicit",
    "Dim shell, command, exitCode",
    "On Error Resume Next",
    "Set shell = CreateObject(\"WScript.Shell\")",
    "If Err.Number <> 0 Then WScript.Quit 70",
    `command = "${command.replaceAll('"', '""')}"`,
    "Err.Clear",
    "exitCode = shell.Run(command, 0, True)",
    "If Err.Number <> 0 Then WScript.Quit 70",
    "WScript.Quit exitCode",
    "",
  ].join("\r\n");
  const arguments_ = `//B //NoLogo ${windowsQuote(launcherPath)}`;
  return Object.freeze({
    name,
    marker,
    directory: dir,
    restartPolicy: Object.freeze({ count: RESTART_COUNT, intervalSeconds: RESTART_INTERVAL_MINUTES * 60 }),
    launcher: Object.freeze({ path: launcherPath, content: launcherContent }),
    action: Object.freeze({ execute: wscript, arguments: arguments_, workingDirectory: dir }),
    autoStart: !api,
  });
}

function requestFor(operation, plan) {
  if (!plan?.name || !plan.marker || !plan.action || !plan.directory) throw new Error("a gateway task plan is required");
  return {
    operation,
    name: plan.name,
    marker: plan.marker,
    execute: plan.action.execute,
    arguments: plan.action.arguments,
    workingDirectory: plan.action.workingDirectory,
    autoStart: plan.autoStart !== false,
  };
}

export function createWindowsTaskSchedulerAdapter({ runner = spawnSync, powershellPath = "powershell.exe" } = {}) {
  function invoke(operation, plan) {
    const result = runner(powershellPath, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(windowsTaskSchedulerScript, "utf16le").toString("base64"),
    ], {
      input: JSON.stringify(requestFor(operation, plan)),
      encoding: "utf8",
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      if (result.error?.code === "ETIMEDOUT") throw taskError(`Task Scheduler ${operation} timed out`, "TASK_SCHEDULER_TIMEOUT");
      if (result.status !== 0) {
        let failure;
        try { failure = JSON.parse(result.stdout); } catch { failure = null; }
        const code = ["TASK_SCHEDULER_ACCESS_DENIED", "TASK_SCHEDULER_OPERATION_FAILED"].includes(failure?.errorCode)
          ? failure.errorCode
          : result.error?.code === "EACCES" ? "TASK_SCHEDULER_ACCESS_DENIED" : "TASK_SCHEDULER_PROCESS_FAILED";
        const category = typeof failure?.errorCategory === "string" && /^[A-Za-z]+$/.test(failure.errorCategory)
          ? `; ${failure.errorCategory}` : "";
        throw taskError(`Task Scheduler ${operation} failed (${code}${category})`, code);
      }
      throw taskError(`Task Scheduler ${operation} failed (TASK_SCHEDULER_PROCESS_FAILED)`, "TASK_SCHEDULER_PROCESS_FAILED");
    }
    try { return JSON.parse(result.stdout); }
    catch { throw taskError(`Task Scheduler ${operation} returned invalid status`, "TASK_SCHEDULER_INVALID_STATUS"); }
  }
  return Object.freeze({
    status: async (plan) => invoke("status", plan),
    register: async (plan) => invoke("register", plan),
    start: async (plan) => invoke("start", plan),
    disable: async (plan) => invoke("disable", plan),
    enable: async (plan) => invoke("enable", plan),
    unregister: async (plan) => invoke("unregister", plan),
  });
}

async function inspect(plan, adapter) {
  if (!adapter || typeof adapter.status !== "function") throw new Error("Task Scheduler adapter is required");
  const status = await adapter.status(plan);
  if (status?.exists && !status.owned) throw new Error("gateway task ownership conflict; refusing to modify the task");
  return status;
}

function requireMatchingSpec(status) {
  if (status?.exists && status.owned && status.specMatches !== true) {
    throw new Error("owned gateway task specification changed; refusing to modify or dispatch it");
  }
}

export async function statusOwnedGatewayTask(plan, adapter) {
  return inspect(plan, adapter);
}

function taskPlanFingerprint(plan) {
  const fingerprint = {
    name: plan.name,
    marker: plan.marker,
    directory: plan.directory,
    action: plan.action,
    launcherPath: plan.launcher?.path,
    launcherContent: plan.launcher?.content,
  };
  if (plan.autoStart === false) fingerprint.autoStart = false;
  if (plan.restartPolicy) fingerprint.restartPolicy = plan.restartPolicy;
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
}

function gatewayPathLiteral(scriptPath) {
  const resolved = absolutePath(scriptPath, "gateway script path");
  return windowsQuote(resolved).replaceAll('"', '""');
}

export function rebaseGatewayTaskSnapshot(snapshot, oldPlan, newPlan, { fromScriptPath, toScriptPath } = {}) {
  if (snapshot?.version !== 1 || snapshot.taskName !== oldPlan?.name || snapshot.marker !== oldPlan?.marker
      || snapshot.planFingerprint !== taskPlanFingerprint(oldPlan)) {
    throw new Error("gateway task snapshot does not match the old task plan");
  }
  const unchanged = snapshot.taskName === newPlan?.name
    && snapshot.marker === newPlan?.marker
    && oldPlan.directory === newPlan?.directory
    && JSON.stringify(oldPlan.action) === JSON.stringify(newPlan?.action)
    && JSON.stringify(oldPlan.restartPolicy) === JSON.stringify(newPlan?.restartPolicy)
    && oldPlan.launcher?.path === newPlan?.launcher?.path;
  if (!unchanged) throw new Error("task plan changed outside the gateway script");
  const oldLiteral = gatewayPathLiteral(fromScriptPath);
  const newLiteral = gatewayPathLiteral(toScriptPath);
  const oldContent = oldPlan.launcher?.content;
  const newContent = newPlan.launcher?.content;
  const occurrences = typeof oldContent === "string" ? oldContent.split(oldLiteral).length - 1 : 0;
  if (occurrences !== 1 || newContent !== oldContent.replace(oldLiteral, newLiteral)) {
    throw new Error("gateway task launcher change is not the exact script-path relocation");
  }
  return Object.freeze({ ...snapshot, planFingerprint: taskPlanFingerprint(newPlan) });
}

export async function snapshotGatewayTask(plan, adapter) {
  const current = await inspect(plan, adapter);
  requireMatchingSpec(current);
  return Object.freeze({
    version: 1,
    taskName: plan.name,
    marker: plan.marker,
    planFingerprint: taskPlanFingerprint(plan),
    priorExists: Boolean(current.exists),
    priorOwned: Boolean(current.exists && current.owned),
  });
}

export async function registerOwnedGatewayTask(plan, adapter) {
  const current = await inspect(plan, adapter);
  requireMatchingSpec(current);
  if (!current.exists || !current.owned) {
    if (typeof adapter.register !== "function") throw new Error("Task Scheduler registration is unavailable");
    await adapter.register(plan);
  }
  const verified = await inspect(plan, adapter);
  if (!verified.exists || !verified.owned || verified.specMatches !== true || !verified.enabled) throw new Error("gateway task registration could not be verified");
  return verified;
}

export async function installOwnedGatewayTask(plan, adapter) {
  const snapshot = await snapshotGatewayTask(plan, adapter);
  await registerOwnedGatewayTask(plan, adapter);
  return snapshot;
}

export async function startOwnedGatewayTask(plan, adapter) {
  const current = await inspect(plan, adapter);
  requireMatchingSpec(current);
  if (!current.exists) throw new Error("owned gateway task is not registered");
  if (!current.owned) throw new Error("gateway task ownership conflict; refusing to start the task");
  if (!current.enabled) throw new Error("owned gateway task is disabled");
  if (typeof adapter.start !== "function") throw new Error("Task Scheduler start is unavailable");
  return adapter.start(plan);
}

export async function disableOwnedGatewayTask(plan, adapter) {
  const current = await inspect(plan, adapter);
  requireMatchingSpec(current);
  if (!current.exists) return {disabled: false, reason: 'not_registered'};
  if (!current.owned) throw new Error("gateway task ownership conflict; refusing to disable the task");
  if (!current.enabled) return {disabled: true, alreadyDisabled: true};
  if (typeof adapter.disable !== 'function') throw new Error('Task Scheduler disable is unavailable');
  await adapter.disable(plan);
  const verified = await inspect(plan, adapter);
  requireMatchingSpec(verified);
  if (!verified.exists || !verified.owned || verified.enabled) throw new Error('owned gateway task disable could not be verified');
  return {disabled: true, alreadyDisabled: false};
}

export async function enableOwnedGatewayTask(plan, adapter) {
  const current = await inspect(plan, adapter);
  requireMatchingSpec(current);
  if (!current.exists) throw new Error('owned gateway task is not registered');
  if (!current.owned) throw new Error('gateway task ownership conflict; refusing to enable the task');
  if (current.enabled) return {enabled: true, alreadyEnabled: true};
  if (typeof adapter.enable !== 'function') throw new Error('Task Scheduler enable is unavailable');
  await adapter.enable(plan);
  const verified = await inspect(plan, adapter);
  requireMatchingSpec(verified);
  if (!verified.exists || !verified.owned || !verified.enabled) throw new Error('owned gateway task enable could not be verified');
  return {enabled: true, alreadyEnabled: false};
}

export async function unregisterOwnedGatewayTask(plan, adapter) {
  const current = await inspect(plan, adapter);
  requireMatchingSpec(current);
  if (!current.exists) return { removed: false };
  if (!current.owned) throw new Error("gateway task ownership conflict; refusing to remove the task");
  if (typeof adapter.unregister !== "function") throw new Error("Task Scheduler removal is unavailable");
  return adapter.unregister(plan);
}

export async function restoreGatewayTask(snapshot, plan, adapter) {
  if (snapshot?.version !== 1 || snapshot.taskName !== plan?.name || snapshot.marker !== plan?.marker ||
      snapshot.planFingerprint !== taskPlanFingerprint(plan)) {
    throw new Error("gateway task snapshot does not match the task plan");
  }
  const current = await inspect(plan, adapter);
  requireMatchingSpec(current);
  if (snapshot.priorExists) {
    if (!snapshot.priorOwned) throw new Error("refusing to restore a snapshot of an unowned task");
    if (!current.exists || !current.owned || !current.enabled) {
      throw new Error("previously owned gateway task changed; refusing to overwrite it");
    }
    return { restored: false, preserved: true };
  }
  if (!current.exists) return { restored: true, removed: false };
  if (!current.owned) throw new Error("gateway task ownership changed; refusing to remove it");
  const result = await unregisterOwnedGatewayTask(plan, adapter);
  return { restored: true, removed: Boolean(result?.removed) };
}

export function createOwnedGatewayTaskLauncher(plan, adapter) {
  return async ({ paths } = {}) => {
    if (!paths || path.resolve(paths.dir).toLowerCase() !== plan.directory.toLowerCase()) {
      throw new Error("gateway task plan does not match the requested gateway directory");
    }
    return startOwnedGatewayTask(plan, adapter);
  };
}
