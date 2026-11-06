# Reliable task lifecycle and provider mappings

Work Hub owns task scope, criteria, attempts, questions, blockers, results and the
human acceptance decision. Runtime providers own model/tool execution. A final
assistant message, idle process, successful exit, checkpoint or provider result
does not complete a task.

## Fixed lifecycle model

- Amendments append a new scope revision and explicit required or optional
  criteria. They do not rewrite retained attempt input.
- Results are `checkpoint` or `final` and bind criterion evidence, references,
  artifacts and, for verification handoffs, exact source and context identity.
- Acceptance is `accepted`, `incomplete` or `rejected`. Required criteria and
  required verification must be satisfied before acceptance. Automatic acceptance
  is intentionally disabled; ordinary tasks without explicit criteria retain the
  direct human-completion path.
- Blockers use fixed kinds: environment, permission, external dependency, task
  dependency, capacity, provider unknown and child work. They retain an owner,
  requested remedy and auditable resolution/recheck state.
- Interrupted attempts distinguish paused, awaiting input, provider stop, operator
  stop, retryable failure, crash and unknown. Recovery is observe, reconcile,
  resume, bounded retry or escalation. Recovery never replays an uncertain input.
- The task and handoff pages show the current missing action, responsible owner and
  next action. Questions remain canonical requests and are answered through the
  existing scoped inbox.

## Versioned prompt templates

`application/prompts` provides versioned templates for task briefs, checkpoint/final
status, questions and blocks, answer continuation, verifier handoff and incomplete
result repair. Each render has canonical text, template version, input digest and
render digest. Bounded trusted presentation overrides are included in that digest.
Lifecycle authority remains in schemas and services; prose keywords are never state
transitions.

Initial task briefs include exact task/scope revision, attempt, profile/runtime,
requested environment, retained context and criteria. Work Hub automatically renders
and delivers `task_brief` and `verifier_handoff`. The other templates are maintained,
inspectable contracts for permitted agent integrations and explicit prompt-based
fallbacks; structured request, response, result and acceptance records remain the
production authority and are not duplicated by an automatic prose send. In
particular, native provider questions resume through their exact native response
route. A prompt-based answer continuation, when explicitly selected by an
integration, carries the accepted answer, retained completed work and pending
criteria, and provider adapters deliver that rendered text unchanged.

## Provider capability matrix

| Capability | OpenCode | Codex CLI 0.164 | Claude Agent SDK 0.3.311 |
|---|---|---|---|
| New session | Supported | Supported | Unsupported; attach an existing session |
| Continuation | Queued native input | New turn on the same thread | Resumed SDK query |
| Human question | One exact native question with text or fixed choice | One non-secret experimental `requestUserInput`; other shapes use native client | Unsupported; use authenticated Claude Code |
| Permission approval | Unsupported; use native client | Never auto-approved; use native client | Denied by adapter; use native client |
| Child/team activity | Bounded affiliated child traversal; incomplete coverage is unknown | Not enumerable; coverage is unknown | Bounded SDK task/subagent registry; incomplete coverage blocks finality |
| Retry/rate metadata | Provider observation and retained gaps | Exact retry/error/rate notifications | Exact SDK retry/rate/startup/terminal frames |
| Stop | Bound interrupt | Bound turn interrupt, request-only receipt | Unsupported; adapter drains accepted SDK work |

OpenCode and Claude can withhold terminal completion while observable child work is
active. Codex does not expose complete child coverage, so Work Hub reports that
limitation and requires reconciliation instead of asserting that all children ended.

## Trusted integration boundary

The optional DIM host plugin derives the workspace UUID from the authenticated DIM
caller and re-attests the runtime fingerprint. Private integration and short-lived
bridge credentials never appear in agent tool arguments or output. Global OpenCode
tools use the SDK-provided native session ID. Revoking or replacing the integration,
workspace incarnation, binding generation or assignment fences existing bridge
capabilities.

Installing the DIM host plugin and global OpenCode plugin on managed hosts remains an
operator deployment action. Claude live turns require an explicitly authorized
account. AKB exact document-context success parsing is qualified against the
owner-confirmed `4f6b9704c776877c594408e49f944ff169ccf238` contract. Work Hub enforces
its own application workspace/project/principal/installation mapping and explicit
Page/Knowledge allowlists; request, ACL, revision and byte-budget failures remain
fail-closed. See [paired AKB application verification](akb-paired-application-20261106.md)
for actual-service scope and the remaining saved-selection/proposal limitations.
