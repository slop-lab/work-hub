# Integration verification boundaries

This document describes reproducible acceptance, not current service availability.
It is not a registry of deployment URLs, route IDs, running processes or active
sessions. Store exact run/candidate versions, selected agent/model, logs and
receipts with the CI/review record or private disposable-test evidence.

## Independent verification layers

| Layer | Surface | What it establishes |
| --- | --- | --- |
| Source gate | `bash scripts/ci/source.bash` | Pinned install, QG, strict types, default behavioral tests and build |
| Simulator browser gate | `bash scripts/ci/browser.bash` or `npm run test:browser:ci` | Account-free actual built web/API/SQLite journeys with deterministic simulator and loopback wire fixtures; browser/dependency setup and no-skip result checks are required |
| Adapter fixtures | `tests/contracts.opencode.test.ts`, `tests/contracts.opencode-environment.test.ts`, `tests/contracts.dim.test.ts` | Wire mapping, authority and failure semantics, not real host lifecycle |
| Native OpenCode | Explicit opt-in `tests/live-opencode.test.ts` | Actual disposable native question/answer/result and connector-ledger reopen |
| Native browser flow | Explicit `npm run test:browser:live` / `tests/browser-live-opencode.spec.ts` | Work Hub discovery, selection, delegation, waiting, reconnect, answer, continuation, result and human completion against a selected actual service |
| Transport regressions | `tests/opencode-transport.test.ts` | Whole-response deadlines, caller cancellation and safe stream cleanup |
| Source export | `tests/source-snapshot.acceptance.ts` | Metadata-free source membership and unchanged QG enforcement |
| DIM host integration | Separate disposable VM acceptance | Actual host/workspace lifecycle, identity, service access and permitted operations |
| Other runtimes | Their future adapter conformance and actual-service checks | Claude Code/Codex CLI support; OpenCode results are not evidence for them |
| Optional AKB context | Scoped actual AKB reads plus captured input checks | Authorized document/revision capture, not Knowledge acceptance |
| Physical/account acceptance | Separate owner-authorized environment, account and human acceptance | Hardware/host access, provider authentication and deployment authorization; neither source nor simulator browser CI establishes this |

Use the opt-in commands in [runtime integration](live-integration.md). A skipped
live test is not a live pass. A process being present or an HTTP 204 response is
not proof of model execution. Idle is not success. Connector-ledger reopen is
not proof that every provider supports recovery after its own server restart.

Repository-owned GitHub and DIM configuration declare both `source` and `browser`
lanes. GitHub runs them for pushes, pull requests and merge groups, without path
filters; DIM declares both as required ordinary-sysbox jobs. The browser lane
supports Ubuntu 24.04/Debian 12, the exact `.node-version`, and root/passwordless
sudo for Playwright's OS dependencies. Unsupported or missing setup fails, not
skips. See [quality gates](quality-gates.md) for the shared entrypoint and required
publication/review boundary. Source configuration is a candidate for coordinator
review, not a mutation of live protected-ref policy or an accepted remote CI pass.

## Task acceptance common to runtimes

1. Select an environment connection or an environment-free runtime as supported;
   verify exact identity and working directory, not a friendly name.
2. Select an explicit runtime/profile and attach or create a disposable native
   session only where that provider supports it.
3. Save immutable attempt input, then send exactly one task input. Keep accepted,
   observed-running, waiting, unavailable and unknown outcomes distinct.
4. Deliver supported questions/follow-ups to their exact attempt. For unsupported
   approvals or interaction shapes, show the limitation and native fallback.
5. Recreate Work Hub and its connector ledger while waiting; preserve the native
   session ID and never resend an unknown input under a new identity.
6. Collect an associated result and explicit evidence references. Assistant text
   is not a verified repository commit, CI result or review approval.
7. Complete the task only through a human decision. Completion, interrupt,
   session detachment and environment release remain separate actions.

Native session history is deliberately bounded. Excluded ancestry, missing
history and output truncation must remain visible rather than appearing complete.
Test this separately for every runtime and adapter version.

