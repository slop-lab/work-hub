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

## Narrow transport review closure

An independent review found that Ky's own timer stops after response headers.
The connector now races the complete request/body operation against its unchanged
ten-second deadline and caller cancellation, with non-blocking stream cleanup.
Safe cancellation errors preserve read-only retry versus mutation reconciliation;
caller cancellation reasons and provider bodies are not exposed.

Disposable loopback acceptance reproduces an HTTP 200 response with flushed
headers and a JSON body that never ends. Before the fix it remained pending after
12 seconds; after the fix it failed with `opencode_timeout` at about 10.01 seconds.
An oversized synthetic stream whose `cancel()` never settles previously hung;
it now reports the unchanged 2 MiB limit promptly and releases its reader lock.
Caller cancellation after headers also settles promptly, hides its private reason
and sends the mutation only once. A fourth regression ensures a successful HTTP
204 does not abort native work, retain caller cancellation, or retain its deadline
timer. The actual native question/answer/result flow passed after that correction.
All four transport regressions and the existing OpenCode conformance tests passed
together. Final combined source and relevant
actual-service/browser verification are reported with the final candidate SHA.

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
checkout remain ignored/untracked. The integration-only checkpoint is
`66b2fd2e6209e9c7aaeef109cbdc0c66023516bc`. The operator subsequently required
exact QG candidate `31120c1b2945395464b31998db6223852f0715b4`; it and all its
ancestry were normally merged without conflicts. The `@slop-lab/qg@0.1.0` pin,
lockfile, enabled rules, thresholds and source entrypoint are preserved.
Only the exact ignored external Blocks checkout was added to the downloaded
artifact registry, and two integration statements were wrapped without behavior
changes. Final combined source/actual-service verification is reported with the
combined candidate SHA in the handoff. No unrelated session/workspace was reset.

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
