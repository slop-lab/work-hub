import { expect, test } from "@playwright/test";
import { startBrowserHub } from "./browser-fixture.ts";

test("runtime provider, profile, and model remain explicit choices with a wire discovery fixture", async ({ page }) => {
	const app = await startBrowserHub(page);
	let profileBody: unknown;
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	try {
		await page.route("**/api/v1/integrations", async (route) => route.fulfill({ json: {
			runtime: [{ installationId: "runtime-codex", kind: "codex", label: "Local Codex", status: "available", value: {
				version: "1.0.0", directory: "/workspace/main", agents: ["codex"], environment: null,
				models: [{ providerID: "openai", modelID: "gpt-5" }], sessions: [], limitations: [],
			} }], execution: [],
		} }));
		await page.route("**/api/v1/commands", async (route) => {
			const body = route.request().postDataJSON();
			if (body.type === "profile.create") profileBody = body;
			await route.fulfill({ json: { commandId: body.commandId, actorId: "user-admin", status: "confirmed", objectRefs: [], operationIds: [] } });
		});
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Discover connections", exact: true }).click();
		await expect(page.getByText("Codex CLI", { exact: true })).toBeVisible();
		const profile = page.getByLabel(/^Runtime profile/);
		const model = page.getByLabel(/^Connected model/);
		const project = page.getByLabel(/^Work Hub project/);
		await expect(profile).toHaveValue("");
		await expect(model).toHaveValue("");
		await expect(project).toHaveValue("");
		await profile.selectOption("codex");
		await model.selectOption("0");
		await project.selectOption({ index: 1 });
		const save = page.getByRole("button", { name: "Save execution profile", exact: true });
		await expect(save).toBeEnabled();
		for (const width of [375, 768, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await page.screenshot({ path: `.omo/evidence/product-ui-final/runtime-choice-${width}.png`, fullPage: true });
			await page.locator("article").filter({ has: page.getByRole("heading", { name: "Local Codex", exact: true }) }).screenshot({ path: `.omo/evidence/product-ui-final/runtime-choice-panel-${width}.png` });
		}
		await save.click();
		await expect.poll(() => profileBody).toBeTruthy();
		expect(profileBody).toMatchObject({ payload: { configuration: { agent: "codex", model: { providerID: "openai", modelID: "gpt-5" }, projectId: expect.any(String) } } });
		expect(pageErrors).toEqual([]);
	} finally { await app.close(); }
});

test("Claude Code uses an explicit manual model and saves an attach-only provider configuration", async ({ page }) => {
	let profileBody: unknown;
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/v1/integrations", async (route) => route.fulfill({ json: {
		runtime: [{ installationId: "runtime-claude", kind: "claude-code", label: "Local Claude", status: "available", value: {
			version: "1.0.0", directory: "/workspace/main", agents: ["claude-code"], environment: null,
			models: [], sessions: [], limitations: ["Creating new native sessions is unavailable; attach a verified existing session."],
		} }], execution: [],
	} }));
	await page.route("**/api/v1/commands", async (route) => {
		const body = route.request().postDataJSON();
		if (body.type === "profile.create") profileBody = body;
		await route.fulfill({ json: { commandId: body.commandId, actorId: "user-admin", status: "confirmed", objectRefs: [], operationIds: [] } });
	});
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Discover connections", exact: true }).click();
		await page.getByLabel(/^Runtime profile/).selectOption("claude-code");
		await page.getByLabel(/^Model ID/).fill("claude-sonnet-4-5");
		await page.getByLabel(/^Work Hub project/).selectOption({ index: 1 });
		await page.getByRole("button", { name: "Save execution profile", exact: true }).click();
		await expect.poll(() => profileBody).toBeTruthy();
		expect(profileBody).toMatchObject({ payload: {
			configuration: { model: "claude-sonnet-4-5" },
			requiredCapabilities: ["attachSession", "structuredInput"],
		} });
		expect(pageErrors).toEqual([]);
	} finally { await app.close(); }
});

