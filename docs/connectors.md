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

## Configured modules and receipt association

`HubOptions.connectors` supplies execution/runtime implementations keyed by
installation ID. Installation availability comes from those configured modules
and their validated v1 manifests/capabilities, not a provider-name allowlist.
Administrative installation/profile records still control whether new work is
enabled. Configuring a module does not make it a tested production integration.

Mutating replies are checked against the requested operation ID, connector
method, result schema and evidence effect. Native-session attachment preserves
the exact selected native reference and route; response delivery must acknowledge
the requested response. Read-only observations validate their source installation
and typed value. Output and event cursors are separate opaque provider values;
neither is inferred from output item IDs.

The terminal/native-view extension has executable `SurfaceContextSchema`,
`SurfaceChannelSchema` and `SurfaceViewSchema` contracts. No terminal gateway or
live native surface is included. Interactive input replay remains forbidden.

## Human-to-agent request inbox

A human can address a question to an explicitly active session, attempt and
binding generation. This persists a request; it does not launch work or inject
an instruction. A runtime credential with `request.respond` can discover its
open requests at `GET /api/v1/bridge/requests` and answer through
`POST /api/v1/bridge/commands`, targeting the request with its expected revision
and binding generation. The answer becomes an immutable canonical response.

The inbox is bounded to 100 open requests in that exact credential scope. Ended
attempts do not retain an actionable agent inbox. A runtime cannot answer a human
recipient's question or approve its own action. Human-to-agent answers use
`responseRoute: "none"`: they are saved to the Hub, not delivered back to the
answering runtime. Agent-to-human responses retain the separate native or bridge
delivery/acknowledgment workflow described by the contract.
