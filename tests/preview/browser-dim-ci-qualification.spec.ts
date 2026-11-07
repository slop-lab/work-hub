import { expect, test } from "@playwright/test";
import { startBrowserHub } from "../browser-fixture.ts";

test("Given the simulator dashboard, when DIM CI qualifies failure evidence, then the deliberately absent heading fails visibly", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "DIM CI qualification deliberately absent heading", exact: true })).toBeVisible({ timeout: 1_000 });
	} finally {
		await app.close();
	}
});
