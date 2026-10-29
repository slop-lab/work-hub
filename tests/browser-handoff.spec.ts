import { expect, test, type Locator } from "@playwright/test";
import { admin, createTask, delegateNone, drainIdle, finishAttempt } from "./acceptance-fixture.ts";
import { startBrowserHub } from "./browser-fixture.ts";

async function capture(locator: Locator, path: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try { await locator.screenshot({ path }); return; }
		catch (error) {
			if (!(error instanceof Error) || !error.message.includes("not attached") || attempt === 2) throw error;
		}
	}
}

test("Given a verification retry, when task detail opens, then each retained handoff has its explicit attempt URL", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser-handoff-sessions", admin);
		const repository = app.hub.registerProjectRepository(admin, { projectId: "project-default", canonicalIdentity: "https://example.invalid/work-hub.git" });
		const preview = app.hub.previewHandoff(admin, {
			taskId,
			profileId: "profile-structured",
			repositoryId: repository.id,
			repositoryRevision: repository.revision,
			sourceBranch: "main",
			sourceCommit: "a".repeat(40),
			requestedValidation: "Run the native verification suite",
			contextDigest: `sha256:${"b".repeat(64)}`,
			recipient: { kind: "new" },
		});
		const delegated = await app.hub.execute(admin, {
			commandId: "browser-handoff-first",
			type: "attempt.delegate",
			target: { kind: "task", id: taskId },
			expected: { task: app.hub.getTask(admin, taskId).revision, profile: 1 },
			payload: { profileId: "profile-structured", environment: { mode: "none" }, selectedReferenceIds: [], selectedResponseIds: [], authorizedEffectKinds: [], handoff: { previewDigest: preview.previewDigest, verification: preview.verification, recipient: preview.recipient } },
		});
		await drainIdle(app.hub);
		const first = app.hub.snapshot(admin).attempts.find((item) => item.id === delegated.objectRefs[0]?.id);
		if (first === undefined) throw new TypeError("Delegation did not create an attempt");
		await finishAttempt(app.hub, first);
		const retry = await app.hub.execute(admin, {
			commandId: "browser-handoff-retry",
			type: "attempt.retry",
			target: { kind: "attempt", id: first.id },
			expected: { task: app.hub.getTask(admin, taskId).revision, profile: 1 },
			payload: { predecessorId: first.id, input: "current_task", sameSession: false },
		});
		await drainIdle(app.hub);
		const secondId = retry.objectRefs[0]?.id;
		if (secondId === undefined) throw new TypeError("Retry did not create an attempt");

		await page.goto(`${app.url}/#/backlog/${taskId}`);
		const sessions = page.getByRole("region", { name: "Execution attempts" });
		await expect(sessions.getByText(first.id, { exact: true })).toBeVisible();
		await expect(sessions.getByText(secondId, { exact: true })).toBeVisible();
		await expect(sessions.locator(`a[href="#/backlog/${taskId}/handoff/${first.id}"]`)).toBeVisible();
		await expect(sessions.locator(`a[href="#/backlog/${taskId}/handoff/${secondId}"]`)).toBeVisible();
	} finally {
		await app.close();
	}
});

test("Given exact source and recipient input, when preview becomes stale, then the canonical preview is shown and first send is rejected", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser-handoff-stale-preview", admin);
		await page.goto(`${app.url}/#/backlog/${taskId}`);
		await page.getByRole("button", { name: "Prepare verification handoff" }).click();
		const dialog = page.getByRole("dialog", { name: "Prepare verification handoff" });
		await dialog.getByLabel("Repository identity").fill("https://example.invalid/release.git");
		await dialog.getByLabel("Source branch").fill("release/1.0");
		await dialog.getByLabel("Full source commit").fill("not-a-full-commit");
		await dialog.getByLabel("Requested validation").fill("Run native Linux verification");
		await dialog.getByLabel("Context digest").fill(`sha256:${"d".repeat(64)}`);
		await dialog.getByRole("button", { name: "Preview exact handoff" }).click();
		expect(await dialog.getByLabel("Full source commit").evaluate((input) => input instanceof HTMLInputElement && input.checkValidity())).toBe(false);
		await expect(dialog.getByRole("region", { name: "Exact canonical prompt" })).toBeHidden();
		await dialog.getByLabel("Full source commit").fill("c".repeat(40));
		const previewResponse = page.waitForResponse((response) => response.url().includes(`/tasks/${taskId}/handoffs/preview`) && response.request().method() === "POST");
		await dialog.getByRole("button", { name: "Preview exact handoff" }).click();
		const preview = await (await previewResponse).json() as { readonly prompt: string; readonly promptDigest: string; readonly previewDigest: string };
		const prompt = dialog.getByRole("region", { name: "Exact canonical prompt" });
		await expect(prompt.locator("pre")).toHaveText(preview.prompt);
		await expect(prompt.getByText(preview.promptDigest, { exact: true })).toBeVisible();
		await expect(prompt.getByText(preview.previewDigest, { exact: true })).toBeVisible();
		await expect(prompt).toContainText("pending_session_creation");
		await expect(prompt).toContainText("assigned_after_creation");
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			const form = dialog.locator("form");
			await form.evaluate((element) => { element.scrollTop = 0; });
			await dialog.screenshot({ path: `.omo/evidence/handoff/preview-top-${width}.png` });
			await form.evaluate((element) => { element.scrollTop = element.scrollHeight; });
			await dialog.screenshot({ path: `.omo/evidence/handoff/preview-bottom-${width}.png` });
			await dialog.getByRole("button", { name: "Preview exact handoff" }).focus();
			await page.keyboard.press("Tab");
			await dialog.screenshot({ path: `.omo/evidence/handoff/preview-focus-${width}.png` });
		}

		await app.hub.execute(admin, { commandId: "browser-handoff-stale-task", type: "task.update", target: { kind: "task", id: taskId }, expected: { task: app.hub.getTask(admin, taskId).revision }, payload: { description: "Changed after preview" } });
		await dialog.getByRole("button", { name: "Send verification handoff" }).click();
		await expect(dialog.getByRole("alert")).toContainText(/stale|changed/i);
		expect(app.hub.listHandoffs(admin, taskId)).toHaveLength(0);
	} finally {
		await app.close();
	}
});

