import { expect, test } from "@playwright/test";
import { z } from "zod";
import { startBrowserHub } from "./browser-fixture.ts";

test.use({ trace: "retain-on-failure" });

test("Given delegated simulated work, when explicit simulator events are emitted, then question, result, and termination remain distinct", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Validate simulator controls");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Validate simulator controls" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await expect(page.getByLabel("Execution profile")).toHaveValue("profile-structured");
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
		const sessionId = page.url().split("/").at(-1);
		if (sessionId === undefined) throw new TypeError("Session route missing its ID");
		const initialState = z.object({ sessions: z.array(z.object({ id: z.string(), activeAttemptId: z.string().optional() })) }).parse(await (await page.request.get(`${app.url}/api/v1/state`)).json());
		const oldAttemptId = initialState.sessions.find((item) => item.id === sessionId)?.activeAttemptId;
		if (oldAttemptId === undefined) throw new TypeError("Delegated session missing its active attempt");
		await expect(page.getByText("Simulator scenario")).toBeVisible();
		await page.getByText("Simulator scenario").click();
		await page.getByRole("textbox", { name: "Instruction" }).fill("Record an explicit session instruction.");
		const instructionRefresh = page.waitForResponse((response) => response.url().includes("/api/v1/context") && response.request().method() === "GET");
		await page.getByRole("button", { name: "Send instruction" }).click();
		console.info("[browser-work-hub phase 1] instruction response");
		await instructionRefresh;
		await page.getByLabel("Simulated event").selectOption("question");
		await expect(page.getByLabel("Question route")).toHaveValue("native");
		await page.getByLabel("Simulator text").fill("Choose a release boundary");
		console.info("[browser-work-hub phase 2] context response preserving simulator draft");
		await page.waitForResponse((response) => response.url().includes("/api/v1/context") && response.request().method() === "GET");
		await expect(page.getByLabel("Simulated event")).toHaveValue("question");
		await expect(page.getByLabel("Question route")).toHaveValue("native");
		await expect(page.getByLabel("Simulator text")).toHaveValue("Choose a release boundary");
		console.info("[browser-work-hub phase 3] emit selected simulator event");
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		await expect(page.getByRole("region", { name: "Linked requests" })
			.getByText("Choose a release boundary", { exact: true })).toBeVisible();
		await page.getByLabel("Simulated event").selectOption("result");
		await page.getByLabel("Simulator text").fill("Claimed simulator result");
		console.info("[browser-work-hub phase 4] emit selected simulator event");
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		await expect(page.getByText("Claimed simulator result")).toBeVisible();
		await expect(page.getByText("result_submitted")).toBeHidden();
		await page.getByRole("textbox", { name: "Instruction" }).fill("Keep this draft on the ended attempt.");
		await page.getByLabel("Simulated event").selectOption("termination");
		await page.getByLabel("Termination outcome").selectOption("completed");
		console.info("[browser-work-hub phase 5] emit selected simulator event");
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		await expect(page.getByText("finished", { exact: true })).toBeVisible();
		console.info("[browser-work-hub phase 6] continue ended session");
		await page.getByRole("button", { name: "Continue session" }).click();
		await expect(page.getByRole("textbox", { name: "Instruction" })).toHaveValue("");
		const drafts = await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index) ?? "")));
		expect(drafts.some((draft) => draft?.includes(oldAttemptId) === true && draft.includes("Keep this draft on the ended attempt."))).toBeTruthy();
		await page.getByLabel("Simulated event").selectOption("termination");
		await page.getByLabel("Termination outcome").selectOption("completed");
		console.info("[browser-work-hub phase 7] emit selected simulator event");
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		await expect(page.getByText("finished", { exact: true })).toBeVisible();
		await page.getByRole("link", { name: "Open task" }).click();
		await page.getByRole("button", { name: "Complete task" }).last().click();
		await expect(page.getByText("done", { exact: true })).toBeVisible();
	} finally {
		console.info("[browser-work-hub phase 8] close disposable browser application");
		await app.close();
	}
});

