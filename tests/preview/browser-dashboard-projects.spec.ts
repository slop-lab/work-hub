import { expect, test } from "@playwright/test";
import { admin } from "../acceptance-fixture.ts";
import { startBrowserHub } from "../browser-fixture.ts";

test("Given identical task and question titles across projects, when Today refreshes and an answer is saved, then project and task context stay distinct without starting work", async ({ page }, testInfo) => {
  const app = await startBrowserHub(page);
  try {
    const release = app.hub.administration.projects.create(admin, { name: "Release engineering" });
    const billing = app.hub.administration.projects.create(admin, { name: "Billing platform" });
    for (const [index, project] of [release, billing].entries()) {
      const created = await app.hub.execute(admin, { commandId: `project-context-task-${index}`, type: "task.create",
        payload: { projectId: project.id, title: "Shared delivery task" } });
      const taskId = created.objectRefs.find((reference) => reference.kind === "task")?.id;
      if (taskId === undefined) throw new TypeError("Task creation must return its canonical task ID.");
      const asked = await app.hub.execute(admin, { commandId: `project-context-question-${index}`, type: "request.create",
        payload: { kind: "question", projectId: project.id, taskId,
          recipient: { kind: "user", userId: admin.id }, prompt: "Which delivery should proceed?",
          reason: index === 0 ? "Release decision pending" : "Billing decision pending",
          referenceIds: [], answerSchema: { kind: "text", minLength: 1, maxLength: 1000 },
          blocking: "none", validity: { kind: "task", taskId }, responseRoute: "none" } });
      expect(asked.status).toBe("confirmed");
    }
    await page.goto(`${app.url}/#/dashboard`);
    await page.reload();
    const releaseCard = page.getByRole("article").filter({ has: page.getByText("Release decision pending", { exact: true }) });
    const billingCard = page.getByRole("article").filter({ has: page.getByText("Billing decision pending", { exact: true }) });
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await expect(releaseCard.getByText("Project: Release engineering", { exact: true })).toBeVisible();
      await expect(billingCard.getByText("Project: Billing platform", { exact: true })).toBeVisible();
      await expect(releaseCard.getByText("Task: Shared delivery task", { exact: true })).toBeVisible();
      await expect(billingCard.getByText("Task: Shared delivery task", { exact: true })).toBeVisible();
      await page.evaluate(() => {
        const card = [...document.querySelectorAll<HTMLElement>("article.attention-item")]
          .find((entry) => [...entry.querySelectorAll("p")].some((text) => text.textContent === "Release decision pending"));
        if (card === undefined) throw new TypeError("The current release decision card must be rendered.");
        const group = card.closest("section.attention-group");
        if (group === null) throw new TypeError("The decision card must belong to its attention group.");
        group.scrollIntoView({ block: "start", behavior: "instant" });
      });
      await expect(releaseCard.getByText("Project: Release engineering", { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(billingCard.getByText("Project: Billing platform", { exact: true })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`today-project-context-${width}.png`) });
    }
    await page.reload();
    await releaseCard.getByRole("button", { name: /^Answer / }).click();
    await page.getByRole("dialog").getByLabel("Answer").fill("Proceed with the release scope.");
    await page.getByRole("button", { name: "Save answer", exact: true }).click();
    await expect(releaseCard).toHaveCount(0);
    await expect(billingCard.getByText("Project: Billing platform", { exact: true })).toBeVisible();
    expect(app.hub.getDashboard(admin).answerNeeded).toHaveLength(1);
    expect(app.hub.snapshot(admin).attempts).toHaveLength(0);
    expect(app.hub.snapshot(admin).sessions).toHaveLength(0);
  } finally { await app.close(); }
});
