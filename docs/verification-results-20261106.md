# Remaining runtime verification, 2026-11-06

This continues `docs/verification-followup-20261105.md`. Existing evidence and
production state are preserved. The private continuation ledger is
`/home/dim/tasks/verification-results-20261106/work-hub-ledger.md`.

Run build-producing checks to completion before browser verification: the browser
fixtures serve the candidate's `dist/web` files. A retained concurrent run exposed
a blank login page while assets were rebuilt and a detached scroll target during
background refresh. Authentication and timeouts were not relaxed. The screenshot
setup now performs synchronous native scrolling, and both failed scenarios passed
in the quiet sequential rerun. Final source/browser results and exact command
exits are recorded separately in the private ledger.

## Actual Codex custom-provider execution

The authorized installation command `dim-tools-setup codex` completed successfully.
The installed binary reports `codex-cli 0.156.1`, matching the DIM helper's pin.
This is an actual CLI installation, not the version literal in a fixture.

`node scripts/verify-codex-router.ts --run` executed one small disposable turn
through the existing normal guest DIM router. It used a separate private
`CODEX_HOME`, the explicitly selected `gpt-6.1-sol` Responses model, no tools or
file access, no production records, and no first-party login. The existing
project-scoped token stayed in memory/the child environment; generated TOML
contained an environment-variable name, not its credential value.

The actual Work Hub Codex connector confirmed submission, observed completed
execution and agent output, and emitted `result.submitted`. Native thread identity
and output digest are retained in the private receipt. The owned temporary work
directory, Codex home and ledger were cleaned after connector close.

**PASS: Codex runtime with the scoped custom provider.** This is explicitly not
ChatGPT authentication evidence: `dim-agent codex login status` still exits 1.
For a later first-party check, authenticate in the exact adapter `CODEX_HOME`
using `codex login --device-auth` or the supported browser login, then verify
`codex login status`. Do not copy an operator account or conflate router access
with that first-party account.

The verification driver requires explicit `--run`; ordinary builds/tests and
`--probe` do not issue a model call. Provider/model selection is checked against
the live scoped capability catalogue; it never silently substitutes another
model. Native catalogue validation and Work Hub readiness must pass before a
turn, and the generated sandbox is read-only. The final run requires exact marker
text, while the earlier retained execution receipt establishes the narrower
observed-marker/runtime-result claim.

The non-billable `--probe` stage initially failed because Codex's bundled catalogue
did not include the router's selected model, despite the passing real turn.
The driver now supplies Codex's supported `model_catalog_json` configuration from
the live scoped capability metadata. Native `codex debug models`, Work Hub
discovery and readiness then passed: one selected model, `ready:true`, zero model
calls. This is catalogue configuration, not bypassing an account check or making
up an API response. Failed native catalogue validation and fixed metadata receipts
are retained privately.

## Contract-gated AKB paired verifier

The coordinator is relaying the precise AKB owner request. Missing SSH is not
treated as a permanent blocker. A supported response document can be relayed to
`/home/dim/tasks/verification-results-20261106/akb-owner-response.md`, with private
principal files delivered through the reviewed secret transport rather than chat.

Prepare one owner-approved private manifest for:

```sh
node scripts/verify-akb-paired.ts --run /absolute/private-owner-manifest.json
```

Manifest format: `workhub.akb-paired-verification.v1`. Required fields:

| Field | Owner/coordinator supplies |
|---|---|
| `ownerContract` | Absolute non-secret contract file `path`, exact file `sha256`, AKB `sourceCommit` |
| `origin`, `workspaceId` | Protected HTTPS/internal loopback origin and disposable AKB workspace |
| `principals` | Absolute 0600 files for `reader`, `unmapped`, `denied`; each file contains only `{ "token": "..." }` |
| `documentsQuery` | Exact supported `kind`, `query`, bounded `limit` |
| `contextRequest` | Owner-confirmed pinned references or selection Page, plus byte budget |
| `resultRetrievalPath` | Exact supported GET path within that disposable workspace's Knowledge API; not an inferred endpoint |
| `expected` | Exact `{status, body}` for `documents`, `context`, `unauthenticated`, `unmapped`, `denied`, `result` |

The verifier checks the contract digest before network access. Success cases must
be HTTP 200; negative cases must be the owner-specified 401/403/404. Bodies are
compared exactly with the owner-provided JSON, not a guessed success schema.
It executes discovery, context success, invalid authentication, missing mapping,
permission denial, valid-reader recovery and result retrieval. Only bounded GET
and read-only context POST calls are made. Redirects and automatic retries are
disabled; whole-request/body time and response byte limits apply. Output contains
status/digests, never principal tokens or response bodies.

Review found and fixed a failure-path disclosure: raw JSON parsing and deep
equality diagnostics could previously print private response/token fragments.
Synthetic mismatch-body, malformed-response and malformed-principal sentinel
tests first failed and then passed after fixed diagnostics replaced raw parser
and object dumps. Malformed private configuration now raises a sanitized typed
error without its original JSON excerpt. These tests qualify failure redaction,
not real AKB DTO correctness.

The owner must provision and identify disposable records/accounts and the result
to retrieve, and provide cleanup/revocation commands. The verifier does not invent
account-issuance APIs, create proposals, accept Knowledge or write production data.

**Prepared, not real-service PASS:** the local harness self-test proves bounded
paired execution and truthful output classification. It is fixture evidence only.
The output deliberately reports `applicationSuccessParserQualified:false`:
transport/DTO comparison is not a replacement for implementing and exercising the
Work Hub success-parser/persistence/UI paths after the confirmed owner response.

## Remaining runtime evidence

**PASS, actual isolated Team Mode:** OpenCode 1.18.31 plus installed
oh-my-openagent 4.19.4 ran a real lead and `Sisyphus-Junior` child on the public free
model. Persisted child session `ses_e515ee1f0ffe1MPVQ79Z0lrAJy` has parent
`ses_e515f7863ffeYzg2cxg4Z6BAiQ`, delivered its marker independently, and completed
task 1. Parent and child each record cost 0 and zero file changes. Native exports,
database, tool call IDs and cleanup evidence are retained under private
`team-runtime/`. Shared configuration hashes were unchanged; the final team list
was empty after cleanup. This supersedes the earlier pure-runtime tooling gap,
but is not automatically Work Hub team-aggregation qualification.

Observed OMO runtime gaps remain: task completion required an `in_progress` hop;
configured team limits 1/1 were reported as 8/4; graceful approval still left the
member active, so owned-team forced cleanup was necessary. These are reported with
native evidence rather than patched inside a different project's installed bundle.
The native experimental background endpoint's earlier `false` result remains a
limitation, not a successful detached-background claim.

**Awaiting DIM owner capability:** the optional recipient implementation exists in
this candidate under `integrations/dim-host-plugin-work-hub`, but is not advertised
by the current host. It must be checked against the deployed DIM SDK, installed by
the owner, and granted a private current-incarnation registration before real
`assignment`, `ack`, and `result` operations can be qualified. The historical
compatibility SHA is not assumed compatible with the current deployed SDK. No
unrelated controller/service was restarted and no bridge-generation/source hash
was substituted for a runtime incarnation.

**Claude remains pending:** the actual guest router catalogue contains Responses
routes, not an advertised Anthropic/Claude backend, and no scoped Claude login is
present. No protocol shim, borrowed operator auth or fabricated Claude pass was
introduced. A compatible owner-confirmed backend or scoped first-party login and
attachable disposable session is still required.
