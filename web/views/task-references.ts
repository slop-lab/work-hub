import { commandId } from "../api.ts";
import { badge, el, findFormValue, label, submitButton } from "../dom.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function referenceSection(ctx: UiContext, task: HubTask): HTMLElement {
	const kind = el("select", { class: "select", name: "kind" }, el("option", { value: "text" }, "Retained text"), el("option", { value: "link" }, "External link"));
	const title = el("input", { class: "input", name: "title", required: true });
	const text = el("textarea", { class: "textarea", name: "content", rows: "4" });
	const url = el("input", { class: "input", name: "url", type: "url", placeholder: "https://example.com/spec" });
	const textField = label("Reference text", text, "Stored by Work Hub and included only when selected.");
	const urlField = label("Reference URL", url, "The URL is recorded as metadata and is never fetched by Work Hub.");
	urlField.hidden = true;
	kind.addEventListener("change", () => {
		textField.hidden = kind.value !== "text";
		urlField.hidden = kind.value !== "link";
	});
	const form = el("form", { class: "detail-section form-grid" }, el("h2", {}, "References"), label("Reference kind", kind), label("Reference title", title), textField, urlField, submitButton("Save reference", "secondary"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const payload = kind.value === "link" ? { kind: "link", title: findFormValue(form, "title"), url: findFormValue(form, "url") } : { kind: "text", title: findFormValue(form, "title"), content: findFormValue(form, "content") };
		void ctx.command({ commandId: commandId(), type: "reference.create", target: { kind: "task", id: task.id }, expected: { task: task.revision }, payload }, "Reference saved. External links were not fetched.").then((saved) => {
			if (saved) form.reset();
		});
	});
	const references = ctx.state.references.filter((item) => item.taskId === task.id);
	const history = references.length === 0 ? el("p", { class: "muted" }, "No retained text or links yet.") : el("div", { class: "history-list" }, ...references.map((item) => el("article", { class: "history-item" }, el("div", { class: "cluster" }, badge(item.kind, "info"), el("strong", {}, item.title)), item.retainedText == null ? el("a", { href: item.url ?? "#", target: "_blank", rel: "noreferrer" }, item.url ?? "Unavailable link") : el("p", {}, item.retainedText))));
	return el("div", { class: "stack" }, form, history);
}
