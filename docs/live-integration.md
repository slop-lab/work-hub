# Optional live integration: implementation and limits

Branch: `integration/dim-opencode-live`, based on native `origin/main`
`8269a7777e7d572b47919b9733331746b96c6204`. The QG candidate is separate and has
not been assumed merged. No package or QG changes are included in this slice.

## Responsibility and evidence

Work Hub keeps tasks, immutable attempt input, commands/outbox, questions, answers,
results and explicit human completion. The optional adapters live under
`application/connectors`. OpenCode keeps its actual agent/model/tool loop. DIM
keeps environment and service lifecycle. AKB keeps canonical knowledge and human
acceptance; see [the pending owner contract](akb-owner-contract.md).

No Docker, SSH, scheduler, host socket, master credential or lifecycle engine is
introduced. This coding workspace is an ordinary container, not a KVM guest test
runner. No existing environment is a disposable lifecycle test target.

### Actual OpenCode surface used

The installed 1.18.31 server's own `/doc` and a separate disposable server were
used to verify these interfaces:

- `GET /global/health`, `/path`, `/agent`, `/config/providers`;
- `GET /session?limit=50`, `POST /session`, `GET /session/{id}`;
- `POST /session/{id}/prompt_async`, exact `GET /session/{id}/message/{messageID}`;
- bounded `GET /session/{id}/message?limit=100`;
- `GET /question`, `POST /question/{id}/reply`, `POST /session/{id}/abort`.

Configured-provider discovery avoids the unrelated global `/provider` catalog,
observed at about 7.1 MiB. Transport reads remain bounded to 2 MiB with a 10-second
timeout, redirects refused and automatic HTTP retries disabled. Agents with
`hidden: null` are handled as reported by this installed server. Agent/model
selection is explicit, checked again before input, and never silently replaced.
OMO role model choices and configuration are not rewritten.

Each native mutation is fenced in a separate private SQLite ledger before the
HTTP effect. A client message ID is retained before sending. HTTP 204 alone is
**unknown delivery**, not proof of start or success. Exact user-message history
can confirm receipt. A corresponding assistant must be observed before reporting
runtime activity, and a completed associated assistant report is collected as a
result, not independent engineering verification or task completion.

No native prompt deduplication is claimed. Unknown input is never resent, even
after restart. Lookup only inspects the exact original message; missing history
does not prove non-execution. Session creation and lost question/abort responses
may require manual native inspection rather than automatic recovery.

Bindings retain the selected native installation, working directory, session,
agent/model and Hub-owned input ancestry across restart. Only Hub-owned messages
and their assistant children enter the task transcript. Unrelated pre-attachment
or external-client history is omitted, not copied into project access. Text is
bounded to 64 KiB per part and 100 native messages per observation; gaps remain
visible in the browser. Raw tool stdout and provider error bodies are not proxied.

One native free-text or single-choice question is mapped when its tool message
belongs to the current attempt. Multi-question, multi-select and native permission
approval shapes require the authenticated native view. Work Hub does not invent
local answers to them. Interrupt acknowledgment does not establish termination.
Native clients may also control a session; exclusive native control is not claimed.

Runtime mutations require the saved control grant. DIM-backed runtime bindings
also retain their environment scope/expiry and refuse new input after expiry.
Safety interrupt remains possible after environment expiry. A mapped connection
cannot bypass DIM authority using environment-free delegation.

## Trusted connection setup

Set `WORK_HUB_CONNECTIONS` to a private **0600**, single-link, user-owned regular
JSON file, at most 64 KiB. The service reads it at startup. Never put it in a
tracked directory, task text or browser form. Production operator credentials
belong in a reviewed service outside the untrusted coding workspace. The browser
receives safe projected discovery only, never connection origins or credentials.

An external-runtime-only configuration looks like this; placeholders are not
credentials or working installation identifiers:

```json
{
  "opencode": [{
    "installationId": "opencode-approved-environment",
    "label": "Approved OpenCode connection",
    "origin": "https://scoped-runtime.internal/",
    "directory": "/approved/repository",
    "authorization": "Basic OPERATOR_SUPPLIED_SCOPED_AUTHORIZATION",
    "nativeUrlTemplate": "https://authenticated-native-view.example/"
  }],
  "dim": []
}
```

Use **Settings → Discover connections** to inspect actual agent/model availability
and directory. Save an execution profile with an explicit project mapping.
Delegate only from a task. For an existing native session, copy its exact discovery
reference into **Session → Attach existing agent session**. Observe is the default;
attachment sends no greeting, resume or initial task input. Native open links are
operator-configured authenticated inspection/fallback URLs, never share-token URLs.

### DIM scoped adapter, not an invented host catalog

The actual available DIM interface in this workspace provides read-only
`GET /v1/resources` and `GET /v1/plugins` under a workspace-scoped bearer. It does
not expose a global host/workspace catalog, allocation/release grants or current
incarnation attestation. The adapter therefore offers neither allocation nor
release, and does not infer either permission from attachment.

An operator can add a `dim` entry only with explicit `installationId`, `label`,
scoped `endpoint`/`token`, stable `hostId`, workspace **UUID**, separate
`incarnation`, `displayName`, `identityExpiresAt`, `runtimeInstallationId`,
`allowedProjectIds`, and exact `workAreas` (`key`, `path`, `pathNamespace`, access
and preserve-existing policy). The matching OpenCode entry must have
`environment: {executionInstallationId, hostId, workspaceId, incarnation}`.
These are saved operator attestations, not discovery invented by Work Hub. They
expire closed and require revalidation after recreation. OpenCode `/path` verifies
the configured working directory. Names and URLs are not stable identity.

