import { sendSimulatorControl } from "../api.ts";
import { el, findFormValue, label, submitButton } from "../dom.ts";
import { markFormClean } from "../form-islands.ts";
import type { HubSession } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function simulatorPanel(ctx: UiContext, session: HubSession): HTMLElement | null {
	if (!ctx.state.simulator || ctx.state.me.role !== "admin") return null;
	const supportsQuestions = session.capabilities.nativeQuestionSupport || session.capabilities.bridgeQuestionSupport;
	const questionOption = el("option", { value: "question", disabled: !supportsQuestions }, "Question");
	const type = el("select", { class: "select", name: "type" }, el("option", { value: "output" }, "Output"), questionOption, el("option", { value: "result" }, "Result"), el("option", { value: "termination" }, "Termination"), el("option", { value: "gap" }, "History gap"));
	const text = el("textarea", { class: "textarea", name: "text", rows: "3", placeholder: "Artificial scenario content" });
	const route = el("select", { class: "select", name: "route" });
	if (session.capabilities.nativeQuestionSupport) route.append(el("option", { value: "native" }, "Native route"));
	if (session.capabilities.bridgeQuestionSupport) route.append(el("option", { value: "bridge" }, "Bridge route"));
	route.disabled = !supportsQuestions;
	const blocking = el("select", { class: "select", name: "blocking" }, el("option", { value: "runtime_action" }, "Runtime action"), el("option", { value: "none" }, "Nonblocking"));
	const outcome = el("select", { class: "select", name: "outcome" }, ...["completed", "stopped", "failed", "unknown"].map((value) => el("option", { value }, value)));
	const routeField = label("Question route", route);
	const blockingField = label("Blocking", blocking);
	const outcomeField = label("Termination outcome", outcome);
	const contentField = label("Scenario content", text);
	const questionLimitation = el("p", { class: "limitation" }, "Questions are unavailable because this session supports neither native nor bridge question delivery.");
	questionLimitation.hidden = supportsQuestions;
	const syncFields = (): void => {
		routeField.hidden = type.value !== "question";
		blockingField.hidden = type.value !== "question";
		outcomeField.hidden = type.value !== "termination";
		contentField.hidden = type.value === "termination";
	};
	type.addEventListener("change", syncFields);
	const form = el("form", { class: "stack" }, label("Simulated event", type), questionLimitation, contentField, routeField, blockingField, outcomeField, submitButton("Emit simulated event", "secondary"));
	syncFields();
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const kind = findFormValue(form, "type");
		const content = findFormValue(form, "text");
		if (kind === "question" && !supportsQuestions) {
			ctx.notice("This session supports neither native nor bridge question delivery.", "error");
			return;
		}
		const payload =
			kind === "question"
				? { type: kind, sessionId: session.id, prompt: content, route: findFormValue(form, "route"), blocking: findFormValue(form, "blocking") }
				: kind === "result"
					? { type: kind, sessionId: session.id, summary: content }
					: kind === "termination"
						? { type: kind, sessionId: session.id, outcome: findFormValue(form, "outcome") }
						: kind === "gap"
							? { type: kind, sessionId: session.id, reason: content }
							: { type: "output", sessionId: session.id, text: content };
		void sendSimulatorControl(payload)
			.then(() => {
				markFormClean(form);
				return ctx.refresh();
			})
			.then(() => ctx.notice("Artificial simulator event emitted. This is not live execution evidence.", "warning"))
			.catch((error: unknown) => ctx.notice(error instanceof Error ? error.message : "Simulator event failed.", "error"));
	});
	contentField.querySelector(".field__label")?.replaceChildren("Simulator text");
	const storageKey = `workhub:simulator-panel:${ctx.state.me.id}:${session.id}`;
	const details = el("details", { class: "detail-section simulator-panel" }, el("summary", {}, "Simulator scenario"), el("p", { class: "limitation" }, "Artificial events for deterministic demos. They are never live-provider evidence."), form);
	details.open = sessionStorage.getItem(storageKey) === "open";
	details.addEventListener("toggle", () => {
		if (details.open) sessionStorage.setItem(storageKey, "open");
		else sessionStorage.removeItem(storageKey);
	});
	return details;
}
