import { commandId } from "../api.ts";
import { badge, el, findFormValue, label, submitButton } from "../dom.ts";
import type { LifecycleBlocker, TaskLifecycle } from "../lifecycle-api.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

const blockerKinds = [
	["environment", "Environment"], ["permission", "Permission"], ["external_dependency", "External dependency"],
	["task_dependency", "Task dependency"], ["capacity", "Capacity or rate"], ["provider_unknown", "Provider unknown"], ["child_work", "Child work"],
] as const;

export function lifecycleBlockers(ctx: UiContext, task: HubTask, lifecycle: TaskLifecycle): HTMLElement {
	return el(
		"div",
		{ class: "lifecycle-grid" },
		blockerList(ctx, lifecycle.blockers),
		openBlockerForm(ctx, task),
	);
}

function blockerList(ctx: UiContext, blockers: TaskLifecycle["blockers"]): HTMLElement {
	return el(
		"section",
		{ class: "lifecycle-pane", "aria-label": "Blockers" },
		el("div", { class: "section-heading" }, el("h3", {}, "Blockers"), badge(String(blockers.length), blockers.some((item) => item.status !== "resolved") ? "warning" : "neutral")),
		blockers.length === 0 ? el("p", { class: "muted" }, "No lifecycle blockers recorded.") : el("div", { class: "lifecycle-rows" }, ...blockers.map((blocker) => blockerRow(ctx, blocker))),
	);
}

function blockerRow(ctx: UiContext, blocker: LifecycleBlocker): HTMLElement {
	const resolution = el("input", { class: "input", name: "resolution", "aria-label": `Resolution for ${blocker.id}` });
	const recheck = el("input", { class: "input", name: "recheck", "aria-label": `Recheck note for ${blocker.id}` });
	const actions = el("div", { class: "lifecycle-blocker__actions" });
	if (blocker.status !== "resolved") {
		const resolve = submitButton("Resolve blocker", "secondary");
		resolve.setAttribute("aria-label", `Resolve ${blocker.id}`);
		const form = el("form", { class: "lifecycle-blocker__form", "data-form-key": `lifecycle-resolve:${blocker.taskId}:${blocker.id}` }, resolution, resolve);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (resolution.value.trim().length === 0) { ctx.notice("Record the concrete blocker resolution.", "error"); return; }
			void ctx.command({ commandId: commandId(), type: "blocker.resolve", target: { kind: "blocker", id: blocker.id }, payload: { resolution: resolution.value.trim() } }, "Blocker resolved. Resume remains a separate action.");
		});
		actions.append(form);
	}
	if (blocker.status === "resolved") {
		const recheckButton = submitButton("Recheck blocker", "secondary");
		recheckButton.setAttribute("aria-label", `Recheck ${blocker.id}`);
		const form = el("form", { class: "lifecycle-blocker__form", "data-form-key": `lifecycle-recheck:${blocker.taskId}:${blocker.id}` }, recheck, recheckButton);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (recheck.value.trim().length === 0) { ctx.notice("Record what should be rechecked.", "error"); return; }
			void ctx.command({ commandId: commandId(), type: "blocker.recheck", target: { kind: "blocker", id: blocker.id }, payload: { note: recheck.value.trim() } }, "Blocker recheck recorded without fabricating provider success.");
		});
		actions.append(form);
	}
	return el(
		"article",
		{ class: "lifecycle-row" },
		el("div", { class: "cluster" }, badge(blocker.status, blocker.status === "resolved" ? "success" : "warning"), badge(readable(blocker.kind)), blocker.attemptId === undefined ? null : badge("attempt linked", "info")),
		el("strong", {}, blocker.owner),
		el("p", {}, blocker.detail),
		el("p", { class: "muted" }, blocker.remedy),
		blocker.resolution === undefined ? null : el("p", {}, `Resolution: ${blocker.resolution}`),
		blocker.recheckNote === undefined ? null : el("p", {}, `Recheck: ${blocker.recheckNote}`),
		el("span", { class: "mono" }, blocker.id),
		actions,
	);
}

function openBlockerForm(ctx: UiContext, task: HubTask): HTMLElement {
	const kind = el("select", { class: "select", name: "kind" }, ...blockerKinds.map(([value, text]) => el("option", { value }, text)));
	const owner = el("input", { class: "input", name: "owner", required: true });
	const remedy = el("input", { class: "input", name: "remedy", required: true });
	const detail = el("textarea", { class: "textarea", name: "detail", rows: "3", required: true });
	const attempt = el("select", { class: "select", name: "attemptId" }, el("option", { value: "" }, "Task-level blocker"), ...ctx.state.attempts.filter((item) => item.taskId === task.id).map((item) => el("option", { value: item.id }, item.id)));
	const form = el("form", { class: "lifecycle-form", "data-form-key": `lifecycle-blocker:${task.id}` }, label("Blocker kind", kind), label("Responsible owner", owner), label("Requested remedy", remedy), label("Blocker detail", detail), label("Related attempt", attempt), submitButton("Open blocker", "secondary"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void ctx.command({ commandId: commandId(), type: "blocker.open", target: { kind: "task", id: task.id }, payload: { ...(attempt.value.length === 0 ? {} : { attemptId: attempt.value }), kind: kind.value, owner: findFormValue(form, "owner"), remedy: findFormValue(form, "remedy"), detail: findFormValue(form, "detail") } }, "Blocker opened with an explicit owner and remedy.");
	});
	return el("details", { class: "lifecycle-pane lifecycle-disclosure" }, el("summary", {}, "Open blocker"), form);
}

function readable(value: string): string {
	return value.replaceAll("_", " ");
}
