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
| `npm run test:browser` | Existing real-backend browser journeys; requires compatible Chromium |

The root `.qg.yaml` uses the supported top-level command check to invoke the
existing `check` script. This avoids maintaining duplicate test/build definitions
or recursively calling QG. Its timeout is 180 seconds; a failed child command or
timeout makes QG fail. The recommended repository rules retain their default
enabled states, severities and thresholds.

DIM's existing `source` job in `.dim/ci/runner.yml` still invokes
`scripts/ci/source.bash`. That script installs the exact lockfile with `npm ci`
and runs `npm run quality` instead of running the source checks separately.
The required-job and protected-reference policies are unchanged. Run the same
entrypoint locally with `bash scripts/ci/source.bash`.

Browser verification stays separate from that source job so CI does not depend
on a browser runtime or change the workspace's server/session setup. Changes to
browser-served code should also run the browser suite as described in the README.

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
approval. The proposal still requires the normal DIM source job and review.
