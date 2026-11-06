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

For this workspace, the running preview is:

- URL: `https://work-hub--preview.mj-y.com/`
- Loopback port: `43127`
- Owned data: `/home/dim/.local/state/work-hub-preview-20261106`
- Private token path: `/home/dim/.local/state/work-hub-preview-20261106/preview-admin-token`
- Nonsecret launcher log: `/home/dim/tasks/ui-preview-20261106/preview.log`

The DIM service supervisor currently fails reading its kernel boot identity.
This preview was launched separately in the background using the same foreground
CLI. Use the identity-checked `stop` command above, not a broad `service resume`
or production restart. It is not registered for automatic restart after a workspace
reboot. Start it again explicitly when needed.

## Verification

`npm run check` includes strict types, behavior/HTTP tests and the build.
`npm run test:browser` reuses the existing Chromium runner and temporary real
application/database fixtures. `tests/preview/browser-preview.spec.ts` adds only
missing no-result, failed/unknown termination, durable deep-link/reload,
delivery-recovery and external-mode denial coverage. Other existing journeys
retain question/review/acceptance checks. These are simulator-backed application
regressions, **not real-provider qualification**.

External-URL Chromium evidence and a small screenshot set are retained under
`/home/dim/tasks/ui-preview-20261106/`. No live provider request or login is part
of preview startup, seeding or browser qualification.
