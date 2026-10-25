import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "./codec.ts";
import { EnvironmentObservationState } from "./environment-observation-state.ts";
import { RuntimeState } from "./runtime-state.ts";

export class ObservationRepository {
  private readonly runtime: RuntimeState;
  private readonly environments: EnvironmentObservationState;

  constructor(database: DatabaseSync, clock: Clock) {
    this.runtime = new RuntimeState(database, clock);
    this.environments = new EnvironmentObservationState(database, clock);
  }

  runtimeBindings(input: Parameters<RuntimeState["runtimeBindings"]>[0]):
    ReturnType<RuntimeState["runtimeBindings"]> {
    return this.runtime.runtimeBindings(input);
  }

  observationCursors(workspaceId: string, sessionId: string):
    ReturnType<RuntimeState["observationCursors"]> {
    return this.runtime.observationCursors(workspaceId, sessionId);
  }

  saveOutputPage(input: Parameters<RuntimeState["saveOutputPage"]>[0]): void {
    this.runtime.saveOutputPage(input);
  }

  saveEventCursor(workspaceId: string, sessionId: string, cursor: string): void {
    this.runtime.saveEventCursor(workspaceId, sessionId, cursor);
  }

  environmentBindings(input: Parameters<RuntimeState["environmentBindings"]>[0]):
    ReturnType<RuntimeState["environmentBindings"]> {
    return this.runtime.environmentBindings(input);
  }

  saveEnvironmentObservation(input: Parameters<EnvironmentObservationState["save"]>[0]): void {
    this.environments.save(input);
  }

  environmentSafety(workspaceId: string, sessionId: string):
    ReturnType<EnvironmentObservationState["safety"]> {
    return this.environments.safety(workspaceId, sessionId);
  }
}
