import type { CommandInput } from "./api.ts";
import type { HubState } from "./state-schema.ts";

export type NoticeTone = "info" | "success" | "warning" | "error";

export type UiContext = {
	readonly state: HubState;
	readonly navigate: (route: string) => void;
	readonly command: (input: CommandInput, successMessage: string) => Promise<boolean>;
	readonly notice: (message: string, tone?: NoticeTone) => void;
	readonly refresh: () => Promise<void>;
};

export type Route = { readonly kind: "dashboard" } | { readonly kind: "backlog"; readonly taskId?: string } | { readonly kind: "handoff"; readonly taskId: string; readonly attemptId: string } | { readonly kind: "session"; readonly sessionId?: string } | { readonly kind: "operation"; readonly operationId: string } | { readonly kind: "environments" } | { readonly kind: "settings" } | { readonly kind: "showcase" };

export function parseRoute(): Route {
	if (new URLSearchParams(location.search).get("showcase") === "1") return { kind: "showcase" };
	const [section = "dashboard", id, subsection, nestedId] = location.hash.replace(/^#\/?/, "").split("/");
	switch (section) {
		case "backlog":
			if (id !== undefined && subsection === "handoff" && nestedId !== undefined) return { kind: "handoff", taskId: id, attemptId: nestedId };
			return id === undefined ? { kind: "backlog" } : { kind: "backlog", taskId: id };
		case "session":
			return id === undefined ? { kind: "session" } : { kind: "session", sessionId: id };
		case "operation":
			return id === undefined ? { kind: "dashboard" } : { kind: "operation", operationId: id };
		case "environments":
			return { kind: "environments" };
		case "settings":
			return { kind: "settings" };
		case "dashboard":
			return { kind: "dashboard" };
		default:
			return { kind: "dashboard" };
	}
}
