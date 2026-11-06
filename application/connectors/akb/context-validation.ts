import { z } from 'zod';
import { HubError } from '../../domain/errors.ts';
import { assertNever } from '../../domain/assert-never.ts';
import { akbBlockSchema, type AkbConnection, type AkbContextRequest } from './schema.ts';
import { akbContextResponseSchema, type AkbContextResponse } from './context-schema.ts';
import { akbCandidateSchema, akbKnowledgeRelationSchema, akbKnowledgeSourceSchema } from './knowledge-schema.ts';

export function assertAkbSources(connection: AkbConnection, request: AkbContextRequest): void {
  if (!('references' in request)) throw new HubError({ code: 'akb_context_requires_explicit_selection',
    category: 'unsupported', message: 'Use explicit pinned references for scoped Work Hub context capture.', retry: 'manual_action' });
  if (request.references.some((reference) => !akbSourceAllowed(connection, reference))) {
    throw new HubError({ code: 'akb_source_outside_scope', category: 'authorization',
      message: 'An AKB source is outside the configured explicit source allowlist.', retry: 'never' });
  }
}

export function akbSourceAllowed(connection: AkbConnection, reference: { readonly kind: 'page' | 'knowledge'; readonly id: string }): boolean {
  switch (reference.kind) {
    case 'page': return connection.allowedPageIds.includes(reference.id);
    case 'knowledge': return connection.allowedKnowledgeIds.includes(reference.id);
    default: return assertNever(reference.kind);
  }
}

export function validateAkbContext(raw: unknown, request: AkbContextRequest, workspaceId: string): AkbContextResponse {
  const parsed = akbContextResponseSchema.safeParse(raw);
  if (!parsed.success) throw incompatible();
  const context = parsed.data;
  const rawItems = z.object({ items: z.array(z.unknown()) }).parse(raw).items;
  const identities = context.items.map(({ kind, id, revision }) => ({ kind, id, revision }));
  if (!('references' in request) || JSON.stringify(context.references) !== JSON.stringify(request.references) ||
    JSON.stringify(identities) !== JSON.stringify(request.references) || context.selectionPage !== null ||
    context.maxBytes !== request.maxBytes || context.contentBytes !== Buffer.byteLength(JSON.stringify(rawItems)) ||
    context.contentBytes > request.maxBytes) {
    throw new HubError({ code: 'akb_context_identity_mismatch', category: 'identity_mismatch',
      message: 'AKB context identities, order or byte budget differ from the exact requested selection.', retry: 'never' });
  }
  for (const item of context.items) {
    switch (item.kind) {
      case 'page': {
        if (item.schemaVersion !== 'page.content.v1') throw incompatible();
        const page = z.object({ id: z.string().optional(), workspaceId: z.string().optional(),
          revision: z.number().int().positive().optional(), lifecycle: z.literal('active').optional(),
          title: z.string(), document: z.strictObject({ version: z.literal(1), blocks: z.array(akbBlockSchema) }),
        }).safeParse(item.snapshot);
        if (!page.success || page.data.id !== undefined && page.data.id !== item.id ||
          page.data.workspaceId !== undefined && page.data.workspaceId !== workspaceId ||
          page.data.revision !== undefined && page.data.revision !== item.revision) throw incompatible();
        break;
      }
      case 'knowledge': {
        if (item.schemaVersion !== 'knowledge-object.r7.v1') throw incompatible();
        const knowledge = z.object({ candidate: akbCandidateSchema,
          sources: z.array(akbKnowledgeSourceSchema), relations: z.array(akbKnowledgeRelationSchema),
          acceptedProposalId: z.string(), acceptedReviewId: z.string(),
        }).safeParse(item.snapshot);
        if (!knowledge.success) throw incompatible();
        break;
      }
      default: assertNever(item.kind);
    }
  }
  return context;
}

function incompatible(): HubError {
  return new HubError({ code: 'akb_incompatible_response', category: 'provider_failure',
    message: 'AKB returned an incompatible canonical context response.', retry: 'manual_action' });
}