## Regression invariants

- Unknown prompt delivery remains fenced after restart without another POST.
- Native transcript import excludes unrelated external/pre-attachment ancestry.
- Only questions and results associated with the current attempt affect it.
- Control/use-grant scope and expiry are enforced; route membership is checked.
- Environment expiry blocks new input but must not prevent a safety interrupt.
- Full-response deadlines cover both headers and body; cleanup must not hang.
- Successful asynchronous handoff must detach transport timers/cancellation
  without aborting native work.
- A metadata-free DIM source snapshot must still run the same QG rules and source
  checks. Temporary membership metadata supplies no history, approval or CI authority.

The source-snapshot procedure is documented in
[quality gates](quality-gates.md#authoritative-metadata-free-dim-snapshots).
Changing or locally reproducing the source entrypoint is not an accepted native
DIM CI publication. Use exact-candidate CI and human review records for that claim.

## Evidence and configuration lifetime

Tracked documents retain procedures, capability limits and source references.
Protected runtime/deployment state retains current endpoints, connection files
and supervisor configuration. CI/review or disposable run artifacts retain exact
versions, outcomes and receipt identifiers. A dated health observation must not
be used as present service discovery.

This separation does not erase historical evidence: earlier run records remain
in version history or their original evidence system. It prevents stale instance
records from becoming permanent product setup or an integration prerequisite.

## Inspecting DIM-scheduled source and browser jobs

Both jobs use the shared project-owned `scripts/ci/bootstrap-node.bash`. An
already exact Node24.22.1 is reused; a different job-image Node is replaced for
that job process by the reviewed Linux x64 archive, verified against its fixed
SHA256. Tools live in private temporary storage outside the source checkout and
are removed on exit. The job image must provide curl, SHA256, tar/xz and realpath;
Playwright's OS dependencies still require the supported Ubuntu/Debian job and
root or passwordless sudo. This does not modify the worker's global tools.
The source lane indexes the authoritative snapshot before tools or npm generate
files, retaining the existing metadata-free QG boundary.

From the selected project workspace, commit and push the intended ordinary
branch, then use the scoped helper:

```sh
dim-ci request --request-id "$REQUEST_ID" --ref "$CANDIDATE_REF"
dim-ci status --request-id "$REQUEST_ID"
dim-ci jobs --request-id "$REQUEST_ID"
dim-ci logs --request-id "$REQUEST_ID" --job "$EXECUTION_ID"
dim-ci artifacts --request-id "$REQUEST_ID" --job "$EXECUTION_ID"
dim-ci download --request-id "$REQUEST_ID" --job "$EXECUTION_ID" --artifact "$ARTIFACT_ID" --output ./browser-failure.png
```

Use a fresh UUID for `REQUEST_ID`, the exact ordinary branch ref for
`CANDIDATE_REF`, and the execution UUID returned by `jobs` for the requested
source or browser job. Choose `ARTIFACT_ID` from that execution's manifest,
checking its logical name and digest. No shared query/operator credential or
private connection file belongs in these commands. `logs` displays verified
retained tails by default; save a full stream with
`dim-ci logs --request-id "$REQUEST_ID" --job "$EXECUTION_ID" --stream stdout --output ./browser-stdout.log`.
Downloads require a new destination rather than overwriting existing evidence.

The browser EXIT trap exports produced `test-results/browser-ci` files to
`$DIM_ARTIFACTS_DIR/browser` even when setup or tests fail, preserving the
original exit code and temporary-state cleanup. The DIM manifest names these
files below `files/browser/`, including the JSON report, failure screenshots and
error context when produced. The original `test-results/browser-ci` directory
remains available to GitHub's existing artifact upload. A setup failure before
Playwright cannot produce a screenshot; inspect its retained stderr instead.

Repository declarations and these local script tests are **not** proof that the
live DIM policy or scheduler jobs passed. Record the exact candidate, both
actual execution IDs, accepted outcomes, downloaded evidence digests and cleanup
receipts after the coordinator applies the project policy and executes the jobs.
