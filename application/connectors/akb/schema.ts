import { z } from 'zod';

export const akbConnectionSchema = z.strictObject({
  installationId: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  origin: z.url().refine((value) => {
    const url = new URL(value);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  }, 'AKB origin must be HTTPS or loopback HTTP with no path, credentials, query, or fragment.'),
  authorization: z.string().regex(/^Bearer [^\s]+$/),
  workspaceId: z.string().min(1).max(200),
  workHubWorkspaceId: z.string().min(1).max(200),
  allowedProjectIds: z.array(z.string().min(1).max(200)).min(1).max(500),
  allowedSpaceIds: z.array(z.string().min(1).max(200)).max(500).default([]),
  allowedPageIds: z.array(z.string().min(1).max(200)).max(500).default([]),
  allowedKnowledgeIds: z.array(z.string().min(1).max(200)).max(500).default([]),
  allowedUserIds: z.array(z.string().min(1).max(200)).min(1).max(500).optional(),
  sourcePrincipalId: z.string().min(1).max(200).optional(),
}).refine((value) => value.allowedSpaceIds.length > 0 || value.allowedPageIds.length > 0 || value.allowedKnowledgeIds.length > 0,
  'AKB connection requires at least one allowed Space, Page or Knowledge object.');

export type AkbConnection = z.infer<typeof akbConnectionSchema>;

export const akbSourceReferenceSchema = z.strictObject({
  kind: z.enum(['page', 'knowledge']),
  id: z.string().min(1).max(200).regex(/^[^/\\]+$/),
  revision: z.number().int().positive(),
});

const akbReferencesSchema = z.array(akbSourceReferenceSchema).min(1).max(25).superRefine((references, context) => {
  const keys = new Set<string>();
  for (const reference of references) {
    const key = `${reference.kind}\u0000${reference.id}\u0000${reference.revision}`;
    if (keys.has(key)) context.addIssue({ code: 'custom', message: 'AKB context references must be unique.' });
    keys.add(key);
  }
});

const akbContextBudgetSchema = z.number().int().positive().max(256 * 1024).default(64 * 1024);

export const akbContextRequestSchema = z.union([
  z.strictObject({ references: akbReferencesSchema, maxBytes: akbContextBudgetSchema }),
  z.strictObject({ selectionPage: z.strictObject({ id: z.string().min(1).max(200),
    revision: z.number().int().positive() }), maxBytes: akbContextBudgetSchema }),
]);

export const akbDocumentQuerySchema = z.strictObject({
  kind: z.enum(['page', 'knowledge']),
  query: z.string().trim().max(500).default(''),
  limit: z.number().int().min(1).max(100).default(20),
  afterId: z.string().max(200).optional(),
});

export type AkbContextRequest = z.infer<typeof akbContextRequestSchema>;
export type AkbDocumentQuery = z.infer<typeof akbDocumentQuerySchema>;

export type AkbBlock = {
  readonly id: string;
  readonly type: 'paragraph' | 'heading' | 'list' | 'list_item' | 'code' | 'quote' | 'table' | 'callout' |
    'entity_embed' | 'artifact_embed';
  readonly text: string;
  readonly children: readonly AkbBlock[];
  readonly level?: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
  readonly language?: string | undefined;
  readonly entityId?: string | undefined;
  readonly artifactId?: string | undefined;
};

export const akbBlockSchema: z.ZodType<AkbBlock> = z.lazy(() => z.strictObject({
  id: z.string().min(1).max(200),
  type: z.enum(['paragraph', 'heading', 'list', 'list_item', 'code', 'quote', 'table', 'callout',
    'entity_embed', 'artifact_embed']),
  text: z.string().max(100_000),
  children: z.array(akbBlockSchema).max(1_000).readonly(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).optional(),
  language: z.string().max(100).optional(),
  entityId: z.string().min(1).max(200).optional(),
  artifactId: z.string().min(1).max(200).optional(),
}));

export const akbPageSchema = z.strictObject({
  id: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200),
  spaceId: z.string().min(1).max(200).nullable(), parentPageId: z.string().min(1).max(200).nullable(),
  title: z.string(), revision: z.number().int().positive(),
  lifecycle: z.enum(['active', 'archived']),
  document: z.strictObject({ version: z.literal(1), blocks: z.array(akbBlockSchema).max(10_000).readonly() }),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});

export type AkbPage = z.infer<typeof akbPageSchema>;
export const akbPageResponseSchema = z.strictObject({ page: akbPageSchema, projection: z.record(z.string(), z.unknown()) });
export const akbPageListResponseSchema = z.strictObject({ pages: z.array(akbPageSchema).max(500) });

export const akbCaptureSchema = z.strictObject({
  commandId: z.string().min(1).max(200),
  installationId: z.string().min(1).max(200), pageId: z.string().min(1).max(200),
  revision: z.number().int().positive(),
});