test("Given a pending simulator acknowledgement, when the next draft is edited and focus leaves the form, then refresh preserves and submits the new event", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Validate simulator controls");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Validate simulator controls" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await expect(page.getByLabel("Execution profile")).toHaveValue("profile-structured");
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
		const sessionId = page.url().split("/").at(-1);
		if (sessionId === undefined) throw new TypeError("Session route missing its ID");
		await page.getByText("Simulator scenario").click();
		await page.getByLabel("Simulated event").selectOption("question");
		await page.getByLabel("Simulator text").fill("Choose a release boundary");
		await page.evaluate(() => {
			const originalFetch = window.fetch;
			window.fetch = async (...args: Parameters<typeof fetch>) => {
				const response = await originalFetch(...args);
				if (response.url.endsWith("/api/v1/simulator/commands")) {
					window.fetch = originalFetch;
					setTimeout(() => { document.documentElement.dataset["simulatorAckDrained"] = "true"; }, 0);
				}
				return response;
			};
		});
		let releaseAcknowledgement!: () => void;
		const acknowledgement = new Promise<void>((resolve) => { releaseAcknowledgement = resolve; });
		let releaseContext!: () => void;
		const context = new Promise<void>((resolve) => { releaseContext = resolve; });
		let contextPending!: () => void;
		const pendingRefresh = new Promise<void>((resolve) => { contextPending = resolve; });
		let submitted!: () => void;
		const submission = new Promise<void>((resolve) => { submitted = resolve; });
		await page.route("**/api/v1/context**", async (route) => { contextPending(); await context; await route.continue(); });
		await page.route("**/api/v1/simulator/commands", async (route) => {
			const response = await route.fetch();
			submitted();
			await acknowledgement;
			await route.fulfill({ response });
		}, { times: 1 });
		try {
			console.info("[browser-work-hub phase 9] pending background context request");
			await pendingRefresh;
			const originalForm = await page.getByLabel("Simulated event").evaluateHandle((field: HTMLSelectElement) => field.form!);
			console.info("[browser-work-hub phase 10] emit selected simulator event");
			await page.getByRole("button", { name: "Emit simulated event" }).click();
			console.info("[browser-work-hub phase 11] backend simulator command effect");
			await submission;
			await page.getByLabel("Simulated event").selectOption("result");
			await page.getByLabel("Simulator text").fill("Claimed simulator result");
			await page.getByRole("button", { name: "Log out" }).focus();
			const completed = page.waitForResponse((response) => response.url().endsWith("/api/v1/simulator/commands"));
			expect(await originalForm.evaluate((form) => form.isConnected)).toBe(true);
			releaseAcknowledgement();
			console.info("[browser-work-hub phase 12] simulator acknowledgement response");
			await completed;
			// Drain the acknowledgement's promise reactions before allowing the pending refresh to render.
			console.info("[browser-work-hub phase 13] simulator fetch acknowledgement reactions");
			await page.waitForFunction(() => document.documentElement.dataset["simulatorAckDrained"] === "true");
		} finally {
			releaseAcknowledgement();
			releaseContext();
			console.info("[browser-work-hub phase 14] released context routes");
			await page.unrouteAll({ behavior: "wait" });
		}
		await expect(page.getByText("Artificial simulator event emitted. This is not live execution evidence.", { exact: true })).toBeVisible();
		await expect(page.getByLabel("Simulated event")).toHaveValue("result");
		await expect(page.getByLabel("Simulator text")).toHaveValue("Claimed simulator result");
		await expect(page.getByRole("region", { name: "Linked requests" })
			.getByText("Choose a release boundary", { exact: true })).toBeVisible();
		let submittedResult!: (payload: unknown) => void;
		const resultRequest = new Promise<unknown>((resolve) => { submittedResult = resolve; });
		await page.route("**/api/v1/simulator/commands", async (route) => {
			submittedResult(route.request().postDataJSON());
			await route.continue();
		}, { times: 1 });
		console.info("[browser-work-hub phase 15] emit selected simulator event");
		await page.getByRole("button", { name: "Emit simulated event" }).click();
		expect(await resultRequest).toEqual({ type: "result", sessionId, summary: "Claimed simulator result" });
		await expect(page.getByText("Claimed simulator result")).toBeVisible();
	} finally {
		console.info("[browser-work-hub phase 16] close disposable browser application");
		await app.close();
	}
});