test("Given a fresh preview, when handoff result and follow-up are reviewed, then reload retains provenance and human completion stays explicit", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser-handoff-lifecycle", admin);
		await page.goto(`${app.url}/#/backlog/${taskId}`);
		await page.getByRole("button", { name: "Prepare verification handoff" }).click();
		const dialog = page.getByRole("dialog", { name: "Prepare verification handoff" });
		await dialog.getByLabel("Repository identity").fill("https://example.invalid/lifecycle.git");
		await dialog.getByLabel("Source branch").fill("main");
		await dialog.getByLabel("Full source commit").fill("e".repeat(40));
		await dialog.getByLabel("Requested validation").fill("Run native release verification");
		await dialog.getByLabel("Context digest").fill(`sha256:${"f".repeat(64)}`);
		await dialog.getByRole("button", { name: "Preview exact handoff" }).click();
		await expect(dialog.getByRole("region", { name: "Exact canonical prompt" })).toBeVisible();
		await dialog.getByRole("button", { name: "Send verification handoff" }).click();
		await expect(page).toHaveURL(new RegExp(`#/backlog/${taskId}/handoff/attempt-`));
		const attemptId = page.url().split("/").at(-1);
		if (attemptId === undefined) throw new TypeError("Handoff URL did not contain an attempt");
		await expect.poll(() => app.hub.getHandoff(admin, attemptId).delivery["status"]).toBe("delivered");
		const initialDetail = app.hub.getHandoff(admin, attemptId);
		const deliveryDigest = initialDetail.delivery["deliveryDigest"];
		if (typeof deliveryDigest !== "string") throw new TypeError("Handoff delivery digest missing");
		const session = app.hub.getSession(admin, initialDetail.attempt.sessionId).session;
		app.hub.acknowledgeAttemptDelivery({ id: "runtime-browser", workspaceId: admin.workspaceId, role: "runtime", projectIds: [session.projectId], profileIds: [], bindingIds: [], sessionId: session.id, attemptId, bindingGeneration: session.bindingGeneration, allowedCommandTypes: [] }, { attemptId, deliveryDigest });
		await page.reload();
		await expect(page.getByRole("region", { name: "Exact source" }).getByText("e".repeat(40), { exact: true })).toBeVisible();
		await expect(page.getByRole("region", { name: "Delivery status" })).toContainText("acknowledged");
		await expect(page.getByRole("region", { name: "Recipient identity" })).toContainText("assigned_after_creation");

		const detail = app.hub.getHandoff(admin, attemptId);
		const inputDigest = detail.attempt.inputSnapshot["digest"];
		if (typeof inputDigest !== "string") throw new TypeError("Handoff input digest missing");
		await app.hub.execute(admin, { commandId: "browser-handoff-result", type: "result.submit", target: { kind: "attempt", id: attemptId }, payload: { submissionKey: "browser-native", outcome: "partial", inputDigest, actualCommit: initialDetail.preview.verification.sourceCommit, actualContextDigest: initialDetail.preview.verification.contextDigest, summary: "Native verification needs one follow-up", limitations: ["One platform remains blocked"], referenceIds: [],
			artifacts: [{ repositoryId: initialDetail.preview.repository.id, sourceCommit: initialDetail.preview.verification.sourceCommit,
				path: "docs/native-validation-report.md", digest: `sha256:${"a".repeat(64)}` }],
			evidence: [{ origin: "external_check", detail: "Native suite report retained" }] } });
		await page.reload();
		const result = page.locator(".result-card");
		await expect(result).toContainText("Native verification needs one follow-up");
		await expect(result).toContainText("partial");
		await expect(result).toContainText("e".repeat(40));
		await expect(result).toContainText(initialDetail.preview.verification.contextDigest);
		await expect(result).toContainText("docs/native-validation-report.md");
		const handoffUrl = page.url();
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(handoffUrl);
			await expect(page.getByRole("region", { name: "Exact source" })).toBeVisible();
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await capture(page.locator(".task-hero"), `.omo/evidence/handoff/lifecycle-hero-${width}.png`);
			await capture(page.getByRole("region", { name: "Exact source" }), `.omo/evidence/handoff/lifecycle-source-${width}.png`);
			await capture(page.getByRole("region", { name: "Recipient identity" }), `.omo/evidence/handoff/lifecycle-recipient-${width}.png`);
			await capture(page.getByRole("region", { name: "Delivery status" }), `.omo/evidence/handoff/lifecycle-delivery-${width}.png`);
			await page.setViewportSize({ width, height: 1800 });
			await capture(result.locator(".section-heading"), `.omo/evidence/handoff/result-heading-${width}.png`);
			await capture(result.getByLabel("Result provenance"), `.omo/evidence/handoff/result-provenance-${width}.png`);
			await capture(result.getByLabel("Result limitations"), `.omo/evidence/handoff/result-limitations-${width}.png`);
			await capture(result.getByRole("group", { name: "Result actions" }), `.omo/evidence/handoff/result-actions-${width}.png`);
		}

		await result.getByRole("button", { name: "Request revision" }).click();
		const revision = page.getByRole("dialog", { name: "Request revision" });
		await revision.getByLabel("Revision instruction").fill("Resolve the blocked platform and report the same source");
		await revision.getByLabel("Instruction timing").selectOption("immediate");
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await revision.screenshot({ path: `.omo/evidence/handoff/followup-${width}.png` });
		}
		await revision.getByRole("button", { name: "Send revision" }).click();
		await expect(revision).toBeHidden();

		const lifecycleDecision = page.getByRole("region", { name: "Reliable lifecycle" });
		await lifecycleDecision.getByLabel("Acceptance decision").selectOption("accepted");
		await lifecycleDecision.getByLabel("Active execution decision").selectOption("allow_to_continue");
		await lifecycleDecision.getByLabel("Decision note").fill("Human accepted the partial verification with recorded limitation");
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await capture(lifecycleDecision, `.omo/evidence/handoff/human-acceptance-${width}.png`);
		}
		await lifecycleDecision.getByRole("button", { name: "Record acceptance decision" }).click();
		await expect(lifecycleDecision).toContainText("No lifecycle action is pending.");
		await expect(page.getByRole("button", { name: "Reopen to backlog" })).toBeVisible();
		expect(app.hub.getTask(admin, taskId).status).toBe("done");
	} finally {
		await app.close();
	}
});

