import { badge, el, formatTime } from "../dom.ts";
import type { HubRequest } from "../state-schema.ts";

export function linkedRequests(requests: readonly HubRequest[]): HTMLElement {
	const open = requests.filter((request) => request.status === "open");
	return el(
		"section",
		{ class: "detail-section", role: "region", "aria-label": "Linked requests", "data-lifecycle-section": "linked-requests" },
		el("div", { class: "section-heading" }, el("h2", {}, "Linked requests"), badge(`${open.length} open`, open.some((request) => request.blocking !== "none") ? "warning" : "neutral")),
		requests.length === 0
			? el("p", { class: "muted" }, "No linked requests.")
			: el("div", { class: "lifecycle-rows" }, ...requests.map((request) => el(
				"article",
				{ class: "lifecycle-row" },
				el("div", { class: "cluster" }, badge(request.status, request.status === "open" ? "warning" : request.status === "answered" ? "success" : "neutral"), badge(blockingLabel(request), request.blocking === "none" ? "info" : "warning"), badge(`delivery ${readable(request.deliveryStatus ?? "pending")}`)),
				el("strong", {}, request.prompt),
				request.reason === undefined ? null : el("p", {}, request.reason),
				el("p", { class: "muted" }, `Updated ${formatTime(request.updatedAt)}.`),
				request.deliveryStatus === "unknown" ? el("p", { class: "limitation" }, "Delivery is unknown. Work Hub does not infer that the exact attempt resumed.") : null,
				el("p", { class: "muted" }, nextAction(request)),
				el("span", { class: "mono" }, request.id),
			))),
		open.some((request) => request.recipient.kind !== "agent_session") ? el("a", { class: "button button--secondary", href: "#/dashboard" }, "Open inbox to answer") : null,
	);
}

function blockingLabel(request: HubRequest): string {
	if (request.blocking === "runtime_action") return "Blocking runtime action";
	if (request.blocking === "before_delegate") return "Blocking delegation";
	return "Nonblocking";
}

function nextAction(request: HubRequest): string {
	if (request.status === "answered" && request.deliveryStatus === "acknowledged") return "Answer delivered to the exact attempt; resume can be observed here.";
	if (request.status === "answered") return "Answer saved for the exact attempt; runtime resume waits for delivery acknowledgement.";
	if (request.status !== "open") return "This request is no longer actionable.";
	if (request.blocking === "runtime_action") return "Answer in Today to resume the exact attempt.";
	if (request.blocking === "before_delegate") return "Answer in Today before delegation can continue.";
	return "Independent work may continue while this answer is pending.";
}

function readable(value: string): string {
	return value.replaceAll("_", " ");
}
