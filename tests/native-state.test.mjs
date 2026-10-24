import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalWorkspace } from "../scripts/plugin-state.mjs";
import { NativeTasks, NativeWriterLease } from "../scripts/native-state.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "native-state.mjs");

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

function runCli(args, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-state-cli-"));
  const out = path.join(dir, "out");
  const err = path.join(dir, "err");
  const outFd = openSync(out, "w");
  const errFd = openSync(err, "w");
  let result;
  try {
    const childEnv = {...process.env};
    delete childEnv.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
    result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...childEnv, CODEX_THREAD_ID: "trusted-parent-A", CODEX_HOME: path.join(dir, "codex-home"), LOCALAPPDATA: path.join(dir, "local"), SOL_LUNA_PLUGIN_STATE: path.join(dir, "plugin-state"), ...env },
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(out, "utf8");
  const stderr = readFileSync(err, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout, stderr };
}

const root = await mkdtemp(path.join(os.tmpdir(), "native-state-"));
try {
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const stateDir = path.join(root, "state");
  const tasks = new NativeTasks({ stateDir });
  const dispatchTasks = new NativeTasks({stateDir: path.join(root, "dispatch-reservations")});
  const gatewayProfile = "cdefabcdefabcdefabcdefab";
  const gatewayBinding = {executor: "api", profileId: gatewayProfile, model: "mock-gateway-model", role: `native_api_${gatewayProfile}`, providerId: `api-native-${gatewayProfile}`};
  await assert.rejects(dispatchTasks.begin({parentThreadId: "parent-A", childThreadId: "unreserved-api-child", taskNonce: "unreserved-api-001", model: gatewayBinding.model, binding: gatewayBinding}), /dispatch intent|reservation/i);
  checks += 1;
  const concurrentGates = await Promise.allSettled([
    dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01", executor: "api", profileId: gatewayProfile, model: gatewayBinding.model}),
    dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01", executor: "api", profileId: gatewayProfile, model: gatewayBinding.model}),
  ]);
  equal(concurrentGates.filter(result => result.status === "fulfilled").length, 1, "only one concurrent gate can own a gateway dispatch nonce");
  equal(concurrentGates.filter(result => result.status === "rejected").length, 1, "a duplicate pending nonce is rejected instead of shared");
  await dispatchTasks.begin({parentThreadId: "parent-A", childThreadId: "concurrent-api-child", taskNonce: "concurrent-api-gate-01", model: gatewayBinding.model, binding: gatewayBinding});
  await assert.rejects(dispatchTasks.begin({parentThreadId: "parent-A", childThreadId: "second-api-child", taskNonce: "concurrent-api-gate-01", model: gatewayBinding.model, binding: gatewayBinding}), /intent|nonce|child/i);
  checks += 1;
  await assert.rejects(dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01", executor: "api", profileId: gatewayProfile, model: gatewayBinding.model}), /nonce|child|reuse/i);
  checks += 1;
  await dispatchTasks.finish({parentThreadId: "parent-A", childThreadId: "concurrent-api-child", status: "completed"});
  const followupIntent = await dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01", executor: "api", profileId: gatewayProfile, model: gatewayBinding.model, reuseChildThreadId: "concurrent-api-child"});
  equal(followupIntent.reuse_child_id, "concurrent-api-child", "a fresh follow-up intent is linked to its existing child");
  await dispatchTasks.cancelDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01"});
  equal((await dispatchTasks.assertOwner("concurrent-api-child", "parent-A")).status, "completed", "cancelling a rejected follow-up preserves the prior terminal status");
  await dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01", executor: "api", profileId: gatewayProfile, model: gatewayBinding.model, reuseChildThreadId: "concurrent-api-child"});
  const resumedGateway = await dispatchTasks.begin({parentThreadId: "parent-A", childThreadId: "concurrent-api-child", taskNonce: "concurrent-api-gate-01", model: gatewayBinding.model, binding: gatewayBinding});
  equal(resumedGateway.status, "running", "a gated follow-up resumes the exact completed child instead of creating a new identity");
  equal(await dispatchTasks.hasActiveGatewayExecutions(), true, "follow-up bind consumes intent and keeps the gateway alive for the existing child");
  await dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01", executor: "api", profileId: gatewayProfile, model: gatewayBinding.model, reuseChildThreadId: "concurrent-api-child"});
  await dispatchTasks.finish({parentThreadId: "parent-A", childThreadId: "concurrent-api-child", status: "completed"});
  equal(await dispatchTasks.hasActiveGatewayExecutions(), false, "terminal child completion clears a pending follow-up intent and active record");
  await dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "concurrent-api-gate-01", executor: "api", profileId: gatewayProfile, model: gatewayBinding.model, reuseChildThreadId: "concurrent-api-child"});
  await dispatchTasks.begin({parentThreadId: "parent-A", childThreadId: "concurrent-api-child", taskNonce: "concurrent-api-gate-01", model: gatewayBinding.model, binding: gatewayBinding});
  await dispatchTasks.finish({parentThreadId: "parent-A", childThreadId: "concurrent-api-child", status: "completed"});
  await dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "api-dispatch-001", executor: "api", profileId: "abcdefabcdefabcdefabcdef", model: "mock-api-model"});
  equal(await dispatchTasks.hasActiveGatewayExecutions(), true, "pending API dispatch reservation keeps the gateway alive before child bind");
  await assert.rejects(dispatchTasks.reserveDispatch({parentThreadId: "parent-B", taskNonce: "api-dispatch-001", executor: "api", profileId: "abcdefabcdefabcdefabcdef", model: "mock-api-model"}), /pending|different execution/);
  checks += 1;
  await dispatchTasks.begin({parentThreadId: "parent-A", childThreadId: "dispatch-child", taskNonce: "api-dispatch-001", model: "mock-api-model", binding: {executor: "api", profileId: "abcdefabcdefabcdefabcdef", model: "mock-api-model", role: "native_api_abcdefabcdefabcdefabcdef", providerId: "api-native-abcdefabcdefabcdefabcdef"}});
  equal(await dispatchTasks.hasActiveGatewayExecutions(), true, "atomic bind replaces the pending reservation with an active gateway child");
  equal((await dispatchTasks.cancelDispatch({parentThreadId: "parent-A", taskNonce: "api-dispatch-001"})).missing, true, "cancel cannot target an intent after atomic bind moved it to a real child");
  await dispatchTasks.finish({parentThreadId: "parent-A", childThreadId: "dispatch-child"});
  equal(await dispatchTasks.hasActiveGatewayExecutions(), false, "terminal child clears gateway activity after bind");
  await dispatchTasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "api-dispatch-002", executor: "deepseek", model: "deepseek/deepseek-flash"});
  equal((await dispatchTasks.cancelDispatch({parentThreadId: "parent-A", taskNonce: "api-dispatch-002"})).cancelled, true, "confirmed pre-spawn failure explicitly cancels its pending gateway intent");
  equal(await dispatchTasks.hasActiveGatewayExecutions(), false, "cancelled gateway intent no longer blocks idle shutdown");
  await dispatchTasks.reserveDispatch({parentThreadId: "trusted-parent-A", taskNonce: "cli-dispatch-cancel-01", executor: "deepseek", model: "deepseek/deepseek-flash"});
  const cancelCli = runCli(["dispatch-cancel", "--task-nonce", "cli-dispatch-cancel-01", "--state-dir", path.join(root, "dispatch-reservations")]);
  equal(cancelCli.status, 0, "native-state exposes the explicit confirmed pre-spawn cancellation path");
  equal(JSON.parse(cancelCli.stdout).task.cancelled, true, "dispatch-cancel removes only the trusted parent's pending intent");
  await tasks.begin({ parentThreadId: "parent-A", childThreadId: "child-A", model: "deepseek/deepseek-flash", workspace: workspaceA, taskNonce: "task-nonce-A" });
  await tasks.begin({ parentThreadId: "parent-B", childThreadId: "child-B", model: "gpt-6-luna", workspace: workspaceB, taskNonce: "task-nonce-B" });
  const profileId = "abcdefabcdefabcdefabcdef";
  const apiBinding = {
    executor: "api",
    profileId,
    model: "different-api-model",
    role: `native_api_${profileId}`,
    providerId: `api-native-${profileId}`,
  };
  await assert.rejects(tasks.begin({
    parentThreadId: "parent-A",
    childThreadId: "child-A",
    binding: apiBinding,
  }), /already has a different model/);
  checks += 1;
  await tasks.reserveDispatch({parentThreadId: "parent-A", taskNonce: "task-nonce-A", executor: "api", profileId, model: "deepseek/deepseek-flash", reuseChildThreadId: "child-A"});
  const lateBound = await tasks.begin({
    parentThreadId: "parent-A",
    childThreadId: "child-A",
    taskNonce: "task-nonce-A",
    binding: { ...apiBinding, model: "deepseek/deepseek-flash" },
  });
  equal(lateBound.binding.profileId, profileId, "a matching late binding preserves the original child model");
  equal((await tasks.owned("parent-A")).length, 1, "parent A sees only its own child");
  equal((await tasks.owned("parent-A"))[0].child_thread_id, "child-A", "parent A owns child A");
  equal((await tasks.owned("parent-B")).length, 1, "parent B sees only its own child");
  await assert.rejects(tasks.assertOwner("child-B", "parent-A"), /another parent chat/);
  checks += 1;
  await assert.rejects(tasks.begin({ parentThreadId: "parent-B", childThreadId: "child-A" }), /another parent chat/);
  checks += 1;
  await assert.rejects(tasks.begin({
    parentThreadId: "parent-A",
    childThreadId: "child-invalid-nonce",
    model: "deepseek/deepseek-flash",
    taskNonce: "--child",
  }), /taskNonce/);
  checks += 1;

  const leases = new NativeWriterLease({ stateDir });
  const realWorkspaceA = await realpath(workspaceA);
  const expectedCanonicalA = process.platform === "win32" ? realWorkspaceA.toLowerCase() : realWorkspaceA;
  const reserved = await leases.reserve({ workspace: workspaceA, parentThreadId: "parent-A", taskNonce: "task-nonce-A" });
  equal(reserved.workspace, expectedCanonicalA, "writer reservation canonicalizes via the OS real path");
  equal(await canonicalWorkspace(workspaceA), await canonicalWorkspace(realWorkspaceA), "short/long aliases canonicalize to one workspace");
  await assert.rejects(
    leases.reserve({ workspace: realWorkspaceA, parentThreadId: "parent-B", taskNonce: "alias-task-nonce" }),
    /already reserved by another native task/,
  );
  checks += 1;
  equal(reserved.state, "reserved", "lease starts reserved before spawn");
  const bound = await leases.bind({ workspace: workspaceA, parentThreadId: "parent-A", taskNonce: "task-nonce-A", childThreadId: "child-A" });
  equal(bound.state, "active", "lease binds the child explicitly");
  equal(bound.child_thread_id, "child-A", "child id is stored after bind");
  await assert.rejects(
    leases.reserve({ workspace: workspaceA, parentThreadId: "parent-B", taskNonce: "task-nonce-B" }),
    /already reserved by another native task/,
  );
  checks += 1;
  await assert.rejects(
    leases.bind({ workspace: workspaceA, parentThreadId: "parent-B", taskNonce: "task-nonce-B", childThreadId: "child-B" }),
    /reservation changed/,
  );
  checks += 1;
  const leaseB = await leases.reserve({ workspace: workspaceB, parentThreadId: "parent-B", taskNonce: "task-nonce-B" });
  ok(leaseB, "a different workspace admits a parallel reservation");
  equal(await leases.release({ workspace: workspaceA, parentThreadId: "parent-B", taskNonce: "task-nonce-B" }), false, "wrong chat cannot release another lease");
  equal(await leases.release({ workspace: workspaceA, parentThreadId: "parent-A", taskNonce: "task-nonce-A" }), true, "owner releases its reservation explicitly");
  equal(await leases.get(workspaceA), null, "released workspace has no residual lease");

  const cliState = path.join(root, "cli-state");
  const reserve = runCli(["reserve", "--workspace", workspaceA, "--task-nonce", "cli-task-nonce", "--state-dir", cliState]);
  equal(reserve.status, 0, "CLI reserve uses trusted CODEX_THREAD_ID without --parent");
  const bind = runCli(["bind", "--workspace", workspaceA, "--task-nonce", "cli-task-nonce", "--child", "cli-child", "--model", "deepseek/deepseek-flash", "--state-dir", cliState]);
  equal(bind.status, 0, "CLI bind records the actual child");
  const whoA = runCli(["who", "--state-dir", cliState], { CODEX_THREAD_ID: "trusted-parent-A" });
  equal(JSON.parse(whoA.stdout).owned.length, 1, "trusted parent sees its own child");
  const whoB = runCli(["who", "--state-dir", cliState], { CODEX_THREAD_ID: "trusted-parent-B" });
  equal(JSON.parse(whoB.stdout).owned.length, 0, "another parent cannot see the child");
  const forged = runCli(["reserve", "--workspace", workspaceB, "--task-nonce", "forged-nonce", "--parent", "trusted-parent-B", "--state-dir", cliState]);
  equal(forged.status, 1, "CLI rejects --parent ownership forgery");
  assert.match(forged.stderr, /--parent is not accepted/);
  checks += 1;
  const finished = runCli(["finish", "--workspace", workspaceA, "--task-nonce", "cli-task-nonce", "--child", "cli-child", "--state-dir", cliState]);
  equal(finished.status, 0, "CLI finish releases the reservation");
  equal((await new NativeWriterLease({ stateDir: cliState }).get(workspaceA)), null, "finish releases the workspace lease");

  const readonlyState = path.join(root, "readonly-api-state");
  const readonlyProfile = "abcdefabcdefabcdefabcdef";
  const writer = runCli(["reserve", "--workspace", workspaceA, "--task-nonce", "writer-keep-nonce", "--state-dir", readonlyState]);
  equal(writer.status, 0, "a writer reservation can coexist with read-only API recording");
  const recordArgs = [
    "record", "--workspace", workspaceA, "--task-nonce", "api-record-nonce", "--child", "api-readonly-child",
    "--model", "api-readonly-model", "--executor", "api", "--profile-id", readonlyProfile,
    "--role", `native_api_${readonlyProfile}`, "--provider-id", `api-native-${readonlyProfile}`,
    "--state-dir", readonlyState,
  ];
  const unreservedRecord = runCli(recordArgs);
  equal(unreservedRecord.status, 1, "native-state CLI refuses to record an API child without a gateway intent");
  assert.match(unreservedRecord.stderr, /matching pending dispatch intent/);
  checks += 1;
  await new NativeTasks({stateDir: readonlyState}).reserveDispatch({parentThreadId: "trusted-parent-A", taskNonce: "api-record-nonce", executor: "api", profileId: readonlyProfile, model: "api-readonly-model"});
  const recorded = runCli(recordArgs);
  equal(recorded.status, 0, "read-only API child can be recorded without taking the writer lease");
  const recordedTask = JSON.parse(recorded.stdout).task;
  equal(recordedTask.binding.profileId, readonlyProfile, "record stores the complete API binding");
  equal(recordedTask.binding.model, "api-readonly-model", "record stores the exact API model");
  const swallowedNonce = runCli([
    "record", "--workspace", workspaceA, "--task-nonce", "--child", "api-invalid-nonce",
    "--model", "api-readonly-model", "--executor", "api", "--profile-id", readonlyProfile,
    "--role", `native_api_${readonlyProfile}`, "--provider-id", `api-native-${readonlyProfile}`,
    "--state-dir", readonlyState,
  ]);
  equal(swallowedNonce.status, 1, "a flag following --task-nonce is rejected instead of becoming the nonce");
  assert.match(swallowedNonce.stderr, /taskNonce|task-nonce/);
  equal((await new NativeWriterLease({ stateDir: readonlyState }).get(workspaceA)).state, "reserved",
    "recording a read-only API child leaves the unrelated writer reservation intact");
  const recordedBinding = runCli(["binding", "--child", "api-readonly-child", "--state-dir", readonlyState]);
  equal(JSON.parse(recordedBinding.stdout).binding.profileId, readonlyProfile, "binding reads the recorded API profile");
  await new NativeTasks({stateDir: readonlyState}).reserveDispatch({parentThreadId: "trusted-parent-A", taskNonce: "api-record-nonce", executor: "api", profileId: readonlyProfile, model: "api-readonly-model", reuseChildThreadId: "api-readonly-child"});
  const cancelFollowupCli = runCli(["dispatch-cancel", "--task-nonce", "api-record-nonce", "--state-dir", readonlyState]);
  equal(cancelFollowupCli.status, 0, "CLI can cancel a confirmed rejected follow-up intent");
  equal((await new NativeTasks({stateDir: readonlyState}).assertOwner("api-readonly-child", "trusted-parent-A")).status, "running",
    "follow-up cancellation preserves the active child instead of completing or interrupting it");
  await new NativeTasks({stateDir: readonlyState}).reserveDispatch({parentThreadId: "trusted-parent-A", taskNonce: "api-record-nonce", executor: "api", profileId: readonlyProfile, model: "api-readonly-model", reuseChildThreadId: "api-readonly-child"});
  const sameChildFollowup = runCli(recordArgs);
  equal(sameChildFollowup.status, 0, "the same read-only child can continue with its original binding");
  equal(JSON.parse(sameChildFollowup.stdout).task.binding.profileId, readonlyProfile,
    "same-child follow-up keeps the original API profile");
  const crossParent = runCli(recordArgs, { CODEX_THREAD_ID: "trusted-parent-B" });
  equal(crossParent.status, 1, "another parent cannot overwrite the recorded API child");
  assert.match(crossParent.stderr, /another parent chat/);
  const changedModel = runCli(recordArgs.map((value) => value === "api-readonly-model" ? "different-model" : value));
  equal(changedModel.status, 1, "a recorded API child model is immutable");
  assert.match(changedModel.stderr, /different model|immutable/i);
  const completed = runCli(["complete", "--child", "api-readonly-child", "--status", "completed", "--state-dir", readonlyState]);
  equal(completed.status, 0, "complete finishes only the API task record");
  equal(JSON.parse(completed.stdout).task.status, "completed", "complete reports the task status");
  equal((await new NativeWriterLease({ stateDir: readonlyState }).get(workspaceA)).state, "reserved",
    "complete does not release another writer lease");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native state assertions`);