test("Given administrator access, when environment and settings forms submit, then real administration state updates", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Environments" }).click();
		await page.getByLabel("Execution connector").selectOption("execution-sim");
		await page.getByLabel("Name").fill("Browser QA container");
		await page.getByLabel("Provider locator").fill("qa-container-1");
		await page.getByLabel("Allowed working directory").fill("/workspace/qa");
		await page.getByRole("button", { name: "Register" }).click();
		await expect(page.getByRole("heading", { name: "Browser QA container" })).toBeVisible();
		await page.getByRole("button", { name: "Verify read-only" }).click();
		await expect(page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Browser QA container" }) }).getByText("Verified", { exact: true }).first()).toBeVisible();
		await expect(page.getByRole("definition").filter({ hasText: "immutable" })).toBeVisible();
		await page.getByRole("link", { name: "Settings" }).click();
		await page.getByLabel("Display name").fill("Browser Reviewer");
		await page.getByRole("button", { name: "Create user" }).click();
		await expect(page.getByText("Browser Reviewer")).toBeVisible();
		await page.getByLabel("Project name").fill("Browser QA project");
		await page.getByRole("button", { name: "Create project" }).click();
		await expect(page.getByText("Browser QA project", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Disable profile" }).first().click();
		await expect(page.getByText("disabled", { exact: true }).first()).toBeVisible();
	} finally {
		await app.close();
	}
});

test("Given a task reference and human decision, when delegation is previewed and the task is completed, then selections and business state stay explicit", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Document selected context");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Document selected context" }).click();
		await page.getByLabel("Reference title").fill("Release notes");
		await page.getByLabel("Reference text").fill("Retained context for the delegated attempt.");
		await page.getByRole("button", { name: "Save reference" }).click();
		await expect(page.getByText("Retained context for the delegated attempt.")).toBeVisible();
		await page.getByRole("button", { name: "Delegate" }).click();
		await expect(page.getByLabel("Include reference Release notes")).toBeVisible();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByLabel("Completion note").fill("Completed by human review without a runtime result.");
		await page.getByRole("button", { name: "Complete task" }).click();
		await expect(page.getByText("done", { exact: true })).toBeVisible();
		await expect(page.getByText("Completion note: Completed by human review without a runtime result.")).toBeVisible();
		await page.getByRole("button", { name: "Reopen to backlog" }).click();
		await expect(page.getByText("backlog", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Archive task" }).click();
		await expect(page.getByText("Task archived.")).toBeVisible();
	} finally {
		await app.close();
	}
});

test("Given no current session, when an existing native session is attached, then observe is the default and no work is submitted", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Observe imported native work");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("link", { name: "Session" }).click();
		await page.getByLabel("Task context").selectOption({ label: "Observe imported native work" });
		await page.getByLabel("Runtime profile").selectOption("profile-structured");
		await expect(page.getByLabel("Requested access")).toHaveValue("observe");
		await page.getByLabel("Native session ID").fill("native-session-browser-qa");
		await page.getByRole("button", { name: "Attach without starting work" }).click();
		await expect(page.getByText("observe", { exact: true }).first()).toBeVisible();
		await expect(page.getByText("No output yet")).toBeVisible();
	} finally {
		await app.close();
	}
});

