# Optional runtime and environment integrations

Work Hub is the task-management product, not a DIM/OpenCode-specific frontend.
Environment providers, agent runtimes and document sources are separate choices.
DIM plus OpenCode is one supported integration direction, not the only way to use
Work Hub. AKB and Blocks are optional to task execution and completion.

## Product direction versus implemented adapters

| Component | Responsibility | Current Work Hub implementation |
| --- | --- | --- |
| Work Hub | Tasks, attempts, captured input, questions, commands, results, human completion | Core product |
| Environment provider | Environment identity, resources, lifecycle and service access | Simulator and limited DIM scoped adapter |
| OpenCode | Its own agent/model/tool loop and native sessions | Concrete runtime adapter |
| Claude Code | Its own agent/model/tool loop and conversations | Official Agent SDK adapter for existing-session attachment and turns |
| Codex CLI | Its own agent/model/tool loop and threads | App-server adapter with native thread/turn identities |
| AKB | Documents, knowledge, permissions and revisions | Authenticated Page read and explicit revision-pinned task-context capture |
| Blocks | AKB's editor/rendering dependency | No Work Hub editor integration required |

Additional runtimes must implement the existing `AgentRuntimeConnector` port.
They must not require a second task engine or silently replace the chosen runtime,
agent or model. Native resume, questions, approvals, interrupt and history support
are negotiated per adapter; an unsupported capability remains explicit.

## Configured runtime and document connections

The private connection file accepts separate `opencode`, `codex`, `claude`, `dim`
and `akb` arrays. An installation need not configure OpenCode to use another
runtime. Each installation ID is unique; there is no simulator or model fallback.

Codex connections specify the trusted executable, working directory, private
Codex home and deliberate model/provider. They use the official app-server
protocol. A configured DIM environment mapping is checked separately from native
thread identity. Native questions/approvals remain in the native client; the
adapter does not fabricate a response route. Its owned stdio process quiesces
new input and drains accepted native turns before shutdown.

Claude Code connections use the pinned official Agent SDK and an approved working
directory. The stable interface does not create an empty native session, so the
adapter attaches an existing session without a greeting or initial prompt.
Model selection is explicit; filesystem session discovery is not proof of model
authentication. Unknown turns are not resent. Closing Work Hub drains its active
SDK queries rather than forcefully closing or aborting them.

AKB connections specify the source origin and server-side authorization, source
workspace and permitted Spaces/Pages, plus the destination Work Hub workspace
and permitted projects. Task context capture re-reads the selected Page and
rejects changed revisions, archive state or denied/missing access. The resulting
reference retains selected text and source provenance in the existing immutable
attempt-input flow. It creates no editable document mirror or automatic proposal.

Connection discovery and profile selection are available in Settings. A task's
References section offers explicit AKB preview/capture. Source authorization and
runtime credentials are never browser form values, URLs or storage entries.

## Current OpenCode adapter contract

The adapter under `application/connectors/opencode` was developed against the
OpenCode 1.18.31 API shape. This is a compatibility baseline, not a claim about
the version or availability of any running service. Verify each target server's
own API description before configuring it. The used interfaces are:

- `GET /global/health`, `/path`, `/agent`, `/config/providers`;
- `GET /session?limit=50`, `POST /session`, `GET /session/{id}`;
- `POST /session/{id}/prompt_async`;
- exact `GET /session/{id}/message/{messageID}` and bounded message history;
- `GET /question`, `POST /question/{id}/reply`, `POST /session/{id}/abort`.

The transport uses a whole-operation deadline, bounded response bodies, no
redirects and no automatic HTTP retries. Selection is explicit and checked again
before input. Runtime/provider configuration is not rewritten by Work Hub.

Each native mutation is fenced in a private persistent connector ledger before
the HTTP effect. A client message ID is saved before sending. HTTP 204 alone is
unknown delivery, not proof of running or success. Exact user-message history can
confirm receipt; associated assistant observations establish runtime activity.
An associated completed assistant report is a result, not independent engineering
verification or human task completion.

