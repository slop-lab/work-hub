# Work Hub Design System

## 0. Research Log

- Embedded refs: shortlisted Linear, Sentry, and IBM Carbon; picked `taste-skill` + Linear because the product needs engineering precision and high scan density without becoming a protocol console.
- Lazyweb: 1 desktop query, 3 screens viewed (Linear backlog, Jira task detail, Rocketlane task/conversation); retained compact status grouping, a rich detail rail, and a persistent conversation region only when a session is selected.
- Image concepts: no verifiable generated-image artifact is retained in this repository. The implemented light graphite workspace is therefore governed by the token and component contract below, not by an unavailable mockup.
- Product contracts: implementation spec v0.3 and provider-neutral TypeScript contracts read in full. The UI preserves distinctions between task completion, attempt control, session attachment, environment detachment, and allocation release.

## 1. Atmosphere & Identity

Work Hub feels like a precise engineering notebook rather than a runtime cockpit.
The signature is the **attention rail**: actionable work is grouped by the decision
a person must make, while task content remains the visual center. Cool mist
surfaces and graphite type keep long sessions calm; a restrained vermilion accent
marks deliberate human actions. Design read: a responsive operational application
for developers and small teams, with Linear-like precision, title-first capture,
and explicit safety language. Dials: variance 4, motion 3, density 7.

Primary personas:
- **Maintainer on a laptop:** triages backlog, delegates, answers questions, reviews results, and needs keyboard-efficient navigation.
- **Operator under uncertainty:** must distinguish unknown, stale, simulated, detached, and released states without relying on color.
- **Low-vision or motion-sensitive member:** needs strong contrast, visible focus, zoom-safe reflow, and no decorative motion.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|---|---|---|---|
| Canvas | `--color-canvas` | `#f3f5f7` | App background |
| Surface | `--color-surface` | `#ffffff` | Primary panes and forms |
| Surface muted | `--color-surface-muted` | `#e9edf1` | Sidebar, grouped rows, disabled regions |
| Surface strong | `--color-surface-strong` | `#dce2e8` | Selected and pressed regions |
| Ink | `--color-ink` | `#17202a` | Primary text |
| Ink muted | `--color-ink-muted` | `#53606d` | Secondary text |
| Ink quiet | `--color-ink-quiet` | `#65717d` | Metadata and placeholders |
| Border | `--color-border` | `#cdd5dd` | Standard separation |
| Border strong | `--color-border-strong` | `#74808c` | Controls and emphasized separation |
| Accent | `--color-accent` | `#b43b24` | Primary action, active navigation, links |
| Accent hover | `--color-accent-hover` | `#8f2e1c` | Hover/pressed action |
| Accent soft | `--color-accent-soft` | `#f7ddd6` | Selected/action context |
| Success | `--color-success` | `#247a52` | Confirmed/done |
| Warning | `--color-warning` | `#9a6200` | Stale, limited, needs attention |
| Error | `--color-error` | `#a92f3b` | Rejected, failed, destructive |
| Info | `--color-info` | `#315f8f` | Observing, queued, neutral system info |
| Focus | `--color-focus` | `#0b6fc2` | Keyboard focus ring |
| Scrim | `--color-scrim` | `rgba(23, 32, 42, 0.55)` | Dialog backdrop |

### Rules
- Accent is reserved for interactive choices and the current location, never decoration.
- Status always includes a text label or icon plus text; color is supplementary.
- Simulator uses the warning palette and the literal label "Simulator".
- Untrusted text inherits ink tokens and is inserted with `textContent`; rich HTML is not rendered.
- No dark theme in the initial release. This is an explicit single-theme operational surface, not a consumer page.

## 3. Typography

### Font Stack
- Primary: `"Avenir Next", "Segoe UI Variable", ui-sans-serif, system-ui, sans-serif`
- Mono: `"IBM Plex Mono", "Cascadia Mono", ui-monospace, monospace`

### Scale

| Level | Token | Size / line-height | Weight | Usage |
|---|---|---|---|---|
| Display | `--text-display` | `2rem / 1.12` | 650 | Current task or route title |
| H1 | `--text-h1` | `1.5rem / 1.2` | 650 | Page heading |
| H2 | `--text-h2` | `1.125rem / 1.3` | 650 | Pane and attention group heading |
| H3 | `--text-h3` | `1rem / 1.35` | 620 | Card title |
| Body | `--text-body` | `0.9375rem / 1.55` | 450 | Default copy |
| Small | `--text-small` | `0.8125rem / 1.45` | 500 | Metadata and helper text |
| Caption | `--text-caption` | `0.75rem / 1.4` | 600 | Badges and field labels |
| Mono | `--text-mono` | `0.8125rem / 1.5` | 450 | IDs, command/evidence metadata |

Rules: titles are sentence case; labels are concise and never decorative uppercase; body text is never smaller than the Small token; unbroken identifiers use mono and `overflow-wrap: anywhere`.

