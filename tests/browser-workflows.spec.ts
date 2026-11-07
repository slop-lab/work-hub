import { expect, test } from "@playwright/test";
import { startBrowserHub } from "./browser-fixture.ts";

test("Given a signed-in administrator, when Add task is clicked, then the real backend persists the task", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Verify restore instructions");
		const addTask = page.getByRole("button", { name: "Add task" });
		await expect(addTask).toHaveAttribute("type", "submit");
		await addTask.click();
		await expect(page.getByRole("heading", { name: "Verify restore instructions" })).toBeVisible();
	} finally {
		await app.close();
	}
});

test("Given multiple projects and owners, when backlog filters and capture selections change, then the selected scope is persisted", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Settings" }).click();
		await page.getByLabel("Project name").fill("Release engineering");
		await page.getByRole("button", { name: "Create project" }).click();
		await expect(page.getByText("Release engineering", { exact: true })).toBeVisible();
		await page.getByLabel("Display name").fill("Release owner");
		await page.getByRole("button", { name: "Create user" }).click();
		await expect(page.getByText("Release owner")).toBeVisible();
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("Task project").selectOption({ label: "Release engineering" });
		await page.getByLabel("New task title").fill("Ship selected project task");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByLabel("Filter by project").selectOption({ label: "Release engineering" });
		await expect(page.getByRole("heading", { name: "Ship selected project task" })).toBeVisible();
		await page.getByRole("button", { name: "Open Ship selected project task" }).click();
		await page.locator("select[name=ownerId]").selectOption({ label: "Release owner" });
		await expect(page.locator("select[name=ownerId]")).not.toHaveValue("");
		await page.getByRole("button", { name: "Save task" }).click();
		await expect(page.getByRole("definition").filter({ hasText: "Release owner" })).toBeVisible();
	} finally {
		await app.close();
	}
});

test("Given a task, when task fields, comment, and a formal question are submitted, then saved history survives refresh", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("Exercise durable task forms");
		await page.getByRole("button", { name: "Add task" }).click();
		await page.getByRole("button", { name: "Open Exercise durable task forms" }).click();
		await page.getByRole("textbox", { name: "Description", exact: true }).fill("Persist every explicit form action.");
		await page.getByLabel("Priority").selectOption("low");
		let releaseContext: () => void = () => undefined;
		const contextRelease = new Promise<void>((resolve) => { releaseContext = resolve; });
		let contextReady: () => void = () => undefined;
		const contextResponseReady = new Promise<void>((resolve) => { contextReady = resolve; });
		let holdNextContext = true;
		await page.route("**/api/v1/context*", async (route) => {
			if (!holdNextContext) { await route.continue(); return; }
			holdNextContext = false;
			const response = await route.fetch();
			contextReady();
			await contextRelease;
			await route.fulfill({ response });
		});
		await page.getByRole("button", { name: "Save task" }).click();
		await contextResponseReady;
		const comment = page.getByLabel("Comment text");
		await comment.focus();
		const replacementObserved = page.evaluate(() => {
			const original = document.querySelector('textarea[name="comment"]');
			if (original === null) throw new TypeError("Comment field missing before refresh");
			return new Promise<void>((resolve) => {
				const observer = new MutationObserver(() => {
					if (!original.isConnected) { observer.disconnect(); resolve(); }
				});
				observer.observe(document.querySelector("#app") ?? document.body, { childList: true, subtree: true });
			});
		});
		const contextRendered = page.waitForResponse((response) => response.url().includes("/api/v1/context") && response.request().method() === "GET");
		releaseContext();
		await Promise.all([contextRendered, replacementObserved]);
		await page.keyboard.insertText("Comment persisted through the application command service.");
		await expect(page.getByLabel("Comment text")).toHaveValue("Comment persisted through the application command service.");
		await expect(page.getByLabel("Comment text")).toBeFocused();
		await page.getByLabel("Expected outcome").fill("Fresh handlers keep the current task revision.");
		await page.getByRole("button", { name: "Save task" }).click();
		await expect(page.getByRole("status")).toContainText("Task updated.");
		await expect(page.getByLabel("Comment text")).toHaveValue("Comment persisted through the application command service.");
		await page.getByRole("button", { name: "Add comment" }).click();
		await expect(page.getByRole("status")).toContainText("Comment added.");
		await page.getByLabel("Question").fill("Which release should carry this change?");
		await page.getByLabel("Recipient").selectOption({ label: "Administrator" });
		await page.getByRole("button", { name: "Save question" }).click();
		await page.getByRole("link", { name: "Today" }).click();
		await page.getByRole("button", { name: /Answer which release should carry this change/i }).click();
		await page.getByRole("dialog").getByLabel("Answer").fill("The next minor release.");
		await page.getByRole("button", { name: "Save answer" }).click();
		await expect(page.getByRole("dialog")).toBeHidden();
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByRole("button", { name: "Open Exercise durable task forms" }).click();
		await page.reload();
		await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("Persist every explicit form action.");
		await expect(page.getByText("Comment persisted through the application command service.")).toBeVisible();
		await expect(page.getByText("Which release should carry this change?").first()).toBeVisible();
		await expect(page.getByText("The next minor release.")).toBeVisible();
	} finally {
		await app.close();
	}
});
