import { ApiError, type CommandInput, loadState, login, logout, sendCommand } from "./api.ts";
import { clear } from "./dom.ts";
import { captureDirtyForms, clearDirtyForms, markDirtyForm, markFormClean, restoreDirtyForms } from "./form-islands.ts";
import { loginScreen } from "./login.ts";
import { appShell, errorScreen, loadingScreen, showToast } from "./shell.ts";
import type { HubState } from "./state-schema.ts";
import { type NoticeTone, parseRoute, type Route, type UiContext } from "./ui-context.ts";
import { backlogView } from "./views/backlog.ts";
import { dashboardView } from "./views/dashboard.ts";
import { environmentsView } from "./views/environments.ts";
import { sessionView } from "./views/session.ts";
import { operationView } from "./views/operation.ts";
import { settingsView } from "./views/settings.ts";
import { showcaseView } from "./views/showcase.ts";
import { clearConnectionInventory } from './views/connections.ts';

function requireRoot(): HTMLElement {
	const value = document.querySelector<HTMLElement>("#app");
	if (value === null) throw new TypeError("Missing #app root");
	return value;
}

const root = requireRoot();

let state: HubState | null = null;
let refreshInFlight: Promise<void> | null = null;
let submittedForm: HTMLFormElement | null = null;
let renderedLocation: string | undefined;

