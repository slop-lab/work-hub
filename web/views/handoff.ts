import { type HandoffDetail, loadHandoff } from "../api.ts";
import { badge, el, formatTime } from "../dom.ts";
import type { HubAttempt, HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";
import { resultSection } from "./result-review.ts";
import { taskActions } from "./task-actions.ts";

export function handoffView(ctx: UiContext, taskId: string, attemptId: string): HTMLElement {
	const task = ctx.state.tasks.find((item) => item.id === taskId);
	const attempt = ctx.state.attempts.find((item) => item.id === attemptId && item.taskId === taskId);
	if (task === undefined || attempt === undefined) return missingHandoff(taskId, attemptId);
	const session = ctx.state.sessions.find((item) => item.id === attempt.sessionId);
	const results = ctx.state.results.filter((item) => item.attemptId === attempt.id);
	const source = sourceSection(attempt);
	const delivery = deliverySection();
	const recipient = recipientSection(attempt, session?.runtimeLabel);
	const deliveryStep = lifecycleStep("Delivery", "Loading", "info");
	const page = el(
		"div",
		{ class: "page handoff-page" },
		el(
			"header",
			{ class: "task-hero" },
			el(
				"div",
				{},
				el("a", { class: "back-link", href: `#/backlog/${task.id}` }, "Back to task"),
				el("p", { class: "kicker" }, "Verification handoff"),
				el("h1", {}, task.title),
				el("div", { class: "cluster" }, badge(`Execution ${attempt.phase}`, phaseTone(attempt)), badge(`Observation ${attempt.observation}`, observationTone(attempt.observation))),
			),
		),
		el("section", { class: "handoff-lifecycle", "aria-label": "Handoff lifecycle" }, lifecycleStep("Source", "Bound", "success"), deliveryStep, lifecycleStep("Activity", attempt.phase, phaseTone(attempt)), lifecycleStep("Result", results.at(-1)?.outcome ?? "No result", results.length === 0 ? "warning" : results.at(-1)?.outcome === "passed" ? "success" : "warning")),
		el(
			"div",
			{ class: "detail-layout" },
			el(
				"div",
				{ class: "stack stack--large" },
				source,
				delivery,
				activitySection(attempt),
				resultSection(ctx, task, results),
				taskActions(ctx, task),
			),
			el("aside", { class: "context-rail" }, recipient, identitySection(task, attempt)),
		),
	);
	void loadHandoff(attempt.id).then((detail) => {
		if (!page.isConnected) return;
		source.replaceWith(sourceSection(attempt, detail));
		delivery.replaceWith(deliverySection(detail));
		deliveryStep.replaceWith(lifecycleStep("Delivery", detail.delivery.status, deliveryTone(detail.delivery.status)));
		recipient.replaceWith(recipientSection(attempt, session?.runtimeLabel, detail.preview.target));
	}).catch((error: unknown) => {
		if (!page.isConnected) return;
		delivery.replaceWith(el("section", { class: "detail-section detail-section--caution", role: "alert", "aria-label": "Delivery status" }, el("h2", {}, "Handoff record unavailable"), el("p", {}, error instanceof Error ? error.message : "The persisted handoff could not be loaded.")));
	});
	return page;
}

function sourceSection(attempt: HubAttempt, detail?: HandoffDetail): HTMLElement {
	const source = attempt.inputSnapshot;
	const verification = detail?.preview.verification;
	return el(
		"section",
		{ class: "detail-section handoff-source", "aria-label": "Exact source" },
		el("div", { class: "section-heading" }, el("h2", {}, "Exact source"), badge("Immutable snapshot", "info")),
		facts([
			["Repository", detail?.preview.repository.canonicalIdentity ?? textValue(source["repositoryLabel"])],
			["Branch", verification?.sourceBranch ?? textValue(source["branch"])],
			["Full commit", verification?.sourceCommit ?? textValue(source["commitId"])],
			["Requested validation", verification?.requestedValidation ?? textList(source["requestedValidation"])],
			["Context digest", verification?.contextDigest ?? textValue(source["contextDigest"])],
			["Prompt digest", detail?.preview.promptDigest ?? textValue(source["promptDigest"])],
			["Task revision", textValue(source["taskRevision"])],
		]),
		detail === undefined ? null : el("details", { class: "handoff-prompt" }, el("summary", {}, "Exact canonical prompt"), el("pre", { class: "handoff-context" }, detail.preview.prompt)),
		contextReferences(source["contextItems"]),
	);
}

function deliverySection(detail?: HandoffDetail): HTMLElement {
	const tone = detail === undefined ? "warning" : deliveryTone(detail.delivery.status);
	return el(
		"section",
		{ class: "detail-section detail-section--caution", "aria-label": "Delivery status" },
		el("div", { class: "section-heading" }, el("h2", {}, "Delivery"), badge(detail?.delivery.status ?? "Loading", tone)),
		detail === undefined
			? el("p", {}, "Loading the persisted delivery record. Delivery, acknowledgement, and execution remain separate facts.")
			: facts([["Delivery digest", detail.delivery.deliveryDigest], ["Updated", formatTime(detail.delivery.updatedAt)], ["Input receipt", detail.delivery.inputReceiptJson ?? "Not acknowledged"], ["Last error", detail.delivery.lastErrorJson ?? "None"]]),
	);
}

function activitySection(attempt: HubAttempt): HTMLElement {
	return el(
		"section",
		{ class: "detail-section", "aria-label": "Execution activity" },
		el("div", { class: "section-heading" }, el("h2", {}, "Execution activity"), badge(attempt.phase, phaseTone(attempt))),
		facts([
			["Role", attempt.role],
			["Observation", attempt.observation],
			["Updated", formatTime(attempt.updatedAt)],
			["Outcome", attempt.outcome ?? "No terminal outcome"],
		]),
		el("p", { class: "muted" }, "Agent activity and a submitted result do not complete the task. Human acceptance remains explicit below."),
	);
}

function recipientSection(attempt: HubAttempt, runtimeLabel?: string, target?: HandoffDetail["preview"]["target"]): HTMLElement {
	const attached = target?.kind === "attached" ? target : undefined;
	return el(
		"section",
		{ class: "detail-section", "aria-label": "Recipient identity" },
		el("h2", {}, "Recipient"),
		facts([
			["Runtime", runtimeLabel ?? "Unavailable"],
			["Target", target === undefined ? "Loading" : target.kind === "new" ? "New session" : "Existing session"],
			["Session", attached?.sessionId ?? attempt.sessionId],
			["Incarnation", target?.incarnation ?? "Loading"],
			["Authority", target?.authority ?? "Loading"],
			["Readiness", target?.readiness ?? "Loading"],
		]),
		el("a", { class: "button button--secondary", href: `#/session/${attempt.sessionId}` }, "Open recipient session"),
	);
}

function identitySection(task: HubTask, attempt: HubAttempt): HTMLElement {
	return el(
		"section",
		{ class: "detail-section" },
		el("h2", {}, "Handoff identity"),
		facts([
			["Attempt", attempt.id],
			["Task", task.id],
			["Profile", `${attempt.profileId} r${attempt.profileRevision}`],
			["Predecessor", attempt.predecessorId ?? "None"],
		]),
	);
}

function contextReferences(value: unknown): HTMLElement {
	if (!Array.isArray(value) || value.length === 0) return el("p", { class: "muted" }, "No context references were retained in this snapshot.");
	return el("div", { class: "stack" }, el("h3", {}, "Context references"), ...value.map((item, index) => el("details", { class: "handoff-reference" }, el("summary", {}, contextLabel(item, index)), el("pre", { class: "handoff-context mono" }, JSON.stringify(item, null, 2)))));
}

function contextLabel(item: unknown, index: number): string {
	if (typeof item !== "object" || item === null) return `Context ${index + 1}`;
	const title = Reflect.get(item, "title");
	const sourceId = Reflect.get(item, "sourceId");
	return typeof title === "string" ? title : typeof sourceId === "string" ? sourceId : `Context ${index + 1}`;
}

function lifecycleStep(label: string, status: string, tone: "info" | "warning" | "success" | "error"): HTMLElement {
	return el("div", { class: "handoff-lifecycle__step" }, el("span", { class: "muted" }, label), badge(status, tone));
}

function facts(items: readonly (readonly [string, string])[]): HTMLElement {
	return el("dl", { class: "definition-list" }, ...items.flatMap(([term, value]) => [el("dt", {}, term), el("dd", { class: "mono" }, value)]));
}

function textValue(value: unknown): string {
	return typeof value === "string" || typeof value === "number" ? String(value) : "Not recorded";
}

function textList(value: unknown): string {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") || "None" : "Not recorded";
}

function phaseTone(attempt: HubAttempt): "info" | "warning" | "success" | "error" {
	if (attempt.phase !== "finished") return attempt.phase === "waiting_input" ? "warning" : "info";
	return attempt.outcome === "failed" ? "error" : attempt.outcome === "result_submitted" ? "success" : "warning";
}

function observationTone(observation: HubAttempt["observation"]): "info" | "warning" | "success" | "error" {
	switch (observation) {
		case "fresh": return "success";
		case "stale": return "warning";
		case "unreachable": return "error";
		case "unknown": return "info";
	}
}

function deliveryTone(status: HandoffDetail["delivery"]["status"]): "info" | "warning" | "success" | "error" {
	switch (status) {
		case "pending": return "info";
		case "delivered": return "info";
		case "acknowledged": return "success";
		case "failed": return "error";
		case "unknown": return "warning";
	}
}

function missingHandoff(taskId: string, attemptId: string): HTMLElement {
	return el("div", { class: "page" }, el("section", { class: "empty-state empty-state--large" }, el("h1", {}, "Handoff unavailable"), el("p", {}, "The task and attempt URL do not identify a retained handoff."), el("p", { class: "mono" }, `${taskId} / ${attemptId}`), el("a", { class: "button button--secondary", href: `#/backlog/${taskId}` }, "Back to task")));
}