Settings can register these exact targets, then **Environments → Verify read-only**
performs scoped discovery. Attach/detach mutate Hub-owned access records only.
No target contents or lifecycle are changed. Grant references and route membership
are checked before attaching/opening; the derived runtime authority retains its
environment grant expiry and work-area scope.

**Writable DIM attachment is not accepted as live-qualified here.** The scoped
interface cannot establish that external native work is idle. The connector
reports activity as unknown, and the existing core refuses a writable attachment
without safe activity evidence. Do not relabel unknown as idle to pass a demo.
The DIM owner must supply a supported scoped identity/activity/lease discovery
interface or a reviewed trusted operator adapter, plus a disposable target. A
host-wide token inside this workspace is not an acceptable workaround.

## Actual-service checks

No provider or model is hardcoded in core. The acceptance commands deliberately
select this request's model and the currently discovered coordinator:

```sh
npm ci
npm run check
WORK_HUB_LIVE_MODEL=openai/gpt-6.1-sol \
WORK_HUB_LIVE_AGENT='Sisyphus - ultraworker' \
node --test tests/live-opencode.test.ts

PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium \
WORK_HUB_LIVE_MODEL=openai/gpt-6.1-sol \
WORK_HUB_LIVE_AGENT='Sisyphus - ultraworker' \
npx playwright test tests/browser-live-opencode.spec.ts
```

The opt-in fixtures start their own loopback OpenCode process in a separate
temporary work directory with a generated dedicated password. They do not attach
to or prompt an existing session. Backend data/credentials live in a different
temporary directory from the runtime work area. Default tests do not spend model
tokens; the live tests explicitly skip without a selected model and agent.

The live connector check exercises real question/answer/result and ledger reopen.
The browser check uses real authenticated Work Hub HTTP, configured discovery,
profile creation, task delegation, a native question, backend/connector recreation
while waiting, answer delivery, bounded transcript, a same-session continuation,
second result and explicit human completion. The ordinary DIM conformance checks
are wire fixtures, not real host lifecycle acceptance. No guest KVM claim is made.

## Persistent development services and route

The dedicated development OpenCode helper starts only its own fixture directory
`.deps/opencode-dev-workdir`, generates only a fixture credential in `data`, and
does not launch through Work Hub core. Existing OMO models remain unchanged.

```sh
dim-expose --name workhub-ui --port 3000 --ingress shared
dim-expose --name workhub-native --port 4198 --ingress shared
dim-workspace service register --name workhub-native-dev -- env \
  WORK_HUB_CONNECTIONS=/workspace/main/data/live-connections.json \
  WORK_HUB_NATIVE_PUBLIC_ORIGIN=https://work-hub-integration--workhub-native.mj-y.com/ \
  node /workspace/main/scripts/dev-native-service.ts
dim-workspace service resume

# Once, locally; save the administrator token privately.
npm run bootstrap
npm run build
dim-workspace service register --name workhub-ui-dev -- env \
  WORK_HUB_CONNECTIONS=/workspace/main/data/live-connections.json \
  DATA_DIR=/workspace/main/data \
  PUBLIC_ORIGIN=https://work-hub-integration--workhub-ui.mj-y.com \
  node /workspace/main/application/api/server.ts
dim-workspace service resume
dim-workspace service list
```

The first bootstrap has already been done for this development instance. Do not
repeat it. An operator can issue a new local user credential with
`npm run bootstrap -- credential user-admin`; no credential is included in this
document. Service restart does not stop native work or erase SQLite data.

Observed routes, approval `not-required`:

- Work Hub: `https://work-hub-integration--workhub-ui.mj-y.com/`, route ID
  `b0c363d7-dee4-492c-9f8f-299d409612e7`.
- Dedicated native fixture: `https://work-hub-integration--workhub-native.mj-y.com/`,
  route ID `b502443a-1bb1-4768-ad74-33299170d8f2`.

Both services were observed running. Work Hub `/health` returned 200 with
`simulation:false, liveReady:false`; unauthenticated Work Hub data and native
OpenCode health both returned 401. This is development publication, not approval,
promotion, production installation or full integration acceptance.

## Bounded remaining owner work

1. DIM: supply reviewed scoped host/workspace/incarnation/activity discovery and
   a disposable target. If VM verification is needed, request a **separate**
   disposable KVM runner after the assigned DIM runtime/device-grant fix; control
   plane and host must be separate VMs per DIM's privileged test contract.
2. AKB: deliver the exact-revision/proposal API contract and scoped installation,
   workspace/project mapping in [the owner handoff](akb-owner-contract.md). Then
   implement that actual transport and the context/proposal UI; no fake endpoint
   or auto-acceptance is supplied in this branch.
3. Root: run native DIM CI, human review and merge/install using the exact proposed
   SHA. QG can be reviewed/merged independently; this branch does not promote it.
4. Run the full Blocks Page → exact AKB revision → DIM/OpenCode → explicit result
   evidence → human completion → AKB proposal → fresh-browser human acceptance
   only after those interfaces/principals are provisioned.
