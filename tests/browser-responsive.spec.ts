import { expect, test } from "@playwright/test";
import { startBrowserHub } from "./browser-fixture.ts";

const routes = ["dashboard", "backlog", "session", "environments", "settings"] as const;
const widths = [375, 768, 1280] as const;

test("Given Settings is active at desktop width, when the viewport narrows, then the route reel reveals the active link", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(`${app.url}/#/settings`);
		const navigation = page.getByRole("navigation", { name: "Primary navigation" });
		const settings = navigation.getByRole("link", { name: "Settings" });
		await expect(settings).toHaveAttribute("aria-current", "page");

		await page.setViewportSize({ width: 375, height: 900 });
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

		const settingsIsRevealed = await settings.evaluate((link) => {
			const routeReel = link.closest(".app-sidebar");
			if (!(routeReel instanceof HTMLElement)) throw new TypeError("Route reel missing");
			const reelBounds = routeReel.getBoundingClientRect();
			const linkBounds = link.getBoundingClientRect();
			return linkBounds.left >= reelBounds.left && linkBounds.right <= Math.min(reelBounds.right, window.innerWidth);
		});
		expect(settingsIsRevealed).toBe(true);
		await page.screenshot({ path: ".omo/evidence/product-ui-final/route-reel-settings-375.png" });
	} finally {
		await app.close();
	}
});

test("Given the real product routes, when rendered at required breakpoints, then each route fits without primary overflow", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog" }).click();
		await page.getByLabel("New task title").fill("릴리스 경계를 검증하는 매우 긴 작업 제목과 식별자 abcdefghijklmnopqrstuvwxyz0123456789");
		await page.getByRole("button", { name: "Add task" }).click();
		await expect(page.getByText("Task captured.", { exact: true })).toBeHidden({ timeout: 6_000 });
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
		await expect(page.locator('h1')).toContainText('릴리스');
		const wordLines = await page.locator('h1').evaluate((heading) => {
			const node = heading.firstChild;
			if (!(node instanceof Text)) throw new TypeError('Task title text missing');
			const start = node.data.indexOf('작업');
			if (start < 0) throw new TypeError('CJK word missing');
			const range = document.createRange();
			range.setStart(node, start);
			range.setEnd(node, start + 2);
			return new Set([...range.getClientRects()].map((rect) => rect.top)).size;
		});
		expect(wordLines).toBe(1);
		const headingFits = await page.locator('h1').evaluate((heading) => {
			const hero = heading.closest('.task-hero');
			if (hero === null) throw new TypeError('Task hero missing');
			const range = document.createRange();
			range.selectNodeContents(heading);
			return [...range.getClientRects()].every((rect) => rect.right <= hero.getBoundingClientRect().right + 1);
		});
		expect(headingFits).toBe(true);
		await page.screenshot({ path: ".omo/evidence/product-ui-final/cjk-task-375.png", fullPage: true });
		await page.getByRole("button", { name: "Delegate" }).click();
		await page.getByLabel("Environment choice").selectOption("provision");
		await expect(page.getByLabel("Execution connector")).toBeVisible();
		await page.getByRole("dialog").locator("form").evaluate((form) => { form.scrollTop = form.scrollHeight; });
		await page.screenshot({ path: ".omo/evidence/product-ui-final/delegation-provision-375.png" });
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByLabel("Reference kind").selectOption("link");
		const referenceUrl = page.getByLabel("Reference URL");
		await expect(referenceUrl).toBeVisible();
		await expect(page.getByLabel("Reference text")).toBeHidden();
		await referenceUrl.scrollIntoViewIfNeeded();
		await referenceUrl.locator("xpath=ancestor::form").screenshot({ path: ".omo/evidence/product-ui-final/reference-link-375.png" });
	} finally {
		await app.close();
	}
});
