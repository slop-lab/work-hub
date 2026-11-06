import { expect, test } from "@playwright/test";
import { z } from "zod";
import { startBrowserHub } from "./browser-fixture.ts";

test("Given backlog browsing, when filters and pagination change, then the browser uses bounded server task queries instead of workspace state polling", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		for (let index = 1; index <= 55; index += 1) {
			const response = await page.request.post(`${app.url}/api/v1/commands`, { headers: { Origin: app.url }, data: { commandId: `bounded-task-${index}`, type: "task.create", payload: { projectId: "project-default", title: `Bounded browser task ${String(index).padStart(2, "0")}` } } });
			expect(response.ok(), await response.text()).toBeTruthy();
		}
		const taskRequests: string[] = [];
		page.on("request", (request) => { if (request.url().includes("/api/v1/tasks")) taskRequests.push(request.url()); });
		await page.getByRole("link", { name: "Backlog" }).click();
		await expect(page.getByRole("button", { name: "Load more tasks" })).toBeVisible();
		await page.getByLabel("Search tasks").fill("task 55");
		await expect(page.getByRole("button", { name: "Open Bounded browser task 55" })).toBeVisible();
		expect(taskRequests.some((url) => url.includes("limit=50"))).toBeTruthy();
		expect(taskRequests.some((url) => url.includes("q=task+55") || url.includes("q=task%2055"))).toBeTruthy();
		expect(taskRequests.every((url) => !url.endsWith("/api/v1/state"))).toBeTruthy();
	} finally { await app.close(); }
});

test("Given loaded transcript pages, when background context refreshes, then viewed session and attempt history stays expanded", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Preserve transcript pages");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Preserve transcript pages" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
		const sessionId = page.url().split("/").at(-1);
		if (sessionId === undefined) throw new TypeError("Session route missing its ID");
		for (let index = 1; index <= 55; index += 1) {
			const response = await page.request.post(`${app.url}/api/v1/simulator/commands`, { headers: { Origin: app.url }, data: { type: "output", sessionId, text: `Persistent output ${index}` } });
			expect(response.ok(), await response.text()).toBeTruthy();
		}
		await page.getByRole("button", { name: "Refresh" }).click();
		await page.getByRole("button", { name: "Load more history" }).click();
		await expect(page.getByText("Persistent output 55")).toBeVisible();
		await page.waitForTimeout(1_700);
		await expect(page.getByText("Persistent output 55")).toBeVisible();
		await expect(page.getByText(/55 retained entries/)).toBeVisible();
	} finally { await app.close(); }
});

test("Given a definite external failure, when its dashboard recovery is opened, then details and manual recovery remain actionable without unsafe reconcile", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		app.hub.simulator?.controls.scriptNext("runtime.openSession", { kind: "definite_failure", code: "browser_recovery_failure" });
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Recover failed operation");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Recover failed operation" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.getByRole("link", { name: "Today" }).click();
		await page.getByRole("link", { name: "Review operation" }).click();
		await expect(page.getByRole("heading", { name: "Operation recovery" })).toBeVisible();
		await expect(page.getByText("runtime.openSession", { exact: true })).toBeVisible();
		await expect(page.getByText("browser_recovery_failure", { exact: false })).toBeVisible();
		await expect(page.getByText("Observed", { exact: true })).toBeVisible();
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await page.screenshot({ path: `.omo/evidence/product-ui-final/operation-recovery-${width}.png`, fullPage: true });
		}
		await expect(page.getByText("Recovery policy: manual action", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Reconcile operation" })).toHaveCount(0);
	} finally { await app.close(); }
});

test("Given active delegated work, when a human asks the scoped agent, then the request is saved for the agent inbox without starting more work", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Ask scoped agent");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Ask scoped agent" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
		await expect(page.getByText("running", { exact: true })).toBeVisible();
		await page.getByRole("link", { name: "Open task" }).click();
		const sideEffectsBefore = app.hub.simulator?.calls.list().filter((call) => ["runtime.openSession", "runtime.startAttempt", "runtime.sendInstruction"].includes(call.operationKind)).length;
		await page.getByLabel("Recipient").selectOption({ label: "Agent session: Structured simulator" });
		await page.getByLabel("Question").fill("What remains uncertain?");
		await page.getByRole("button", { name: "Save question" }).click();
		await expect(page.getByText("What remains uncertain?").first()).toBeVisible();
		await expect(page.getByText("Agent inbox · delivery not required", { exact: true })).toBeVisible();
		await page.setViewportSize({ width: 375, height: 900 });
		await page.getByText("Agent inbox · delivery not required", { exact: true })
			.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
		await page.screenshot({ path: ".omo/evidence/product-ui-final/scoped-agent-request-375.png" });
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.getByRole("heading", { name: "Ask a formal question" })
			.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
		await page.screenshot({ path: ".omo/evidence/product-ui-final/scoped-agent-request-1280.png" });
		const sideEffectsAfter = app.hub.simulator?.calls.list().filter((call) => ["runtime.openSession", "runtime.startAttempt", "runtime.sendInstruction"].includes(call.operationKind)).length;
		expect(sideEffectsAfter).toBe(sideEffectsBefore);
	} finally { await app.close(); }
});

