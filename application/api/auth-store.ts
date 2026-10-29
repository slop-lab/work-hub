import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const bridgeScopeSchema = z.strictObject({
  workspaceId: z.string().min(1).default('workspace-default'),
  userId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  attemptId: z.string().min(1),
  bindingGeneration: z.number().int().positive(),
  installationId: z.string().min(1).optional(),
  nativeSessionDigest: z.string().min(1).optional(),
  deliveryDigest: z.string().min(1).optional(),
  incarnation: z.string().min(1).optional(),
  targetWorkspaceId: z.string().uuid().optional(),
  hostId: z.string().min(1).optional(),
  nativeSessionId: z.string().min(1).optional(),
  recipientIntegrationKey: z.string().min(1).optional(),
  recipientIntegrationGeneration: z.number().int().positive().optional(),
  allowedCommands: z.array(z.enum(['request.create', 'request.respond', 'result.submit', 'attempt.report', 'bridge.response.ack'])).min(1),
  expiresAt: z.iso.datetime(),
});
export type BridgeScope = z.infer<typeof bridgeScopeSchema>;
export type BridgeScopeInput = Readonly<Omit<z.input<typeof bridgeScopeSchema>, 'allowedCommands'>> & { readonly allowedCommands: readonly BridgeScope['allowedCommands'][number][] };
const credentialSchema = z.object({
  user_id: z.string(),
  kind: z.enum(['user', 'browser', 'bridge']),
  expires_at: z.string().nullable(),
  scope_json: z.string().nullable(),
});
export type Identity = {
  readonly userId: string;
  readonly kind: 'user' | 'browser' | 'bridge';
  readonly scope?: BridgeScope;
};
export const recipientIntegrationSchema = z.strictObject({
  installationId: z.string().min(1), hostId: z.string().min(1),
  workHubWorkspaceId: z.string().min(1), targetWorkspaceId: z.string().uuid(),
  incarnation: z.string().min(1), authorization: z.string().min(16),
});
export type RecipientIntegration = z.infer<typeof recipientIntegrationSchema>;
export type RecipientIntegrationAuthorization = RecipientIntegration & {
  readonly recipientIntegrationKey: string;
  readonly recipientIntegrationGeneration: number;
};
export class BootstrapError extends Error {}

export class AuthStore {
  readonly db: DatabaseSync;
  private readonly recipientIntegrations = new Map<string, {
    readonly integration: RecipientIntegration;
    readonly generation: number;
  }>();
  private readonly recipientIntegrationGenerations = new Map<string, number>();
  constructor(path: string, integrations: readonly RecipientIntegration[] = []) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS credentials (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        kind TEXT NOT NULL, expires_at TEXT, scope_json TEXT
      );
      CREATE TABLE IF NOT EXISTS bootstrap (id INTEGER PRIMARY KEY CHECK(id=1));`);
    for (const integration of integrations) this.configureRecipientIntegration(integration);
  }
  bootstrap(userId: string): string {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM bootstrap').get()) {
        throw new BootstrapError('Administrator already bootstrapped; use the local credential command.');
      }
      this.db.prepare('INSERT INTO bootstrap(id) VALUES(1)').run();
      const token = this.issueUser(userId);
      this.db.exec('COMMIT');
      return token;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  issueUser(userId: string): string {
    return this.issue({ userId, kind: 'user' });
  }
  issueBridge(scope: BridgeScopeInput): string {
    const parsed = bridgeScopeSchema.parse(scope);
    return this.issue({ userId: parsed.userId, kind: 'bridge', scope: parsed }, parsed.expiresAt);
  }
  createBrowserSession(userId: string): string {
    return this.issue({ userId, kind: 'browser' }, new Date(Date.now() + 12 * 3600_000).toISOString());
  }
  configureRecipientIntegration(input: RecipientIntegration): string {
    const integration = recipientIntegrationSchema.parse(input);
    const key = this.digest(integration.authorization);
    const generation = (this.recipientIntegrationGenerations.get(key) ?? 0) + 1;
    this.recipientIntegrationGenerations.set(key, generation);
    this.recipientIntegrations.set(key, { integration, generation });
    return integration.authorization;
  }
  authenticateRecipientIntegration(authorization: string): RecipientIntegrationAuthorization | undefined {
    const key = this.digest(authorization);
    const record = this.recipientIntegrations.get(key);
    return record === undefined ? undefined : { ...record.integration,
      recipientIntegrationKey: key, recipientIntegrationGeneration: record.generation };
  }
  revokeRecipientIntegration(authorization: string): void {
    this.recipientIntegrations.delete(this.digest(authorization));
  }
  private issue(identity: Identity, expiresAt?: string): string {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?)').run(
      this.digest(token), identity.userId, identity.kind, expiresAt ?? null,
      identity.scope ? JSON.stringify(identity.scope) : null,
    );
    return token;
  }
  authenticate(token: string): Identity | undefined {
    const raw = this.db.prepare('SELECT user_id,kind,expires_at,scope_json FROM credentials WHERE token_hash=?').get(this.digest(token));
    if (!raw) return undefined;
    const row = credentialSchema.parse(raw);
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return undefined;
    const scope = row.scope_json ? bridgeScopeSchema.parse(JSON.parse(row.scope_json)) : undefined;
    if (scope?.recipientIntegrationKey !== undefined) {
      const integration = this.recipientIntegrations.get(scope.recipientIntegrationKey);
      if (integration === undefined || integration.generation !== scope.recipientIntegrationGeneration) {
        return undefined;
      }
    }
    return {
      userId: row.user_id,
      kind: row.kind,
      ...(scope === undefined ? {} : { scope }),
    };
  }
  revoke(token: string): void {
    this.db.prepare('DELETE FROM credentials WHERE token_hash=?').run(this.digest(token));
  }
  diagnostics(): unknown {
    return this.db.prepare('SELECT user_id,kind,expires_at FROM credentials').all();
  }
  close(): void { this.db.close(); }
  private digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
}
