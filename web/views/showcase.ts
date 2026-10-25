import { badge, button, el, label } from "../dom.ts";
import type { UiContext } from "../ui-context.ts";

export function showcaseView(_ctx: UiContext): HTMLElement {
	const input = el("input", { class: "input", placeholder: "Default input" });
	return el(
		"div",
		{ class: "page showcase" },
		el("header", { class: "page-heading" }, el("div", {}, el("p", { class: "kicker" }, "Design system"), el("h1", {}, "Primitive showcase"), el("p", { class: "lead" }, "Required states at mobile, tablet, and desktop widths."))),
		el(
			"section",
			{ class: "showcase-block" },
			el("h2", {}, "Buttons"),
			el(
				"div",
				{ class: "cluster" },
				button("Primary", "primary"),
				button("Secondary", "secondary"),
				button("Quiet", "quiet"),
				button("Danger", "danger"),
				(() => {
					const value = button("Disabled", "secondary");
					value.disabled = true;
					return value;
				})(),
			),
		),
		el("section", { class: "showcase-block" }, el("h2", {}, "Badges"), el("div", { class: "cluster" }, badge("neutral"), badge("info", "info"), badge("warning", "warning"), badge("success", "success"), badge("error", "error"), badge("Simulator", "warning"))),
		el("section", { class: "showcase-block showcase-grid" }, label("Input", input, "Helper text explains the expected value."), label("Select", el("select", { class: "select" }, el("option", {}, "Choose one"))), label("Text area", el("textarea", { class: "textarea", rows: "3" }))),
		el(
			"section",
			{ class: "showcase-block" },
			el("h2", {}, "States"),
			el(
				"div",
				{ class: "attention-grid" },
				el("article", { class: "attention-item" }, badge("fresh", "success"), el("h3", {}, "Action available"), el("p", {}, "A normal attention item with a safe next step."), button("Review", "primary")),
				el("article", { class: "attention-item" }, badge("stale", "warning"), el("h3", {}, "Target changed"), el("p", {}, "Refresh before applying the draft to a new attempt.")),
				el("article", { class: "attention-item" }, badge("unknown", "error"), el("h3", {}, "Effect unknown"), el("p", {}, "Reconcile the original operation before retrying.")),
			),
		),
		el(
			"section",
			{ class: "showcase-block" },
			el("h2", {}, "Loading and empty"),
			el(
				"div",
				{ class: "switcher" },
				el("div", { class: "loading-block" }, el("span", { class: "skeleton skeleton--title" }), el("span", { class: "skeleton" }), el("span", { class: "skeleton" })),
				el("div", { class: "empty-state" }, el("h3", {}, "Nothing here yet"), el("p", {}, "The next safe action is stated directly.")),
			),
		),
	);
}
