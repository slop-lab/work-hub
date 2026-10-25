import { SimulatedExecutionConnector } from "./execution.ts";
import { SimulatedRuntimeConnector } from "./runtime.ts";
import { SimulatorStore } from "./store.ts";
import type { RuntimeProfile, Simulators } from "./types.ts";
import { PersistentSimulatorControls } from "./controls.ts";

export { SimulatedAdminEventSchema } from "./controls.ts";
export { SimulatedQuestionSchema, SimulatedReadinessSchema, SimulatedReleaseResultSchema, SimulatedResultSchema, SimulatedSessionSeedSchema, SimulatedTerminationSchema } from "./types.ts";
export type { RuntimeProfile, ScriptedOutcome, SimulatedEnvironment, SimulatedQuestion, SimulatedReadiness, SimulatedReleaseResult, SimulatedResult, SimulatedSessionSeed, SimulatedTermination, SimulatorCall, SimulatorCallLog, SimulatorControls, Simulators } from "./types.ts";

export function createSimulators(path: string, options: { readonly runtimeProfile?: RuntimeProfile } = {}): Simulators {
  const store = new SimulatorStore(`${path}.sim`);
  if (options.runtimeProfile !== undefined) store.setRuntimeProfile(options.runtimeProfile);
  return {
    execution: new SimulatedExecutionConnector(store),
    runtime: new SimulatedRuntimeConnector(store),
    controls: new PersistentSimulatorControls(store),
    calls: { list: () => store.listCalls() },
    close: () => store.close(),
  };
}
