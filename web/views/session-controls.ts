import { commandId } from "../api.ts";
import { button, el, findFormValue, label, submitButton } from "../dom.ts";
import type { HubAttempt, HubBinding, HubSession } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

type Draft = { readonly attemptId: string; readonly bindingGeneration: number; readonly intent: "active" | "ended"; readonly text: string };

export function instructionComposer(ctx: UiContext, session: HubSession, attempt?: HubAttempt): HTMLElement {
	if (attempt === undefined)
		return el(
			"section",
			{ class: "composer" },
			el("h2", {}, "Continue deliberately"),
			el("p", {}, "There is no active attempt. Sending a message cannot silently create one."),
			button("Start continuation", "primary", () => void continueSession(ctx, session)),
		);
	const textarea = el("textarea", { class: "textarea composer__input", name: "instruction", rows: "4", placeholder: "Give the active attempt one clear instruction", "aria-label": "Instruction" });
	const mode = el("select", { class: "select", name: "mode", "aria-label": "Instruction delivery mode" });
	for (const value of session.capabilities.instructionModes) mode.append(el("option", { value }, value === "immediate" ? "Steer now" : "Runtime queue"));
	const stored = readDraft(ctx, session, attempt);
	if (stored !== null) textarea.value = stored.text;
	const send = submitButton("Send instruction");
	send.disabled = session.controlMode !== "control" || session.capabilities.instructionModes.length === 0;
	const form = el("form", { class: "composer" }, el("h2", {}, "Instruction for active attempt"), label("Instruction", textarea, "The chosen delivery mode is explicit and capability-checked."), label("Delivery mode", mode), send);
	textarea.addEventListener("input", () => writeDraft(ctx, session, attempt, textarea.value));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = findFormValue(form, "instruction");
		if (text.length === 0) return;
		send.disabled = true;
		void ctx
			.command(
				{ commandId: commandId(), type: "session.instruct", target: { kind: "session", id: session.id }, expected: { session: session.revision, bindingGeneration: session.bindingGeneration }, payload: { attemptId: attempt.id, text, referenceIds: [], mode: findFormValue(form, "mode") } },
				"Instruction saved and accepted for delivery.",
			)
			.then((saved) => {
				if (saved) {
					textarea.value = "";
					clearDraft(ctx, session, attempt);
				}
			})
			.finally(() => {
				send.disabled = false;
			});
	});
	return form;
}

export function sessionControls(ctx: UiContext, session: HubSession, attempt?: HubAttempt, binding?: HubBinding): HTMLElement {
	const section = el("section", { class: "detail-section detail-section--caution" }, el("h2", {}, "Controls"), el("p", {}, "Stop request, confirmed termination, session closure, and environment detachment are separate facts."));
	if (attempt !== undefined && session.controlMode === "control")
		section.append(
			button(
				"Request stop",
				"danger",
				() =>
					void ctx.command(
						{ commandId: commandId(), type: "attempt.stop", target: { kind: "attempt", id: attempt.id }, expected: { bindingGeneration: session.bindingGeneration }, payload: { mode: session.capabilities.stopModes[0] ?? "stop_work", reason: "Requested from session workspace" } },
						"Stop requested. Termination is not assumed.",
					),
			),
		);
	if (attempt === undefined || attempt.phase === "finished") section.append(button("Continue session", "secondary", () => void continueSession(ctx, session)));
	section.append(button("Close logical session", "quiet", () => void ctx.command({ commandId: commandId(), type: "session.close", target: { kind: "session", id: session.id }, expected: { session: session.revision }, payload: attempt?.role === "observed" && attempt.phase !== "finished" ? { externalWorkDecision: "continues" } : {} }, "Logical session closed. Environment lifecycle is unchanged.")));
	if (binding?.canDetach === true) section.append(button("Detach environment access", "secondary", () => void ctx.command({ commandId: commandId(), type: "environment.detach", target: { kind: "environment_binding", id: binding.id }, expected: { bindingGeneration: binding.generation }, payload: { reason: "Detached from session workspace" } }, "Environment access detached. External lifecycle is unchanged.")));
	return section;
}

function continueSession(ctx: UiContext, session: HubSession): Promise<boolean> {
	const task = ctx.state.tasks.find((item) => item.id === session.taskId);
	return ctx.command(
		{
			commandId: commandId(),
			type: "session.continue",
			target: { kind: "session", id: session.id },
			expected: { session: session.revision, bindingGeneration: session.bindingGeneration, ...(task === undefined ? {} : { task: task.revision }) },
			payload: { profileId: session.profileId ?? "profile-structured", context: "current_task", environmentReuse: "reuse", instruction: "Continue with the current task brief and report a new result." },
		},
		"Continuation accepted as a new attempt.",
	);
}

function draftKey(ctx: UiContext, session: HubSession, attempt: HubAttempt): string {
	const intent = attempt.phase === "finished" ? "ended" : "active";
	return `workhub:draft:${ctx.state.me.id}:${session.id}:${attempt.id}:${session.bindingGeneration}:${intent}`;
}
function readDraft(ctx: UiContext, session: HubSession, attempt: HubAttempt): Draft | null {
	const raw = sessionStorage.getItem(draftKey(ctx, session, attempt));
	if (raw === null) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value === "object" && value !== null && "attemptId" in value && "bindingGeneration" in value && "intent" in value && "text" in value && typeof value.attemptId === "string" && typeof value.bindingGeneration === "number" && (value.intent === "active" || value.intent === "ended") && typeof value.text === "string") return { attemptId: value.attemptId, bindingGeneration: value.bindingGeneration, intent: value.intent, text: value.text };
		return null;
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}
function writeDraft(ctx: UiContext, session: HubSession, attempt: HubAttempt, text: string): void {
	const intent = attempt.phase === "finished" ? "ended" : "active";
	sessionStorage.setItem(draftKey(ctx, session, attempt), JSON.stringify({ attemptId: attempt.id, bindingGeneration: session.bindingGeneration, intent, text } satisfies Draft));
}
function clearDraft(ctx: UiContext, session: HubSession, attempt: HubAttempt): void {
	sessionStorage.removeItem(draftKey(ctx, session, attempt));
}
