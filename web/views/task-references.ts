import { captureAkbReference, commandId, loadAkbPage, loadAkbPages, loadAkbSources, type AkbPage } from "../api.ts";
import { badge, button, el, findFormValue, formatTime, label, submitButton } from "../dom.ts";
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
	const history = references.length === 0 ? el("p", { class: "muted" }, "No retained text, captured documents, or links yet.") : el("div", { class: "history-list" },
		...references.map((item) => el("article", { class: "history-item" }, el("div", { class: "cluster" }, badge(item.provenance?.provider === "akb" ? "AKB capture" : item.kind, "info"), el("strong", {}, item.title)),
			item.provenance === undefined ? null : el("p", { class: "mono captured-text" }, `Source ID ${item.provenance.pageId} · workspace ${item.provenance.workspaceId} · installation ${item.provenance.installationId}`),
			item.provenance === undefined ? item.contentRevision == null ? null : el("p", { class: "mono" }, `Captured revision ${item.contentRevision}`) : el("p", { class: "mono" }, `Captured revision ${item.provenance.revision} · source updated ${formatTime(item.provenance.sourceUpdatedAt)} · retained by Work Hub`),
			item.retainedText != null ? el("p", { class: 'captured-text' }, item.retainedText) : item.url != null ? el("a", { class: 'captured-text', href: item.url, target: "_blank", rel: "noreferrer" }, item.url) : el("p", { class: "muted" }, "Captured content is retained by Work Hub."))));
	return el("div", { class: "stack" }, form, akbCaptureSection(ctx, task), history);
}

function akbCaptureSection(ctx: UiContext, task: HubTask): HTMLElement {
	const source = el("select", { class: "select", name: "akbSource" }, el("option", { value: "" }, "Discover sources first"));
	const page = el("select", { class: "select", name: "akbPage", disabled: true }, el("option", { value: "" }, "Choose a source first"));
	const provenance = el("p", { class: "snapshot-meta" }, "No AKB document selected. Capture reads only from a configured backend source.");
	const preview = el("p", { class: "captured-text muted" });
	const message = el("p", { class: "form-message", "aria-live": "polite" });
	const capture = button("Capture selected revision", "secondary", () => void captureSelection());
	capture.disabled = true;
	let pages: readonly AkbPage[] = [];
	let selectedPage: AkbPage | undefined;
	let captureCommandId = commandId();
	const renderPageSelection = async (): Promise<void> => {
		const selected = pages.find((item) => item.id === page.value);
		selectedPage = undefined;
		capture.disabled = true;
		preview.textContent = "";
		if (selected === undefined) { provenance.textContent = "Choose a document to pin its current revision."; return; }
		provenance.textContent = `Reading source ID ${selected.id} before capture…`;
		try {
			const detail = await loadAkbPage(task.projectId, source.value, selected.id);
			if (page.value !== selected.id || source.value.length === 0) return;
			selectedPage = detail.page;
			captureCommandId = commandId();
			provenance.textContent = `Source ID ${detail.page.id} · selected revision ${detail.page.revision}`;
			preview.textContent = detail.preview.length === 0 ? "The selected document has no text preview. Capture still uses the retained backend projection." : detail.preview;
			capture.disabled = false;
			message.textContent = "";
		} catch (error) {
			provenance.textContent = `Source ID ${selected.id} could not be read.`;
			message.textContent = error instanceof Error ? error.message : "Document read failed.";
		}
	};
	const loadPages = async (): Promise<void> => {
		page.disabled = true;
		capture.disabled = true;
		page.replaceChildren(el("option", { value: "" }, "Loading documents…"));
		try {
			pages = await loadAkbPages(task.projectId, source.value);
			page.replaceChildren(el("option", { value: "" }, pages.length === 0 ? "No documents available" : "Choose a document"), ...pages.map((item) => el("option", { value: item.id }, `${item.title} · revision ${item.revision}`)));
			page.disabled = pages.length === 0;
			message.textContent = "";
		} catch (error) {
			page.replaceChildren(el("option", { value: "" }, "Document discovery failed"));
			message.textContent = error instanceof Error ? error.message : "Document discovery failed.";
		}
	};
	const discover = button("Discover AKB sources", "secondary", () => {
		discover.disabled = true;
		message.textContent = "Checking configured AKB sources…";
		void loadAkbSources(task.projectId).then((sources) => {
			source.replaceChildren(el("option", { value: "" }, sources.length === 0 ? "No AKB sources configured" : "Choose an AKB source"), ...sources.map((item) => el("option", { value: item.installationId }, item.label)));
			message.textContent = sources.length === 0 ? "Ask the operator to configure a private AKB connection. Credentials are never entered here." : "";
		}).catch((error: unknown) => { message.textContent = error instanceof Error ? error.message : "AKB source discovery failed."; }).finally(() => { discover.disabled = false; });
	});
	const captureSelection = async (): Promise<void> => {
		const selected = selectedPage;
		if (selected === undefined || source.value.length === 0) return;
		capture.disabled = true;
		message.textContent = "Capturing the selected immutable revision…";
		try {
			await captureAkbReference({ taskId: task.id, commandId: captureCommandId, installationId: source.value, pageId: selected.id, revision: selected.revision });
			ctx.notice(`Captured ${selected.title} at revision ${selected.revision}.`, "success");
			await ctx.refresh();
		} catch (error) {
			message.textContent = error instanceof Error ? error.message : "Document capture failed.";
			capture.disabled = false;
		}
	};
	source.addEventListener("change", () => { pages = []; provenance.textContent = "No document selected."; if (source.value.length > 0) void loadPages(); });
	page.addEventListener("change", () => void renderPageSelection());
	return el("section", { class: "detail-section stack akb-capture" }, el("div", { class: "section-heading akb-capture__heading" }, el("h2", {}, "Capture AKB context"), discover), el("p", { class: "muted" }, "Select a configured source and document. Work Hub records the exact selected revision; it does not mirror document status or replace the AKB editor."), label("AKB source", source), label("Document and revision", page), provenance, preview, message, capture);
}
