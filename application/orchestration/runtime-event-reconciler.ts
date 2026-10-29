import {
  RecipientSchema, RequestValiditySchema, type NativeRequestEvent, type RuntimeEvent,
} from "../contracts/index.ts";
import type { Actor } from "../domain/authorization.ts";
import { assertNever } from "../domain/assert-never.ts";
import { HubError } from "../domain/errors.ts";
import { validatePublication } from "../commands/request-publication.ts";
import type { CommandOf } from "../commands/types.ts";
import { answerSchemaSchema, jsonObjectSchema } from "../domain/schema-common.ts";
import type { ExecutionRepository } from "../persistence/execution-repository.ts";
import type { InteractionRepository } from "../persistence/interaction-repository.ts";
import type { ResultRepository } from "../persistence/result-repository.ts";
import type { StateRepository } from "../persistence/state-repository.ts";
import type { LifecycleRepository } from "../persistence/lifecycle-repository.ts";
import type { WorkRepository } from "../persistence/work-repository.ts";
import { z } from "zod";
import { canonicalJson, digest } from '../persistence/codec.ts';

export class RuntimeEventReconciler {
  private readonly input: {
    readonly state: StateRepository; readonly execution: ExecutionRepository;
    readonly interactions: InteractionRepository; readonly results: ResultRepository;
    readonly lifecycle?: LifecycleRepository; readonly work?: WorkRepository;
  };

  constructor(input: RuntimeEventReconciler["input"]) { this.input = input; }

  apply(workspaceId: string, sessionId: string, installationId: string, event: RuntimeEvent): void {
    if (event.bindingGeneration !== this.input.execution.getSession(workspaceId, sessionId).bindingGeneration ||
      !this.nativeSessionMatches(workspaceId, sessionId, event) ||
      !this.eventTargetsSessionAttempt(workspaceId, sessionId, event)) return;
    const publication = event.payload.type === "request.created"
      ? this.runtimePublication(workspaceId, sessionId, installationId,
          event.bindingGeneration, event.payload.request)
      : undefined;
    if (publication === false) return;
    const sourceEventId = event.sourceEventId ??
      `${event.streamScope}:${event.sourceSequence ?? event.sourceCursor ?? event.observedAt}`;
    this.input.state.claimInboundEvent({ workspaceId, installationId, sourceEventId,
      bindingGeneration: event.bindingGeneration, event }, () => {
      switch (event.payload.type) {
      case "output":
        this.input.state.saveOutput({ workspaceId, sessionId,
          ...(event.payload.item.hubAttemptId === undefined ? {} : {
            attemptId: event.payload.item.hubAttemptId,
          }), bindingGeneration: event.bindingGeneration, sourceItemId: sourceEventId,
          item: event.payload.item });
        return;
      case "execution.observed": {
        const attemptId = event.payload.observation.hubAttemptId;
        if (attemptId !== undefined && this.input.state.attemptBelongs(workspaceId, sessionId, attemptId)) {
          this.applyExecution(workspaceId, attemptId, event.payload.observation);
        }
        return;
      }
      case "request.created":
        if (publication === undefined) return;
        this.input.interactions.createRequest({ workspaceId, authorId: `runtime:${installationId}`,
          projectId: publication.projectId,
          ...(publication.taskId === undefined ? {} : { taskId: publication.taskId }),
          ...(publication.sessionId === undefined ? {} : { sessionId: publication.sessionId }),
          ...(publication.attemptId === undefined ? {} : { attemptId: publication.attemptId }),
          ...(publication.bindingGeneration === undefined ? {} : {
            bindingGeneration: publication.bindingGeneration,
          }), kind: publication.kind, recipient: publication.recipient, prompt: publication.prompt,
          ...(publication.reason === undefined ? {} : { reason: publication.reason }),
          referenceIds: publication.referenceIds, answerSchema: publication.answerSchema,
          blocking: publication.blocking, validity: publication.validity,
          ...(publication.actionDescription === undefined ? {} : {
            actionDescription: publication.actionDescription,
          }), ...(publication.supersedesRequestId === undefined ? {} : {
            supersedesRequestId: publication.supersedesRequestId,
          }), responseRoute: publication.responseRoute });
        return;
      case "request.invalidated":
        this.input.interactions.invalidateNativeRequest({ workspaceId, sessionId,
          bindingGeneration: event.bindingGeneration,
          installationId: event.payload.nativeRequestRef.installationId,
          providerScope: event.payload.nativeRequestRef.providerScope,
          kind: event.payload.nativeRequestRef.kind, nativeId: event.payload.nativeRequestRef.id,
          reason: event.payload.reason });
        return;
      case "response.acknowledged":
        this.input.interactions.acknowledgeDeliveryScoped({ workspaceId, sessionId,
          bindingGeneration: event.bindingGeneration, responseId: event.payload.responseId,
          responseDigest: event.payload.responseDigest });
        return;
      case "result.submitted": {
        const attempt = this.input.execution.getAttempt(workspaceId, event.payload.attemptId);
        this.input.results.create({ workspaceId, taskId: attempt.taskId, attemptId: attempt.id,
          authorId: `runtime:${installationId}`, summary: event.payload.summary,
          limitations: [], referenceIds: event.payload.referenceIds, artifacts: [],
          evidence: [{ origin: "runtime_observation", detail: canonicalJson({
            sourceInstallationId: installationId, nativeSession: event.nativeSession,
            sourceEventId, contentDigest: digest(event.payload.summary),
            observation: 'Captured runtime report, not independent commit or CI verification.',
          }) }], outcome: "unspecified", kind: "checkpoint", criterionEvidence: [] });
        return;
      }
      case "gap":
        this.input.state.saveOutput({ workspaceId, sessionId,
          bindingGeneration: event.bindingGeneration, sourceItemId: sourceEventId,
          item: { kind: "gap", reason: event.payload.reason, observedAt: event.observedAt } });
        return;
      case "extension": this.applyLifecycleExtension(workspaceId, sessionId, installationId,
        event.payload.namespace, event.payload.data); return;
        default: return assertNever(event.payload);
      }
    });
  }