test("AKB capture pins the selected revision, reports provenance, and preserves conflict errors with wire fixtures", async ({ page }) => {
	const app = await startBrowserHub(page);
	let captureCount = 0;
	let capturedBody: unknown;
	const scopedProjectIds: string[] = [];
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	try {
		const recordScope = (url: string): void => { scopedProjectIds.push(new URL(url).searchParams.get("projectId") ?? ""); };
		await page.route(/\/api\/v1\/external-context\/akb\?/, async (route) => { recordScope(route.request().url()); await route.fulfill({ json: { connections: [{ installationId: "akb-docs", label: "Engineering knowledge" }] } }); });
		await page.route(/\/api\/v1\/external-context\/akb\/akb-docs\/pages\?/, async (route) => { recordScope(route.request().url()); await route.fulfill({ json: { pages: [{ id: "page-release", title: "Release process", revision: 42, parentPageId: null }] } }); });
		await page.route(/\/api\/v1\/external-context\/akb\/akb-docs\/pages\/page-release\?/, async (route) => { recordScope(route.request().url()); await route.fulfill({ json: { page: { id: "page-release", title: "Release process", revision: 42, parentPageId: null, document: { blocks: [{ text: "Verify the release checklist before deployment." }] } } } }); });
		await page.route(/\/api\/v1\/tasks\/[^/]+\/external-context\/akb$/, async (route) => {
			captureCount += 1;
			capturedBody = route.request().postDataJSON();
			if (captureCount === 1) {
				await route.fulfill({ status: 409, json: { error: { code: "akb_revision_changed", message: "Selected revision is no longer current." } } });
				return;
			}
			await route.fulfill({ json: { reference: { kind: "reference", id: "ref-akb", revision: 1 } } });
		});
		await page.getByRole("link", { name: "Backlog", exact: true }).click();
		await page.getByLabel("New task title").fill("Capture AKB context");
		await page.getByRole("button", { name: "Add task", exact: true }).click();
		await page.getByRole("button", { name: "Open Capture AKB context", exact: true }).click();
		await expect(page.getByText("Task captured.", { exact: true })).toBeVisible();
		await expect(page.getByText("Task captured.", { exact: true })).toBeHidden({ timeout: 6_000 });
		await page.waitForResponse((response) => response.url().includes("/api/v1/context"));
		await page.getByRole("button", { name: "Discover AKB sources", exact: true }).click();
		const akbSource = page.locator('select[name="akbSource"]');
		await expect(akbSource.locator("option")).toHaveCount(2);
		await akbSource.selectOption("akb-docs");
		await page.locator('select[name="akbPage"]').selectOption("page-release");
		await expect(page.getByText("Source ID page-release · selected revision 42", { exact: true })).toBeVisible();
		await expect(page.getByText("Verify the release checklist before deployment.", { exact: true })).toBeVisible();
		for (const width of [375, 768, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await page.screenshot({ path: `.omo/evidence/product-ui-final/akb-context-${width}.png`, fullPage: true });
			await page.locator("section.akb-capture").screenshot({ path: `.omo/evidence/product-ui-final/akb-context-panel-${width}.png` });
		}
		const capture = page.getByRole("button", { name: "Capture selected revision", exact: true });
		await capture.click();
		await expect(page.getByText("Selected revision is no longer current.", { exact: true })).toBeVisible();
		await capture.click();
		await expect(page.getByText("Captured Release process at revision 42.", { exact: true })).toBeVisible();
		expect(capturedBody).toMatchObject({ commandId: expect.stringMatching(/^cmd-web-/), installationId: "akb-docs", pageId: "page-release", revision: 42 });
		expect(scopedProjectIds).toHaveLength(3);
		expect(scopedProjectIds.every((projectId) => projectId.length > 0)).toBe(true);
		expect(pageErrors).toEqual([]);
	} finally { await app.close(); }
});

test("existing native attachment requires an explicit runtime profile and discovered provider reference", async ({ page }) => {
	let attachedBody: unknown;
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/v1/integrations", async (route) => route.fulfill({ json: {
		runtime: [{ installationId: "runtime-claude", kind: "claude-code", label: "Local Claude", status: "available", value: {
			version: "1.0.0", directory: "/workspace/main", agents: ["review"], environment: null, models: [], limitations: [],
			sessions: [{ id: "session-verified", label: "Review session", nativeSession: { installationId: "runtime-claude", providerScope: "workspace", kind: "claude-session", id: "native-123" } }],
		} }], execution: [],
	} }));
	await page.route("**/api/v1/commands", async (route) => {
		const body = route.request().postDataJSON();
		if (body.type !== "session.attach") { await route.continue(); return; }
		attachedBody = body;
		await route.fulfill({ json: { commandId: body.commandId, actorId: "user-admin", status: "confirmed", confirmedEffect: "attached", objectRefs: [], operationIds: [] } });
	});
	const app = await startBrowserHub(page);
	try {
		await page.getByRole("link", { name: "Backlog", exact: true }).click();
		await page.getByLabel("New task title").fill("Attach provider session");
		await page.getByRole("button", { name: "Add task", exact: true }).click();
		await expect(page.getByText("Task captured.", { exact: true })).toBeVisible();
		await expect(page.getByText("Task captured.", { exact: true })).toBeHidden({ timeout: 6_000 });
		const currentState = await page.evaluate(async () => {
			const response = await fetch("/api/v1/context?route=session");
			return response.json();
		});
		await page.route("**/api/v1/context*", async (route) => {
			await route.fulfill({ json: {
				...currentState,
				installations: [...currentState.installations, { id: "runtime-claude", label: "Local Claude", revision: 1, kind: "agent_runtime", contractMajor: 1, enabled: true, available: true, simulator: false, reason: "available" }],
				profiles: [...currentState.profiles, { id: "profile-claude", revision: 1, label: "Claude review", allowedEnvironmentModes: ["none"], defaultEnvironmentMode: "none", enabled: true, limitations: [], simulator: false, runtimeInstallationId: "runtime-claude", configuration: {}, defaultEnvironment: { mode: "none" }, requiredCapabilities: [], allowedEffects: [] }],
			} });
		});
		await page.getByRole("link", { name: "Session", exact: true }).click();
		const profile = page.getByLabel(/^Runtime profile/);
		await expect(profile).toHaveValue("");
		await profile.selectOption("profile-claude");
		await expect(page.getByLabel(/^Native session ID/)).toBeHidden();
		const nativeSession = page.locator('select[name="discoveredSession"]');
		await expect(nativeSession).toBeVisible();
		await nativeSession.selectOption("session-verified");
		await page.locator('select[name="task"]').selectOption({ label: "Attach provider session" });
		for (const width of [375, 768, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await page.getByRole("button", { name: "Attach without starting work", exact: true }).scrollIntoViewIfNeeded();
			await page.screenshot({ path: `.omo/evidence/product-ui-final/native-attach-${width}.png`, fullPage: true });
			const panel = page.getByRole("heading", { name: "Attach existing agent session", exact: true }).locator("..");
			await panel.scrollIntoViewIfNeeded();
			const bounds = await panel.boundingBox();
			if (bounds === null) throw new TypeError("The native attachment panel must remain visible.");
			const x = Math.max(0, bounds.x);
			const y = Math.max(0, bounds.y);
			await page.screenshot({ path: `.omo/evidence/product-ui-final/native-attach-panel-${width}.png`, clip: {
				x, y, width: Math.min(bounds.x + bounds.width, width) - x,
				height: Math.min(bounds.y + bounds.height, 900) - y,
			} });
		}
		await page.getByRole("button", { name: "Attach without starting work", exact: true }).click();
		expect(attachedBody).toMatchObject({ payload: { profileId: "profile-claude", nativeSession: { installationId: "runtime-claude", kind: "claude-session", id: "native-123" } } });
		expect(pageErrors).toEqual([]);
	} finally { await app.close(); }
});
