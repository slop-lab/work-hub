import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ActionContext, AttemptStart, CallContext, OpenSessionInput, RuntimeTarget } from "../application/contracts/index.ts";
import { createSimulators } from "../application/simulator/index.ts";

const call = { workspaceId: "workspace", installationId: "sim-runtime", correlationId: "corr" } satisfies CallContext;
const action = (operationId: string): ActionContext => ({ ...call, commandId: `cmd-${operationId}`, operationId, inputDigest: `sha256:${operationId}`, authorizedGrantRefs: ["grant"] });
const route = { kind: "external", route: { id: "route", ownerInstallationId: "sim-runtime", kind: "simulated" } } as const;
const startInput = (target: AttemptStart["target"]): AttemptStart => ({ target, input: { id: `snapshot-${target.hubAttemptId}`, digest: `sha256:${target.hubAttemptId}`, taskId: "task", taskRevision: 1, profileId: "profile", profileRevision: 1, instruction: "work", selectedReferenceIds: [], selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: "2026-10-22T00:00:00Z" }, workAreas: [] });

test("attach is observation-only and does not submit initial work", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-runtime-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  const input: OpenSessionInput = { hubSessionId: "hub", route, configuration: {}, requestedControl: "observe", mode: "attach", nativeSession: { installationId: "sim-runtime", providerScope: "simulated", kind: "agent-session", id: "native", incarnation: "v1" }, sessionLaunchOwner: "external" };
  const receipt = await sims.runtime.openSession(action("open"), input);
  assert.equal(receipt.status, "confirmed");
  assert.equal(sims.calls.list().some((entry) => entry.operationKind === "runtime.startAttempt"), false);
  if (receipt.status === "confirmed") assert.equal(receipt.result.controlGrant.mode, "observe");
});

test("limited bridge profile rejects unsupported timing and exposes history gaps", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-limited-${process.pid}-${Date.now()}.sqlite`), { runtimeProfile: "limited_bridge" });
  t.after(() => sims.close());
  const opened = await sims.runtime.openSession(action("open-limited"), { hubSessionId: "hub", route, configuration: {}, requestedControl: "control", mode: "create", sessionLaunchOwner: "runtime_connector" });
  assert.equal(opened.status, "confirmed");
  if (opened.status !== "confirmed") return;
  const target: RuntimeTarget = { hubSessionId: "hub", nativeSession: opened.result.nativeSession, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id };
  const instruction = await sims.runtime.sendInstruction(action("instruct"), { target: { ...target, hubAttemptId: "attempt" }, text: "now", referenceIds: [], mode: "immediate" });
  assert.equal(instruction.status, "rejected");
  sims.controls.addHistoryGap("hub", "retention_truncated");
  const output = await sims.runtime.readOutput(call, { target, limit: 20 });
  assert.equal(output.coverage, "live_only");
  assert.equal(output.gaps[0]?.reason, "retention_truncated");
});

test("event replay is deterministic and stop uncertainty stays unresolved", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-events-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  const opened = await sims.runtime.openSession(action("open-structured"), { hubSessionId: "hub", route, configuration: {}, requestedControl: "control", mode: "create", sessionLaunchOwner: "runtime_connector" });
  assert.equal(opened.status, "confirmed");
  if (opened.status !== "confirmed") return;
  const target = { hubSessionId: "hub", nativeSession: opened.result.nativeSession, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id, hubAttemptId: "attempt" };
  const start: AttemptStart = { target, input: { id: "snapshot", digest: "sha256:snapshot", taskId: "task", taskRevision: 1, profileId: "profile", profileRevision: 1, instruction: "work", selectedReferenceIds: [], selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [], assembledAt: "2026-10-22T00:00:00Z" }, workAreas: [] };
  await sims.runtime.startAttempt(action("start"), start);
  sims.controls.emitOutput("hub", "one");
  sims.controls.emitOutput("hub", "two");
  const page = await sims.runtime.readOutput(call, { target, after: "1", limit: 10 });
  assert.deepEqual(page.items.map((item) => item.text), ["two"]);
  sims.controls.scriptNext("runtime.requestStop", { kind: "unknown_after_effect" });
  const stop = await sims.runtime.requestStop(action("stop"), { target, mode: "stop_work" });
  assert.equal(stop.status, "unknown");
  const observation = await sims.runtime.inspectSession(call, target);
  assert.equal(observation.value.execution.phase, "ended");
  sims.controls.setSessionMissing("hub");
  const missing = await sims.runtime.inspectSession(call, target);
  assert.equal(missing.value.exists, false);
  assert.equal(missing.value.limitations.includes("native_session_missing"), true);
});

test("admin question, result and termination controls persist in the separate simulator database", async (t) => {
  const path = join("/tmp", `workhub-admin-${process.pid}-${Date.now()}.sqlite`);
  const first = createSimulators(path);
  const opened = await first.runtime.openSession(action("open-admin"), { hubSessionId: "admin-session", route, configuration: {}, requestedControl: "control", mode: "create", sessionLaunchOwner: "runtime_connector" });
  assert.equal(opened.status, "confirmed");
  first.controls.emitQuestion({ hubSessionId: "admin-session", hubAttemptId: "attempt", requestId: "request", projectId: "project", taskId: "task", recipient: { kind: "user", userId: "human" }, bindingGeneration: 1, prompt: "Choose a safe option", responseRoute: "bridge", blocking: "runtime_action" });
  first.controls.emitResult({ hubSessionId: "admin-session", hubAttemptId: "attempt", bindingGeneration: 1, summary: "Completed", referenceIds: ["reference"] });
  first.controls.emitTermination({ hubSessionId: "admin-session", hubAttemptId: "attempt", bindingGeneration: 1, termination: "completed" });
  first.close();
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.sim`), true);

  const restored = createSimulators(path);
  t.after(() => restored.close());
  if (opened.status !== "confirmed") return;
  const target = { hubSessionId: "admin-session", nativeSession: opened.result.nativeSession, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id };
  const events = [];
  if (restored.runtime.subscribe !== undefined) for await (const event of restored.runtime.subscribe(call, { target })) events.push(event);
  assert.deepEqual(events.map((event) => event.payload.type), ["request.created", "result.submitted", "execution.observed"]);
  const observation = await restored.runtime.inspectSession(call, target);
  assert.equal(observation.value.execution.termination, "completed");
});

