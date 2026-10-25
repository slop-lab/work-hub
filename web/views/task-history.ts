import { badge, el, formatTime } from "../dom.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function taskHistory(ctx: UiContext, task: HubTask): HTMLElement {
	const entries = ctx.state.entries
		.filter((item) => item.taskId === task.id)
		.map((item) => ({ at: item.createdAt, node: el("article", { class: "history-item" }, el("div", { class: "cluster" }, badge(item.kind), el("time", { datetime: item.createdAt }, formatTime(item.createdAt))), el("p", {}, item.text || "Recorded task event"), el("span", { class: "mono" }, item.authorId)) }));
	const answers = ctx.state.requests
		.filter((request) => request.taskId === task.id)
		.flatMap((request) =>
			ctx.state.responses
				.filter((response) => response.requestId === request.id)
				.map((response) => ({
					at: response.committedAt,
					node: el(
						"article",
						{ class: "history-item history-item--answer" },
						el("div", { class: "cluster" }, badge("saved answer", "success"), el("time", { datetime: response.committedAt }, formatTime(response.committedAt))),
						el("p", {}, request.prompt),
						el("strong", {}, answerText(response.answer)),
						el("span", { class: "mono" }, `request revision ${response.requestRevision}`),
					),
				})),
		);
	const ordered = [...entries, ...answers].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
	return el(
		"section",
		{ class: "detail-section" },
		el("header", { class: "section-heading" }, el("h2", {}, "Task history"), badge(String(ordered.length))),
		ordered.length === 0 ? el("p", { class: "muted" }, "No comments or saved answers yet.") : el("div", { class: "history-list" }, ...ordered.map((item) => item.node)),
	);
}

function answerText(answer: UiContext["state"]["responses"][number]["answer"]): string {
	switch (answer.kind) {
		case "text":
			return answer.text;
		case "single_choice":
			return answer.optionId;
		case "approval":
			return `${answer.decision}${answer.note === undefined ? "" : `: ${answer.note}`}`;
	}
}