test("Given an ended permitted control session, when it is selected as recipient, then the handoff attaches to that exact session", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser-handoff-attach", admin);
		const predecessor = await delegateNone(app.hub, taskId, "browser-handoff-attach");
		await finishAttempt(app.hub, predecessor);
		await page.goto(`${app.url}/#/backlog/${taskId}`);
		await page.getByRole("button", { name: "Prepare verification handoff" }).click();
		const dialog = page.getByRole("dialog", { name: "Prepare verification handoff" });
		await dialog.getByLabel("Repository identity").fill("https://example.invalid/attached.git");
		await dialog.getByLabel("Source branch").fill("main");
		await dialog.getByLabel("Full source commit").fill("1".repeat(40));
		await dialog.getByLabel("Requested validation").fill("Verify in the retained native session");
		await dialog.getByLabel("Context digest").fill(`sha256:${"2".repeat(64)}`);
		await dialog.getByLabel("Recipient session").selectOption(predecessor.sessionId);
		await dialog.getByRole("button", { name: "Preview exact handoff" }).click();
		await expect(dialog.getByRole("region", { name: "Exact canonical prompt" }).getByText(predecessor.sessionId, { exact: true })).toBeVisible();
		await dialog.getByRole("button", { name: "Send verification handoff" }).click();
		await expect(page).toHaveURL(new RegExp(`#/backlog/${taskId}/handoff/attempt-`));
		const attemptId = page.url().split("/").at(-1);
		if (attemptId === undefined) throw new TypeError("Attached handoff URL did not contain an attempt");
		const attached = app.hub.getHandoff(admin, attemptId);
		expect(attached.attempt.sessionId).toBe(predecessor.sessionId);
		expect(attached.preview.recipient.kind).toBe("attached");
	} finally {
		await app.close();
	}
});
