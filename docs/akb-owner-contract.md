# AKB owner contract requested by Work Hub integration

Owner: remote-main-2, workspace `akb`. Consumer: remote-main-4,
`integration/dim-opencode-live`. This is a requirements handoff, not a claim that
new AKB endpoints are installed or working. No AKB HTTP paths are guessed here.
The current owner brief names baseline `eeed623fd877d3bbd15c6117513db979b85c41a1`;
an exact-revision/proposal contract has not been delivered to this checkout.

## Authority and installation mapping

The trusted backend needs one explicitly configured mapping:

- Work Hub installation ID, workspace ID and permitted project IDs;
- AKB installation identity, canonical workspace and project IDs;
- server-side credential reference for an authenticated, scoped AKB principal;
- safe browser deep-link origin, not a bearer token or a private route handle.

An equal display name does not establish any mapping. AKB authorizes search,
revision retrieval, proposal submission and human acceptance independently.
Work Hub must not impersonate an accepting human or grant itself extra scope.

## Context selection requirement

Please supply the actual supported discovery, authorization and retrieval API,
including status/error semantics and its reviewed commit. The consumer needs:

1. Authorized bounded search/list of canonical Pages and Knowledge.
2. Selection by installation, AKB workspace/project, object kind and object ID.
3. Retrieval of one exact immutable revision, never a silent read of latest.
4. Stable revision identity, content digest with defined canonicalization, title,
   content format, retained selected text, observed time and revision deep link.
5. Explicit permission-denied, missing and no-longer-retained revision outcomes.

The captured Work Hub input retains the selected content alongside its external
identity, revision and digest. Later AKB edits cannot rewrite a delegated attempt.
This retained input is evidence, not a second editable knowledge document.
No fake AKB WorkItem or Run, task-status mirror, or general two-way sync is needed.
Blocks stays behind AKB's editor adapter. Work Hub does not embed Blocks or assume
an npm release. The supplied local source pin remains ignored and untracked.

## Result-to-proposal requirement

Submission is a separate explicit human action after reviewing a particular
Work Hub result. It must create a **proposal**, not accepted Knowledge. Please
supply the owner-defined proposal API and its idempotency/lookup behavior.
Required provenance fields, or equivalent owner-defined fields, are:

| Source | Required identity/evidence |
| --- | --- |
| Work Hub | Installation, workspace, project and task ID |
| Attempt | Attempt ID and immutable input snapshot ID/digest |
| Result | Immutable result ID and captured content digest |
| Native runtime | OpenCode installation/session and source message/event identity |
| AKB input | Every selected canonical object, exact revision and digest |
| Engineering evidence | Explicit repository/commit and CI/review evidence references, if supplied |
| Submitting human | Scoped authenticated principal and explicit submission intent |

The adapter must refuse mismatched task/attempt/result provenance, changed result
content and out-of-map projects before submission. Repeating a timed-out proposal
write is forbidden unless the actual owner API provides safe idempotency and
lookup. Keep an uncertain submission visible; do not manufacture acceptance.

The response needs proposal identity, revision/digest or equivalent immutable
receipt, and a safe review deep link. A fresh AKB browser, authenticated as a human
with acceptance authority, reviews and accepts it. Work Hub must not call an
acceptance endpoint. Git approval, DIM CI acceptance, task completion and knowledge
acceptance remain four distinct decisions.

## Acceptance still blocked on owner delivery

The remaining cross-service run is: save a Blocks Page in AKB; select its exact
revision in Work Hub; delegate in a verified DIM environment through OpenCode;
answer/follow up; collect a result and explicit commit/CI refs; human-complete the
task; explicitly submit the proposal; review/accept in a fresh AKB browser.

Needed handoff: reviewed commit, actual API/auth schemas, installation/project
mapping and a disposable scoped test principal/environment. No operator master
credential, host socket, broad SSH key or existing-session mutation is requested.
