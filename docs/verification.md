# Verification commands and evidence

Run checks against the candidate source, not a running development instance's
documentation or a different checkout. Keep exact commit IDs, dependency/runtime
versions, selected models, run receipts and command output in CI/review evidence
or private disposable-test artifacts rather than this product guide.

## Source and repository checks

```sh
npm ci
npm run quality
npm run test:contracts
npm run test:acceptance
```

`quality` runs QG and the existing strict-types, behavioral-test and browser-build
pipeline. The DIM source entrypoint is `bash scripts/ci/source.bash`; the
metadata-free source contract is described in [quality gates](quality-gates.md).
Do not treat a local source pass as native DIM CI publication or human approval.

## Browser checks

```sh
npm run build
npm run test:browser
```

Use a compatible Chromium executable via `PLAYWRIGHT_EXECUTABLE_PATH` when needed.
Tests own temporary data and services. Never point them at a user's existing
workspace, session or production database. The responsive journeys cover normal
routes, dialogs, CJK wrapping, draft preservation and explicit command effects.

## External integrations

Fixture tests establish request/response mapping and failure boundaries, not
compatibility with every deployed provider. Actual-service tests must identify
the tested service/version and use unique disposable sessions/tasks. A skipped
opt-in live test is not a live pass. See [integration verification](integration-verification.md)
for the separate native runtime, document-source and environment surfaces.

Common invariants include no resend after unknown input, exact native session and
attempt association, source permissions before context capture, immutable selected
input, and human completion independent of an assistant result. Test the supported
capabilities of each runtime separately; one adapter's pass does not qualify another.

## Backup, retention and measurements

The [acceptance matrix](acceptance.md) maps existing scenarios to behavior.
Backup/restore and retention checks preserve canonical questions, responses,
results and uncertain operation identities; output gaps remain explicit.
Follow the [operations procedure](operations.md) rather than copying a live SQLite
main file without its WAL state.

`node scripts/benchmark.ts` measures its declared local workload. Record machine
and workload details with the output. Do not infer a full concurrent-session/event
load envelope, live-provider latency, browser score or deployment qualification
from a smaller capture/read benchmark.