test("control transfer persists the returned grant for later mutation", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-control-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  const opened = await sims.runtime.openSession(action("open-observe"), { hubSessionId: "controlled", route, configuration: {}, requestedControl: "observe", mode: "attach", nativeSession: { installationId: "sim-runtime", providerScope: "simulated", kind: "agent-session", id: "controlled-native", incarnation: "v1" }, sessionLaunchOwner: "external" });
  assert.equal(opened.status, "confirmed");
  if (opened.status !== "confirmed") return;
  const oldTarget = { hubSessionId: "controlled", nativeSession: opened.result.nativeSession, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id };
  const transfer = await sims.runtime.requestControl(action("take-control"), { target: oldTarget, requestedActions: ["start_attempt"] });
  assert.equal(transfer.status, "confirmed");
  if (transfer.status !== "confirmed") return;
  const started = await sims.runtime.startAttempt(action("controlled-start"), startInput({ ...oldTarget, controlGrantRef: transfer.result.id, hubAttemptId: "controlled-attempt" }));
  assert.equal(started.status, "confirmed");
});

test("attaching a seeded active native session preserves running observation", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-seeded-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  const nativeSession = { installationId: "sim-runtime", providerScope: "simulated", kind: "agent-session", id: "seeded-native", incarnation: "v3" };
  sims.controls.seedSession({ hubSessionId: "seeded", nativeSession, controlMode: "observe", phase: "running", hubAttemptId: "external-attempt", history: "partial" });
  const opened = await sims.runtime.openSession(action("attach-seeded"), { hubSessionId: "seeded", route, configuration: {}, requestedControl: "observe", mode: "attach", nativeSession, sessionLaunchOwner: "external" });
  assert.equal(opened.status, "confirmed");
  if (opened.status !== "confirmed") return;
  const observation = await sims.runtime.inspectSession(call, { hubSessionId: "seeded", nativeSession, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id });
  assert.equal(observation.value.execution.phase, "running");
  assert.equal(observation.value.execution.hubAttemptId, "external-attempt");
});

