import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { createApplication } from "../application/api/app.ts";
import { AuthStore } from "../application/api/auth-store.ts";
import { Hub } from "../application/orchestration/hub.ts";

const reviewStateSchema = z.object({
	tasks: z.array(z.object({ id: z.string(), revision: z.number(), title: z.string(), status: z.string(), primaryAttemptId: z.string().optional() })),
	sessions: z.array(z.object({ id: z.string(), revision: z.number(), taskId: z.string(), state: z.string(), activeAttemptId: z.string().optional() })),
	attempts: z.array(z.object({ id: z.string(), taskId: z.string(), sessionId: z.string(), phase: z.string(), profileId: z.string(), profileRevision: z.number(), stopRequestedAt: z.string().optional() })),
	results: z.array(z.object({ id: z.string(), taskId: z.string(), attemptId: z.string() })),
});

type ReviewState = z.infer<typeof reviewStateSchema>;
type ReviewBrowserHub = {
	readonly url: string;
	readonly hub: Hub;
	readonly close: () => Promise<void>;
};
type ReviewSetup = {
	readonly taskId: string;
	readonly sessionId: string;
	readonly attemptId: string;
	readonly resultId: string;
};

async function startReviewBrowserHub(page: Page): Promise<ReviewBrowserHub> {
	const directory = mkdtempSync(join(tmpdir(), "work-hub-browser-review-"));
	const hub = new Hub(join(directory, "hub.sqlite"));
	const auth = new AuthStore(join(directory, "auth.sqlite"));
	const token = auth.bootstrap("user-admin");
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	if (address === null || typeof address === "string") throw new TypeError("Review browser fixture did not reserve a TCP port");
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	const url = `http://127.0.0.1:${address.port}`;
	const app = createApplication({ hub, auth, origin: url, secureCookies: false });
	const webRoot = fileURLToPath(new URL("../dist/web/", import.meta.url));
	app.get("/app.js", serveStatic({ root: webRoot }));
	app.get("/app.css", serveStatic({ root: webRoot }));
	app.get("/", serveStatic({ path: join(webRoot, "index.html") }));
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: address.port });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const timer = setInterval(() => void hub.reconcile().then(() => hub.drain()), 100);
	await page.goto(url);
	await page.getByLabel("Bootstrap token").fill(token);
	await page.getByRole("button", { name: "Sign in" }).click();
	return {
		url,
		hub,
		close: async () => {
			clearInterval(timer);
			await new Promise<void>((resolve) => server.close(() => resolve()));
			hub.close();
			auth.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

async function getState(page: Page, app: ReviewBrowserHub): Promise<ReviewState> {
	const response = await page.request.get(`${app.url}/api/v1/state`);
	expect(response.ok()).toBeTruthy();
	return reviewStateSchema.parse(await response.json());
}

async function createResult(page: Page, app: ReviewBrowserHub, title: string): Promise<ReviewSetup> {
	await page.getByRole("link", { name: "Backlog" }).click();
	await page.getByLabel("New task title").fill(title);
	await page.getByRole("button", { name: "Add task" }).click();
	await page.getByRole("button", { name: `Open ${title}` }).click();
	await page.getByRole("button", { name: "Delegate" }).click();
	await page.getByLabel("Environment choice").selectOption("none");
	await page.getByRole("button", { name: "Confirm delegation" }).click();
	await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
	const state = await getState(page, app);
	const task = state.tasks.find((item) => item.title === title);
	if (task === undefined) throw new TypeError("Created review task missing from state");
	const session = state.sessions.find((item) => item.taskId === task.id);
	if (session === undefined) throw new TypeError("Delegated review session missing from state");
	await expect.poll(async () => (await getState(page, app)).sessions.find((item) => item.id === session.id)?.state).toBe("open");
	const attempt = state.attempts.find((item) => item.id === session.activeAttemptId);
	if (attempt === undefined) throw new TypeError("Active review attempt missing from state");
	const resultResponse = await page.request.post(`${app.url}/api/v1/simulator/commands`, {
		headers: { Origin: app.url },
		data: { type: "result", sessionId: session.id, summary: `${title} result` },
	});
	expect(resultResponse.ok(), await resultResponse.text()).toBeTruthy();
	await page.reload();
	await expect(page.getByText(`${title} result`)).toBeVisible();
	const resultState = await getState(page, app);
	const result = resultState.results.find((item) => item.attemptId === attempt.id);
	if (result === undefined) throw new TypeError("Emitted review result missing from state");
	await page.getByRole("link", { name: "Open task" }).click();
	return { taskId: task.id, sessionId: session.id, attemptId: attempt.id, resultId: result.id };
}

test("Given an active result, when revision is requested, then one supported runtime instruction targets its attempt", async ({ page }) => {
	const app = await startReviewBrowserHub(page);
	try {
		const setup = await createResult(page, app, "Revise active browser result");
		await page.getByRole("button", { name: "Request revision" }).click();
		const dialog = page.getByRole("dialog", { name: "Request revision" });
		await dialog.getByLabel("Revision instruction").fill("Address the browser review findings");
		await dialog.getByLabel("Instruction timing").selectOption("immediate");
		await page.screenshot({ path: ".omo/evidence/result-review/active-revision.png" });
		await dialog.getByRole("button", { name: "Send revision" }).click();
		await expect(dialog).toBeHidden();
		await expect.poll(() => app.hub.simulator?.calls.list().filter((call) => call.operationKind === "runtime.sendInstruction").length ?? 0).toBe(1);
		const calls = app.hub.simulator?.calls.list().filter((call) => call.operationKind === "runtime.sendInstruction") ?? [];
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input["text"]).toBe("Address the browser review findings");
		expect(calls[0]?.input["mode"]).toBe("immediate");
		const runtimeTarget = calls[0]?.input["target"];
		if (typeof runtimeTarget !== "object" || runtimeTarget === null) throw new TypeError("Runtime instruction target missing from call log");
		expect(Reflect.get(runtimeTarget, "hubAttemptId")).toBe(setup.attemptId);
	} finally {
		await app.close();
	}
});

test("Given an ended result, when revision is requested, then a continuation attempt retains the source result", async ({ page }) => {
	const app = await startReviewBrowserHub(page);
	try {
		const setup = await createResult(page, app, "Continue ended browser result");
		const termination = await page.request.post(`${app.url}/api/v1/simulator/commands`, { headers: { Origin: app.url }, data: { type: "termination", sessionId: setup.sessionId, outcome: "completed" } });
		expect(termination.ok()).toBeTruthy();
		await expect.poll(async () => (await getState(page, app)).attempts.find((item) => item.id === setup.attemptId)?.phase).toBe("finished");
		await page.reload();
		await page.getByRole("button", { name: "Request revision" }).click();
		const dialog = page.getByRole("dialog", { name: "Continue revision" });
		await dialog.getByLabel("Revision instruction").fill("Continue from the retained browser result");
		await page.screenshot({ path: ".omo/evidence/result-review/ended-continuation.png" });
		await dialog.getByRole("button", { name: "Start continuation" }).click();
		await expect(dialog).toBeHidden();
		const state = await getState(page, app);
		const attempts = state.attempts.filter((item) => item.taskId === setup.taskId);
		expect(attempts).toHaveLength(2);
		const continuation = attempts.find((item) => item.id !== setup.attemptId);
		expect(continuation?.sessionId).toBe(setup.sessionId);
		await expect.poll(() => app.hub.simulator?.calls.list().filter((call) => call.operationKind === "runtime.startAttempt").length ?? 0).toBe(2);
		const starts = app.hub.simulator?.calls.list().filter((call) => call.operationKind === "runtime.startAttempt") ?? [];
		expect(starts).toHaveLength(2);
		expect(state.results.some((result) => result.id === setup.resultId)).toBeTruthy();
	} finally {
		await app.close();
	}
});

test("Given active work and a selected result, when completing, then execution consequence requires an explicit visible choice", async ({ page }) => {
	const app = await startReviewBrowserHub(page);
	try {
		const setup = await createResult(page, app, "Complete active browser result");
		const statusBeforeCompletion = (await getState(page, app)).tasks.find((item) => item.id === setup.taskId)?.status;
		await page.getByRole("button", { name: "Complete task" }).first().click();
		const dialog = page.getByRole("dialog", { name: "Complete task" });
		await expect(dialog.getByLabel("Active execution consequence")).toHaveValue("");
		await dialog.getByLabel("Completion note").fill("Accepted after browser review");
		await dialog.getByLabel("Active execution consequence").selectOption("request_stop");
		await page.screenshot({ path: ".omo/evidence/result-review/explicit-completion-choice.png" });
		await dialog.getByLabel("Active execution consequence").selectOption("");
		await dialog.getByRole("button", { name: "Confirm completion" }).click();
		expect((await getState(page, app)).tasks.find((item) => item.id === setup.taskId)?.status).toBe(statusBeforeCompletion);
		await dialog.getByLabel("Active execution consequence").selectOption("request_stop");
		await dialog.getByRole("button", { name: "Confirm completion" }).click();
		await expect(dialog).toBeHidden();
		const state = await getState(page, app);
		expect(state.tasks.find((item) => item.id === setup.taskId)?.status).toBe("done");
		expect(state.attempts.find((item) => item.id === setup.attemptId)?.stopRequestedAt).toBeTruthy();
	} finally {
		await app.close();
	}
});
