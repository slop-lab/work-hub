import { commandId } from "../api.ts";
import { badge, el, findFormValue, label, submitButton } from "../dom.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function questionSection(ctx: UiContext, task: HubTask): HTMLElement {
	const prompt = el("textarea", { class: "textarea", name: "prompt", rows: "3", placeholder: "Ask a decision that should survive this browser session" });
	const reason = el("input", { class: "input", name: "reason", placeholder: "Why this answer matters" });
	const recipient = el("select", { class: "select", name: "recipient" }, el("option", { value: `project:${task.projectId}` }, "Project members"));
	for (const user of ctx.state.users) recipient.append(el("option", { value: `user:${user.id}` }, user.displayName));
	const agentTargets = ctx.state.sessions.filter((session) => session.taskId === task.id && session.state === "open" && ctx.state.attempts.some((attempt) => attempt.id === session.activeAttemptId && attempt.phase !== "finished"));
	for (const session of agentTargets) recipient.append(el("option", { value: `session:${session.id}` }, `Agent session: ${session.runtimeLabel}`));
	const answerKind = el("select", { class: "select", name: "answerKind" }, el("option", { value: "text" }, "Free text"), el("option", { value: "single_choice" }, "Single choice"));
	const options = el("input", { class: "input", name: "options", placeholder: "Keep one release, Remove now" });
	const optionsField = label("Choice options", options, "Separate labels with commas. Stable option IDs are generated from their order.");
	optionsField.hidden = true;
	answerKind.addEventListener("change", () => {
		optionsField.hidden = answerKind.value !== "single_choice";
	});
	const beforeDelegate = el("option", { value: "before_delegate" }, "Block delegation");
	const blocking = el("select", { class: "select", name: "blocking" }, el("option", { value: "none" }, "Nonblocking"), beforeDelegate);
	const agentBoundary = el("p", { class: "boundary-note", hidden: true }, "The selected agent polls this scoped request from its existing session. Saving does not send an instruction or start another attempt.");
	const syncRecipient = (): void => {
		const isAgent = recipient.value.startsWith("session:");
		beforeDelegate.disabled = isAgent;
		if (isAgent) blocking.value = "none";
		agentBoundary.hidden = !isAgent;
	};
	recipient.addEventListener("change", syncRecipient);
	const form = el(
		"form",
		{ class: "detail-section form-grid" },
		el("h2", {}, "Ask a formal question"),
		label("Question", prompt, "Saving a question never starts a runtime or environment."),
		label("Reason", reason),
		label("Recipient", recipient),
		label("Answer format", answerKind),
		optionsField,
		label("Blocking scope", blocking),
		agentBoundary,
		el("p", { class: "muted" }, "Approvals and runtime-action blocks require immutable action and attempt metadata, so they cannot be authored from this task-only form."),
		requestStatus(ctx, task),
		submitButton("Save question", "secondary"),
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = findFormValue(form, "prompt");
		if (value.length === 0) return;
		const recipientValue = findFormValue(form, "recipient");
		const sessionId = recipientValue.startsWith("session:") ? recipientValue.slice("session:".length) : undefined;
		const session = sessionId === undefined ? undefined : agentTargets.find((item) => item.id === sessionId);
		const attempt = session === undefined ? undefined : ctx.state.attempts.find((item) => item.id === session.activeAttemptId);
		if (sessionId !== undefined && (session === undefined || attempt === undefined)) {
			ctx.notice("The selected agent target is no longer active. Refresh and choose again.", "error");
			return;
		}
		void ctx
			.command(
				{
					commandId: commandId(),
					type: "request.create",
					target: { kind: "task", id: task.id },
					expected: { task: task.revision },
					payload: {
						kind: "question",
						projectId: task.projectId,
						taskId: task.id,
						...(session === undefined || attempt === undefined ? {} : { sessionId: session.id, attemptId: attempt.id, bindingGeneration: session.bindingGeneration }),
						recipient: parseRecipient(recipientValue),
						prompt: value,
						reason: findFormValue(form, "reason") || undefined,
						referenceIds: [],
						answerSchema: parseAnswerSchema(answerKind.value, findFormValue(form, "options")),
						blocking: session === undefined ? findFormValue(form, "blocking") : "none",
						validity: { kind: "task", taskId: task.id },
						responseRoute: "none",
					},
				},
				session === undefined ? "Question saved without starting work." : "Question saved to the scoped agent inbox without starting work.",
			)
			.then((saved) => {
				if (saved) form.reset();
			});
	});
	syncRecipient();
	return form;
}

function requestStatus(ctx: UiContext, task: HubTask): HTMLElement {
	const requests = ctx.state.requests.filter((request) => request.taskId === task.id);
	if (requests.length === 0) return el("p", { class: "muted" }, "No saved questions yet.");
	return el("div", { class: "history-list" }, ...requests.map((request) => {
		const destination = request.recipient.kind === "agent_session" ? "Agent inbox" : "Human response";
		const delivery = request.deliveryStatus ?? (request.responseRoute === "none" || request.responseRoute === undefined ? "not_required" : "pending");
		return el("article", { class: "history-item" }, el("div", { class: "cluster" }, badge(request.status, request.status === "open" ? "warning" : "success"), badge(request.recipient.kind === "agent_session" ? "agent request" : "human request")), el("p", {}, request.prompt), el("span", { class: "muted" }, `${destination} · delivery ${delivery.replaceAll("_", " ")}`));
	}));
}

function parseRecipient(value: string): Readonly<Record<string, string>> {
	const [kind, id = ""] = value.split(":", 2);
	if (kind === "user") return { kind: "user", userId: id };
	if (kind === "session") return { kind: "agent_session", sessionId: id };
	return { kind: "project_members", projectId: id };
}

function parseAnswerSchema(kind: string, value: string): Readonly<Record<string, unknown>> {
	if (kind === "single_choice")
		return {
			kind: "single_choice",
			options: value
				.split(",")
				.map((label, index) => ({ id: `option-${index + 1}`, label: label.trim() }))
				.filter((item) => item.label.length > 0),
		};
	return { kind: "text", minLength: 1, maxLength: 8_000 };
}