test("Given retained simulator output, when more than one page exists, then session history loads through the real paginated endpoint", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Page retained output");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Page retained output" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
		const sessionId = page.url().split("/").at(-1);
		expect(sessionId).toBeTruthy();
		await expect.poll(async () => {
			const response = await page.request.get(`${app.url}/api/v1/state`);
			return z.object({ sessions: z.array(z.object({ id: z.string(), state: z.string() })) }).parse(await response.json()).sessions.find((item) => item.id === sessionId)?.state;
		}).toBe("open");
		for (let index = 1; index <= 55; index += 1) {
			const response = await page.request.post(`${app.url}/api/v1/simulator/commands`, { headers: { Origin: app.url }, data: { type: "output", sessionId, text: `Retained output ${index}` } });
			expect(response.ok(), await response.text()).toBeTruthy();
		}
		await page.reload();
		await expect(page.getByRole("button", { name: "Load more history" })).toBeVisible();
		await page.getByRole("button", { name: "Load more history" }).click();
		await expect(page.getByText("Retained output 55")).toBeVisible();
	} finally {
		await app.close();
	}
});

test("Given an unsent session draft, when the user logs out, then the per-user draft is cleared before the next login", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Clear logout draft");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Clear logout draft" }).click();
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("none");
		await page.getByRole("button", { name: "Confirm delegation" }).click();
		await page.locator("#main-content").getByRole("link", { name: "Session", exact: true }).click();
		await page.getByRole("textbox", { name: "Instruction" }).fill("Unsent private draft");
		await page.getByRole("button", { name: "Log out" }).click();
		await page.getByLabel("Bootstrap token").fill(app.token);
		await page.getByRole("button", { name: "Sign in" }).click();
		await page.getByRole("link", { name: "Session" }).click();
		await expect(page.getByRole("textbox", { name: "Instruction" })).toHaveValue("");
	} finally {
		await app.close();
	}
});

test("Given a stale task revision, when save is rejected, then the dirty draft remains and no unhandled rejection escapes", async ({ page }) => {
	const app = await startBrowserHub(page);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Preserve stale draft");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Preserve stale draft" }).click();
		await page.getByRole("textbox", { name: "Description", exact: true }).fill("Keep this text after the conflict.");
		const stateResponse = await page.request.get(`${app.url}/api/v1/state`);
		const state = z.object({ tasks: z.array(z.object({ id: z.string(), revision: z.number(), title: z.string() })) }).parse(await stateResponse.json());
		const task = state.tasks.find((item) => item.title === "Preserve stale draft");
		if (task === undefined) throw new TypeError("Created task missing from state");
		const update = await page.request.post(`${app.url}/api/v1/commands`, { headers: { Origin: app.url }, data: { commandId: `external-${crypto.randomUUID()}`, type: "task.update", target: { kind: "task", id: task.id }, expected: { task: task.revision }, payload: { title: "Changed elsewhere" } } });
		expect(update.ok()).toBeTruthy();
		await page.waitForResponse((response) => response.url().includes("/api/v1/context") && response.request().method() === "GET");
		await expect(page.getByRole("heading", { name: "Changed elsewhere" })).toBeVisible();
		await page.getByRole("button", { name: "Save task" }).click();
		await expect(page.getByRole("textbox", { name: "Description", exact: true }))
			.toHaveValue("Keep this text after the conflict.");
		await expect(page.getByRole("alert")).toContainText("stale");
		expect(pageErrors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("Given an unresolved attention item, when it is read and dismissed, then canonical action remains available", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Keep canonical question actionable");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Keep canonical question actionable" }).click();
		await page.getByRole("textbox", { name: "Question" }).fill("Should this stay open?");
		await page.getByRole("button", { name: "Save question" }).click();
		await page.getByRole("link", { name: "Today" }).click();
		await page.getByRole("button", { name: "Mark read" }).click();
		await page.getByRole("button", { name: "Dismiss notice" }).click();
		await expect(page.getByRole("button", { name: /Answer should this stay open/i })).toBeVisible();
	} finally {
		await app.close();
	}
});