test("runtime readiness and target identity failures are deterministic", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-readiness-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  sims.controls.setRuntimeReadiness("route", { ready: false, unmetRequirements: ["runtime_unavailable"] });
  const readiness = await sims.runtime.probe(call, route);
  assert.equal(readiness.value.ready, false);
  const opened = await sims.runtime.openSession(action("open-target"), { hubSessionId: "target", route, configuration: {}, requestedControl: "control", mode: "create", sessionLaunchOwner: "runtime_connector" });
  assert.equal(opened.status, "confirmed");
  if (opened.status !== "confirmed") return;
  const wrongNative = { ...opened.result.nativeSession, incarnation: "replacement" };
  const rejected = await sims.runtime.startAttempt(action("wrong-native"), startInput({ hubSessionId: "target", nativeSession: wrongNative, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id, hubAttemptId: "attempt" }));
  assert.equal(rejected.status, "rejected");
  const target = { hubSessionId: "target", nativeSession: opened.result.nativeSession, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id, hubAttemptId: "attempt" };
  assert.equal((await sims.runtime.startAttempt(action("right-target"), startInput(target))).status, "confirmed");
  assert.equal((await sims.runtime.sendInstruction(action("wrong-grant"), { target: { ...target, controlGrantRef: "stale-grant" }, text: "unsafe", referenceIds: [], mode: "immediate" })).status, "rejected");
  assert.equal((await sims.runtime.requestStop(action("wrong-attempt"), { target: { ...target, hubAttemptId: "other-attempt" }, mode: "stop_work" })).status, "rejected");
});

test("output and admin events share one monotonic cursor without collisions", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-cursors-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  const opened = await sims.runtime.openSession(action("open-cursors"), { hubSessionId: "cursors", route, configuration: {}, requestedControl: "control", mode: "create", sessionLaunchOwner: "runtime_connector" });
  assert.equal(opened.status, "confirmed");
  if (opened.status !== "confirmed") return;
  sims.controls.emitOutput("cursors", "one");
  sims.controls.emitQuestion({ hubSessionId: "cursors", hubAttemptId: "attempt", requestId: "question", projectId: "project", recipient: { kind: "project_members", projectId: "project" }, bindingGeneration: 1, prompt: "question", responseRoute: "bridge", blocking: "none" });
  sims.controls.emitOutput("cursors", "three");
  const target = { hubSessionId: "cursors", nativeSession: opened.result.nativeSession, bindingGeneration: 1, controlGrantRef: opened.result.controlGrant.id };
  const events = [];
  if (sims.runtime.subscribe !== undefined) for await (const event of sims.runtime.subscribe(call, { target })) events.push(event);
  assert.deepEqual(events.map((event) => event.sourceCursor), ["1", "2", "3"]);
  const resumed = [];
  if (sims.runtime.subscribe !== undefined) for await (const event of sims.runtime.subscribe(call, { target, after: "1" })) resumed.push(event);
  assert.deepEqual(resumed.map((event) => event.sourceCursor), ["2", "3"]);
});

test("twenty simulated sessions keep independent streams and enforce output size", async (t) => {
  const sims = createSimulators(join("/tmp", `workhub-envelope-${process.pid}-${Date.now()}.sqlite`));
  t.after(() => sims.close());
  for (let index = 0; index < 20; index += 1) sims.controls.emitOutput(`session-${index}`, `output-${index}`);
  for (let index = 0; index < 20; index += 1) {
    const page = await sims.runtime.readOutput(call, { target: { hubSessionId: `session-${index}`, nativeSession: { installationId: "sim-runtime", providerScope: "simulated", kind: "agent-session", id: `native:session-${index}`, incarnation: "v1" }, bindingGeneration: 1, controlGrantRef: `control:session-${index}` }, limit: 10 });
    assert.equal(page.items[0]?.text, `output-${index}`);
    assert.equal(page.nextCursor, "1");
  }
  assert.throws(() => sims.controls.emitOutput("oversized", "x".repeat(65_537)));
});
