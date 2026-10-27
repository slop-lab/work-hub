# Work Hub

A small, task-centered workspace for durable work records, human questions and
deliberate agent delegation. Built from the supplied v0.3 implementation baseline.

**Work Hub is independent of a particular runtime or environment provider.**
OpenCode, Claude Code and Codex CLI are runtime integration targets; DIM is one
environment-management option, and AKB is an optional document/knowledge source.
The default configuration uses deterministic simulations. Optional adapters
connect OpenCode, Codex CLI and existing Claude Code sessions; a scoped DIM
connection and authorized AKB Page capture can be configured independently.
See [runtime integration](docs/live-integration.md) for implemented connection
configuration and capability-specific behavior.

## Quick start

Requirements: **Node.js 24 or newer** and npm. No external services or credentials.

```sh
npm ci
npm run build
npm run bootstrap
# Save the generated administrator token somewhere private.
npm start
```

Open **http://localhost:3000** and sign in with that token. The first project is
ready for title-only tasks and questions; delegation is always an explicit action.
Bootstrap is local and one-time. It is not a public setup endpoint. Data defaults
to `./data`; use `DATA_DIR=/path/to/private-data` for persistent deployment.

```sh
npm run dev                # restart the backend when TypeScript changes
npm run build              # rebuild browser assets after frontend changes
npm run typecheck          # strict TypeScript
npm run quality            # QG repository rules, then existing types/tests/build
npm run quality:staged     # staged rule inputs; same working-tree checks
npm run quality:rules      # full rule scan only, not the complete CI gate
npm test                   # behavior, contract and HTTP tests
npm run test:contracts     # connector conformance
npm run test:acceptance    # acceptance scenarios
npm run test:browser       # browser journeys (install Chromium first)
```

For browser tests: `npx playwright install chromium`. Tests use temporary data
directories; do not point test fixtures at a real workspace database.
On a host with an existing compatible Chromium, set `PLAYWRIGHT_EXECUTABLE_PATH`.
Browser tests require that browser's normal shared libraries; the core Node tests
and application service do not require a browser installation.

## Try the end-to-end simulator flow

1. Capture a title in **Backlog**, add context or a formal question, and answer it
   from **Today**. No environment or runtime starts from capture or a question.
2. Select **Delegate**. The project's default profile is selected, but nothing runs
   until confirmation. Choose no environment, a new simulated allocation, or a
   saved existing registration that you verified under **Environments**.
3. Open **Session**. The collapsed **Simulator scenario** panel can emit a question,
   result, output or termination observation. These are artificial reports, not real execution.
4. Answer a question, inspect its saved/delivery state, then emit a result. A result
   does not end work; termination is a separate simulated event.
5. Request revision as an instruction while work is active, or as a new continuation
   after it ends. Complete the task only through a human decision. Active work
   requires an explicit choice to request stop or acknowledge that it may continue.
6. Detach existing-environment access without deleting anything. Allocation release
   is separate, requires its recorded grant and an explicit reference-preservation choice.

## How the product is divided

- **Tasks** describe work and the human's business decision.
- **Sessions** identify a logical native-runtime collaboration context.
- **Attempts** are explicitly initiated work units, with immutable input snapshots.
- **Environment registrations** save approved existing-target locators.
- **Environment bindings** record verified incarnations and scoped use/lifecycle grants.
- **Requests/responses** preserve questions and immutable committed decisions;
  runtime delivery is a separate tracked fact.
- **Results** report an attempt's work. A human still chooses completion or revision.

Connecting to an existing environment does not allocate or initialize it. Attaching
an existing native session does not submit a prompt. Viewing or closing a browser
tab does not launch or stop work. Detaching ends access, not infrastructure lifecycle.
An allocation release is a separate guarded action governed by its recorded policy.

## Layout

```text
application/api/             HTTP, authentication, local bootstrap
application/commands/        validated mutation handlers
application/domain/          canonical work and interaction rules
application/persistence/     migrations and transactional storage
application/orchestration/   durable outbox, stages and reconciliation
application/contracts/      provider-neutral v0.3 types and runtime validators
application/simulator/      deterministic, persistent connector implementations
web/                        task-oriented browser application
tests/                      behavioral and acceptance evidence
docs/                       architecture, operations, connector guide, test report
```

## Configuration and credentials

See `.env.example`. Environment variables are read from the process; the server does
not automatically load a `.env` file. The listener is loopback by default. Network
deployment requires an HTTPS `PUBLIC_ORIGIN` and a TLS reverse proxy. Never expose
the unencrypted internal listener to an untrusted network.

Additional user credentials are issued locally for existing enabled user IDs:

```sh
npm run bootstrap -- credential user-id
npm run bootstrap -- --help
```

Users and bridge principals are separate. A bridge token has an expiry, task,
session, attempt, binding generation and command allowlist. It cannot answer a
human approval or operate on another task. Tokens and private route handles are
excluded from work exports; do not paste secrets into task text or runtime output.

## Design and operating documentation

- [Architecture and five milestones](docs/architecture.md)
- [Deployment, backup and restore](docs/operations.md)
- [Connector author guide](docs/connectors.md)
- [Design system](DESIGN.md)
- [Acceptance traceability](docs/acceptance.md)
- [Executed verification and limits](docs/verification.md)
- [Repository quality gates](docs/quality-gates.md)
- [Runtime adapters and optional integrations](docs/live-integration.md)
- [Integration verification procedure](docs/integration-verification.md)

Production qualification, terminal gateways, workflows, automatic prompt retries,
agent review engines, merges, IDE functionality and infrastructure management remain
outside the adapters. No host or control-plane installation is modified.
