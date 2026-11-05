import { expect, test, type Locator } from "@playwright/test";
import { admin, createTask, delegateNone, drainIdle, finishAttempt } from "../acceptance-fixture.ts";
import { startBrowserHub } from "../browser-fixture.ts";

async function capture(locator: Locator, path: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try { await expect(locator).toBeVisible(); await locator.screenshot({ path }); return; }
		catch (error) {
			if (!(error instanceof Error) || (!error.message.includes("not attached") && !error.message.includes("not visible") && !error.message.includes("not an HTMLElement")) || attempt === 2) throw error;
		}
	}
}

test("Given amended criteria and checkpoint then final results, when the owner reviews them, then only the current evidenced final result can be accepted", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser lifecycle acceptance", admin);
		await page.goto(`${app.url}/#/backlog/${taskId}`);
		const lifecycle = page.getByRole("region", { name: "Reliable lifecycle" });
		await expect(lifecycle).toBeVisible();

		await lifecycle.locator("summary", { hasText: "Amend criteria" }).click();
		await lifecycle.getByLabel("Amendment summary").fill("Require focused browser evidence.");
		await lifecycle.getByLabel("Criterion key").fill("browser-evidence");
		await lifecycle.getByLabel("Criterion description").fill("릴리스 경계를 검증하는 집중 브라우저 수명주기가 통과한다.");
		await lifecycle.getByLabel("Requirement").selectOption("required");
		await lifecycle.getByLabel("Verification").selectOption("required");
		await page.reload();
		await lifecycle.locator("summary", { hasText: "Amend criteria" }).click();
		await expect(lifecycle.getByLabel("Amendment summary")).toHaveValue("Require focused browser evidence.");
		await lifecycle.getByRole("button", { name: "Add criteria amendment" }).click();
		await expect(lifecycle.getByText("릴리스 경계를 검증하는 집중 브라우저 수명주기가 통과한다.", { exact: true })).toBeVisible();

		const attempt = await delegateNone(app.hub, taskId, "browser-lifecycle-acceptance");
		const checkpoint = await app.hub.execute(admin, {
			commandId: "browser-lifecycle-checkpoint",
			type: "result.submit",
			target: { kind: "attempt", id: attempt.id },
			payload: { kind: "checkpoint", summary: "Implementation checkpoint", limitations: ["Browser evidence is pending."], referenceIds: [], evidence: [], criterionEvidence: [] },
		});
		expect(checkpoint.status).toBe("confirmed");
		await page.reload();
		await expect(lifecycle.getByText("checkpoint", { exact: true })).toBeVisible();
		await expect(lifecycle.getByRole("button", { name: "Record acceptance decision" })).toBeDisabled();

		const criterionId = app.hub.getTaskLifecycle(admin, taskId).criteria[0]?.id;
		if (criterionId === undefined) throw new TypeError("Lifecycle criterion missing");
		const incomplete = await app.hub.execute(admin, {
			commandId: "browser-lifecycle-final-incomplete",
			type: "result.submit",
			target: { kind: "attempt", id: attempt.id },
			payload: { kind: "final", summary: "Final claim without browser evidence", limitations: ["Focused journey not run."], referenceIds: [], evidence: [], criterionEvidence: [] },
		});
		expect(incomplete.status).toBe("confirmed");
		await finishAttempt(app.hub, attempt);
		await page.reload();
		await expect(lifecycle.getByRole("region", { name: "Criteria history" }).getByText("browser-evidence", { exact: true })).toBeVisible();
		await expect(lifecycle.getByLabel("Acceptance decision")).toHaveValue("incomplete");
		await lifecycle.getByLabel("Decision note").fill("Run the focused browser journey.");
		await lifecycle.getByRole("button", { name: "Record acceptance decision" }).click();
		await expect(lifecycle).toContainText("revise result");
		await expect(lifecycle).toContainText("result author");

		const corrected = await app.hub.execute(admin, {
			commandId: "browser-lifecycle-verification-reference",
			type: "reference.create",
			target: { kind: "task", id: taskId },
			payload: { kind: "text", title: "Focused browser evidence", content: "Playwright lifecycle journey passed." },
		});
		const verificationReferenceId = corrected.objectRefs[0]?.id;
		if (verificationReferenceId === undefined) throw new TypeError("Verification reference missing");
		const correctedResult = await app.hub.execute(admin, {
			commandId: "browser-lifecycle-final-corrected",
			type: "result.submit",
			target: { kind: "attempt", id: attempt.id },
			payload: { kind: "final", summary: "Focused browser journey passed", limitations: [], referenceIds: [verificationReferenceId], evidence: [{ origin: "external_check", detail: "Playwright lifecycle journey passed." }], criterionEvidence: [{ criterionId, status: "satisfied", detail: "Focused browser journey passed.", referenceIds: [verificationReferenceId] }] },
		});
		expect(correctedResult.status).toBe("confirmed");
		await page.reload();
		await expect(lifecycle).toContainText("1 of 1 required criteria satisfied");
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await expect(lifecycle).toContainText("1 of 1 required criteria satisfied");
			await page.locator("#main-content").evaluate((element) => { element.scrollTo({ top: 0, behavior: "instant" }); });
			await page.screenshot({ path: `.omo/evidence/lifecycle/task-shell-top-${width}.png` });
			const taskBottom = await page.locator("#main-content").evaluate((element) => { element.scrollTo({ top: element.scrollHeight, behavior: "instant" }); return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }; });
			expect(taskBottom.scrollTop).toBeGreaterThan(0);
			await page.screenshot({ path: `.omo/evidence/lifecycle/task-shell-bottom-${width}.png` });
			if (width === 375) {
				await page.locator(".app-sidebar").evaluate((element) => { element.scrollTo({ left: element.scrollWidth, behavior: "instant" }); });
				await page.screenshot({ path: ".omo/evidence/lifecycle/task-route-reel-end-375.png" });
			}
			await capture(lifecycle, `.omo/evidence/lifecycle/task-acceptance-${width}.png`);
			await capture(lifecycle.getByRole("heading", { name: "Current result decision" }).locator("xpath=.."), `.omo/evidence/lifecycle/task-acceptance-form-${width}.png`);
			await capture(lifecycle.getByRole("region", { name: "Criteria history" }).locator(".lifecycle-row").first(), `.omo/evidence/lifecycle/task-cjk-criterion-${width}.png`);
		}
		await lifecycle.getByLabel("Acceptance decision").selectOption("accepted");
		await lifecycle.getByRole("button", { name: "Record acceptance decision" }).click();
		await expect(lifecycle).toContainText("No lifecycle action is pending.");
		expect(app.hub.getTask(admin, taskId).status).toBe("done");
		await lifecycle.locator("summary", { hasText: "Amend criteria" }).click();
		await lifecycle.getByLabel("Amendment summary").fill("This draft must clear on logout.");
		await page.getByRole("button", { name: "Log out" }).click();
		await page.getByLabel("Bootstrap token").fill(app.token);
		await page.getByRole("button", { name: "Sign in" }).click();
		await page.goto(`${app.url}/#/backlog/${taskId}`);
		await expect(page.getByRole("region", { name: "Reliable lifecycle" }).getByLabel("Amendment summary")).toHaveValue("");
	} finally {
		await app.close();
	}
});

