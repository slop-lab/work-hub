# Paired AKB application verification, 2026-11-06

This supersedes the pending-contract limitation in the earlier dated verification
receipts without relabeling their historical fixture/transport evidence.

## Confirmed owner boundary

- AKB owner-certified source: `4f6b9704c776877c594408e49f944ff169ccf238`.
- Existing protected service: `https://akb--akb-verify.mj-y.com`.
- Disposable source workspace: `verify-workhub-20261105-db591ef9`.
- Delegated service principal has only `content.read`, `knowledge.read`, and
  `knowledge.propose`; no reviewer, acceptance, owner, content-write or Project-read
  grant is used or requested.
- The capability is workspace-bound. There is no AKB principal-to-Work-Hub-project
  mapping API. Work Hub's authenticated project membership, optional explicit
  `allowedUserIds`, application workspace and installation tuple are the owning
  mapping. The dedicated AKB tenant assignment is an owner-provided fact, not a
  fabricated Project response.

## Implemented application path

`ConfiguredConnections` loads an isolated owner-readable 0600 configuration, not
the differently shaped staged capability file directly. The verification driver
builds that configuration from the one delegated capability and actual locally
created Work Hub workspace/project/principal records. Existing Codex/runtime
configuration is not overwritten. Source allowlists contain the supplied Page and
Knowledge IDs; allowed Spaces are empty because the supplied ordinary Page has no
Space. The token is server-side only, never returned in connection DTOs or retained
references.

New authenticated Work Hub APIs:

- `GET /api/v1/external-context/akb/:installationId/documents?projectId=...&kind=page|knowledge`
  returns parsed live summaries/cursors filtered by explicit source ID allowlists.
- `GET /api/v1/external-context/akb/:installationId/pages/:pageId/revisions/:revision?projectId=...`
  reads the exact Page DTO, not latest.
- `GET /api/v1/external-context/akb/:installationId/knowledge/:knowledgeId/revisions/:revision?projectId=...`
  reads the exact direct Knowledge object and preserves its candidate/acceptance
  distinction.
- `POST /api/v1/tasks/:taskId/external-context/akb/context` accepts
  `{commandId,installationId,contextRequest:{references,maxBytes}}`, fetches the
  exact ordered context and transactionally retains one immutable reference per
  source. `GET /api/v1/references/:id` retrieves the retained canonical JSON.

The client checks source allowlists before explicit-source transport, validates
the owner response schema, exact identity/revision/order, returned selection,
selected byte budget and `contentBytes === UTF8(JSON.stringify(items))`. Context
snapshots are canonical revision JSON, not Page read DTOs. Known Page and Knowledge
schema versions are validated without inventing missing read-DTO metadata.
Work Hub computes its own context/content digests; AKB returns no context ID or
server digest. Source workspace, installation, kind, ID, revision, schema version
and revision creation time are retained as provenance.

Discovery follows at most eight upstream pages per request and never forwards a
filtered-out source ID as a public cursor. Incoming/outgoing cursors must be
allowlisted IDs; hidden-only coverage beyond the bound requests a narrower query
instead of falsely claiming discovery is complete. Local reference display titles
are non-empty and bounded to 500 characters, while canonical snapshot titles and
bodies remain unchanged. Knowledge/discovery failures use resource-neutral source
errors, not misleading Page-only diagnostics.

The legacy single-Page capture path retains its latest-selection conflict
semantics. The new explicit context path can capture Page revision 2 while live
discovery reports revision 3. It never silently substitutes latest.

## Actual paired verification

```sh
node scripts/verify-akb-paired.ts --application
# Equivalent direct entry point:
node scripts/verify-akb-application.ts --run
```

Both use the staged minimum connector capability privately and launch only an
isolated loopback Work Hub application with disposable local data. No model turn,
provider login, external route creation or AKB mutation occurs. The raw owner
contract and observed immutable responses remain outside the repository under the
private evidence root; there are no embedded credential values.

The real HTTP application path verifies:

1. Actual authenticated Work Hub identity and secret-free integration metadata.
2. Actual routed AKB document pagination, Knowledge discovery and exact Page and
   Knowledge reads through the production clients/schemas.
3. Locally authenticated but unmapped principal, unmapped project, workspace,
   installation and out-of-allowlist source denials before source access.
4. Actual missing-revision and byte-budget errors, with no partial capture.
5. Page/Knowledge capture, persisted HTTP retrieval and structural equality with
   the owner's actual immutable snapshots.
6. Changed-payload conflict under the same command ID.
7. Durable replay after local app restart while the isolated provider credential
   is unusable; returned IDs are retained results, not a claimed fresh source read.
8. A new read fails on the real backend with that invalid credential, then the
   identical logical command succeeds after restoring the original scoped
   credential. No owner credential is rotated or widened.
9. Original retained snapshots survive restart/recovery unchanged.
10. Actual reviewer-only proposal detail is denied under the minimum connector
    capability. Exact accepted Knowledge retrieval remains permitted.

AKB 404 unavailable-source responses are exposed as Work Hub authorization errors;
backend authentication failure is a manual-action conflict, not a request to log
the human out or borrow a broader credential. Exact stage/status/code evidence is
retained privately. Owned local server, configuration and database are cleaned;
AKB owner records and its routed service are preserved for coordinator cleanup.

## Explicit limitations and evidence scope

- This is paired Work Hub HTTP application/client/persistence verification, not a
  new mixed-source Web picker or a claim that the owner's separate browser tests
  qualify Work Hub UI.
- Scoped context capture currently requires explicit pinned references. Saved
  selection-Page resolution and Space-only context discovery are not enabled by
  guessing source identities; the legacy Space-filtered Page API remains separate.
- Proposal publishing/review/acceptance is not added to Work Hub by these read
  changes. No connector proposal detail or self-accept success is invented, and
  no reviewer/admin token is requested to make a guessed harness pass.
- The older `--run <owner-manifest>` transport harness remains preparation-only.
  Actual pairing uses `--application` and needs no extra AKB role-token files or
  nonexistent remote mapping endpoint.

Private logs, safe configuration-validation receipts, exact Work Hub HEAD/dirty
status, command exits and final application results are indexed in
`/home/dim/tasks/verification-results-20261106/akb-application-ledger.md`.
