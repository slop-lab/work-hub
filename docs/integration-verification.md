# Integration verification observed on 2026-10-26 UTC

This is evidence for the optional integration slice, not production qualification
or the complete DIM + AKB + Blocks acceptance target.

## Executed checks

| Command/surface | Observed result |
| --- | --- |
| `npm run check` | Strict TypeScript, 244 passing default tests, one explicitly skipped opt-in live test, build exit 0 |
| `npm run typecheck && npm run build` after final frontend edits | Exit 0 |
| Explicit live `node --test tests/live-opencode.test.ts` | One actual-service test passed |
| Full Playwright suite with explicit live agent/model | All 27 journeys passed |
| Published authenticated development UI | Sign-in, discovery, explicit model/agent profile, durable task/reference and two owner questions observed working |
| Fresh screenshots | 18 route captures at 375/768/1280 plus three actual-service session captures; zero primary overflow and page errors |
| Two independent visual review passes | Both PASS on the same 21-capture set |

The opt-in runs used `WORK_HUB_LIVE_MODEL=openai/gpt-6.1-sol` and
`WORK_HUB_LIVE_AGENT='Sisyphus - ultraworker'`. Playwright used
`PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium` because this ordinary Alpine coding
container cannot run the downloaded glibc browser. Chromium was installed only
inside this coding container. No host runtime, socket or policy was changed.

The actual native server reported OpenCode **1.18.31**. One independently executed
native run recorded session `ses_e8953f7ddffeOl65Z6sfdduTfQ`: question answered,
result received, the same native binding after connector ledger reopen, and two
retained user/assistant output items. This is a newly created fixture session,
not the original implementation coordinator's session.

The actual browser journey exercised discovery, task creation/delegation, native
waiting question, Hub/connector recreation while waiting, human answer delivery,
result collection, visible partial-history coverage, same-session continuation,
second result and explicit human completion. Neither HTTP 204 nor idle was used
as evidence of start/success. The native test and all default tests are reported
separately; wire fixtures are not labeled real DIM lifecycle acceptance.

## Safety findings reproduced and corrected

- Unknown prompt delivery remains fenced after restart, without a second POST.
- Native transcript import excludes unrelated external/pre-attachment ancestry.
- Unrelated native questions cannot make the current attempt appear waiting.
- Input requires the current control grant; DIM-backed bindings retain use-grant
  scope/expiry. Missing/expired grants and forged route membership are refused.
- Environment expiry blocks more input but not a safety interrupt.
- Older native-attempt observations cannot finish the current Hub attempt.
- Connector history gaps survive reconciliation and remain visible to users.
- Continuation includes the current profile revision without a simulator fallback.
- Long captured revision IDs/digests reflow on mobile, and background refresh
  preserves the main scroll position without replaying a scroll animation.

New production adapter modules are at most 148 source lines. The touched
runtime-observation test file is 233 nonblank/non-comment lines; do not grow it
without splitting subsequent coverage. Source responsibilities remain separated:
transport/schema, native ownership, input receipts, observations and configured
connection projection. Boundary values are parsed with Zod; no type-suppression
or untyped assertion was added.

## Persistent development record

- UI: `https://work-hub-integration--workhub-ui.mj-y.com/`.
- Handoff task: `#/backlog/task-3a32f01c-d00f-4eba-9f95-95da2ff6c69e` on that UI.
- The task retains the actual command evidence and explicit nonblocking AKB/DIM
  owner questions. It was not re-delegated to another implementation agent.
- Work Hub and dedicated native fixture service supervisors were observed running.
- Public Work Hub health: HTTP 200, `simulation:false`, `liveReady:false`.
- Unauthenticated Work Hub data and native OpenCode health: HTTP 401.
- Route IDs, setup and credential handling: [live integration](live-integration.md).

Screenshots, browser output, runtime credentials, databases and the local Blocks
checkout remain ignored/untracked. The original QG candidate/package changes
were not imported or duplicated. No unrelated session/workspace was reset.

## Not verified / not claimed

- LSP diagnostics could not run because TypeScript/Biome language servers are not
  installed. Strict `tsc`, the build and executable tests are the substitute.
- Lighthouse scores were not measured; no 100-score claim is made.
- DIM's current scoped API does not establish fresh host/workspace incarnation or
  external-writer idleness. Writable attachment, allocation/release and VM/KVM
  lifecycle acceptance are not claimed. A separate disposable runner and reviewed
  operator discovery/lease interface are still required.
- AKB exact-revision context and proposal transport/UI await the owner's reviewed
  contract and scoped installation/project mapping. No guessed endpoint, fake
  canonical store, proposal acceptance or two-way status synchronization exists.
- Git/CI evidence is never inferred from an assistant's text. Full source/commit,
  CI and review references must be attached and checked in the remaining run.
- Native DIM CI publication, human code review, merge/promotion and installation
  remain root/operator actions. No self-approval or production deployment occurred.
