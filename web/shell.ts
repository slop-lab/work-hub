import { button, el } from "./dom.ts";
import type { HubState } from "./state-schema.ts";
import type { NoticeTone, Route } from "./ui-context.ts";

const navItems = [
	["dashboard", "Today", "#/dashboard"],
	["backlog", "Backlog", "#/backlog"],
	["session", "Session", "#/session"],
	["environments", "Environments", "#/environments"],
	["settings", "Settings", "#/settings"],
] as const;

let activeNavLink: WeakRef<HTMLAnchorElement> | undefined;
let revealFrame: number | undefined;
let resizeListenerInstalled = false;

function revealActiveNavLink(): void {
	const link = activeNavLink?.deref();
	if (link?.isConnected === true) link.scrollIntoView({ block: "nearest", inline: "center" });
}

function trackActiveNavLink(link: HTMLAnchorElement): void {
	activeNavLink = new WeakRef(link);
	if (!resizeListenerInstalled) {
		window.addEventListener("resize", () => {
			if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
			revealFrame = window.requestAnimationFrame(() => {
				revealFrame = undefined;
				revealActiveNavLink();
			});
		});
		resizeListenerInstalled = true;
	}
	queueMicrotask(revealActiveNavLink);
}

export function appShell(state: HubState, route: Route, content: HTMLElement, onLogout: EventListener): HTMLElement {
	const active = route.kind === "handoff" ? "backlog" : route.kind;
	activeNavLink = undefined;
	const nav = el("nav", {
		class: "app-nav",
		"aria-label": "Primary navigation",
	});
	for (const [key, label, href] of navItems) {
		const link = el("a", { class: `app-nav__link${active === key ? " is-active" : ""}`, href }, label);
		if (active === key) {
			link.setAttribute("aria-current", "page");
			trackActiveNavLink(link);
		}
		nav.append(link);
	}
	const simulator = state.simulator ? el("div", { class: "simulator-banner" }, "Simulator", el("span", {}, "External execution is not a live-provider result.")) : null;
	return el(
		"div",
		{ class: "app-shell" },
		el("a", { class: "skip-link", href: "#main-content" }, "Skip to content"),
		el(
			"header",
			{ class: "app-header" },
			el("a", { class: "brand", href: "#/dashboard", "aria-label": "Work Hub home" }, el("span", { class: "brand__mark", "aria-hidden": "true" }), el("span", {}, "Work Hub")),
			el("div", { class: "app-header__context" }, simulator, el("span", { class: "user-name" }, state.me.displayName), button("Log out", "quiet", onLogout)),
		),
		el("aside", { class: "app-sidebar" }, nav, el("div", { class: "sidebar-note" }, el("strong", {}, "Decide before automating"), el("span", {}, "Questions, results, and boundaries stay attached to the task."))),
		el("main", { class: "app-main", id: "main-content", tabindex: "-1" }, content),
		el("div", {
			class: "toast-region",
			"aria-live": "polite",
			"aria-atomic": "true",
		}),
	);
}

export function showToast(message: string, tone: NoticeTone): void {
	const region = document.querySelector<HTMLElement>(".toast-region");
	if (region === null) return;
	const toast = el(
		"div",
		{
			class: `toast toast--${tone}`,
			role: tone === "error" ? "alert" : "status",
		},
		message,
	);
	region.replaceChildren(toast);
	window.setTimeout(() => toast.remove(), 5000);
}

export function loadingScreen(message = "Loading workspace"): HTMLElement {
	return el("main", { class: "center-screen" }, el("div", { class: "loading-block", role: "status" }, el("span", { class: "skeleton skeleton--title" }), el("span", { class: "skeleton" }), message));
}

export function errorScreen(message: string, retry: EventListener): HTMLElement {
	return el("main", { class: "center-screen" }, el("section", { class: "error-panel" }, el("h1", {}, "Work Hub is unavailable"), el("p", {}, message), button("Try again", "primary", retry)));
}
