import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type BrowserHub, startBrowserHub } from "../browser-fixture.ts";

const stateSchema = z.object({
	tasks: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
	sessions: z.array(z.object({ id: z.string(), taskId: z.string(), activeAttemptId: z.string().optional() })),
	attempts: z.array(z.object({ id: z.string(), taskId: z.string(), sessionId: z.string(), phase: z.string(), outcome: z.string().optional(), predecessorId: z.string().optional(), recovery: z.string().optional() })),
	results: z.array(z.object({ attemptId: z.string() })),
});

type PreviewSetup = {
	readonly taskId: string;
	readonly sessionId: string;
	readonly attemptId: string;
};

async function state(page: Page, app: BrowserHub): Promise<z.infer<typeof stateSchema>> {
	const response = await page.request.get(`${app.url}/api/v1/state`);
	expect(response.ok(), await response.text()).toBeTruthy();
	return stateSchema.parse(await response.json());
}

async function delegate(page: Page, app: BrowserHub, title: string): Promise<PreviewSetup> {
	await page.getByRole("link", { name: "Backlog" }).click();
	await page.getByLabel("New task title").fill(title);
	await page.getByRole("button", { name: "Add task" }).click();
	await page.getByRole("button", { name: `Open ${title}` }).click();
	await page.getByRole("button", { name: "Delegate" }).click();
	await page.getByLabel("Environment choice").selectOption("none");
	await page.getByRole("button", { name: "Confirm delegation" }).click();
	await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
	await expect(page.getByText("running", { exact: true })).toBeVisible();
	const snapshot = await state(page, app);
	const task = snapshot.tasks.find((item) => item.title === title);
	if (task === undefined) throw new TypeError("Preview task missing from state");
	const session = snapshot.sessions.find((item) => item.taskId === task.id);
	if (session?.activeAttemptId === undefined) throw new TypeError("Preview session missing its active attempt");
	return { taskId: task.id, sessionId: session.id, attemptId: session.activeAttemptId };
}

async function terminate(page: Page, outcome: "completed" | "failed" | "unknown"): Promise<void> {
	await page.getByText("Simulator scenario").click();
	await page.getByLabel("Simulated event").selectOption("termination");
	await page.getByLabel("Termination outcome").selectOption(outcome);
	await page.getByRole("button", { name: "Emit simulated event" }).click();
}

test("Given completed work without a result, when its deep links reload and recovery resumes it, then the task stays incomplete and the terminal outcome is retained", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const setup = await delegate(page, app, "Recover completed work without a result");
		await terminate(page, "completed");
		await expect(page.getByText("finished", { exact: true })).toBeVisible();
		const sessionUrl = page.url();
		await page.reload();
		expect(page.url()).toBe(sessionUrl);
		await expect(page.getByText("finished", { exact: true })).toBeVisible();
		await expect(page.getByText("No questions or results yet.")).toBeVisible();
		await page.getByRole("link", { name: "Open task" }).click();
		const taskUrl = page.url();
		const lifecycle = page.getByRole("region", { name: "Reliable lifecycle" });
		await expect(page.getByText("No result submitted.")).toBeVisible();
		await expect(lifecycle.getByRole("region", { name: "Attempt recovery" })).toContainText("unknown");
		await page.reload();
		expect(page.url()).toBe(taskUrl);
		await expect(page.getByText("No result submitted.")).toBeVisible();
		const ended = await state(page, app);
		expect(ended.tasks.find((item) => item.id === setup.taskId)?.status).toBe("active");
		expect(ended.attempts.find((item) => item.id === setup.attemptId)?.outcome).toBe("ended_without_result");
		expect(ended.results.some((item) => item.attemptId === setup.attemptId)).toBeFalsy();
		await lifecycle.getByLabel("Recovery action").selectOption("resume");
		await lifecycle.getByLabel("Recovery reason").fill("Continue after the resultless completion report.");
		await lifecycle.getByRole("button", { name: "Controlled recovery" }).click();
		await expect.poll(async () => (await state(page, app)).attempts.find((item) => item.predecessorId === setup.attemptId)?.phase).toBe("running");
		const recovered = await state(page, app);
		expect(recovered.attempts.some((item) => item.predecessorId === setup.attemptId && item.recovery === "resume" && item.phase === "running")).toBeTruthy();
	} finally {
		await app.close();
	}
});

test("Given failed work without a result, when a bounded retry is submitted, then failure remains visible without completing the task and linked work starts", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const setup = await delegate(page, app, "Retry failed work without a result");
		await terminate(page, "failed");
		await expect(page.getByText("finished", { exact: true })).toBeVisible();
		await page.getByRole("link", { name: "Open task" }).click();
		const lifecycle = page.getByRole("region", { name: "Reliable lifecycle" });
		await expect(page.getByText("No result submitted.")).toBeVisible();
		await expect(lifecycle.getByRole("region", { name: "Attempt recovery" })).toContainText("crash");
		await page.reload();
		const failed = await state(page, app);
		expect(failed.tasks.find((item) => item.id === setup.taskId)?.status).toBe("active");
		expect(failed.attempts.find((item) => item.id === setup.attemptId)?.outcome).toBe("failed");
		await lifecycle.getByLabel("Recovery action").selectOption("retry");
		await lifecycle.getByLabel("Recovery reason").fill("Retry the retained failed attempt once.");
		await lifecycle.getByLabel("Retry limit").fill("1");
		await lifecycle.getByRole("button", { name: "Controlled recovery" }).click();
		await expect.poll(async () => (await state(page, app)).attempts.find((item) => item.predecessorId === setup.attemptId)?.phase).toBe("running");
		const retried = await state(page, app);
		expect(retried.attempts.some((item) => item.predecessorId === setup.attemptId && item.recovery === "retry" && item.phase === "running")).toBeTruthy();
	} finally {
		await app.close();
	}
});

