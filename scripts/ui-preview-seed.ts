import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import { AuthStore } from "../application/api/auth-store.ts";
import type { Actor } from "../application/domain/authorization.ts";
import type { AttemptView, SessionView } from "../application/domain/model.ts";
import { Hub } from "../application/orchestration/hub.ts";
import type { PreviewPaths } from "./ui-preview-ownership.ts";

const scenarioSchema = z.strictObject({
  taskId: z.string(),
  sessionId: z.string(),
  attemptId: z.string(),
  predecessorAttemptId: z.string().optional(),
  requestId: z.string().optional(),
  resultId: z.string().optional(),
});
const manifestSchema = z.strictObject({
  kind: z.literal("work-hub-ui-preview-scenarios"),
  version: z.literal(1),
  scenarios: z.strictObject({
    activeOutput: scenarioSchema,
    blockingQuestion: scenarioSchema,
    resultReview: scenarioSchema,
    completedWithoutResult: scenarioSchema,
    failedStopped: scenarioSchema,
    answeredDeliveryUnknown: scenarioSchema,
    limitedHistory: scenarioSchema,
  }),
});
export type PreviewScenarioManifest = z.infer<typeof manifestSchema>;

type SeededAttempt = {
  readonly taskId: string;
  readonly attempt: AttemptView;
  readonly session: SessionView;
};

export async function seedPreview(paths: PreviewPaths): Promise<PreviewScenarioManifest> {
  if (existsSync(paths.scenariosPath)) {
    for (const path of [paths.hubPath, paths.simulatorPath, paths.authPath, paths.tokenPath]) {
      if (!existsSync(path)) throw new PreviewSeedError("Preview state is incomplete; refusing to replace existing credentials or data.");
    }
    return manifestSchema.parse(JSON.parse(readFileSync(paths.scenariosPath, "utf8")));
  }
  if (existsSync(paths.hubPath)) throw new PreviewSeedError("Preview Hub data exists without a scenario manifest; reset it before seeding.");
  bootstrapToken(paths);
  const hub = new Hub(paths.hubPath, { mode: "simulator" });
  try {
    const actor = hub.actorForUser("user-admin");
    if (actor === undefined) throw new PreviewSeedError("The built-in preview administrator is unavailable.");
    const manifest = await createScenarios(hub, actor);
    writeFileSync(paths.scenariosPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return manifest;
  } finally {
    hub.close();
  }
}

async function createScenarios(hub: Hub, actor: Actor): Promise<PreviewScenarioManifest> {
  const simulator = hub.simulator;
  if (simulator === undefined) throw new PreviewSeedError("The preview must use the built-in simulator.");

  const active = await createAttempt(hub, actor, "active-output", "Active output", "profile-structured");
  simulator.controls.emitOutput(active.session.id, "Artificial preview output: implementation is actively progressing.", active.attempt.id);
  await hub.reconcile();

  const blocking = await createAttempt(hub, actor, "blocking-question", "Blocking question", "profile-structured");
  simulator.controls.emitQuestion(questionInput(blocking, actor, "preview-question-open", "Which acceptance target should this artificial preview use?"));
  await hub.reconcile();
  const blockingRequest = hub.getDashboard(actor).answerNeeded.find((request) => request.attemptId === blocking.attempt.id);
  if (blockingRequest === undefined) throw new PreviewSeedError("The blocking question scenario was not observed.");

  const review = await createAttempt(hub, actor, "result-review", "Result awaiting review", "profile-structured");
  simulator.controls.emitResult({ hubSessionId: review.session.id, hubAttemptId: review.attempt.id,
    bindingGeneration: review.session.bindingGeneration,
    summary: "Artificial preview result: review the demonstrated outcome before accepting it.", referenceIds: [] });
  await hub.reconcile();
  const result = hub.snapshot(actor).results.find((candidate) => candidate.attemptId === review.attempt.id);
  if (result === undefined) throw new PreviewSeedError("The result review scenario was not observed.");

  const completed = await createAttempt(hub, actor, "completed-no-result", "Completed without result", "profile-structured");
  simulator.controls.emitTermination(terminationInput(completed, "completed"));
  await hub.reconcile();

  const failed = await createAttempt(hub, actor, "failed-stopped", "Failed and stopped", "profile-structured");
  simulator.controls.emitTermination(terminationInput(failed, "failed"));
  await hub.reconcile();
  const stopped = await createStoppedRetry(hub, actor, failed);

  const limited = await createAttempt(hub, actor, "limited-history", "Limited capability and history", "profile-limited");
  simulator.controls.emitOutput(limited.session.id, "Artificial preview output with intentionally partial history.", limited.attempt.id);
  simulator.controls.addHistoryGap(limited.session.id, "Artificial preview gap: earlier native history is unavailable.");
  await hub.reconcile();

  const delivery = await createAttempt(hub, actor, "delivery-unknown", "Answered with unknown delivery", "profile-structured");
  simulator.controls.emitQuestion(questionInput(delivery, actor, "preview-question-delivery", "Should this artificial delivery proceed?"));
  await hub.reconcile();
  const deliveryRequest = hub.getDashboard(actor).answerNeeded.find((request) => request.attemptId === delivery.attempt.id);
  if (deliveryRequest === undefined) throw new PreviewSeedError("The delivery question scenario was not observed.");
  simulator.controls.scriptNext("runtime.deliverResponse", { kind: "unknown_after_effect" });
  simulator.controls.setDeliveryLookupAvailable(delivery.session.id, false);
  await hub.execute(actor, { commandId: "preview-answer-delivery", type: "request.respond",
    target: { kind: "request", id: deliveryRequest.id },
    expected: { request: deliveryRequest.revision, bindingGeneration: delivery.session.bindingGeneration },
    payload: { answer: { kind: "text", text: "Proceed with the artificial preview path." } } });
  await hub.drain({ limit: 1 });

  return manifestSchema.parse({ kind: "work-hub-ui-preview-scenarios", version: 1, scenarios: {
    activeOutput: scenario(active),
    blockingQuestion: { ...scenario(blocking), requestId: blockingRequest.id },
    resultReview: { ...scenario(review), resultId: result.id },
    completedWithoutResult: scenario(completed),
    failedStopped: { ...scenario(stopped), predecessorAttemptId: failed.attempt.id },
    answeredDeliveryUnknown: { ...scenario(delivery), requestId: deliveryRequest.id },
    limitedHistory: scenario(limited),
  } });
}

async function createStoppedRetry(hub: Hub, actor: Actor, predecessor: SeededAttempt): Promise<SeededAttempt> {
  const retry = await hub.execute(actor, { commandId: "preview-retry-stopped", type: "attempt.retry",
    target: { kind: "attempt", id: predecessor.attempt.id },
    expected: { task: hub.getTask(actor, predecessor.taskId).revision, profile: 1 },
    payload: { predecessorId: predecessor.attempt.id, profileId: "profile-structured",
      input: "current_task", sameSession: false, environment: { mode: "none" } } });
  await drainIdle(hub);
  const attemptId = retry.objectRefs.find((reference) => reference.kind === "attempt")?.id;
  const attempt = hub.snapshot(actor).attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined) throw new PreviewSeedError("The stopped retry scenario was not created.");
  const session = hub.getSession(actor, attempt.sessionId).session;
  await hub.execute(actor, { commandId: "preview-stop-retry", type: "attempt.stop",
    target: { kind: "attempt", id: attempt.id }, expected: { bindingGeneration: session.bindingGeneration },
    payload: { mode: "interrupt", reason: "Artificial preview stop request." } });
  await drainIdle(hub);
  return { taskId: predecessor.taskId, attempt, session };
}

