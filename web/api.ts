import ky, { HTTPError } from "ky";
import { z } from "zod";
import { type CommandReceipt, commandReceiptSchema, type HubState, hubStateSchema, type OutputPage, outputPageSchema, type TaskPage, taskPageSchema } from "./state-schema.ts";
import type { Route } from "./ui-context.ts";

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

export async function loadState(route: Route): Promise<HubState> {
	try {
		const context = route.kind === "backlog" ? { route: route.taskId === undefined ? "backlog" : "task", ...(route.taskId === undefined ? {} : { id: route.taskId }) } : route.kind === "handoff" ? { route: "task", id: route.taskId } : route.kind === "session" ? { route: "session", ...(route.sessionId === undefined ? {} : { id: route.sessionId }) } : route.kind === "operation" ? { route: "operation", id: route.operationId } : { route: route.kind };
		return hubStateSchema.parse(await client.get("context", { searchParams: context }).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export type TaskQuery = { readonly q?: string; readonly projectId?: string; readonly status?: string; readonly ownerId?: string; readonly priority?: number; readonly after?: string; readonly limit?: number };

export async function loadTasks(query: TaskQuery): Promise<TaskPage> {
	try {
		const searchParams: Record<string, string> = { limit: String(query.limit ?? 50), ...(query.q === undefined || query.q.length === 0 ? {} : { q: query.q }), ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
			...(query.status === undefined ? {} : { status: query.status }), ...(query.ownerId === undefined ? {} : { ownerId: query.ownerId }), ...(query.priority === undefined ? {} : { priority: String(query.priority) }), ...(query.after === undefined ? {} : { after: query.after }) };
		return taskPageSchema.parse(await client.get("tasks", { searchParams }).json());
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

export async function loadSessionOutput(sessionId: string, attemptId?: string, after?: string): Promise<OutputPage> {
	try {
		return outputPageSchema.parse(await client.get(`sessions/${sessionId}/output`, { searchParams: { limit: "50", ...(attemptId === undefined ? {} : { attemptId }), ...(after === undefined ? {} : { after }) } }).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

const akbSourceSchema = z.object({ installationId: z.string().min(1), label: z.string().min(1) });
const akbPageSchema = z.object({ id: z.string().min(1), title: z.string(), revision: z.number().int().positive(), parentPageId: z.string().nullable().optional() });
const akbDocumentSchema = z.object({ page: akbPageSchema.extend({ document: z.object({ blocks: z.array(z.object({ text: z.string() })) }) }) });
const akbSourcesSchema = z.object({ connections: z.array(akbSourceSchema) });
const akbPagesSchema = z.object({ pages: z.array(akbPageSchema), nextCursor: z.string().nullable().optional() });
const capturedReferenceSchema = z.object({ reference: z.object({ kind: z.literal("reference"), id: z.string().min(1), revision: z.number().int().positive() }) });
const projectRepositorySchema = z.object({ id: z.string().min(1), projectId: z.string().min(1), canonicalIdentity: z.string().min(1), revision: z.number().int().positive() });
const handoffRecipientSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("new") }),
	z.object({ kind: z.literal("attached"), sessionId: z.string().min(1), sessionRevision: z.number().int().positive(), bindingGeneration: z.number().int().positive(), profileId: z.string().min(1), profileRevision: z.number().int().positive() }),
]);
const verificationEnvelopeSchema = z.object({ repositoryId: z.string().min(1), repositoryRevision: z.number().int().positive(), sourceBranch: z.string().min(1), sourceCommit: z.string().min(1), requestedValidation: z.string().min(1), contextDigest: z.string().min(1) });
const handoffPreviewSchema = z.object({ previewDigest: z.string().min(1), promptDigest: z.string().min(1), prompt: z.string().min(1), taskId: z.string().min(1), taskRevision: z.number().int().positive(), profileId: z.string().min(1), profileRevision: z.number().int().positive(), repository: projectRepositorySchema, verification: verificationEnvelopeSchema, recipient: handoffRecipientSchema });
const handoffDetailSchema = z.object({
	task: z.object({ id: z.string().min(1), revision: z.number().int(), title: z.string() }),
	attempt: z.object({ id: z.string().min(1), taskId: z.string().min(1), sessionId: z.string().min(1), phase: z.string(), observation: z.string(), inputSnapshot: z.record(z.string(), z.unknown()) }),
	preview: handoffPreviewSchema,
	delivery: z.object({ attemptId: z.string().min(1), deliveryDigest: z.string().min(1), status: z.enum(["pending", "delivered", "acknowledged", "failed", "unknown"]), inputReceiptJson: z.string().nullable(), lastErrorJson: z.string().nullable(), updatedAt: z.string().min(1) }),
	results: z.array(z.record(z.string(), z.unknown())),
});

export type AkbSource = z.infer<typeof akbSourceSchema>;
export type AkbPage = z.infer<typeof akbPageSchema>;
export type AkbPageDetail = { readonly page: AkbPage; readonly preview: string };
export type ProjectRepository = z.infer<typeof projectRepositorySchema>;
export type HandoffRecipient = z.infer<typeof handoffRecipientSchema>;
export type VerificationEnvelope = z.infer<typeof verificationEnvelopeSchema>;
export type HandoffPreview = z.infer<typeof handoffPreviewSchema>;
export type HandoffDetail = z.infer<typeof handoffDetailSchema>;

export async function registerProjectRepository(input: { readonly projectId: string; readonly canonicalIdentity: string }): Promise<ProjectRepository> {
	try {
		return projectRepositorySchema.parse(await client.post(`projects/${encodeURIComponent(input.projectId)}/repositories`, { json: { canonicalIdentity: input.canonicalIdentity } }).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function previewHandoff(input: { readonly taskId: string; readonly profileId: string; readonly repositoryId: string; readonly repositoryRevision: number; readonly sourceBranch: string; readonly sourceCommit: string; readonly requestedValidation: string; readonly contextDigest: string; readonly recipient: HandoffRecipient }): Promise<HandoffPreview> {
	try {
		return handoffPreviewSchema.parse(await client.post(`tasks/${encodeURIComponent(input.taskId)}/handoffs/preview`, { json: { profileId: input.profileId, repositoryId: input.repositoryId, repositoryRevision: input.repositoryRevision, sourceBranch: input.sourceBranch, sourceCommit: input.sourceCommit, requestedValidation: input.requestedValidation, contextDigest: input.contextDigest, recipient: input.recipient } }).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function loadTaskHandoffs(taskId: string): Promise<readonly HandoffDetail[]> {
	try {
		return z.object({ items: z.array(handoffDetailSchema) }).parse(await client.get(`tasks/${encodeURIComponent(taskId)}/handoffs`).json()).items;
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function loadHandoff(attemptId: string): Promise<HandoffDetail> {
	try {
		return handoffDetailSchema.parse(await client.get(`handoffs/${encodeURIComponent(attemptId)}`).json());
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function loadAkbSources(projectId: string): Promise<readonly AkbSource[]> {
	try {
		return akbSourcesSchema.parse(await client.get("external-context/akb", { searchParams: { projectId } }).json()).connections;
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function loadAkbPages(projectId: string, installationId: string): Promise<readonly AkbPage[]> {
	try {
		return akbPagesSchema.parse(await client.get(`external-context/akb/${encodeURIComponent(installationId)}/pages`, { searchParams: { projectId } }).json()).pages;
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function loadAkbPage(projectId: string, installationId: string, pageId: string): Promise<AkbPageDetail> {
	try {
		const result = akbDocumentSchema.parse(await client.get(`external-context/akb/${encodeURIComponent(installationId)}/pages/${encodeURIComponent(pageId)}`, { searchParams: { projectId } }).json());
		return { page: result.page, preview: result.page.document.blocks.map((block) => block.text.trim()).filter((text) => text.length > 0).slice(0, 3).join("\n").slice(0, 500) };
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export async function captureAkbReference(input: { readonly taskId: string; readonly commandId: string; readonly installationId: string; readonly pageId: string; readonly revision: number }): Promise<string> {
	try {
		return capturedReferenceSchema.parse(await client.post(`tasks/${encodeURIComponent(input.taskId)}/external-context/akb`, { json: {
			commandId: input.commandId,
			installationId: input.installationId,
			pageId: input.pageId,
			revision: input.revision,
		} }).json()).reference.id;
	} catch (error) {
		if (error instanceof HTTPError) throw new ApiError(error.response.status, await safeJson(error));
		throw error;
	}
}

export function commandId(): string {
	return `cmd-web-${crypto.randomUUID()}`;
}
