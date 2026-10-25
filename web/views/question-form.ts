import { commandId } from "../api.ts";
import { el, findFormValue, label, submitButton } from "../dom.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function questionSection(ctx: UiContext, task: HubTask): HTMLElement {
	const prompt = el("textarea", { class: "textarea", name: "prompt", rows: "3", placeholder: "Ask a decision that should survive this browser session" });
	const reason = el("input", { class: "input", name: "reason", placeholder: "Why this answer matters" });
	const recipient = el("select", { class: "select", name: "recipient" }, el("option", { value: `project:${task.projectId}` }, "Project members"));
	for (const user of ctx.state.users) recipient.append(el("option", { value: `user:${user.id}` }, user.displayName));
	for (const session of ctx.state.sessions.filter((item) => item.taskId === task.id)) recipient.append(el("option", { value: `session:${session.id}`, disabled: true }, `Agent session: ${session.runtimeLabel} (use a runtime-bound request)`));
	const answerKind = el("select", { class: "select", name: "answerKind" }, el("option", { value: "text" }, "Free text"), el("option", { value: "single_choice" }, "Single choice"));
	const options = el("input", { class: "input", name: "options", placeholder: "Keep one release, Remove now" });
	const optionsField = label("Choice options", options, "Separate labels with commas. Stable option IDs are generated from their order.");
	optionsField.hidden = true;
	answerKind.addEventListener("change", () => {
		optionsField.hidden = answerKind.value !== "single_choice";
	});
	const blocking = el("select", { class: "select", name: "blocking" }, el("option", { value: "none" }, "Nonblocking"), el("option", { value: "before_delegate" }, "Block delegation"));
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
		el("p", { class: "muted" }, "Approvals and runtime-action blocks require immutable action and attempt metadata, so they cannot be authored from this task-only form."),
		submitButton("Save question", "secondary"),
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = findFormValue(form, "prompt");
		if (value.length === 0) return;
		const recipientValue = findFormValue(form, "recipient");
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
						recipient: parseRecipient(recipientValue),
						prompt: value,
						reason: findFormValue(form, "reason") || undefined,
						referenceIds: [],
						answerSchema: parseAnswerSchema(answerKind.value, findFormValue(form, "options")),
						blocking: findFormValue(form, "blocking"),
						validity: { kind: "task", taskId: task.id },
						responseRoute: recipientValue.startsWith("session:") ? "bridge" : "none",
					},
				},
				"Question saved without starting work.",
			)
			.then((saved) => {
				if (saved) form.reset();
			});
	});
	return form;
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
