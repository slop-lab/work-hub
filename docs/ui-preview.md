# Inspect the real UI with isolated simulator data

From the repository root, with Node 24 and installed dependencies:

```sh
npm run build && npm run preview -- start --directory /absolute/private/preview --port 43127 --origin http://localhost:43127
```

Select a new directory whose parent exists, or an empty directory. This runs the
normal `application/api/server.ts`, built browser assets, HTTP authentication,
SQLite persistence, Hub commands and existing simulator. It is not another UI or
a screenshot mock. The normal Simulator banner and `[Preview]` task titles mark
all artificial evidence. No provider account is needed or qualified by this lane.

The launcher prints the **path only** of `preview-admin-token`. That file is mode
0600 inside a mode 0700 directory. Obtain it through a private operator channel
and enter it in the normal sign-in form. Never put its contents in a URL, terminal
recording, screenshot, task, or log. Browser sessions use the existing auth store.

## Click paths

Use **Backlog**, open the named `[Preview]` task, then **Session**. The manifest
`preview-scenarios.json` also records current task/session IDs for direct URLs:
`/#/backlog/TASK_ID` and `/#/session/SESSION_ID`. Reload retains the same records.

| Task | Inspect or act |
|---|---|
| Active output | Session > Transcript; **Simulator scenario** can append output or observations. |
| Blocking question | Today > **Answer which acceptance target...** > Save answer; Session > Linked requests shows the separately tracked delivery. |
| Result awaiting review | Open task > result review > **Request revision**. A reported result does not terminate execution or complete its task. |
| Completed without result | Open task > Reliable lifecycle > Attempt recovery. Choose a reason and explicit controlled resume/retry; no successful result is invented. |
| Failed and stopped | Inspect the failed predecessor and stopped retry in task history. Recovery remains a deliberate human action. |
| Answered with unknown delivery | Session > Linked requests. Under **Simulator scenario**, choose **Restore delivery lookup** and **Emit simulated event**. Then Today > Operational issues > **Review operation** > **Reconcile operation**. Reload the session to see delivery acknowledged. Fresh pending lookups may reconcile automatically; long-lived operations intentionally stop after bounded lookup attempts and need the explicit check. No answer is resent. |
| Limited capability and history | Session > Transcript and capability limitations. History gaps remain visible; unsupported immediate input is not silently queued. |

Existing browser journeys additionally cover final-result acceptance, active-work
completion choices, and revision continuations. The seeded reported result is a
checkpoint, not fabricated final acceptance. Completing work is always a human
decision with the existing active-execution safeguards.

## Status, stop, reset and restart

Run these from the same repository, always explicitly selecting the directory:

```sh
npm run preview -- status --directory /absolute/private/preview
npm run preview -- stop --directory /absolute/private/preview
npm run preview -- reset --directory /absolute/private/preview
npm run preview -- start --directory /absolute/private/preview --port 43127 --origin http://localhost:43127
```

Ctrl-C also stops a foreground launch gracefully. `stop` checks the process's
start ticks, server script, data directory, port and origin before signaling it.
This process check uses Linux `/proc`; it does not signal a guessed or stale PID.
It does not terminate runtimes or environments belonging to other applications.

`reset` refuses a running preview. A directory/repository ownership marker and
private, user-owned, regular single-link state files are required. Linked paths,
unowned nonempty directories and identity mismatches are rejected. An exclusive
operation lock serializes launch setup, stop and reset. An interrupted setup can
leave that lock behind; do not automatically steal or recursively delete it.

Reset archives only the exact owned Hub/simulator databases, their SQLite
sidecars, and scenario manifest under `archive/`, then reseeds using normal Hub
operations. It preserves authentication/token files and unrelated files, including
provider configuration. Scenario IDs change after reset; the token does not.
Never substitute production `data` or an existing auth/provider directory.

The child server receives only `DATA_DIR`, `HOST`, `NODE_ENV`, `PORT`,
`PUBLIC_ORIGIN`, and `WORKER_INTERVAL_MS`. Inherited `WORK_HUB_CONNECTIONS`, provider
keys, router credentials, `HOME` and `NODE_OPTIONS` are not passed. Seeding also
constructs an explicitly simulator-only Hub. External installations retain their
normal server-side administrator and simulator-availability gates; the new
lookup-restoration control is unavailable there.

## Workspace HTTPS preview

Choose an unused loopback port. Obtain the public URL through the workspace's
advertised DIM `external-urls` interface rather than guessing a hostname:

```sh
dim-expose --name preview --port 43127 --ingress shared
```

Use the returned HTTPS **origin**, without its trailing slash, as `--origin`.
The normal server then issues Secure, HttpOnly, SameSite=Strict cookies and
enforces same-origin mutations. Exposing a route does not disable authentication.
Do not restart another service to make the port available. Route exposure may
create a new record rather than updating an existing one; inspect `dim-expose
list` before repeating it.

Keep current endpoints, route IDs, process identities, credential paths, service
availability and screenshots in the private deployment/review handoff, not this
procedure. Reuse an existing correctly owned route instead of exposing another.
Use the supported supervisor only when available; the foreground CLI and checked
stop command work independently. Never resume or restart unrelated services.

## Verification

`npm run check` includes strict types, behavior/HTTP tests and the build.
`npm run test:browser:ci` is the required account-free browser CI command. It
installs the exact lockfile, matching Chromium and OS dependencies, builds the
actual application, and runs the simulator project through the existing runner.
It rejects missing setup, skips, focused tests, empty execution and failed/flaky
results. Run it in a disposable supported Linux checkout, never the retained
manual preview's serving checkout. `npm run test:browser` is the already-prepared
developer shortcut using the same tests and temporary real application/database
fixtures. `tests/preview/browser-preview.spec.ts` covers
missing no-result, failed/unknown termination, durable deep-link/reload,
delivery-recovery and external-mode denial coverage. Other existing journeys
retain question/review/acceptance checks. These are simulator-backed application
regressions, **not real-provider qualification**.

`npm run test:browser:live` is separate optional actual-service qualification and
requires explicit native model/agent selection. Simulator CI establishes software
behavior, not actual Codex/Claude execution, provider accounts, host lifecycle or
physical/account acceptance. Local results are not accepted remote CI publication
or human approval. Retain exact candidate/run receipts and screenshots privately.
No live provider request or login is part of preview startup, seeding or required
simulator browser CI.