test("Given a blocker and an interrupted handoff attempt, when it is rechecked and retried, then recovery stays explicit and bounded on task and handoff URLs", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser lifecycle recovery", admin);
		const repository = app.hub.registerProjectRepository(admin, { projectId: "project-default", canonicalIdentity: "https://example.invalid/lifecycle.git" });
		const preview = app.hub.previewHandoff(admin, { taskId, profileId: "profile-structured", repositoryId: repository.id, repositoryRevision: repository.revision, sourceBranch: "main", sourceCommit: "a".repeat(40), requestedValidation: "Run lifecycle recovery checks", contextDigest: `sha256:${"b".repeat(64)}`, recipient: { kind: "new" } });
		const delegated = await app.hub.execute(admin, { commandId: "browser-lifecycle-handoff",
			type: "attempt.delegate", target: { kind: "task", id: taskId },
			expected: { task: app.hub.getTask(admin, taskId).revision, profile: 1 }, payload: {
				profileId: "profile-structured", environment: { mode: "none" }, selectedReferenceIds: [],
				selectedResponseIds: [], authorizedEffectKinds: [], handoff: { previewDigest: preview.previewDigest,
					verification: preview.verification, recipient: preview.recipient },
			} });
		await drainIdle(app.hub);
		const attemptId = delegated.objectRefs.find((item) => item.kind === "attempt")?.id;
		if (attemptId === undefined) throw new TypeError("Handoff attempt missing");

		await page.goto(`${app.url}/#/backlog/${taskId}`);
		const lifecycle = page.getByRole("region", { name: "Reliable lifecycle" });
		await lifecycle.locator("summary", { hasText: "Open blocker" }).click();
		await lifecycle.getByLabel("Blocker kind").selectOption("external_dependency");
		await lifecycle.getByLabel("Responsible owner").fill("release engineering");
		await lifecycle.getByLabel("Requested remedy").fill("Publish the signed fixture.");
		await lifecycle.getByLabel("Blocker detail").fill("The fixture is unavailable.");
		await lifecycle.getByLabel("Related attempt").selectOption(attemptId);
		await lifecycle.getByRole("button", { name: "Open blocker" }).click();
		await expect(lifecycle).toContainText("Publish the signed fixture.");
		await lifecycle.locator("summary", { hasText: "Record interruption details" }).click();
		await lifecycle.getByLabel("Interruption kind").selectOption("unknown");
		await lifecycle.getByLabel("Observation action").selectOption("reconcile");
		await lifecycle.getByLabel("Reconciliation note").fill("Provider reported a transient failure.");
		await lifecycle.getByRole("button", { name: "Record interruption" }).click();
		const predecessor = app.hub.snapshot(admin).attempts.find((candidate) => candidate.id === attemptId);
		if (predecessor === undefined) throw new TypeError("Recovery predecessor missing");
		await finishAttempt(app.hub, predecessor, "failed");
		await page.reload();
		await lifecycle.getByLabel("Recovery action").selectOption("retry");
		await lifecycle.getByLabel("Recovery reason").fill("Retry after fixture publication.");
		await lifecycle.getByLabel("Retry limit").fill("1");
		await lifecycle.getByRole("button", { name: "Controlled recovery" }).click();
		await expect(lifecycle).toContainText("Retry 1 of 1");
		const retryAttemptId = app.hub.getTask(admin, taskId).primaryAttemptId;
		if (retryAttemptId === undefined || retryAttemptId === attemptId) throw new TypeError("Linked retry attempt missing");
		await app.hub.execute(admin, { commandId: "browser-lifecycle-retry-interruption", type: "attempt.reconcile",
			target: { kind: "attempt", id: retryAttemptId }, payload: { interruption: "retryable_failure", recovery: "reconcile", note: "The linked retry also ended transiently." } });
		const retryAttempt = app.hub.snapshot(admin).attempts.find((candidate) => candidate.id === retryAttemptId);
		if (retryAttempt === undefined) throw new TypeError("Retry attempt missing");
		await finishAttempt(app.hub, retryAttempt, "failed");
		await page.reload();
		const exhaustedForm = lifecycle.locator(`[data-form-key="lifecycle-recovery:${taskId}:${retryAttemptId}"]`);
		await expect(exhaustedForm.getByRole("option", { name: "Bounded retry" })).toHaveCount(0);
		await expect(exhaustedForm).toContainText("Retry budget exhausted at 1 of 1. Resume or escalate instead.");
		await expect(lifecycle).toContainText("Retry 1 of 1");

		const blocker = app.hub.getTaskLifecycle(admin, taskId).blockers[0];
		if (blocker === undefined) throw new TypeError("Blocker missing");
		await lifecycle.getByLabel(`Resolution for ${blocker.id}`).fill("Fixture published.");
		await lifecycle.getByRole("button", { name: `Resolve ${blocker.id}` }).click();
		await expect(lifecycle).toContainText("Resolution: Fixture published.");
		await lifecycle.getByLabel(`Recheck note for ${blocker.id}`).fill("Recheck scheduled against the retained source.");
		await lifecycle.getByRole("button", { name: `Recheck ${blocker.id}` }).click();
		await expect(lifecycle).toContainText("rechecking");

		await page.goto(`${app.url}/#/backlog/${taskId}/handoff/${retryAttemptId}`);
		const handoffLifecycle = page.getByRole("region", { name: "Reliable lifecycle" });
		await expect(handoffLifecycle).toContainText(/retryable failure|crash/);
		await expect(handoffLifecycle).toContainText("Retry 1 of 1");
		await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6_000 });
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await expect(handoffLifecycle).toContainText("Retry 1 of 1");
			await page.locator("#main-content").evaluate((element) => { element.scrollTo({ top: 0, behavior: "instant" }); });
			await page.screenshot({ path: `.omo/evidence/lifecycle/handoff-shell-top-${width}.png` });
			const handoffBottom = await page.locator("#main-content").evaluate((element) => { element.scrollTo({ top: element.scrollHeight, behavior: "instant" }); return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }; });
			if (handoffBottom.scrollHeight > handoffBottom.clientHeight) expect(handoffBottom.scrollTop).toBeGreaterThan(0);
			else expect(handoffBottom.scrollTop).toBe(0);
			await page.screenshot({ path: `.omo/evidence/lifecycle/handoff-shell-bottom-${width}.png` });
			await capture(handoffLifecycle, `.omo/evidence/lifecycle/handoff-recovery-${width}.png`);
			await capture(handoffLifecycle.getByRole("region", { name: "Attempt recovery" }), `.omo/evidence/lifecycle/handoff-recovery-form-${width}.png`);
			await capture(page.locator('[data-lifecycle-section="blockers"]'), `.omo/evidence/lifecycle/handoff-blockers-${width}.png`);
		}
	} finally {
		await app.close();
	}
});