  private applyLifecycleExtension(workspaceId: string, sessionId: string, installationId: string,
    namespace: string, data: Readonly<Record<string, unknown>>): void {
    const session = this.input.execution.getSession(workspaceId, sessionId);
    const parsed = z.object({ kind: z.string() }).passthrough().safeParse(data);
    if (!parsed.success) return;
    if (this.input.lifecycle === undefined || this.input.work === undefined) return;
    this.input.work.addEntry(workspaceId, session.taskId, `runtime:${installationId}`, "runtime_report", {
      providerLifecycle: { namespace, ...parsed.data }, sessionId,
      ...(session.activeAttemptId === undefined ? {} : { attemptId: session.activeAttemptId }),
    });
    if (session.activeAttemptId === undefined) return;
    if (namespace === "workhub.codex.lifecycle.v1") {
      if (parsed.data.kind === "retry_observed") this.input.lifecycle.reconcileAttempt({ workspaceId,
        attemptId: session.activeAttemptId, interruption: "retryable_failure",
        recovery: parsed.data["willRetry"] === true ? "observe" : "reconcile" });
      if (parsed.data.kind === "provider_error_observed" && parsed.data["willRetry"] !== true) {
        this.input.lifecycle.reconcileAttempt({ workspaceId, attemptId: session.activeAttemptId,
          interruption: "retryable_failure", recovery: "reconcile" });
      }
      return;
    }
    if (namespace !== "workhub.claude.lifecycle.v1") return;
    if (parsed.data.kind === "retry") this.input.lifecycle.reconcileAttempt({ workspaceId,
      attemptId: session.activeAttemptId, interruption: "retryable_failure", recovery: "observe" });
    if (parsed.data.kind === "rate_limit" && parsed.data["status"] === "rejected") {
      this.input.lifecycle.reconcileAttempt({ workspaceId, attemptId: session.activeAttemptId,
        interruption: "retryable_failure", recovery: "observe" });
    }
    if (parsed.data.kind === "state" && parsed.data["state"] === "requires_action") {
      this.input.lifecycle.reconcileAttempt({ workspaceId, attemptId: session.activeAttemptId,
        interruption: "awaiting_input", recovery: "observe" });
    }
  }