Task and section headings keep CJK words intact with `word-break: keep-all`.
Long unbroken identifiers may wrap as an overflow fallback without forcing
ordinary Korean, Japanese or Chinese words to split between glyphs.

## 4. Spacing & Layout

### Scale

Base unit: 4px.

| Token | Value | Usage |
|---|---|---|
| `--space-1` | `0.25rem` | Icon/label |
| `--space-2` | `0.5rem` | Tight cluster |
| `--space-3` | `0.75rem` | Control padding |
| `--space-4` | `1rem` | Row/card padding |
| `--space-5` | `1.25rem` | Comfortable pane gap |
| `--space-6` | `1.5rem` | Section padding |
| `--space-8` | `2rem` | Major grouping |
| `--space-10` | `2.5rem` | Page separation |
| `--space-12` | `3rem` | Empty-state breathing room |

### Geometry
- `--radius-control: 0.375rem`; `--radius-panel: 0.625rem`; `--radius-pill: 999px`.
- `--sidebar-width: 14rem`; `--rail-width: 21rem`; `--content-max: 96rem`.
- Shell is bounded by `100dvb`. Sidebar/header remain fixed; `.app-main` owns vertical scrolling.
- Desktop: fixed sidenav shell; task/session detail may use a main column plus 21rem context rail.
- Tablet: sidenav becomes a horizontal route strip; context rail moves below main content.
- Mobile under 48rem: one readable column, compact shell header fixed outside the `.app-main` scroll owner, horizontal route reel, full-width controls, no primary-content horizontal scroll.
- Intrinsic grids use `repeat(auto-fit, minmax(min(18rem, 100%), 1fr))`.

## 5. Components

### App Shell
- **Structure:** header, primary nav, main scroll owner, optional dialog layer.
- **States:** authenticated, unauthenticated, loading, API unavailable.
- **Accessibility:** landmarks, skip link, current route with `aria-current`.
- **Layout:** fixed-sidenav-shell; only main scrolls.
- **Responsive route reel:** tablet/mobile navigation scrolls horizontally and automatically reveals the active route without moving main content.

### Button
- **Variants:** primary, secondary, quiet, danger.
- **Spacing:** `--space-2` and `--space-3`; one-line labels.
- **States:** hover, active transform, focus ring, disabled, busy with text status.
- **Accessibility:** native button, minimum 44px touch target where standalone.

### Field
- **Structure:** visible label, input/select/textarea, helper/error below.
- **States:** default, focus, invalid, disabled, stale target warning.
- **Accessibility:** no placeholder-only labels; error connected with `aria-describedby`.

### Status Badge
- **Variants:** neutral, info, warning, success, error, simulator.
- **Structure:** optional semantic dot plus text; never color-only.
- **States:** static; no decorative animation.

### Task Row
- **Structure:** status/priority, title, concise metadata, attention summary.
- **States:** default, hover, focus-within, selected, archived.
- **Layout:** grid row on desktop; stacked cluster on mobile.

### Attention Group
- **Structure:** decision-oriented heading, count, actionable items, empty copy.
- **States:** populated, empty, stale, delivery problem.
- **Layout:** intrinsic grid; items use links/buttons rather than clickable divs.

### Detail Section
- **Structure:** heading, content, optional action cluster.
- **Variants:** plain, emphasized, caution.
- **States:** empty, loading, error, limited capability.
- **Administrative rows:** primary labels and mono identifiers stack with `--space-1` so identity metadata never collides with names.

### Modal Sheet
- **Structure:** labelled dialog, summary/preview, form, explicit effect copy, action footer.
- **States:** open, submitting, conflict, error.
- **Accessibility:** focus moves in and returns to trigger; Escape closes only before submission.

### Transcript Entry
- **Structure:** role, timestamp, delivery/status metadata, safe text, references.
- **Variants:** user, agent, runtime, gap.
- **States:** partial, delivered, unknown, retained-history gap.
- **Pagination:** retained output loads from the session output query in pages of 50; coverage, gaps, and a "Load more history" control remain visible.

### Reference Selector
- **Structure:** retained text or an unfetched HTTP(S) link, title, availability, and explicit delegation checkbox.
- **States:** empty, retained text, external/unverified link, unavailable.
- **Safety:** saving a link records metadata only; the browser and hub never fetch it as part of creation.
- **Captured external text:** `.captured-text` preserves line breaks and wraps long
  URLs, revision IDs and digests anywhere without enlarging a grid's intrinsic
  minimum width. Result provenance uses the same inherited body-text primitive.

### Business Decision Panel
- **Structure:** completion note, explicit active-execution decision, complete/cancel/reopen/archive actions.
- **Safety:** task state never implies stop, session close, detach, or release.

### Reliable Lifecycle Section
- **Structure:** current missing action, responsible owner, next action, criterion coverage, amendment history, current result decision, blockers, and attempt recovery.
- **States:** no criteria, checkpoint awaiting final result, final result with gaps, accepted, blocked, interrupted, retry budget exhausted, and recovered.
- **Controls:** fixed lifecycle command forms only; human acceptance is explicit and automatic acceptance is never offered.
- **Layout:** one compact section composed from definition lists, sparse divided rows, and intrinsic form grids; it appears inside normal task and handoff detail flow rather than navigation.

