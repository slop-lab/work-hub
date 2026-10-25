import ky, { HTTPError } from "ky";
import { type CommandReceipt, commandReceiptSchema, type HubState, hubStateSchema, type OutputPage, outputPageSchema } from "./state-schema.ts";

export type CommandInput = {
	readonly commandId: string;
	readonly type: string;
	readonly target?: { readonly kind: string; readonly id: string };
	readonly expected?: Readonly<Record<string, number>>;
	readonly payload: Readonly<Record<string, unknown>>;
};

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

const client = ky.create({
	prefixUrl: "/api/v1",
	timeout: 15_000,
	retry: { limit: 1, methods: ["get"] },
	credentials: "same-origin",
});

async function safeJson(error: HTTPError): Promise<string> {
	const fallback = `Request failed with status ${error.response.status}`;
	try {
		const body = await error.response.json();
		if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") return body.message;
		if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string") return body.error.message;
		return fallback;
	} catch (cause) {
		if (cause instanceof SyntaxError) return fallback;
		throw cause;
	}
}

export async function loadState(): Promise<HubState> {
	try {
		return hubStateSchema.parse(await client.get("state").json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function login(token: string): Promise<void> {
	try {
		await client.post("login", { json: { token } });
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function logout(): Promise<void> {
	await client.post("logout");
}

export async function sendCommand(input: CommandInput): Promise<CommandReceipt> {
	try {
		return commandReceiptSchema.parse(await client.post("commands", { json: input }).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function sendSimulatorControl(payload: Readonly<Record<string, unknown>>): Promise<void> {
	try {
		await client.post("simulator/commands", { json: payload });
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function loadSessionOutput(sessionId: string, after?: string): Promise<OutputPage> {
	try {
		return outputPageSchema.parse(await client.get(`sessions/${sessionId}/output`, { searchParams: { limit: "50", ...(after === undefined ? {} : { after }) } }).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export function commandId(): string {
	return `cmd-web-${crypto.randomUUID()}`;
}
