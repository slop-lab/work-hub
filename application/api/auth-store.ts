import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const bridgeScopeSchema = z.strictObject({
  userId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  attemptId: z.string().min(1),
  bindingGeneration: z.number().int().positive(),
  allowedCommands: z.array(z.enum(['request.create', 'result.submit', 'attempt.report'])).min(1),
  expiresAt: z.iso.datetime(),
});
export type BridgeScope = z.infer<typeof bridgeScopeSchema>;
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
export class BootstrapError extends Error {}

export class AuthStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS credentials (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        kind TEXT NOT NULL, expires_at TEXT, scope_json TEXT
      );
      CREATE TABLE IF NOT EXISTS bootstrap (id INTEGER PRIMARY KEY CHECK(id=1));`);
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
  issueBridge(scope: BridgeScope): string {
    const parsed = bridgeScopeSchema.parse(scope);
    return this.issue({ userId: parsed.userId, kind: 'bridge', scope: parsed }, parsed.expiresAt);
  }
  createBrowserSession(userId: string): string {
    return this.issue({ userId, kind: 'browser' }, new Date(Date.now() + 12 * 3600_000).toISOString());
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
    return {
      userId: row.user_id,
      kind: row.kind,
      ...(row.scope_json ? { scope: bridgeScopeSchema.parse(JSON.parse(row.scope_json)) } : {}),
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
