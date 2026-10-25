# Connector contracts and deterministic simulators

The public provider-neutral contract is exported from `application/contracts/index.ts`. The definitions are split by responsibility while preserving the names from contract specification v0.3:

- `common.ts`: manifests, contexts, observations, errors, receipts, lookup, and closed receipt serialization.
- `execution.ts`: environment identities, grants, allocation, attachment, inspection, detach, and release.
- `runtime.ts`: runtime capabilities, native sessions, attempts, input, output, requests, events, stop, and the runtime connector.
- `application.ts`: profiles, policy, command receipts, and session surfaces.

Boundary schemas use strict Zod objects. `parseSerializedOperationReceipt()` dispatches the closed receipt union by `status`; unknown fields or statuses are rejected.

For reconciliation, use `validateSerializedOperationReceipt(value)`. It first validates the closed `OperationReceipt<JsonValue>` envelope, then dispatches confirmed results through `ConnectorOperationResultSchemas` using both `operationKind` and `resultSchemaId`. Unknown operation kinds, mismatched schema IDs, and malformed typed results are rejected before state is applied. `RuntimeEventSchema` performs the equivalent closed validation for runtime event envelopes and payload variants. All schemas are exported from `application/contracts/index.ts`.

## Facade

```ts
import { createSimulators } from "../application/simulator/index.ts";

const simulators = createSimulators("/var/lib/work-hub/connectors.sqlite", {
  runtimeProfile: "structured",
});

simulators.execution; // ExecutionConnector
simulators.runtime;   // AgentRuntimeConnector
simulators.controls;  // deterministic test/admin controls
simulators.calls;     // connector call evidence
simulators.close();
```

The caller supplies the core SQLite path. Connector calls, scripts, simulated resources, sessions, output, and the operation ledger are durable in a separate `${dbPath}.sim` database. Recreating the facade with the same path preserves idempotency and lookup behavior.

## Operation safety

Every side-effect operation is recorded under the caller's `operationId` and `inputDigest` before the simulated effect executes. Reuse of the same ID and digest returns the stored receipt. Reuse with a different digest returns a conflict. `unknown_after_effect` stores the confirmed effect in the durable lookup ledger while returning an unknown visible receipt, modeling a lost response without blindly replaying the effect.

The simulator never invokes a shell, network client, container engine, runtime binary, or arbitrary callback. It only changes its supplied SQLite database.

## Runtime profiles

`structured` supports native structured input/output, questions and approvals, replay, immediate and queued instructions, control transfer, and observable stop/process termination.

`limited_bridge` supports transcript interaction through an explicit bridge, queued instructions, bridge requests/results, interrupt requests, live-only output, weak native identity, and explicit history gaps. Native questions, native approvals, service preparation, control transfer, continuation, immediate steering, and confirmed termination remain unsupported or unknown.

## Programmatic controls

- `scriptNext(operationKind, outcome)` queues `accepted_waiting`, `unknown_after_effect`, `definite_failure`, or `partial_release` for the next matching operation.
- `setEnvironment(id, state)` controls running/stopped/missing/unknown state, immutable/attested/weak identity, incarnation replacement, and external activity.
- `setRuntimeProfile(profile)` switches between the two declared capability profiles.
- `setSessionMissing(sessionId)` models disappearance without deleting retained history.
- `addHistoryGap(sessionId, reason)` adds an explicit replay/retention gap.
- `emitOutput(sessionId, text)` appends deterministic cursor-addressable output.
- `emitQuestion(input)`, `emitResult(input)`, and `emitTermination(input)` validate closed Zod payloads and append durable runtime events. Termination also updates session observation state.
- `seedSession(input)` prepares an idle, running, waiting, ended, or unknown native session for attach-existing tests without submitting work.
- `setRuntimeReadiness(routeId, readiness)` scripts probe readiness and unmet requirements.
- `setReleaseResult(allocationId, result)` selects exact retained, stopped, deleted, or provider-managed release outcomes.
- `calls.list()` returns ordered evidence for negative assertions such as “verification made no allocation call” or “attachment submitted no initial work.”

Operation kind strings are the interface name plus method, for example `execution.requestAllocation`, `execution.releaseAllocation`, `runtime.openSession`, `runtime.startAttempt`, and `runtime.requestStop`.

Output and admin events share one monotonic per-session cursor. Subscription replay is bounded to 1,000 records per call. Simulated output chunks are limited to 64 KiB and oversized input is rejected rather than truncated.

## Conformance coverage

Run `npm run test:contracts`. The suite checks closed boundary schemas, serialized receipt dispatch, idempotency conflicts, restart reconciliation after a lost receipt, accepted/waiting and definite failures, partial release, stopped and weakly identified environments, incarnation replacement, external activity, attach-without-input, observe-only grants, limited capability refusal, history gaps, cursor replay, unknown stop responses, and missing native sessions.

Passing simulator conformance demonstrates core contract behavior only. It is not evidence of compatibility with a live provider or runtime.
