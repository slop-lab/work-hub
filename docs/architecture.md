# Architecture and delivery decisions

## ADR 001: One process, SQLite, explicit ports

Work Hub is one Node.js 24 TypeScript service. Hono provides HTTP routing, Zod parses
untrusted boundaries, and SQLite transactions own durable commands and work records.
The browser is a small, framework-free TypeScript application bundled by esbuild.
Node's built-in SQLite avoids native addon installation and a separate DB service.
The runtime is selected because Node 24 is present in the implementation environment;
no host runtime installation or infrastructure/control-plane modifications are needed.

The application owns task intent, human decisions, snapshots, reservations, audit,
and orchestration receipts. Execution and runtime ports retain the supplied v0.3
contracts. Core implements no model client, agent loop, scheduler or container
engine. Provider-specific transports live in optional adapters under
`application/connectors`, not in the task engine. Simulator installations are
explicit and visibly labeled; a missing installation fails closed, never falls
back to simulation.

## ADR 002: Canonical rows plus an outbox

SQLite stores canonical identities and queryable state, an immutable decision and
audit history, commands, operations and an outbox. Local acceptance and outbound
intent share a transaction. Provider calls occur after commit. Stable operation IDs
are persisted before invocation. Unknown effects retain reservations until lookup or
inspection establishes what happened. The simulator has a separate persistent ledger
so a crash between its side effect and the hub's receipt save is meaningfully testable.

Task, session, attempt, environment registration, environment binding and runtime
binding are distinct objects. Business state is not execution state. A result does
not terminate work; a completion does not release an environment; detach does not
delete it. Attach-existing never submits an initial prompt.

## ADR 003: Local bootstrap and separate service identities

The initial administrator is established by an explicit local CLI, not a public
setup wizard. Random bearer credentials are stored only as digests. A successful
browser login exchanges a token for a short-lived HttpOnly SameSite cookie.
Authenticated state-changing browser calls require a matching Origin. Runtime
bridge credentials are independently scoped and cannot act as administrators or
answer human approvals. Network exposure requires TLS termination and explicit
public origin configuration. The default listener is loopback.

## ADR 004: Runtime and environment choices are independent

Work Hub owns task intent, explicit delegation, immutable attempt input, durable
questions, follow-up commands, uncertainty, results and human completion.
OpenCode, Claude Code and Codex CLI own their respective model/tool loops.
Each runtime maps its supported machine interface to `AgentRuntimeConnector`;
one runtime's questions, resume or interrupt semantics are not universal promises.

DIM is an optional environment provider, not Work Hub's task/delegation authority.
Adapters use supported interfaces for their execution location. Container-based
DIM workspaces can configure scoped connections and workspace-user services
without acquiring host administration. Do not pass host credentials or
administration sockets through to a guest. Existing host and workspace identity
must be distinguished from display names.

Runtime-specific adapters must not create a second scheduler or silently replace
the selected runtime. Each installation advertises its implemented capabilities.

## ADR 005: Optional document context, not a second document authority

AKB owns its Pages, Knowledge, permissions and revisions. Blocks is its existing
editor/rendering dependency; choosing AKB context does not require a new editor
inside Work Hub. Work Hub can first retain an external link, then optionally
capture authorized content and its returned revision in an attempt snapshot.
That snapshot records what an agent received; it is not an editable AKB replica.

Writing a result to a Page or submitting it to AKB's existing Knowledge proposal
workflow is an optional, explicit authorized action, not a prerequisite for task
execution or human completion. No two-way task-status synchronization is implied.
Existing source permissions and document revisions remain authoritative at the
document service; capture is an explicit Work Hub action.

## ADR 006: Documentation is not a live service registry

Tracked docs describe contracts, setup procedures and reproducible checks.
Deployment URLs, route IDs, active session/task IDs, credentials and supervisor
status belong in protected deployment/runtime state or the relevant run's evidence.
Discover current endpoints through the environment owner's supported service
interface. Stopping a service does not rewrite product documentation; a previously
observed health response is not a promise of current availability.

## Milestones and acceptance gates

1. **Durable work and questions**: authentication/bootstrap, project/task CRUD,
   comments, questions, immutable responses, dashboard, revision conflicts, export.
   First end-to-end slice: capture a title, ask a human question, save an answer,
   restart and observe the same answer. AT-01/02/04/24/26/27/47.
2. **Sessions and command semantics**: profiles, sessions/attempts, pure delegation
   policy, snapshots, reservations, durable outbox, structured simulator, transcript,
   result/revision flow. AT-03/05/06/20/29/33/34/35/36/48.
3. **Environment choices and existing attachment**: registrations, read-only verify,
   incarnation pinning, attach versus allocate, write reservations, grants,
   detach versus guarded release. AT-07 through AT-16 and AT-39.
4. **Runtime contract and interaction**: executable validators, native/bridge
   questions, attach versus create, observe/control, continuation/stop and limited
   profile refusal paths. AT-17/18/19/21/22/23/25/28/40/44/45/46.
5. **Recovery and release quality**: scripted unknown effects, restart recovery,
   cancellation races, late events, output gaps/retention, permission boundaries,
   backup/restore, connector guide, operation traces and full acceptance matrix.
   AT-30/31/32/37/38/41/42/43, plus regression of the preceding gates.

## Verification strategy

Behavioral Node test-runner tests use real temporary SQLite databases and persistent
simulator ledgers. Contract tests assert exact allowed side effects from simulator
call logs, including negative paths; they do not infer safety from screen state.
HTTP integration tests exercise authentication, schema and authorization boundaries.
Browser journeys exercise the actual product UI. The final acceptance report maps
each AT identifier to concrete evidence or an honest gap. Performance targets are
not claims unless accompanied by measurements and the test envelope.

## Deliberately deferred

Production qualification, terminal/native gateways, automatic merge/deploy approval,
IDE tooling, infrastructure management, external
tracker sync and multi-tenant SaaS. Connector conformance is not live readiness.
