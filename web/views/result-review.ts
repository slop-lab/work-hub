import { commandId } from "../api.ts";
import { openDialog } from "../dialogs.ts";
import { button, el, findFormValue, label } from "../dom.ts";
import type { HubResult, HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

type RevisionTarget =
	| { readonly kind: "instruction"; readonly attemptId: string; readonly sessionId: string; readonly bindingGeneration: number; readonly modes: readonly ("immediate" | "runtime_queued")[] }
	| { readonly kind: "continuation"; readonly attemptId: string; readonly sessionId: string; readonly sessionRevision: number; readonly profileId: string; readonly profileRevision: number }
	| { readonly kind: "unavailable"; readonly reason: string };

export function resultSection(ctx: UiContext, task: HubTask, results: UiContext["state"]["results"]): HTMLElement {
	const section = el("section", { class: "detail-section detail-section--result" }, el("h2", {}, "Results"));
	if (results.length === 0) {
		section.append(el("p", { class: "muted" }, "No result submitted."));
		return section;
	}
	for (const result of results) {
		const target = revisionTarget(ctx, task, result);
		const revise = button("Request revision", "secondary", () => {
			if (target.kind !== "unavailable") revisionDialog(ctx, task, result, target);
		});
		if (target.kind === "unavailable") {
			revise.disabled = true;
			revise.title = target.reason;
		}
		section.append(
			el(
				"article",
				{ class: "result-card" },
				el("p", { class: "result-summary" }, result.summary),
				result.limitations.length === 0 ? null : el("div", { class: "boundary-note" }, el("strong", {}, "Known limitations"), el("p", {}, result.limitations.join(" "))),
				target.kind === "unavailable" ? el("p", { class: "muted" }, target.reason) : null,
				el("div", { class: "cluster" }, revise, button("Complete task", "primary", () => completionDialog(ctx, task, result))),
			),
		);
	}
	return section;
}

function revisionTarget(ctx: UiContext, task: HubTask, result: HubResult): RevisionTarget {
	const attempt = ctx.state.attempts.find((item) => item.id === result.attemptId);
	if (attempt === undefined || attempt.taskId !== task.id) return { kind: "unavailable", reason: "This result no longer has a retained attempt target." };
	const session = ctx.state.sessions.find((item) => item.id === attempt.sessionId);
	if (session === undefined || session.taskId !== task.id) return { kind: "unavailable", reason: "This result's original session is unavailable." };
	if (task.primaryAttemptId !== attempt.id || session.activeAttemptId !== attempt.id) return { kind: "unavailable", reason: "This result is obsolete. Revision cannot be retargeted to the current attempt." };
	if (session.controlMode !== "control") return { kind: "unavailable", reason: "This session is view-only. Revision requires control access." };
	if (attempt.phase !== "finished") {
		if (session.capabilities.instructionModes.length === 0) return { kind: "unavailable", reason: "This runtime does not support revision instructions." };
		return { kind: "instruction", attemptId: attempt.id, sessionId: session.id, bindingGeneration: session.bindingGeneration, modes: session.capabilities.instructionModes };
	}
	const profile = ctx.state.profiles.find((item) => item.id === attempt.profileId);
	if (session.state !== "open" || session.profileId !== attempt.profileId || profile === undefined || !profile.enabled || profile.revision !== attempt.profileRevision) {
		return { kind: "unavailable", reason: "Continuation is unavailable for the result's original enabled profile and session." };
	}
	return { kind: "continuation", attemptId: attempt.id, sessionId: session.id, sessionRevision: session.revision, profileId: profile.id, profileRevision: profile.revision };
}

function revisionDialog(ctx: UiContext, task: HubTask, result: HubResult, target: Exclude<RevisionTarget, { readonly kind: "unavailable" }>): void {
	const instruction = el("textarea", { class: "textarea", name: "instruction", rows: "5", required: true });
	const form = el("form", { class: "stack" }, label("Revision instruction", instruction, target.kind === "instruction" ? "The instruction is sent to this result's active attempt." : "A new attempt continues in the same session with this result retained as source context."));
	let mode: HTMLSelectElement | undefined;
	if (target.kind === "instruction") {
		mode = el("select", { class: "select", name: "mode", required: true }, el("option", { value: "" }, "Choose supported timing"));
		for (const supportedMode of target.modes) mode.append(el("option", { value: supportedMode }, supportedMode === "immediate" ? "Send immediately" : "Queue for runtime delivery"));
		form.append(label("Instruction timing", mode));
	}
	const confirm = button(target.kind === "instruction" ? "Send revision" : "Start continuation", "primary");
	const dialog = openDialog(target.kind === "instruction" ? "Request revision" : "Continue revision", form, [button("Cancel", "secondary", () => dialog.close()), confirm]);
	confirm.addEventListener("click", () => {
		const text = findFormValue(form, "instruction");
		const selectedMode = mode === undefined ? undefined : instructionMode(mode.value);
		if (text.length === 0 || (target.kind === "instruction" && selectedMode === undefined)) {
			ctx.notice("Enter a revision instruction and choose a supported timing.", "error");
			return;
		}
		confirm.disabled = true;
		dialog.setAttribute("aria-busy", "true");
		const command = target.kind === "instruction"
			? { commandId: commandId(), type: "task.requestRevision", target: { kind: "task", id: task.id }, expected: { task: task.revision, bindingGeneration: target.bindingGeneration }, payload: { resultId: result.id, sessionId: target.sessionId, instruction: text, path: "instruction", mode: selectedMode } }
			: { commandId: commandId(), type: "task.requestRevision", target: { kind: "task", id: task.id }, expected: { task: task.revision, session: target.sessionRevision, profile: target.profileRevision }, payload: { resultId: result.id, sessionId: target.sessionId, instruction: text, path: "continuation", profileId: target.profileId, context: "current_task", environmentReuse: "reuse" } };
		void ctx.command(command, target.kind === "instruction" ? "Revision instruction accepted." : "Continuation accepted in the existing session.").then((saved) => {
			if (saved) dialog.close();
			else {
				confirm.disabled = false;
				dialog.removeAttribute("aria-busy");
			}
		});
	});
}

function completionDialog(ctx: UiContext, task: HubTask, result: HubResult): void {
	const note = el("textarea", { class: "textarea", name: "completionNote", rows: "4" });
	const primaryAttempt = ctx.state.attempts.find((item) => item.id === task.primaryAttemptId);
	const hasActiveWork = primaryAttempt !== undefined && primaryAttempt.phase !== "finished";
	const form = el("form", { class: "stack" }, el("p", {}, "Completing the task records the human business decision. Runtime execution is a separate effect."), label("Completion note", note));
	let consequence: HTMLSelectElement | undefined;
	if (hasActiveWork) {
		consequence = el("select", { class: "select", name: "activeExecutionDecision", required: true }, el("option", { value: "" }, "Choose what happens to active execution"), el("option", { value: "request_stop" }, "Request stop separately"), el("option", { value: "allow_to_continue" }, "Allow execution to continue"));
		form.append(label("Active execution consequence", consequence, "This choice does not close the session or release its environment."));
	}
	const confirm = button("Confirm completion", "primary");
	const dialog = openDialog("Complete task", form, [button("Cancel", "secondary", () => dialog.close()), confirm]);
	confirm.addEventListener("click", () => {
		const selectedConsequence = consequence === undefined ? undefined : executionDecision(consequence.value);
		if (hasActiveWork && selectedConsequence === undefined) {
			ctx.notice("Choose what should happen to active execution before completing the task.", "error");
			return;
		}
		confirm.disabled = true;
		dialog.setAttribute("aria-busy", "true");
		void ctx.command({ commandId: commandId(), type: "task.setStatus", target: { kind: "task", id: task.id }, expected: { task: task.revision }, payload: { status: "done", resultId: result.id, completionNote: findFormValue(form, "completionNote") || undefined, ...(selectedConsequence === undefined ? {} : { activeExecutionDecision: selectedConsequence }) } }, "Task completed. Runtime and environment state follow the explicit execution choice.").then((saved) => {
			if (saved) dialog.close();
			else {
				confirm.disabled = false;
				dialog.removeAttribute("aria-busy");
			}
		});
	});
}

function instructionMode(value: string): "immediate" | "runtime_queued" | undefined {
	return value === "immediate" || value === "runtime_queued" ? value : undefined;
}

function executionDecision(value: string): "request_stop" | "allow_to_continue" | undefined {
	return value === "request_stop" || value === "allow_to_continue" ? value : undefined;
}
