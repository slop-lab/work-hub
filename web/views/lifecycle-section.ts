import { badge, el } from "../dom.ts";
import { loadTaskLifecycle, type TaskLifecycle } from "../lifecycle-api.ts";
import { restoreDirtyForms } from "../form-islands.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";
import { lifecycleBlockers } from "./lifecycle-blockers.ts";
import { lifecycleCriteria } from "./lifecycle-criteria.ts";
import { lifecycleRecovery } from "./lifecycle-recovery.ts";

export function lifecycleSection(ctx: UiContext, task: HubTask, focusedAttemptId?: string): HTMLElement {
	const section = el(
		"section",
		{ class: "detail-section lifecycle-section", role: "region", "aria-label": "Reliable lifecycle", "aria-busy": "true" },
		el("div", { class: "section-heading" }, el("h2", {}, "Reliable lifecycle"), badge("Loading", "info")),
		el("p", { class: "muted" }, "Loading persisted criteria, result decisions, blockers, and attempt recovery."),
	);
	void loadTaskLifecycle(task.id).then((lifecycle) => {
		if (!section.isConnected) return;
		section.removeAttribute("aria-busy");
		section.replaceChildren(
			el("div", { class: "section-heading" }, el("h2", {}, "Reliable lifecycle"), badge(readable(lifecycle.projection.currentMissingAction), projectionTone(lifecycle))),
			...(focusedAttemptId === undefined ? [] : [el("p", { class: "boundary-note" }, `Task criteria, blockers, and acceptance apply across the task. Attempt recovery below is scoped to ${focusedAttemptId}.`)]),
			projectionSummary(lifecycle),
			lifecycleCriteria(ctx, task, lifecycle),
			lifecycleBlockers(ctx, task, lifecycle),
			lifecycleRecovery(ctx, task, lifecycle, focusedAttemptId),
		);
		restoreDirtyForms(section, focusedAttemptId === undefined ? `backlog:${task.id}` : `handoff:${task.id}:${focusedAttemptId}`, []);
	}).catch((error: unknown) => {
		if (!section.isConnected) return;
		section.removeAttribute("aria-busy");
		section.replaceChildren(el("div", { class: "section-heading" }, el("h2", {}, "Reliable lifecycle"), badge("Unavailable", "error")), el("p", { role: "alert" }, error instanceof Error ? error.message : "Lifecycle facts could not be loaded."));
	});
	return section;
}

function projectionSummary(lifecycle: TaskLifecycle): HTMLElement {
	return el(
		"div",
		{ class: "lifecycle-projection" },
		el("div", {}, el("span", { class: "muted" }, "Current missing action"), el("strong", {}, readable(lifecycle.projection.currentMissingAction))),
		el("div", {}, el("span", { class: "muted" }, "Responsible owner"), el("strong", {}, readable(lifecycle.projection.responsibleOwner))),
		el("div", {}, el("span", { class: "muted" }, "Next action"), el("strong", {}, lifecycle.projection.nextAction)),
		el("div", {}, el("span", { class: "muted" }, "Acceptance"), el("strong", {}, `${lifecycle.projection.acceptanceMode} · ${lifecycle.projection.verificationRequired ? "verification required" : "no required verifier"}`)),
	);
}

function projectionTone(lifecycle: TaskLifecycle): "info" | "warning" | "success" | "error" {
	if (lifecycle.projection.currentMissingAction === "none") return "success";
	if (lifecycle.projection.currentMissingAction === "resolve_blocker" || lifecycle.projection.currentMissingAction === "recover_attempt") return "error";
	if (lifecycle.projection.currentMissingAction === "review_result" || lifecycle.projection.currentMissingAction === "revise_result") return "warning";
	return "info";
}

function readable(value: string): string {
	return value.replaceAll("_", " ");
}
