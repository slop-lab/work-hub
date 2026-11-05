# Verification follow-up, 2026-11-05

This receipt does not promote a feature branch or equate accepted main CI with
feature validation. Private raw evidence is retained under
`/home/dim/tasks/verification-followup-20261105/`; that directory is not published.

## Source identity

- Existing main checkout remains `docs/runtime-neutral-integration` at
  `e19f0c312356ceb8493bc78312362382d207a883`, initially clean and untouched.
- Lifecycle/handoff baseline is `0a5ff826fada3aaefadddf88657a11944b66b4b7`, initially
  clean in `/workspace/work-hub-handoff`.
- Follow-up work uses ordinary branch `work/verification-followup-20261105`.
- Authoritative remote main is `a967a8345732c19391a8173b0a9f135534f6ec1b`.
  Its common ancestor with the candidate is `51827a1`; divergence is 1 main-only
  commit versus 125 candidate-only commits. The one main commit changes only
  `.dim/repos.yml` upstream/publication metadata. No blind merge was performed.
- e19 is already an ancestor of the lifecycle candidate. No reset, force push,
  protected merge, production restart or policy weakening was performed.

The private ledger records the final committed SHA and clean/dirty status with
each command. Baseline evidence applies to the baseline SHA; post-fix evidence
applies to the follow-up tree, not to main.

A disposable candidate app was also exercised at `http://127.0.0.1:3046`:
`/health` and the login page returned 200; unauthenticated `/api/v1/state`
returned 401. Its owned process and private test database were removed afterward.
That test endpoint is no longer listening; no remotely reachable temporary app
or AKB endpoint is claimed.

## Quality and browser coverage: PASS

Baseline `npm run quality`, `npm run check` and `npm run test:browser` exited 0.
The browser command used the compatible system Chromium and isolated fixture
databases. It passed 39 journeys and skipped only the opt-in real-model journey.

Actual DIM verification found that the connector rejected the current scoped
gateway prefix. The fix accepts only the advertised local
`http://127.0.0.1:19420/services/workspace` prefix in addition to existing origins,
preserves that prefix during request resolution, and continues rejecting other
service paths, remote HTTP, userinfo, queries and fragments. Two regressions failed
before the fix and passed afterward. Post-fix full checks passed 394 tests with
one live opt-in skip; browser coverage again passed 39 with one opt-in skip.
Existing QG file/directory size warnings remain advisory, with no policy changes.

## Actual OpenCode and DIM coverage

- **PASS, native service:** OpenCode 1.18.31 was launched with isolated XDG state,
  loopback binding and disposable Basic authentication. Unauthenticated health
  returned 401, authenticated health/status returned 200, SSE client disconnect
  did not kill the server, and owned-server stop/restart preserved the exact
  session messages and child projection hashes.
- **PASS, actual child execution:** the public zero-cost
  `opencode/nemotron-3.5-lightning-free` model invoked a real `explore` child which
  read the README heading. Persisted parent/child messages report cost 0. This is
  not a simulated connector or a fixture-created completion.
- **PASS, actual Work Hub adapter:** `tests/live-opencode.test.ts` ran with isolated
  configuration, the same public free model and agent `build`. Native question,
  answer, result, connector-ledger reconnect and transcript inspection passed.
- **LIMITED, background:** the experimental background endpoint was exercised
  while parent and child were busy; it returned `false`. The synchronous child
  completed normally. This does not prove detached-background support.
- **BLOCKED, team:** the isolated native runtime exposes no team API/tool. No
  shared team/plugin configuration or active main session was altered to invent a
  team pass. A compatible isolated team integration is still required.
- **PASS, real DIM scoped reads:** `node scripts/verify-dim-workspace.ts --read-only`
  used this workspace's existing private scoped transport in memory. Real resource
  and plugin discovery succeeded, an invalid credential was rejected, and the
  valid read recovered. No token was printed or copied.
- **BLOCKED, owner-attested DIM recipient lifecycle:** current discovery does not
  advertise the optional Work Hub recipient plugin or an operator-attested runtime
  incarnation. The read driver explicitly reports `ownerIncarnationAttested:false`
  and performs no attachment/allocation/release or host lifecycle writes. Local
  fixture attachment tests are not counted as installed-host integration evidence.

Owned disposable OpenCode processes/listeners were removed. Isolated state, logs,
session IDs, command exits and child evidence remain private. The production
`work-hub` service was left running unchanged. No new external URL was requested.

## Codex and Claude: BLOCKED for real turns

Codex has no configured executable (`dim-agent codex --version` exits 2), no
`codex` on PATH, and no scoped account configuration. An operator must configure
the pinned CLI, select a private `CODEX_HOME`, authenticate there using the CLI's
supported browser/device flow, and obtain exit 0 from `codex login status`.

The installed Claude Agent SDK 0.3.311 and bundled Claude Code 2.1.311 were queried
for actual non-billable metadata. SDK/adapter discovery succeeded with zero
attachable sessions; `claude auth status` exits 1 with `loggedIn:false`. The
workspace identity needs `claude auth login`, a successful `claude auth status`,
and an existing disposable session for the exact repository directory before an
authorized real SDK turn. A later potentially paid call requires separate approval.

DIM router readiness is not evidence of either CLI/SDK login. No host operator
credential was imported and no paid-provider call was made. Exact command and
supported setup details are in private `provider-readiness.md`.

## AKB success integration: BLOCKED on owner handoff

The available handbook specifies authenticated document discovery and exact
Page/Knowledge context requests, but still omits actual successful response DTOs,
test-principal issuance commands and a reachable scoped service origin. Current
DIM discovery provides no cross-workspace AKB/agent relay. No production AKB
record was written and no success parser was guessed.

A precise persistent request is retained at
`/home/dim/tasks/verification-followup-20261105/akb-owner-handoff-request.md` for the
AKB owner on remote-main-2. It asks for:

1. Exact AKB SHA, endpoint methods, non-secret response schemas and redacted DTOs
   for `/documents`, `/context`, result/proposal submission and retrieval.
2. Principal/mapping/permission/stale-revision/transient error contracts and
   idempotency/retry semantics.
3. Supported disposable test-principal, grants, project mapping, record creation,
   cleanup and revocation commands. Secrets must use the reviewed private transport,
   not this document, chat, tool arguments or copied host credentials.
4. A protected internal origin, or an approved DIM external URL only if needed,
   plus an authorized response handoff route.

The request is persisted locally, not falsely reported as delivered to the remote
agent. Once the owner/coordinator supplies that handoff, implement strict success
schemas and production callers, then validate actual success, denied principal,
missing mapping, permission revocation, retry/recovery and result retrieval against
disposable AKB records. Existing fail-closed transport/fixture coverage is not a
substitute for that real-service evidence.

For a later protected local Work Hub candidate, use a separate private `DATA_DIR`,
loopback port and explicit `PUBLIC_ORIGIN`. Provision its user with
`DATA_DIR='<private-test-data>' npm run bootstrap`; capture the one-time token only
to an owner-readable 0600 file and use the normal authenticated login. Never reuse
production `data/admin-token` or expose an unprotected listener.
