import { commandId } from "../api.ts";
import { answerDialog } from "../dialogs.ts";
import { badge, button, el, findFormValue, formatTime, label, submitButton } from "../dom.ts";
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
			if (item.operationId !== undefined) actions.append(el("a", { class: "button button--secondary", href: `#/operation/${item.operationId}` }, "Review operation"));
			if (viewState?.readAt == null) actions.append(button("Mark read", "quiet", () => void ctx.command({ commandId: commandId(), type: "attention.markRead", payload: { attentionKey: item.key } }, "Attention item marked read. Canonical work is unchanged.")));
			if (viewState?.dismissedAt == null) actions.append(button("Dismiss notice", "quiet", () => void ctx.command({ commandId: commandId(), type: "attention.dismiss", payload: { attentionKey: item.key } }, "Notification dismissed. The unresolved item remains actionable.")));
			const presentation = el("div", { class: "cluster" }, badge(item.freshness, freshnessTone(item.freshness)), viewState?.readAt != null ? badge("read") : null, viewState?.dismissedAt != null ? badge("notification dismissed") : null);
			section.append(el("article", { class: "attention-item" }, el("div", { class: "attention-item__top" }, presentation, el("span", { class: "mono" }, item.reasonCode)), el("h3", {}, item.title), el("p", {}, item.context), item.observedAt === undefined ? null : el("p", { class: "muted" }, `Observed ${formatTime(item.observedAt)}`), actions));
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
		projectQuestionComposer(ctx),
		grid,
	);
}

function projectQuestionComposer(ctx: UiContext): HTMLElement {
	const project = el("select", { class: "select", name: "project" });
	for (const item of ctx.state.projects) project.append(el("option", { value: item.id }, item.name));
	const recipient = el("select", { class: "select", name: "recipient" });
	const syncRecipients = (): void => {
		recipient.replaceChildren(el("option", { value: `project:${project.value}` }, "Project members"));
		for (const user of ctx.state.users.filter((item) => item.enabled !== false)) recipient.append(el("option", { value: `user:${user.id}` }, user.displayName));
	};
	project.addEventListener("change", syncRecipients);
	syncRecipients();
	const prompt = el("textarea", { class: "textarea", name: "prompt", rows: "3", required: true, placeholder: "Ask a project decision without creating a task" });
	const reason = el("input", { class: "input", name: "reason", placeholder: "Why this answer matters" });
	const form = el("form", { class: "detail-section stack" }, el("div", {}, el("h2", {}, "Ask a project question"), el("p", { class: "muted" }, "This records a human decision request. It does not create a task, session, attempt, or environment.")), el("div", { class: "switcher" }, label("Project", project), label("Recipient", recipient)), label("Project question", prompt), label("Reason", reason), submitButton("Save project question", "secondary"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = findFormValue(form, "prompt");
		if (text.length === 0) return;
		const projectId = findFormValue(form, "project");
		const recipientValue = findFormValue(form, "recipient");
		void ctx.command({ commandId: commandId(), type: "request.create", payload: { kind: "question", projectId,
			recipient: recipientValue.startsWith("user:") ? { kind: "user", userId: recipientValue.slice("user:".length) } : { kind: "project_members", projectId }, prompt: text, reason: findFormValue(form, "reason") || undefined, referenceIds: [], answerSchema: { kind: "text", minLength: 1, maxLength: 8_000 }, blocking: "none", validity: { kind: "project", projectId }, responseRoute: "none" } }, "Project question saved without starting work.").then((saved) => {
			if (saved) { prompt.value = ""; reason.value = ""; }
		});
	});
	return form;
}

function answerButton(ctx: UiContext, request: HubRequest, title: string): HTMLButtonElement {
	const value = button("Answer", "primary", () => answerDialog(ctx, request));
	value.setAttribute("aria-label", `Answer ${title.toLocaleLowerCase()}`);
	return value;
}

function freshnessTone(value: string): string {
	return value === "fresh" ? "success" : value === "stale" ? "warning" : "error";
}