async function createAttempt(hub: Hub, actor: Actor, id: string, title: string, profileId: "profile-structured" | "profile-limited"): Promise<SeededAttempt> {
  const taskReceipt = await hub.execute(actor, { commandId: `preview-task-${id}`, type: "task.create",
    payload: { projectId: "project-default", title: `[Preview] ${title}`,
      description: "Artificial preview evidence generated only inside the separately owned simulator directory." } });
  const taskId = taskReceipt.objectRefs.find((reference) => reference.kind === "task")?.id;
  if (taskId === undefined) throw new PreviewSeedError(`Task creation failed for scenario ${id}.`);
  const delegation = await hub.execute(actor, { commandId: `preview-delegate-${id}`, type: "attempt.delegate",
    target: { kind: "task", id: taskId }, expected: { task: 1, profile: 1 }, payload: {
      profileId, environment: { mode: "none" }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [],
    } });
  await drainIdle(hub);
  const attemptId = delegation.objectRefs.find((reference) => reference.kind === "attempt")?.id;
  const attempt = hub.snapshot(actor).attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined) throw new PreviewSeedError(`Delegation failed for scenario ${id}.`);
  return { taskId, attempt, session: hub.getSession(actor, attempt.sessionId).session };
}

async function drainIdle(hub: Hub): Promise<void> {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    if (await hub.drain() === 0) return;
  }
  throw new PreviewSeedError("Preview seeding did not reach an idle outbox.");
}

function bootstrapToken(paths: PreviewPaths): void {
  const tokenExists = existsSync(paths.tokenPath);
  const authExists = existsSync(paths.authPath);
  if (tokenExists !== authExists) throw new PreviewSeedError("Preview authentication files are incomplete; refusing to replace credentials.");
  if (tokenExists) return;
  const auth = new AuthStore(paths.authPath);
  try {
    writeFileSync(paths.tokenPath, `${auth.bootstrap("user-admin")}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    auth.close();
  }
}

function questionInput(seed: SeededAttempt, actor: Actor, requestId: string, prompt: string) {
  return { hubSessionId: seed.session.id, hubAttemptId: seed.attempt.id, requestId,
    projectId: "project-default", taskId: seed.taskId, recipient: { kind: "user" as const, userId: actor.id },
    bindingGeneration: seed.session.bindingGeneration, prompt, responseRoute: "native" as const,
    blocking: "runtime_action" as const };
}

function terminationInput(seed: SeededAttempt, termination: "completed" | "failed") {
  return { hubSessionId: seed.session.id, hubAttemptId: seed.attempt.id,
    bindingGeneration: seed.session.bindingGeneration, termination };
}

function scenario(seed: SeededAttempt) {
  return { taskId: seed.taskId, sessionId: seed.session.id, attemptId: seed.attempt.id };
}

export class PreviewSeedError extends Error {
  readonly name = "PreviewSeedError";
}