  applyExecution(workspaceId: string, attemptId: string, observation: {
    readonly phase: "idle" | "running" | "waiting_input" | "ended" | "unknown";
    readonly termination?: "completed" | "stopped" | "failed" | "unknown";
  }): void {
    switch (observation.phase) {
      case "idle": return;
      case "running": this.input.state.setAttemptPhase(workspaceId, attemptId, "running"); return;
      case "waiting_input": this.input.state.setAttemptPhase(workspaceId, attemptId, "waiting_input"); return;
      case "unknown": return;
      case "ended":
        switch (observation.termination) {
          case "completed": this.input.state.finishAttempt(workspaceId, attemptId, "ended_without_result"); return;
          case "stopped": this.input.state.finishAttempt(workspaceId, attemptId, "canceled"); return;
          case "failed": this.input.state.finishAttempt(workspaceId, attemptId, "failed"); return;
          case "unknown":
          case undefined: return;
          default: return assertNever(observation.termination);
        }
      default: return assertNever(observation.phase);
    }
  }

  private runtimePublication(
    workspaceId: string, sessionId: string, installationId: string,
    bindingGeneration: number, request: NativeRequestEvent,
  ): CommandOf<"request.create">["payload"] | false {
    const draft = request.draft;
    const { actionDescription, ...draftBase } = draft;
    const attemptId = draft.validity.kind === "attempt" ? draft.validity.target.hubAttemptId : undefined;
    const publication: CommandOf<"request.create">["payload"] = {
      ...draftBase, recipient: RecipientSchema.parse(draft.recipient),
      answerSchema: answerSchemaSchema.parse(draft.answerSchema),
      referenceIds: [...draft.referenceIds], sessionId, bindingGeneration,
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(actionDescription === undefined ? {} : {
        actionDescription: jsonObjectSchema.parse(actionDescription),
      }),
      responseRoute: request.responseRoute,
      validity: RequestValiditySchema.parse(draft.validity.kind === "attempt"
        ? { ...draft.validity, nativeRequestRef: request.nativeRequestRef,
            ...(request.nativeRequestRevision === undefined ? {} : {
              nativeRequestRevision: request.nativeRequestRevision,
            }) }
        : draft.validity),
    };
    const actor: Actor = { id: `runtime:${installationId}`, workspaceId, role: "runtime",
      projectIds: [draft.projectId], profileIds: [], bindingIds: [], sessionId,
      ...(attemptId === undefined ? {} : { attemptId }), bindingGeneration,
      allowedCommandTypes: ["request.create"] };
    try { validatePublication(actor, publication, this.input.interactions); return publication; }
    catch (error) { if (error instanceof HubError) return false; throw error; }
  }

  private nativeSessionMatches(workspaceId: string, sessionId: string, event: RuntimeEvent): boolean {
    const native = this.input.state.runtimeBinding(workspaceId, sessionId)["nativeSession"];
    if (typeof native !== "object" || native === null) return false;
    return Reflect.get(native, "installationId") === event.nativeSession.installationId &&
      Reflect.get(native, "providerScope") === event.nativeSession.providerScope &&
      Reflect.get(native, "kind") === event.nativeSession.kind &&
      Reflect.get(native, "id") === event.nativeSession.id &&
      Reflect.get(native, "incarnation") === event.nativeSession.incarnation;
  }

  private eventTargetsSessionAttempt(workspaceId: string, sessionId: string, event: RuntimeEvent): boolean {
    switch (event.payload.type) {
      case "output": return event.payload.item.hubAttemptId === undefined ||
        this.input.state.attemptBelongs(workspaceId, sessionId, event.payload.item.hubAttemptId);
      case "execution.observed": return event.payload.observation.hubAttemptId === undefined ||
        this.input.state.attemptBelongs(workspaceId, sessionId, event.payload.observation.hubAttemptId);
      case "request.created": return event.payload.request.draft.validity.kind !== "attempt" ||
        this.input.state.attemptBelongs(workspaceId, sessionId,
          event.payload.request.draft.validity.target.hubAttemptId);
      case "result.submitted": return this.input.state.attemptBelongs(
        workspaceId, sessionId, event.payload.attemptId);
      case "request.invalidated":
      case "response.acknowledged":
      case "gap":
      case "extension": return true;
      default: return assertNever(event.payload);
    }
  }
}
