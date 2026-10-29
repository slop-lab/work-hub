import { Hono, type Context } from "hono";
import { z } from "zod";

import { HandoffRecipientSchema, SourceCommitSchema } from "../contracts/handoff.ts";
import { DigestSchema } from "../contracts/common.ts";
import type { Actor, Hub } from "../orchestration/hub.ts";
import type { ApiEnvironment } from "./security.ts";

const repositoryInputSchema = z.strictObject({
  canonicalIdentity: z.string().trim().min(1).max(4096),
});
const previewInputSchema = z.strictObject({
  profileId: z.string().min(1), repositoryId: z.string().min(1),
  repositoryRevision: z.number().int().positive(), sourceBranch: z.string().trim().min(1).max(1024),
  sourceCommit: SourceCommitSchema, requestedValidation: z.string().trim().min(1).max(32_768),
  contextDigest: DigestSchema, recipient: HandoffRecipientSchema,
});

export function handoffRoutes(input: {
  readonly hub: Hub;
  readonly actor: (context: Context<ApiEnvironment>) => Actor;
}) {
  const app = new Hono<ApiEnvironment>();
  app.post("/projects/:id/repositories", async (context) => context.json(
    input.hub.registerProjectRepository(input.actor(context), {
      projectId: context.req.param("id"), ...repositoryInputSchema.parse(await context.req.json<unknown>()),
    }), 201,
  ));
  app.get("/projects/:id/repositories", (context) => context.json({
    items: input.hub.listProjectRepositories(input.actor(context), context.req.param("id")),
  }));
  app.post("/tasks/:id/handoffs/preview", async (context) => context.json(
    input.hub.previewHandoff(input.actor(context), {
      taskId: context.req.param("id"), ...previewInputSchema.parse(await context.req.json<unknown>()),
    }),
  ));
  app.get("/tasks/:id/handoffs", (context) => context.json({
    items: input.hub.listHandoffs(input.actor(context), context.req.param("id")),
  }));
  app.get("/handoffs/:id", (context) => context.json(
    input.hub.getHandoff(input.actor(context), context.req.param("id")),
  ));
  return app;
}