test("Given linked blocking and nonblocking questions, when task and session pages reload, then waiting and resume visibility remains without duplicate answer controls", async ({ page }) => {
	const app = await startBrowserHub(page);
	try {
		const taskId = await createTask(app.hub, "browser lifecycle questions", admin);
		const attempt = await delegateNone(app.hub, taskId, "browser-lifecycle-questions");
		const session = app.hub.getSession(admin, attempt.sessionId).session;
		app.hub.simulator?.controls.emitQuestion({ hubSessionId: session.id, hubAttemptId: attempt.id, requestId: "browser-blocking-question", projectId: "project-default", taskId, recipient: { kind: "user", userId: admin.id }, bindingGeneration: session.bindingGeneration, prompt: "May the verification continue?", responseRoute: "native", blocking: "runtime_action" });
		await app.hub.reconcile();
		await app.hub.execute(admin, { commandId: "browser-nonblocking-question", type: "request.create",
			target: { kind: "task", id: taskId }, expected: { task: app.hub.getTask(admin, taskId).revision },
			payload: { kind: "question", projectId: "project-default", taskId, sessionId: session.id,
				attemptId: attempt.id, bindingGeneration: session.bindingGeneration,
				recipient: { kind: "agent_session", sessionId: session.id }, prompt: "What remains uncertain?",
				reason: "Independent work may continue.", referenceIds: [],
				answerSchema: { kind: "text", minLength: 1, maxLength: 200 }, blocking: "none",
				validity: { kind: "task", taskId }, responseRoute: "none",
			} });

		await page.goto(`${app.url}/#/backlog/${taskId}`);
		await expect(page.getByRole("region", { name: "Linked requests" })).toContainText("Blocking runtime action");
		await expect(page.getByRole("region", { name: "Linked requests" })).toContainText("Nonblocking");
		await expect(page.getByRole("region", { name: "Linked requests" })).toContainText("Answer in Today to resume the exact attempt.");
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await page.getByRole("region", { name: "Linked requests" }).screenshot({ path: `.omo/evidence/lifecycle/task-questions-${width}.png` });
		}
		await page.reload();
		await expect(page.getByRole("region", { name: "Linked requests" })).toContainText("May the verification continue?");

		await page.goto(`${app.url}/#/session/${session.id}`);
		const linked = page.getByRole("region", { name: "Linked requests" });
		await expect(linked).toContainText("May the verification continue?");
		await expect(linked.getByRole("button", { name: /Answer/i })).toHaveCount(0);
		await expect(linked).toContainText("Open inbox to answer");
		await page.goto(`${app.url}/#/dashboard`);
		await page.getByRole("button", { name: /Answer may the verification continue/i }).click();
		await page.getByRole("dialog").getByLabel("Answer").fill("Continue with the retained attempt.");
		await page.getByRole("button", { name: "Save answer" }).click();
		await expect(page.getByRole("dialog")).toBeHidden();
		await page.goto(`${app.url}/#/session/${session.id}`);
		await expect(page.getByRole("region", { name: "Linked requests" })).toContainText("exact attempt");
		await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6_000 });
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
			await capture(page.locator('[data-lifecycle-section="linked-requests"]'), `.omo/evidence/lifecycle/session-questions-${width}.png`);
		}
	} finally {
		await app.close();
	}
});
