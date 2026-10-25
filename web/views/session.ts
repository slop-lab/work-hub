import { badge, button, el } from "../dom.ts";
import type { HubAttempt, HubSession } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";
import { instructionComposer, sessionControls } from "./session-controls.ts";
import { emptySession } from "./session-empty.ts";
import { simulatorPanel } from "./simulator-panel.ts";
import { sessionOutput } from "./session-output.ts";

export function sessionView(ctx: UiContext, sessionId?: string): HTMLElement {
	const session = sessionId === undefined ? ctx.state.sessions[0] : ctx.state.sessions.find((item) => item.id === sessionId);
	if (session === undefined) return emptySession(ctx);
	const task = ctx.state.tasks.find((item) => item.id === session.taskId);
	const attempt = ctx.state.attempts.find((item) => item.id === session.activeAttemptId);
	const binding = ctx.state.environmentBindings.find((item) => item.sessionId === session.id);
	const requests = ctx.state.requests.filter((item) => item.sessionId === session.id);
	const results = attempt === undefined ? [] : ctx.state.results.filter((item) => item.attemptId === attempt.id);
	const environment = el(
		"section",
		{ class: "detail-section" },
		el("h2", {}, "Environment attachment"),
		binding === undefined
			? el("p", { class: "muted" }, "No hub-managed environment binding.")
			: el(
					"div",
					{ class: "stack" },
					badge(binding.origin === "allocated" ? "Managed allocation" : "Existing attachment", binding.origin === "allocated" ? "info" : "warning"),
					el("p", {}, binding.identityLabel),
					el("p", { class: "muted" }, binding.limitations.join(" ")),
					el("a", { class: "button button--secondary", href: "#/environments" }, "Review boundary"),
				),
	);
	const related = el(
		"section",
		{ class: "detail-section" },
		el("h2", {}, "Related decisions and results"),
		requests.length === 0 && results.length === 0
			? el("p", { class: "muted" }, "No questions or results yet.")
			: el(
					"div",
					{ class: "stack" },
					...requests.map((item) => el("article", { class: "history-item" }, badge(item.status, item.status === "open" ? "warning" : "success"), el("p", {}, item.prompt))),
					...results.map((item) => el("article", { class: "history-item history-item--answer" }, badge("result", "success"), el("p", {}, item.summary))),
				),
	);
	return el(
		"div",
		{ class: "page session-page" },
		el(
			"header",
			{ class: "page-heading session-heading" },
			el(
				"div",
				{},
				el("p", { class: "kicker" }, task?.title ?? "Session"),
				el("h1", {}, session.runtimeLabel),
				el("div", { class: "cluster" }, badge(session.state, session.state === "open" ? "success" : "neutral"), badge(session.controlMode, session.controlMode === "control" ? "info" : "warning"), attempt === undefined ? null : badge(attempt.phase, attempt.phase === "waiting_input" ? "warning" : "info")),
			),
			el(
				"div",
				{ class: "cluster" },
				task === undefined ? null : el("a", { class: "button button--secondary", href: `#/backlog/${task.id}` }, "Open task"),
				button("Refresh", "quiet", () => void ctx.refresh()),
			),
		),
		el(
			"div",
			{ class: "session-layout" },
			el("section", { class: "transcript-pane" }, el("header", { class: "section-heading" }, el("h2", {}, "Transcript"), el("span", { class: "muted" }, "Retained output is paginated")), sessionOutput(ctx, session, attempt), instructionComposer(ctx, session, attempt)),
			el("aside", { class: "session-rail" }, sessionFacts(session, attempt), related, environment, sessionControls(ctx, session, attempt, binding), simulatorPanel(ctx, session)),
		),
	);
}

function sessionFacts(session: HubSession, attempt?: HubAttempt): HTMLElement {
	return el(
		"section",
		{ class: "detail-section" },
		el("h2", {}, "Session facts"),
		el(
			"dl",
			{ class: "definition-list" },
			el("dt", {}, "Generation"),
			el("dd", {}, String(session.bindingGeneration)),
			el("dt", {}, "Control"),
			el("dd", {}, session.controlMode),
			el("dt", {}, "Attempt"),
			el("dd", {}, attempt?.id ?? "None"),
			el("dt", {}, "Observation"),
			el("dd", {}, attempt?.observation ?? "No attempt"),
			el("dt", {}, "Observed"),
			el("dd", {}, attempt?.updatedAt ?? "No observation"),
		),
		...session.limitations.map((item) => el("p", { class: "limitation" }, item)),
	);
}
