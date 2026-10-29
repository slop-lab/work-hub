import { Hono } from "hono";
import { z } from "zod";

import type { Hub } from "../orchestration/hub.ts";
import type { AuthStore } from "./auth-store.ts";

const exchangeInputSchema = z.strictObject({
  nativeSessionId: z.string().min(1),
});

export function recipientExchangeRoutes(input: { readonly hub: Hub; readonly auth: AuthStore }) {
  const app = new Hono();
  app.post("/recipient/exchange", async (context) => {
    const authorization = context.req.header("Authorization");
    const credential = authorization?.startsWith("Integration ") ? authorization.slice("Integration ".length) : undefined;
    const integration = credential === undefined
      ? undefined : input.auth.authenticateRecipientIntegration(credential);
    if (integration === undefined) {
      return context.json({ error: { code: "integration_credential_required",
        message: "A configured recipient integration credential is required." } }, 403);
    }
    const request = exchangeInputSchema.parse(await context.req.json<unknown>());
    const assignment = input.hub.recipientAssignment({
      workHubWorkspaceId: integration.workHubWorkspaceId,
      targetWorkspaceId: integration.targetWorkspaceId,
      installationId: integration.installationId, hostId: integration.hostId,
      incarnation: integration.incarnation, nativeSessionId: request.nativeSessionId,
    });
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const token = input.auth.issueBridge({
      workspaceId: assignment.workHubWorkspaceId, userId: `recipient:${integration.hostId}`,
      projectId: assignment.projectId, taskId: assignment.taskId, sessionId: assignment.sessionId,
      attemptId: assignment.attemptId, bindingGeneration: assignment.bindingGeneration,
      installationId: assignment.installationId, nativeSessionDigest: assignment.nativeSessionDigest,
      deliveryDigest: assignment.deliveryDigest, incarnation: assignment.incarnation,
      targetWorkspaceId: assignment.targetWorkspaceId, hostId: assignment.hostId,
      nativeSessionId: request.nativeSessionId,
      allowedCommands: ["request.create", "request.respond", "result.submit", "attempt.report", "bridge.response.ack"],
      expiresAt,
    });
    return context.json({ token, expiresAt, assignment });
  });
  return app;
}
