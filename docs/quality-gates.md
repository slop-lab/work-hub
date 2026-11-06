# Repository quality gates

Work Hub pins the published npm package `@slop-lab/qg` to **0.1.0** as a
development dependency. Node.js 24 or newer and the existing npm lockfile remain
the supported toolchain. Install with `npm ci`; no global QG installation is used.

## Commands and CI

| Command | What runs |
|---|---|
| `npm run quality` | Full working-tree QG rules, then `npm run check` once |
| `npm run quality:staged` | Rules over staged/index contents, then the same working-tree checks |
| `npm run quality:rules` | Full QG rule scan only; useful during fixes, not sufficient for CI |
| `npm run check` | Existing strict TypeScript, Node behavioral tests and browser build |
| `npm run test:browser` | Prepared-environment simulator/wire-provider browser journeys; excludes actual-service tests |
| `npm run test:browser:ci` | Shared required browser entrypoint: lockfile install, pinned Chromium plus OS dependencies, build, actual browser journeys and no-skip report validation |
| `npm run test:browser:live` | Explicit actual-OpenCode browser qualification; missing model/agent selection is a failure, not a pass |

The root `.qg.yaml` uses the supported top-level command check to invoke the
existing `check` script. This avoids maintaining duplicate test/build definitions
or recursively calling QG. Its timeout is 180 seconds; a failed child command or
timeout makes QG fail. The recommended repository rules retain their default
enabled states, severities and thresholds.

DIM's existing `source` job in `.dim/ci/runner.yml` still invokes
`scripts/ci/source.bash`. That script installs the exact lockfile with `npm ci`
and runs `npm run quality` instead of running the source checks separately.
Run the same source entrypoint locally with `bash scripts/ci/source.bash`.
The separate `browser` job invokes `scripts/ci/browser.bash`; both names are
declared required in `.dim/repos.yml` and run by `.github/workflows/ci.yml` for
push, pull-request and merge-group events. There are no path filters that silently
omit browser checks for UI changes. GitHub action references use verified full
commit pins; existing dependency pins and the npm lockfile are unchanged.

The source declarations are reviewable candidate configuration only. A coordinator
must publish exact-candidate CI, confirm both check identities and review protected
gate activation. Live protected-ref policy, reviewer requirements and promotion
are not changed by a local run or workflow commit. A missing runner or pending
required check blocks acceptance; it is not a green skipped browser lane.

### Authoritative metadata-free DIM snapshots

DIM source CI supplies the exact reviewed source tree without `.git`. QG 0.1.0
still needs `git ls-files` for its enabled `git/no-tracked-local-files` rule, even
in full-scan mode. A development checkout alone does not exercise that contract.

When the source root has no `.git` entry, the source entrypoint creates temporary
Git metadata outside that tree and indexes **all supplied paths**, including
ignored files, before `npm ci` creates derived dependencies. It then runs the same
`npm run quality`, unchanged rules, strict checks and build. The temporary index
represents authoritative snapshot membership only: it creates no commits,
remotes, history, review evidence or CI authority. It is removed on success or
failure, and no `.git` entry is written into the source tree. `TMPDIR` must be
outside the source tree; an unsafe placement fails rather than hiding files.

A real checkout or worktree with its own `.git` entry retains ordinary Git
behavior and its existing index. A missing root entry never borrows an ancestor
repository's membership. Existing broken Git metadata is not silently replaced.
The QG package, rules, artifact registry, severities and thresholds are unchanged.

Run the disposable full-source acceptance separately from the default Node suite:

```sh
node --test tests/source-snapshot.acceptance.ts
```

It executes the actual source entrypoint in a complete metadata-free snapshot,
checks that the browser build was produced and temporary metadata was removed,
then proves an ignored local-only source file is rejected by the unchanged Git
rule even beneath an unrelated parent repository. It also verifies the parent
index and supplied violating file are preserved. The acceptance has a distinct
filename so its nested full source check cannot recursively invoke itself.

### Required account-free browser lane

Run `bash scripts/ci/browser.bash` or `npm run test:browser:ci` in a disposable
checkout. Supported runners are Ubuntu 24.04 and Debian 12 with the exact Node
version in `.node-version`, network access to the npm/Playwright/OS package
repositories, and root or passwordless sudo for dependency setup. This is software
CI, not a dependency on a live Work Hub deployment or private provider endpoint.

The entrypoint creates a private temporary HOME, TMPDIR and browser cache, and
passes an environment allowlist. It does not inherit provider credentials,
`WORK_HUB_CONNECTIONS`, browser executable overrides or opt-in live-test settings.
It uses `npm ci`, the lockfile-local Playwright CLI, and `install --with-deps
chromium`, then builds and runs the existing simulator project. Browser, library
or download failures stop the command; there is no existing-browser fallback.
The built UI/API/SQLite fixtures create and remove their own temporary data.
Do not run the clean-install/build command in a checkout serving retained manual
preview data; it never needs to touch that preview's directory, auth or ingress.

