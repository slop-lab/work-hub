# v0.3 acceptance traceability

Every row names an executable application scenario. The matrix uses a real temporary
SQLite Hub plus the simulator's separate persistent ledger. Connector call-log
assertions prove forbidden side effects. A row is not marked passing merely because a
lower-level contract test exists.

Run all scenarios with `npm run test:acceptance`.

| ID | Exact executable test | Evidence / current status |
|---|---|---|
| AT-01 | `AT-01/04: authenticated HTTP capture persists across restart and command replay` | Pass: task survives restart; no connector calls are made by capture. |
| AT-02 | `AT-02/24: another authenticated client reads a committed human answer after server restart, without external effects` | Pass: cross-client durable answer and empty simulator log. |
| AT-03 | `AT-03 new-allocation delegation records one ordered allocation, attachment, session, and input sequence` | Pass: durable snapshot and exactly one mutating sequence. |
| AT-04 | `AT-01/04: authenticated HTTP capture persists across restart and command replay`; `administrative commands use the same durable idempotency and audit pipeline as task commands` | Pass: identical replay returns the stored receipt; changed payload conflicts. |
| AT-05 | `AT-05 concurrent distinct delegation commands cannot acquire two primary attempts` | Pass: concurrent commands produce one accepted and one rejected receipt. |
| AT-06 | `AT-06 preparation remains durable when the client disappears and the Hub process restarts` | Pass: the same unresolved Attempt and allocation operation survive restart; no duplicate allocation. |
| AT-07 | `AT-07 existing-target verification is read-only and persists resolved identity` | Pass: only `execution.probeExisting` is called. |
| AT-08 | `AT-08 ready existing-target delegation attaches and starts input without allocation` | Pass: probe/attach/open/input occur; allocation is absent. |
| AT-09 | `AT-09 stopped existing target refuses delegation without start, install, or allocation fallback` | Pass: actionable rejection and probe-only call log. |
| AT-10 | `AT-10 failed native-session creation in an existing target detaches only attachment-owned access` | Pass: failed native open schedules attachment-only detach and never allocation release. |
| AT-11 | `AT-11 detaching an existing binding ends access without release or environment lifecycle calls` | Pass: binding becomes detached; release is absent. |
| AT-12 | `AT-12 attach-only release is rejected before provider invocation` | Pass: server rejects and call-log length is unchanged. |
| AT-13 | `AT-13 managed release preserves the provider's exact retention disposition` | Pass for retained/stopped/deleted; issued lifecycle grants and exact provider receipts are asserted. |
| AT-14 | `AT-14 incarnation replacement blocks a pending mutation instead of attaching the reused locator` | Pass: replacement incarnation blocks attach and raises an operational issue. |
| AT-15 | `AT-15 weak identity is disclosed and cannot be used for mutation without explicit acceptance` | Pass: weak assurance visible and attach absent. |
| AT-16 | `AT-16 a hub reservation blocks a second writer targeting the same work area` | Pass: only one unresolved writer remains. |
| AT-17 | `AT-17 attaching an idle native session sends no initial instruction, greeting, resume, or create request` | Pass: log contains only attach-mode open and inspection. |
| AT-18 | `AT-18 attaching active external work creates an observed attempt with unknown original input` | Pass: observed/attached origin and no fabricated instruction. |
| AT-19 | `AT-19 view-only attachment refuses both instruction and stop before runtime invocation` | Pass: grant checks reject; no instruction/stop connector call. |
| AT-20 | `AT-20 multiple session views reuse one native identity and never launch another process` | Pass for application views/process launch. Raw gateway controller is interface-only; no gateway implementation is claimed. |
| AT-21 | `AT-21 a structured runtime question creates one canonical request in dashboard and session` | Pass: dashboard and shell reference the same Request ID. |
| AT-22 | `AT-22/33/40: scoped bridge question, human answer, explicit acknowledgment and nonterminal result` | Pass: scoped create/poll/respond/explicit ack round trip. |
| AT-23 | `AT-23 a committed answer remains canonical when native delivery becomes unknown` | Pass: native requests retain complete target scope; saved answer and unknown delivery remain distinct. |
| AT-24 | `AT-02/24: another authenticated client reads a committed human answer after server restart, without external effects`; `one response is committed per request revision` | Pass: one canonical response; later answer conflicts. |
| AT-25 | `AT-25 an expired approval is rejected at response commit without runtime delivery`; `an approval that expires after commitment is suppressed before native delivery, without changing the answer` | Pass at commit and before delivery, using an injected server Clock and action-bound approval metadata. |
| AT-26 | `AT-26 a nonblocking question stays actionable without changing a running attempt to paused` | Pass. |
| AT-27 | `AT-27 asking an agent without a selected session cannot implicitly start work` | Pass: prompts selection through rejection; no Session or connector call. |
| AT-28 | `AT-28 unsupported mid-run timing is refused without connector invocation or silent queueing` | Pass with limited runtime profile. |
| AT-29 | `AT-29 continuation after termination creates a distinct attempt and immutable snapshot in the same session` | Pass. |
| AT-30 | `AT-30 a lost stop acknowledgment never creates a false terminal state` | Pass: stop intent recorded, outcome absent, Attempt unresolved. |
| AT-31 | `AT-31 lost allocation response is reconciled by the original operation ID without duplicate allocation` | Pass: one allocation call and eventual running Attempt. |
| AT-32 | `AT-32 cancellation during provisioning fences late readiness and tracks cleanup separately` | Pass: the original waiting allocation becomes ready after stop intent; exact trace is allocation → cancel request → granted release, with zero native session/input calls and a released binding. |
| AT-33 | `AT-22/33/40: scoped bridge question, human answer, explicit acknowledgment and nonterminal result` | Pass: Result saved while Attempt remains unresolved and task active. |
| AT-34 | `AT-34 a late old result is retained without replacing a newer primary attempt or human intent` | Pass. |
| AT-35 | `AT-35 task and profile edits cannot rewrite a running attempt's immutable snapshot` | Pass: byte-equivalent snapshot and pinned profile revision. |
| AT-36 | `AT-36 retry handoff creates a new logical session and does not claim native-state migration` | Pass: a distinct Session/native identity is created. |
| AT-37 | `AT-37 restart after a side effect reconciles the same operation without blind replay` | Pass: persistent simulator ledger shows one native open call. |
| AT-38 | `AT-38 replay after restart deduplicates canonical requests and exposes history gaps` | Pass: one canonical Request and explicit gap output. |
| AT-39 | `AT-39 a disappeared native session preserves local history and is never recreated automatically` | Pass: history remains, no reopen occurs, and observation becomes unreachable. |
| AT-40 | `AT-22/33/40: scoped bridge question, human answer, explicit acknowledgment and nonterminal result` | Pass: runtime self-answer receives HTTP 403. |
| AT-41 | `AT-41 malicious runtime output remains inert data and cannot trigger privileged connector actions` | Pass: exact hostile text retained as data; no privileged calls. Browser CSP/rendering has separate browser coverage. |
| AT-42 | `AT-42 output gaps and canonical questions/results survive managed environment release` | Pass. |
| AT-43 | `AT-43 export excludes access handles and restart reconciles ambiguous work without constructor replay`; `AT-43 filesystem backup and restore preserve answers and authentication while reconciling the original ambiguous operation` | Pass: stopped SQLite files and the independent simulator ledger are copied to a new directory, authentication/answers survive, and the original operation is reconciled without another native open. No JSON import API is claimed. |
| AT-44 | `AT-44 disabling a connector preserves historical session data and blocks new side effects` | Pass: installation state is checked before accepting new delegation while history remains readable. |
| AT-45 | `AT-45 incompatible connector profiles remain unavailable and do not add vendor fields to task records` | Pass. |
| AT-46 | `AT-46 simulator mode is labeled and external mode never silently falls back to simulation` | Pass: readiness flags and fail-closed external mode asserted. |
| AT-47 | `AT-47: reading or dismissing a notification never resolves its canonical request` | Pass. |
| AT-48 | `AT-48 completion requires an explicit active-work decision and unsafe archive remains blocked` | Pass: explicit decision required, stop intent separate, archive rejected. |

## Honest scope limits

- Production-provider compatibility is not tested or claimed.
- AT-20 does not claim a terminal/native gateway implementation.
- Waiting allocations have an explicit deterministic completion control; this is simulator state, not a real provider call.
- AT-43 verifies the documented filesystem backup/restore procedure, not a JSON import API.
- In-place continuation reattachment is refused explicitly; after detachment, use a new-session handoff with selected retained context. No native state migration is claimed.
