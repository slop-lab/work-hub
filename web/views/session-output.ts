import { loadSessionOutput } from "../api.ts";
import { badge, button, el, formatTime } from "../dom.ts";
import type { HubAttempt, HubSession, OutputPage } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

type CachedOutput = { readonly items: readonly OutputPage["items"][number][]; readonly page: OutputPage };
const cache = new Map<string, CachedOutput>();

export function sessionOutput(ctx: UiContext, session: HubSession, attempt?: HubAttempt): HTMLElement {
	const region = el("div", { class: "stack", "aria-live": "polite" }, el("p", { class: "muted" }, "Loading retained output."));
	const key = `${session.id}:${attempt?.id ?? "session"}:${session.bindingGeneration}`;
	const cached = cache.get(key);
	if (cached !== undefined) renderPage(ctx, session, attempt, region, cached.page, cached.items.slice(0, -cached.page.items.length), key);
	void loadSessionOutput(session.id, attempt?.id).then((page) => renderPage(ctx, session, attempt, region, page, cached?.items.filter((item) => !page.items.some((candidate) => candidate.id === item.id)) ?? [], key)).catch((error: unknown) => {
		region.replaceChildren(el("p", { class: "limitation" }, error instanceof Error ? error.message : "Retained output could not be loaded."));
	});
	return region;
}

function renderPage(ctx: UiContext, session: HubSession, attempt: HubAttempt | undefined, region: HTMLElement, page: OutputPage, accumulated: readonly OutputPage["items"][number][] = [], key: string): void {
	const items = [...accumulated, ...page.items];
	cache.set(key, { items, page });
	const list = items.length === 0
		? el("div", { class: "empty-state" }, el("h3", {}, "No output yet"), el("p", {}, "Opening this view does not start or resume work."))
		: el("ol", { class: "transcript" }, ...items.map((item) => el("li", { class: `transcript-entry transcript-entry--${item.role ?? "runtime"}` }, el("div", { class: "transcript-entry__meta" }, el("strong", {}, item.role ?? item.kind), el("time", { datetime: item.observedAt }, formatTime(item.observedAt)), item.partial === true ? badge("partial", "warning") : null), el("p", { class: item.kind === "gap" ? "gap-message" : "" }, item.text ?? "Reference output"))));
	const status = el("p", { class: "muted" }, `${items.length} retained entries · ${page.coverage.replaceAll("_", " ")}`);
	const gaps = page.gaps.map((gap) => el("p", { class: "limitation" }, gap.reason));
	let more: HTMLButtonElement | null = null;
	if (page.nextCursor !== undefined) {
		const cursor = page.nextCursor;
		more = button("Load more history", "secondary", () => {
			if (more === null) return;
			more.disabled = true;
			void loadSessionOutput(session.id, attempt?.id, cursor).then((next) => renderPage(ctx, session, attempt, region, next, items, key)).catch((error: unknown) => {
				ctx.notice(error instanceof Error ? error.message : "More output could not be loaded.", "error");
				if (more !== null) more.disabled = false;
			});
		});
	}
	region.replaceChildren(status, ...gaps, list, ...(more === null ? [] : [more]));
}