No native prompt deduplication is claimed. Unknown input is not resent after a
restart. Lookup inspects the original message only; absent history does not prove
non-execution. Lost session-create, question-reply or interrupt responses can
require manual native inspection.

Bindings retain installation, working directory, native session, explicit
agent/model and Hub-owned message ancestry. Only that ancestry enters a task's
transcript. Unrelated native history is not copied into project access. History
is bounded and partial; gaps remain visible. Provider error bodies and raw tool
stdout are not exposed through the browser.

One associated free-text or single-choice native question is supported.
Multi-question, multi-select and native permission approvals require the native
client. Queued follow-up is supported; immediate steering and exclusive native
control are not promised. An interrupt acknowledgment does not prove termination.

## Trusted connection setup

`WORK_HUB_CONNECTIONS` points to a private 0600, single-link, user-owned regular
JSON file, at most 64 KiB. The backend reads it at startup. Credentials must not
appear in task text, tracked files, browser URLs or browser storage. Use a scoped
runtime connection, not host-wide credential passthrough.

This is an illustrative external-runtime-only shape, not a deployed instance:

```json
{
  "opencode": [{
    "installationId": "opencode-example",
    "label": "Selected runtime connection",
    "origin": "https://runtime.example.com/",
    "directory": "/approved/repository",
    "authorization": "Basic OPERATOR_SUPPLIED_SCOPED_AUTHORIZATION",
    "nativeUrlTemplate": "https://native.example.com/"
  }],
  "dim": []
}
```

Use **Settings > Discover connections** to inspect the actual directory, agents,
models and sessions. Save a profile with the intended project mapping. For an
existing native session, use its exact discovered identity in **Session > Attach
existing agent session**. Observe is the default; attachment sends no initial
prompt. A native open link is an operator-configured authenticated inspection or
fallback path, not the sole task UI or a fabricated sharing URL.

## DIM scoped connection

A DIM workspace is intentionally not a DIM host administrator. The current
workspace-scoped adapter reads `/v1/resources` and `/v1/plugins`; that grant is
not expected to expose host creation, global workspace management or lifecycle
authority. Do not interpret this restriction as missing DIM host functionality.

The adapter uses explicit operator-attested host ID, workspace UUID, incarnation,
expiry, permitted projects and work areas, plus the mapped runtime installation.
The OpenCode connection must map to the same identity and verify its directory
through `/path`. Names alone are not identity. Expired attestations fail closed.
Attach/detach change Hub-owned access records, not target contents or lifecycle.
This adapter does not implement allocation, release, service launch or a scheduler.

The scoped adapter reports external-writer activity as unknown and never treats
that as an enforced write lease. Host lifecycle operations are not exposed by
this connection type. Its behavior is separate from the runtime adapter selected
for a task.

## Reproducible checks

Default tests do not require live model spending. Live checks need deliberate
selection from the target runtime's discovery, not a repository-wide fixed model:

```sh
npm ci
npm run check

# Replace both values using the target runtime's actual discovery.
export WORK_HUB_LIVE_MODEL='<selected-provider>/<selected-model>'
export WORK_HUB_LIVE_AGENT='<selected-agent>'
node --test tests/live-opencode.test.ts
npx playwright test tests/browser-live-opencode.spec.ts
```

Use a compatible installed Chromium via `PLAYWRIGHT_EXECUTABLE_PATH` when needed.
The opt-in fixtures create their own authenticated loopback OpenCode process and
temporary work area; they do not prompt an existing session. Default tests and
live checks must be reported separately. See [verification boundaries](integration-verification.md).

## Deployment state is not documentation

No development service URL, route/session/task ID, supervisor state or bootstrap
completion record is a permanent product address or setup instruction. Obtain
current endpoints from protected deployment configuration and the environment
owner's service interface. Keep per-run evidence outside tracked product docs.

`scripts/dev-native-service.ts` is an optional dedicated development fixture,
not the universal runtime manager. Service publication, startup, restoration and
stable logical addresses remain deployment responsibilities. Removing stale URLs
from docs does not itself fix a disappearing route or restart a stopped service.
