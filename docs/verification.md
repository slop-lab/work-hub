# Verification report

## Implementation checkpoint

The application is implemented against the supplied v0.3 baseline. All included
execution/runtime installations are deterministic simulators. No live DIM,
control-plane, model-provider or external agent-runtime compatibility is claimed.

## Executed checks

The first two rows below record the initial `cc1bf7b` checkpoint. Independent
review subsequently rejected readiness despite those green checks. Closure
progress and review verdicts are tracked in [review-fixes.md](review-fixes.md).

| Check | Observed result |
|---|---|
| `npm run check` | Strict TypeScript, **158/158 Node tests**, and browser production build passed. |
| `npm run test:browser` | **15/15 real-browser journeys** passed against real temporary SQLite/API services, not mocked HTTP responses. |
| Acceptance matrix | AT-01 through AT-48 map to executable scenarios in [acceptance.md](acceptance.md); grouped scenarios cover several related IDs. |
| Connector conformance | Closed schemas, typed receipt dispatch, operation replay/lookup, native identity, grants, detach/release, profile-negative behavior, and 20 independent streams are exercised in the Node suite. |
| Backup/restore | A stopped data directory is copied to a new location; answers, authentication hashes and the separate simulator operation ledger survive restoration. |
| LSP | Not available in this container. No host language-server installation was made; strict `tsc --noEmit` is the static verification evidence. |

The browser checks cover capture, project/owner filters, editing, comments, human
questions and answers, stale-draft conflicts, logout draft cleanup, native-session
observation, environment verification, administration, paged output, active and
ended result revision, explicit completion consequences, and read/dismiss separation.
All five main routes were captured at 375, 768 and 1280 pixels; task and dialog stress
states are included in the responsive test.

## Recovery and authority evidence

- Unknown operation outcomes retain their original IDs; restart looks up those IDs
  rather than blindly resending creation/input under new IDs.
- A delayed allocation can become ready after stop intent. Its actual identity and
  lifecycle grant are retained, no native work starts, and release is separately recorded.
- Committed answers remain immutable when delivery is unknown or later suppressed.
- Approval expiry is checked at response commit and again before delivery.
- Existing target aliases resolve to one provider identity. Replacements invalidate
  old attachments; detach invalidates only attachment access.
- Release requires the exact issued allocation identity/grant/policy; attach-only
  targets cannot gain release authority.
- Structured and limited runtime installations retain independent capabilities in
  the same Hub. Required capabilities and profile effects are checked before work.
- Provider-created native sessions are attached; the initial task input remains a
  distinct single operation.
- Retry distinguishes retained old input from current task context and records
  attempt/session predecessor identities. Closed tasks must be explicitly reopened.
- Result revision really dispatches an instruction or a new continuation attempt;
  it is not merely a comment. Result submission alone does not establish termination.
- A bridge activity report is retained as a sourced report, not proof of native
  termination. Runtime statements cannot nominate themselves as independent checks.

## Local measurement

Command: `node scripts/benchmark.ts`.

| Input/environment | Value |
|---|---|
| Node | v24.22.1 |
| OS-visible parallelism | 8 |
| OS-visible memory | 58.663 GiB; not a dedicated-host or cgroup entitlement claim |
| Durable tasks created | 10,000 |
| Full snapshot read samples | 50 |
| Local command acceptance p95 | 11.919 ms |
| Full snapshot p95 | 43.242 ms |

This is an isolated SQLite capture/read measurement, not the full 4-vCPU/8-GiB,
20-active-session, sustained-100-events/s envelope and not a production benchmark.
The full envelope, browser performance scoring and live-provider latency were not measured.

## Remaining boundaries

- Production connectors and live integration readiness remain a later gate.
- Terminal/native gateways are interface-only. The shipped surface is a transcript;
  no raw terminal channel or controller lease is presented as operational.
- After environment detachment, in-place continuation reattachment is not exposed.
  The service refuses it explicitly and supports a new-session handoff instead.
- No JSON import endpoint, arbitrary artifact-upload service, workflow engine,
  automatic task retry/review/merge, scheduler or agent/model loop is provided.
- Container packaging is supplied as an example; it was not built or deployed in
  this container. The verified operating path is native Node.

Independent final review is recorded separately from these executable test results.

## Final review-closure verification

The final closure implementation passed `npm run check`: strict TypeScript,
**219/219 Node tests**, and build. The expanded real-browser run passed
**24/24** journeys after the deterministic comment-draft race and mobile CJK
wrapping/clipping regressions were fixed. The browser suite also exercises project-level questions, scoped
human-to-agent questions, explicit retry environments, actionable operation
recovery, persistent output pagination, and inert hostile output with CSP.

Live browser and HTTP usage confirmed explicit delegation and scoped bridge
question discovery/answering without a new attempt. A privileged command through
that runtime credential returned HTTP 403. Simulator execution remains distinct
from live-provider compatibility.

Independent re-reviews passed the prior goal, durability and missed-context
blockers; both final visual passes passed. The scoped permission/export review
passed after fixing complete bridge credential tuple enforcement. A broad security
review did not complete because of a tool policy error, so no blanket security
approval is inferred. See [review-fixes.md](review-fixes.md) for the closure ledger.

## DIM required source gate

`.dim/repos.yml` declares the managed main/development protections, explicit
reviewer, and required DIM `source` job. `.dim/ci/runner.yml` selects
`scripts/ci/source.bash`, which runs a lockfile-clean dependency install followed
by strict TypeScript, the complete Node test suite, and the production build.
The ordinary Sysbox runner supplies Node and npm; the job installs no host tools.
Run the same source gate locally with `bash scripts/ci/source.bash` from the
repository root. Real-browser journeys remain a separate `npm run test:browser`
check using a Chromium executable compatible with the development environment.
This source gate does not claim production-provider compatibility or browser
performance/security audit coverage.
