import { expect, test } from "@playwright/test";
import { hubStateSchema, outputPageSchema } from "../../web/state-schema.ts";
import { admin, createTask, delegateNone } from "../acceptance-fixture.ts";
import { startBrowserHub } from "../browser-fixture.ts";

test("Given a real simulator session, when a control includes undocumented fields, then the closed API rejects it without transcript effects", async ({ page }) => {
  const app = await startBrowserHub(page);
  try {
    const taskId = await createTask(app.hub, "ci-closed-control", admin);
    const attempt = await delegateNone(app.hub, taskId, "ci-closed-control");
    const invalid = await page.request.post(`${app.url}/api/v1/simulator/commands`, {
      headers: { Origin: app.url }, data: { type: "output", sessionId: attempt.sessionId,
        text: "Rejected CI control output", nativeSessionId: "untrusted-provider-target" },
    });
    expect(invalid.status()).toBe(422);
    const output = outputPageSchema.parse(await (await page.request.get(`${app.url}/api/v1/sessions/${attempt.sessionId}/output`)).json());
    expect(output.items).toHaveLength(0);
    const valid = await page.request.post(`${app.url}/api/v1/simulator/commands`, {
      headers: { Origin: app.url }, data: { type: "output", sessionId: attempt.sessionId, text: "Accepted CI simulator output" },
    });
    expect(valid.status()).toBe(200);
    expect(await valid.json()).toEqual({ simulated: true, accepted: true, liveExecutionEvidence: false });
    const state = hubStateSchema.parse(await (await page.request.get(`${app.url}/api/v1/state`)).json());
    expect(state.simulator).toBe(true);
    expect(state.profiles.every((profile) => profile.simulator)).toBe(true);
    await page.goto(`${app.url}/#/session/${attempt.sessionId}`);
    await expect(page.getByText("Accepted CI simulator output", { exact: true })).toBeVisible();
    await expect(page.getByText("Rejected CI control output", { exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});

test("Given external mode, when the new lookup control is requested, then current auth and simulator-availability gates still deny it", async ({ page }) => {
  const app = await startBrowserHub(page, { mode: "external" });
  try {
    const data = { type: "delivery_lookup", sessionId: "not-a-simulator-session", available: true };
    const forbidden = await page.request.post(`${app.url}/api/v1/simulator/commands`, { headers: { Origin: app.url }, data });
    expect(forbidden.status()).toBe(403);
    const state = hubStateSchema.parse(await (await page.request.get(`${app.url}/api/v1/state`)).json());
    expect(state.simulator).toBe(false);
    await page.context().clearCookies();
    const anonymous = await page.request.post(`${app.url}/api/v1/simulator/commands`, { headers: { Origin: app.url }, data });
    expect(anonymous.status()).toBe(401);
  } finally { await app.close(); }
});