Playwright forbids focused tests and retries are disabled. Its native JSON report
must contain at least one executed simulator test, exactly one passed result per
test, no skips/expected-failures/global errors, and matching positive pass counts.
The report verifier rejects live-project evidence. Failure screenshots and the
JSON report live in `test-results/browser-ci/`; GitHub uploads that directory even
after failures. Missing artifacts fail upload rather than implying a test pass.

The optional actual-provider project is explicitly selected with
`npm run test:browser:live`; it is never part of the account-free required lane.
Source checks may still visibly skip optional native-service tests. Such skips do
not qualify those services. Browser CI does not prove Codex/Claude execution,
provider login, physical host/VM acceptance, or a human business decision.

## Scope and findings

QG's full scan walks the filesystem, including Git-ignored files. The shared
generated-artifact registry classifies only local outputs: `.codegraph/` indexes,
`.omo/` agent work records/evidence, Playwright captures and reports, screenshots,
and `data/` runtime state. Built-in registrations already cover npm lockfiles and
source maps. Product code, tests, repository configuration and shipped documents
are not excluded. No source rule is disabled or given a higher threshold.

The combined live-integration candidate additionally registers only
`.deps/blocks/**` in the shared downloaded-artifact bucket. This is the ignored,
untracked external Git checkout at exact source pin
`df6f800828cd58acd2af65c32e7341609601be89`, not Work Hub product source or tracked
vendoring. Blocks remains owned and checked by its own repository/AKB adapter;
Work Hub does not rewrite its source to satisfy unrelated document policies.
No broad `.deps/**` exclusion, source suppression, rule severity change or
threshold increase is introduced. Git-integrity policies remain active.

Local `.env` files and SQLite database/WAL/shared-memory files are also classified
to mirror their existing Git-ignore privacy boundary, even outside `data/`.
This prevents content rules from reading private runtime state during a full
scan. `.env.example` remains checked as ordinary repository documentation.

Initial repository findings were corrected by wrapping overlong statements/SQL
without changing behavior, wrapping documentation paragraphs, using ordinary
ASCII punctuation in English documents, and adding `* text=auto eol=lf` in
`.gitattributes`. Existing UI copy, multilingual test fixtures and strict typing
are preserved.

Two default advisory warnings remain visible: the shared component stylesheet
exceeds 500 lines, and the test directory contains more than 50 direct files.
Both remain below QG's default error thresholds. Restructuring either solely to
silence an advisory would add unrelated product/test-discovery churn.

## Optional hooks

This integration does not install or replace Git hooks. QG's default setup check
may print a missing-hook warning; it does not alter rule/check exit status.
Developers who want the supported project-local hook can explicitly run
`npm exec -- qg hooks install` and reproduce it with
`npm exec -- qg run-hook pre-commit`. Existing custom hooks should be reviewed
before replacement; no automatic or forced hook installation is configured.

## Authoritative package documentation

- [Published CLI package](https://www.npmjs.com/package/@slop-lab/qg)
- [CLI setup, configuration, checks and exit codes](https://github.com/slop-lab/quality-gate/blob/7093d0761a3c3ca5ae7070542271c8bcebfd1173/docs/cli.md)
- [Generated-artifact classification](https://github.com/slop-lab/quality-gate/blob/7093d0761a3c3ca5ae7070542271c8bcebfd1173/docs/generated-artifacts.md)

These references were checked against the actual published 0.1.0 package. No
JavaScript/TypeScript configuration module, invented rule framework, extra lint
adapter, coverage threshold or daemon is required for this integration.

## Integration verification

- `bash scripts/ci/source.bash` completed successfully with the pinned lockfile;
  QG ran the existing strict-types, 219-test and build pipeline through `check`.
- `npm run quality:rules` passed with zero errors and the two documented
  advisory warnings, without changing their thresholds.
- `npm run quality:staged` passed against the final staged CI/documentation
  changes and ran the same working-tree source checks.
- A temporary configuration made a child command exit with code 23. The actual
  QG CLI returned exit 1 and reported `checks/intentional-command-failure` with
  that exit code. The probe did not alter repository checks and was removed.
- Synthetic non-secret `.env` and SQLite/WAL/shared-memory fixtures in the
  isolated review checkout initially produced four content-rule findings. The
  privacy classification removed those findings while preserving the normal
  two advisories. All four fixtures were removed after verification.
- `npm run test:browser` passed all 24 real-backend browser journeys after the
  statement-layout changes. No DOM, UI copy, styles or event behavior changed.

These are local verification results, not a native DIM CI publication or human
approval. Current candidates require both declared source and simulator browser
jobs plus normal review; exact remote run identities belong in CI/review receipts.