function navigate(route: string): void {
	location.hash = route.replace(/^#/, "");
}

function notice(message: string, tone: NoticeTone = "info"): void {
	showToast(message, tone);
}

async function command(input: CommandInput, successMessage: string): Promise<boolean> {
	const active = document.activeElement;
	const activeForm = active instanceof Element ? active.closest("form") : null;
	const sourceForm = submittedForm ?? (activeForm instanceof HTMLFormElement ? activeForm : null);
	const sourceIdentity = state === null ? undefined : refreshIdentity(parseRoute(), state);
	submittedForm = null;
	setCommandBusy(true);
	try {
		const receipt = await sendCommand(input);
		const tone: NoticeTone = receipt.status === "confirmed" ? "success" : receipt.status === "rejected" || receipt.status === "failed" ? "error" : receipt.status === "unknown" ? "warning" : "info";
		if (receipt.status !== "rejected" && receipt.status !== "failed") markFormClean(sourceForm, sourceIdentity);
		await refreshAfterCommand();
		if (receipt.status === "rejected" || receipt.status === "failed") throw new ApiError(422, receipt.error?.message ?? "Command was not accepted.");
		notice(receipt.status === "unknown" ? `${successMessage} The external effect is unknown and must be reconciled.` : successMessage, tone);
		return true;
	} finally {
		setCommandBusy(false);
	}
}

function setCommandBusy(busy: boolean): void {
	root.setAttribute("aria-busy", String(busy));
	for (const control of root.querySelectorAll<HTMLButtonElement>("button")) {
		if (busy) {
			control.dataset["commandDisabled"] = String(control.disabled);
			control.disabled = true;
		} else if (control.dataset["commandDisabled"] !== undefined) {
			control.disabled = control.dataset["commandDisabled"] === "true";
			delete control.dataset["commandDisabled"];
		}
	}
}

async function refresh(): Promise<void> {
	if (refreshInFlight !== null) return refreshInFlight;
	const pending = (async () => {
		const route = parseRoute();
		const nextState = await loadState(route);
    const islands = state === null ? [] : captureDirtyForms(root, refreshIdentity(parseRoute(), state));
    const scrollTop = renderedLocation === location.hash ? root.querySelector('main')?.scrollTop ?? 0 : 0;
    state = nextState;
		render();
		restoreDirtyForms(root, refreshIdentity(parseRoute(), state), islands);
    const main = root.querySelector('main');
    if (main) main.scrollTo({ top: scrollTop, behavior: 'instant' });
	})();
	refreshInFlight = pending;
	try { await pending; } finally { if (refreshInFlight === pending) refreshInFlight = null; }
}

async function refreshAfterCommand(): Promise<void> {
	if (refreshInFlight !== null) await refreshInFlight;
	await refresh();
}

async function backgroundRefresh(): Promise<void> {
	if (state === null || document.visibilityState !== "visible" || document.querySelector("dialog[open]") !== null) return;
	await refresh();
}

function refreshIdentity(route: Route, current: HubState): string {
	if (route.kind === "backlog") return `backlog:${route.taskId ?? "list"}`;
	if (route.kind !== "session") return route.kind;
	const session = route.sessionId === undefined ? current.sessions[0] : current.sessions.find((item) => item.id === route.sessionId);
	if (session === undefined) return "session:none";
	const attempt = current.attempts.find((item) => item.id === session.activeAttemptId);
	const intent = attempt?.phase === "finished" ? "ended" : "active";
	const capabilities = `${session.capabilities.instructionModes.join(",")}:${session.capabilities.nativeQuestionSupport}:${session.capabilities.bridgeQuestionSupport}`;
	return `session:${session.id}:${session.bindingGeneration}:${attempt?.id ?? "none"}:${intent}:${capabilities}`;
}

function contentFor(route: Route, ctx: UiContext): HTMLElement {
	switch (route.kind) {
		case "dashboard":
			return dashboardView(ctx);
		case "backlog":
			return backlogView(ctx, route.taskId);
		case "session":
			return sessionView(ctx, route.sessionId);
		case "operation":
			return operationView(ctx, route.operationId);
		case "environments":
			return environmentsView(ctx);
		case "settings":
			return settingsView(ctx);
		case "showcase":
			return showcaseView(ctx);
	}
}

function render(): void {
	if (state === null) return;
	renderedLocation = location.hash;
	const route = parseRoute();
	const retainedToasts = [...(root.querySelector<HTMLElement>(".toast-region")?.children ?? [])];
	const ctx: UiContext = {
		state,
		navigate,
		command: async (input, message) => {
			try {
				return await command(input, message);
			} catch (error) {
				notice(error instanceof Error ? error.message : "Command failed.", "error");
				return false;
			}
		},
		notice,
		refresh,
	};
	clear(root);
	root.append(
		appShell(state, route, contentFor(route, ctx), () => {
			void logout().then(() => {
				clearDirtyForms();
				clearConnectionInventory();
				for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
					const key = sessionStorage.key(index);
					if (key?.startsWith("workhub:draft:") === true) sessionStorage.removeItem(key);
				}
				state = null;
				clear(root);
				root.append(loginScreen(handleLogin));
			});
		}),
	);
	const toastRegion = root.querySelector<HTMLElement>(".toast-region");
	if (toastRegion !== null && retainedToasts.length > 0) toastRegion.replaceChildren(...retainedToasts);
}

async function handleLogin(token: string): Promise<void> {
	await login(token);
	await refresh();
}

async function start(): Promise<void> {
	clear(root);
	root.append(loadingScreen());
	try {
		await refresh();
	} catch (error) {
		clear(root);
		if (error instanceof ApiError && error.status === 401) root.append(loginScreen(handleLogin));
		else root.append(errorScreen(error instanceof Error ? error.message : "Unknown startup error", () => void start()));
	}
}

root.addEventListener("input", (event) => { if (state !== null) markDirtyForm(event, refreshIdentity(parseRoute(), state)); });
root.addEventListener("change", (event) => { if (state !== null) markDirtyForm(event, refreshIdentity(parseRoute(), state)); });
root.addEventListener(
	"submit",
	(event) => {
		if (!(event.target instanceof HTMLFormElement)) return;
		submittedForm = event.target;
		queueMicrotask(() => {
			if (submittedForm === event.target) submittedForm = null;
		});
	},
	{ capture: true },
);
window.addEventListener("hashchange", () => {
	void refresh().catch((error: unknown) => notice(error instanceof Error ? error.message : "Route could not be loaded.", "error"));
});
window.setInterval(() => {
	void backgroundRefresh();
}, 1_500);
void start();