### Linked Request List
- **Structure:** request status, blocking scope, prompt, reason, delivery state, and the safe next action.
- **States:** blocking runtime action, nonblocking, answered, delivery pending, delivery unknown, and superseded.
- **Authority:** task and session surfaces link to the existing Today/inbox answer authority; they never duplicate answer controls.

### Handoff Workspace
- **Route:** `#/backlog/:taskId/handoff/:attemptId`; the attempt identifier is durable backend identity, not browser draft identity.
- **Structure:** source snapshot, repository revision and validation request, recipient/session choice, canonical prompt preview, delivery ledger, parent/child activity, verification result, follow-up, and human decision.
- **Selection:** repository and recipient session are always explicit. Multiple project repositories remain visible with branch, full commit, validation request, and context references; no first-session or hidden-default selection.
- **Preview states:** incomplete, ready, stale, and rejected. Ready preview exposes the exact canonical prompt, target identity and incarnation, authority, readiness, and digest before first send.
- **Delivery states:** pending, delivered, acknowledged, failed, and unknown are rendered independently from execution activity. Retry reconciles or reuses the original command and never asks for credentials or creates a replacement attempt identity.
- **Activity states:** parent and child activity show observing, active, waiting, finished, stale, and unknown without reducing agent-finished to task success.
- **Result states:** passed, failed, partial, and blocked. Every verification entry shows source, environment, context status, and retained provenance rather than a summary-only success treatment.
- **Completion:** revision, continuation, Git/CI evidence, AKB context acceptance, and human task completion remain separate controls and facts.
- **Responsive layout:** desktop uses a main decision column plus the context rail; tablet moves the rail below; mobile preserves source-to-recipient order in one column with no horizontal prompt or identifier overflow.

### Connector Picker
- **Structure:** enabled and available connector installations only; no hidden fallback value.
- **States:** available simulator/connector, none available with disabled submit, unavailable registration history.

### Toast / Command Receipt
- **Structure:** stable effect text, receipt state, optional recovery action.
- **States:** confirmed, accepted/running, rejected/failed, unknown.
- **Accessibility:** polite live region except destructive failures use assertive; never steals focus.

### Primitive Showcase
- `?showcase=1` renders all primitives and meaningful states for visual QA at 375, 768, and 1280 widths before product routes are accepted.

## 6. Motion & Interaction

| Token | Duration | Easing | Usage |
|---|---|---|---|
| `--motion-micro` | `120ms` | `ease-out` | Button press, hover feedback |
| `--motion-standard` | `200ms` | `cubic-bezier(0.16, 1, 0.3, 1)` | Dialog/sheet and route content entrance |

- Motion communicates feedback or state transition only. No perpetual or decorative animation.
- Animate only opacity and transform. Dialog enters with a small opacity/translate change.
- `prefers-reduced-motion: reduce` removes transitions and smooth scrolling.
- Drafts persist to sessionStorage by user + session + attempt, never include login tokens, and are blocked when their attempt target is stale.
- Background refresh preserves the current route's main scroll position as well
  as field drafts. Navigating to another route starts at its top.

## 7. Depth & Surface

Strategy: mixed tonal shift plus restrained borders.

| Level | Token | Treatment |
|---|---|---|
| Base | `--shadow-none` | Canvas or plain section, no shadow |
| Panel | `--shadow-panel` | `0 1px 2px rgba(23, 32, 42, 0.05)` with border |
| Overlay | `--shadow-overlay` | `0 18px 48px rgba(23, 32, 42, 0.18)` |

- Lists prefer whitespace and one divider between rows, not nested cards.
- Raised panels are reserved for dialogs, task capture, attention items, and result review.
- Primary radius is restrained and consistent: controls 6px, panels 10px, pills only for badges/filters.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA target: 4.5:1 body contrast, 3:1 large text and component boundaries.
- Full keyboard path for login, capture, filtering, task editing, question answering, delegation, session instruction, review, environment actions, and settings.
- Visible focus on every interactive element, 44px touch targets on mobile, semantic landmarks/headings, and no focus theft on refresh.
- 200% zoom and 375px width reflow without primary horizontal scrolling.
- Plain-language effect copy distinguishes "detach" from "release" and "complete task" from "stop attempt".
- Unknown/stale/unreachable states include timestamp, reason, and safe next action where supplied.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| UI does not subscribe to the existing event stream | Whole app | `/events` exists, while this release uses bounded snapshot refresh to preserve simple draft/focus behavior. | Adopt cursor-based subscription after reconnect/reset UX is implemented. |
| No specialized terminal/native surface | Session | Contract marks these as interface extensions; normalized transcript remains complete core UX. | Add only after scoped surface channels exist. |
| No dark theme | Whole app | Single light operational theme reduces scope and keeps status contrast testable. | Revisit after core workflows and automated contrast tests stabilize. |
