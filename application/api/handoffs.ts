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
  contextDigest: DigestSchema.optional(),
  selectedReferenceIds: z.array(z.string().min(1)).max(100).default([]),
  selectedResponseIds: z.array(z.string().min(1)).max(100).default([]),
  recipient: HandoffRecipientSchema,
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
  app.post("/tasks/:id/handoffs/preview", async (context) => {
    const parsed = previewInputSchema.parse(await context.req.json<unknown>());
    return context.json(input.hub.previewHandoff(input.actor(context), {
      taskId: context.req.param("id"), profileId: parsed.profileId,
      repositoryId: parsed.repositoryId, repositoryRevision: parsed.repositoryRevision,
      sourceBranch: parsed.sourceBranch, sourceCommit: parsed.sourceCommit,
      requestedValidation: parsed.requestedValidation,
      selectedReferenceIds: parsed.selectedReferenceIds,
      selectedResponseIds: parsed.selectedResponseIds, recipient: parsed.recipient,
    }));
  });
  app.get("/tasks/:id/handoffs", (context) => context.json({
    items: input.hub.listHandoffs(input.actor(context), context.req.param("id"),
      z.coerce.number().int().min(1).max(100).default(50).parse(context.req.query("limit"))),
  }));
  app.get("/handoffs/:id", (context) => context.json(
    input.hub.getHandoff(input.actor(context), context.req.param("id")),
  ));
  return app;
}
