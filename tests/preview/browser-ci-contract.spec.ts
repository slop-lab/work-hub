import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { createConnection } from "node:net";
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

test("Given an unfinished connection to the owned fixture, when it closes, then teardown finishes without waiting for framework-owned page cleanup", async ({ page }) => {
  const app = await startBrowserHub(page);
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(app.url).port) });
  await once(socket, "connect");
  const accepted = new Promise<Buffer>((resolve, reject) => {
    socket.once("data", resolve);
    socket.once("error", reject);
  });
  socket.write(`POST /api/v1/login HTTP/1.1\r\nHost: fixture\r\nOrigin: ${app.url}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{`);
  expect((await accepted).toString()).toContain("HTTP/1.1 100 Continue");
  let stopped = false;
  const closing = app.close().then(() => { stopped = true; });
  try {
    await expect.poll(() => stopped, { timeout: 2_000 }).toBe(true);
    expect(page.isClosed()).toBe(false);
  } finally {
    socket.destroy();
    await page.context().close();
    await closing;
  }
});