test("Given an unknown termination report, when the session reloads, then Work Hub does not invent completion or a result", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const setup = await delegate(page, app, "Keep unknown termination unresolved");
		await terminate(page, "unknown");
		await expect(page.getByText("running", { exact: true })).toBeVisible();
		const deepLink = page.url();
		await page.reload();
		expect(page.url()).toBe(deepLink);
		await expect(page.getByText("running", { exact: true })).toBeVisible();
		await expect(page.getByText("No questions or results yet.")).toBeVisible();
		const unresolved = await state(page, app);
		expect(unresolved.tasks.find((item) => item.id === setup.taskId)?.status).toBe("active");
		expect(unresolved.attempts.find((item) => item.id === setup.attemptId)).toMatchObject({ phase: "running" });
		expect(unresolved.attempts.find((item) => item.id === setup.attemptId)?.outcome).toBeUndefined();
		expect(unresolved.results.some((item) => item.attemptId === setup.attemptId)).toBeFalsy();
	} finally {
		await app.close();
	}
});

test("Given an answer whose native delivery remains unknown, when lookup is restored, then reconciliation acknowledges it without duplicate delivery", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const setup = await delegate(page, app, "Recover unknown answer delivery");
		app.hub.simulator?.controls.emitQuestion({ hubSessionId: setup.sessionId, hubAttemptId: setup.attemptId, requestId: "preview-delivery-question", projectId: "project-default", taskId: setup.taskId, recipient: { kind: "user", userId: "user-admin" }, bindingGeneration: 1, prompt: "Continue after delivery recovery?", responseRoute: "native", blocking: "runtime_action" });
		await app.hub.reconcile();
		await page.reload();
		await page.getByRole("link", { name: "Today" }).click();
		app.hub.simulator?.controls.setDeliveryLookupAvailable(setup.sessionId, false);
		app.hub.simulator?.controls.scriptNext("runtime.deliverResponse", { kind: "unknown_after_effect" });
		await page.getByRole("button", { name: /Answer continue after delivery recovery/i }).click();
		await page.getByRole("dialog").getByLabel("Answer").fill("Continue with the same attempt.");
		await page.getByRole("button", { name: "Save answer" }).click();
		const actor = app.hub.actorForUser("user-admin");
		if (actor === undefined) throw new TypeError("Preview administrator missing");
		await expect.poll(() => app.hub.getDashboard(actor).deliveryProblems.length).toBe(1);
		await page.reload();
		const delivery = page.locator("section").filter({ has: page.getByRole("heading", { name: "Delivery problems" }) });
		await expect(delivery).toContainText("unknown");
		for (let cycle = 0; cycle < 4; cycle += 1) { await app.hub.reconcile(); await app.hub.drain(); }
		await page.reload();
		await page.getByRole("link", { name: "Review operation" }).click();
		await expect(page.getByRole("button", { name: "Reconcile operation" })).toBeVisible();
    await page.goto(`${app.url}/#/session/${setup.sessionId}`);
		await page.getByText("Simulator scenario").click();
		await page.getByLabel("Simulated event").selectOption("delivery_lookup");
		await expect(page.getByLabel("Simulator text")).toBeHidden();
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		await expect.poll(() => app.hub.getDashboard(actor).deliveryProblems.length).toBe(0);
		await page.goto(`${app.url}/#/session/${setup.sessionId}`);
		await expect(page.getByRole("region", { name: "Linked requests" })).toContainText("delivery acknowledged");
		expect(app.hub.simulator?.calls.list().filter((call) => call.operationKind === "runtime.deliverResponse")).toHaveLength(1);
	} finally {
		await app.close();
	}
});

test("Given an external-mode app without providers, when simulator controls are called with and without auth, then the real route denies both contracts", async ({ page }) => {
	const app = await startBrowserHub(page, { mode: "external" });
	try {
		await expect(page.getByText("Simulator scenario")).toHaveCount(0);
		const denied = await page.request.post(`${app.url}/api/v1/simulator/commands`, { headers: { Origin: app.url }, data: { type: "termination", sessionId: "missing", outcome: "failed" } });
		expect(denied.status()).toBe(403);
		expect(await denied.text()).toContain("No simulator installation is configured");
		await page.getByRole("button", { name: "Log out" }).click();
		const anonymous = await page.request.post(`${app.url}/api/v1/simulator/commands`, { headers: { Origin: app.url }, data: { type: "termination", sessionId: "missing", outcome: "failed" } });
		expect(anonymous.status()).toBe(401);
	} finally {
		await app.close();
	}
});
