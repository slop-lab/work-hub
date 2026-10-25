import { commandId } from "../api.ts";
import { answerDialog } from "../dialogs.ts";
import { badge, button, el, formatTime } from "../dom.ts";
import type { HubRequest } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

type GroupKey = keyof UiContext["state"]["attention"];
const groups: readonly {
	readonly key: GroupKey;
	readonly title: string;
	readonly empty: string;
}[] = [
	{
		key: "answerNeeded",
		title: "Answers needed",
		empty: "No questions need your answer.",
	},
	{
		key: "approvalNeeded",
		title: "Approvals",
		empty: "No scoped approvals are waiting.",
	},
	{
		key: "responseDelivery",
		title: "Delivery problems",
		empty: "Saved answers have no delivery problems.",
	},
	{
		key: "activeWork",
		title: "Active work",
		empty: "No attempts need supervision.",
	},
	{
		key: "resultReview",
		title: "Results to review",
		empty: "No results await a decision.",
	},
	{
		key: "operationalIssues",
		title: "Operational issues",
		empty: "No environment or connection issues.",
	},
];

export function dashboardView(ctx: UiContext): HTMLElement {
	const grid = el("div", { class: "attention-grid" });
	for (const group of groups) {
		const items = ctx.state.attention[group.key];
		const section = el("section", { class: `attention-group${items.length === 0 ? " is-empty" : ""}` }, el("header", { class: "section-heading" }, el("h2", {}, group.title), badge(String(items.length), items.length === 0 ? "neutral" : "warning")));
		if (items.length === 0) section.append(el("p", { class: "empty-copy" }, group.empty));
		for (const item of items) {
			const actions = el("div", { class: "cluster" });
			const viewState = ctx.state.userViewState.find((state) => state.attentionKey === item.key);
			const request = item.requestId === undefined ? undefined : ctx.state.requests.find((candidate) => candidate.id === item.requestId);
			if (request !== undefined && request.status === "open") actions.append(answerButton(ctx, request, item.title));
			if (item.sessionId !== undefined)
				actions.append(
					el(
						"a",
						{
							class: "button button--quiet",
							href: `#/session/${item.sessionId}`,
						},
						"Open session",
					),
				);
			if (item.taskId !== undefined) actions.append(el("a", { class: "button button--quiet", href: `#/backlog/${item.taskId}` }, "Open task"));
			if (viewState?.readAt == null) actions.append(button("Mark read", "quiet", () => void ctx.command({ commandId: commandId(), type: "attention.markRead", payload: { attentionKey: item.key } }, "Attention item marked read. Canonical work is unchanged.")));
			if (viewState?.dismissedAt == null) actions.append(button("Dismiss notice", "quiet", () => void ctx.command({ commandId: commandId(), type: "attention.dismiss", payload: { attentionKey: item.key } }, "Notification dismissed. The unresolved item remains actionable.")));
			const presentation = el("div", { class: "cluster" }, badge(item.freshness, freshnessTone(item.freshness)), viewState?.readAt != null ? badge("read") : null, viewState?.dismissedAt != null ? badge("notification dismissed") : null);
			section.append(el("article", { class: "attention-item" }, el("div", { class: "attention-item__top" }, presentation, el("span", { class: "mono" }, item.reasonCode)), el("h3", {}, item.title), el("p", {}, item.context), actions));
		}
		grid.append(section);
	}
	return el(
		"div",
		{ class: "page page--dashboard" },
		el(
			"header",
			{ class: "page-heading" },
			el("div", {}, el("p", { class: "kicker" }, "Today"), el("h1", {}, "Decisions first"), el("p", { class: "lead" }, "Answer questions, review results, and resolve uncertain work before starting more.")),
			el("div", { class: "snapshot-meta" }, "Snapshot ", formatTime(ctx.state.generatedAt)),
		),
		ctx.state.limitations.length === 0 ? null : el("section", { class: "limitation-strip" }, el("strong", {}, "Known limitations"), el("span", {}, ctx.state.limitations.join(" "))),
		grid,
	);
}

function answerButton(ctx: UiContext, request: HubRequest, title: string): HTMLButtonElement {
	const value = button("Answer", "primary", () => answerDialog(ctx, request));
	value.setAttribute("aria-label", `Answer ${title.toLocaleLowerCase()}`);
	return value;
}

function freshnessTone(value: string): string {
	return value === "fresh" ? "success" : value === "stale" ? "warning" : "error";
}
