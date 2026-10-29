import { expect, test } from "@playwright/test";

import { admin, createTask, delegateNone } from "../acceptance-fixture.ts";
import { startBrowserHub } from "../browser-fixture.ts";

test("Given a final result while execution remains active, when the owner accepts it, then the UI requires an explicit active-work decision", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser active acceptance", admin);
		const attempt = await delegateNone(app.hub, taskId, "browser-active-acceptance");
		const submitted = await app.hub.execute(admin, {
			commandId: "browser-active-acceptance-result",
			type: "result.submit",
			target: { kind: "attempt", id: attempt.id },
			payload: { kind: "final", summary: "Reviewable while the provider remains active.", limitations: [], referenceIds: [], evidence: [], criterionEvidence: [] },
		});
		expect(submitted.status).toBe("confirmed");

		await page.goto(`${app.url}/#/backlog/${taskId}`);
		const lifecycle = page.getByRole("region", { name: "Reliable lifecycle" });
		await lifecycle.getByLabel("Acceptance decision").selectOption("accepted");
		await lifecycle.getByRole("button", { name: "Record acceptance decision" }).click();
		await expect(page.getByText("Choose whether active work should stop or continue before accepting the result.", { exact: true })).toBeVisible();
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await lifecycle.getByRole("heading", { name: "Current result decision" }).locator("xpath=..").screenshot({ path: `.omo/evidence/lifecycle/task-active-acceptance-${width}.png` });
		}
		await lifecycle.getByLabel("Active execution decision").selectOption("allow_to_continue");
		await lifecycle.getByRole("button", { name: "Record acceptance decision" }).click();
		await expect(lifecycle).toContainText("No lifecycle action is pending.");
		expect(app.hub.getTask(admin, taskId).status).toBe("done");
		expect(app.hub.snapshot(admin).attempts.find((candidate) => candidate.id === attempt.id)?.unresolved).toBe(true);
	} finally {
		await app.close();
	}
});