test("Given an ended reviewed attempt, when retry is chosen with an explicit allowed environment, then a new logical session is created", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Retry with explicit environment");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Retry with explicit environment" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
		const sessionId = page.url().split("/").at(-1);
		if (sessionId === undefined) throw new TypeError("Session route missing its ID");
		await page.getByText("Simulator scenario").click();
		await page.getByLabel("Simulated event").selectOption("result");
		await page.getByLabel("Simulator text").fill("Retry source result");
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		await page.getByLabel("Simulated event").selectOption("termination");
		await page.getByLabel("Termination outcome").selectOption("completed");
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		await expect(page.getByText("finished", { exact: true })).toBeVisible();
		await page.getByRole("link", { name: "Open task" }).click();
		await page.getByRole("button", { name: "Retry in new session" }).click();
		const dialog = page.getByRole("dialog", { name: "Retry in new session" });
		await expect(dialog.getByText("Structured simulator", { exact: true })).toBeVisible();
		await dialog.getByLabel("Retry environment").selectOption("none");
		await dialog.getByLabel("Retry context").selectOption("current_task");
		await page.setViewportSize({ width: 375, height: 900 });
		await page.screenshot({ path: ".omo/evidence/product-ui-final/new-session-retry-375.png" });
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.screenshot({ path: ".omo/evidence/product-ui-final/new-session-retry-1280.png" });
		await dialog.getByRole("button", { name: "Start new-session retry" }).click();
		await expect(dialog).toBeHidden();
		const response = await page.request.get(`${app.url}/api/v1/state`);
		const state = z.object({ sessions: z.array(z.object({ id: z.string(), taskId: z.string() })), tasks: z.array(z.object({ id: z.string(), title: z.string() })) }).parse(await response.json());
		const taskId = state.tasks.find((item) => item.title === "Retry with explicit environment")?.id;
		expect(state.sessions.filter((item) => item.taskId === taskId)).toHaveLength(2);
		expect(state.sessions.some((item) => item.taskId === taskId && item.id !== sessionId)).toBeTruthy();
	} finally { await app.close(); }
});

test("Given dashboard access, when a project question is saved for members, then it stays actionable without a task or execution side effect", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const sideEffectsBefore = app.hub.simulator?.calls.list().filter((call) => ["runtime.openSession", "runtime.startAttempt", "runtime.sendInstruction"].includes(call.operationKind)).length;
		await page.getByLabel("Project question").fill("Which release should the project target?");
		await page.getByRole("button", { name: "Save project question" }).click();
		const answer = page.getByRole("button", { name: /Answer which release should the project target/i });
		await expect(answer).toBeVisible();
		await expect(page.getByRole("status")).toBeHidden({ timeout: 6_000 });
		await page.setViewportSize({ width: 375, height: 900 });
		await answer.scrollIntoViewIfNeeded();
		await page.screenshot({ path: ".omo/evidence/product-ui-final/project-question-375.png" });
		await page.setViewportSize({ width: 1280, height: 900 });
		await answer.scrollIntoViewIfNeeded();
		await page.screenshot({ path: ".omo/evidence/product-ui-final/project-question-1280.png" });
		const response = await page.request.get(`${app.url}/api/v1/state`);
		const state = z.object({ requests: z.array(z.object({ prompt: z.string(), taskId: z.string().optional(), recipient: z.object({ kind: z.string() }) })) }).parse(await response.json());
		const request = state.requests.find((item) => item.prompt === "Which release should the project target?");
		expect(request?.taskId).toBeUndefined();
		expect(request?.recipient.kind).toBe("project_members");
		const sideEffectsAfter = app.hub.simulator?.calls.list().filter((call) => ["runtime.openSession", "runtime.startAttempt", "runtime.sendInstruction"].includes(call.operationKind)).length;
		expect(sideEffectsAfter).toBe(sideEffectsBefore);
	} finally { await app.close(); }
});
