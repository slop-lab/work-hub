import { expect, test } from "@playwright/test";
import { startBrowserHub } from "./browser-fixture.ts";

const routes = ["dashboard", "backlog", "session", "environments", "settings"] as const;
const widths = [375, 768, 1280] as const;

test("Given the real product routes, when rendered at required breakpoints, then each route fits without primary overflow", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("릴리스 경계를 검증하는 매우 긴 작업 제목과 식별자 abcdefghijklmnopqrstuvwxyz0123456789");
		await page.getByRole("button", { name: "Add task" }).click();
		for (const width of widths) {
			await page.setViewportSize({ width, height: 900 });
			for (const route of routes) {
				await page.goto(`${app.url}/#/${route}`);
				await expect(page.locator("#main-content")).toBeVisible();
				await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
				await page.screenshot({ path: `.omo/evidence/product-ui-final/${route}-${width}.png`, fullPage: true });
			}
		}
		await page.setViewportSize({ width: 375, height: 900 });
		await page.goto(`${app.url}/#/backlog`);
		await page.keyboard.press("Tab");
		await page.screenshot({ path: ".omo/evidence/product-ui-final/focus-375.png" });
		await page.goto(`${app.url}/#/dashboard`);
		await page.locator("#main-content").evaluate((element) => { element.scrollTop = element.scrollHeight; });
		await page.screenshot({ path: ".omo/evidence/product-ui-final/dashboard-scrolled-375.png" });
		await page.goto(`${app.url}/#/backlog`);
		await page.getByRole("button", { name: /Open 릴리스 경계를/ }).click();
		await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 375);
		await page.screenshot({ path: ".omo/evidence/product-ui-final/cjk-task-375.png", fullPage: true });
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("provision");
		await expect(page.getByLabel("Execution connector")).toBeVisible();
		await page.getByRole("dialog").locator("form").evaluate((form) => { form.scrollTop = form.scrollHeight; });
		await page.screenshot({ path: ".omo/evidence/product-ui-final/delegation-provision-375.png" });
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByLabel("Reference kind").selectOption("link");
		await expect(page.getByLabel("Reference URL")).toBeVisible();
		await expect(page.getByLabel("Reference text")).toBeHidden();
		await page.screenshot({ path: ".omo/evidence/product-ui-final/reference-link-375.png", fullPage: true });
	} finally {
		await app.close();
	}
});
