import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { AuthStore, bridgeScopeSchema, BootstrapError } from './auth-store.ts';
import { loadConfig } from './config.ts';

process.umask(0o077);
const [operation = 'bootstrap', ...args] = process.argv.slice(2);
if (operation === '--help' || operation === 'help') {
  console.log(`Work Hub local credential administration

npm run bootstrap                    Establish initial administrator, once
npm run bootstrap -- credential ID   Issue credential for an existing user ID
npm run bootstrap -- bridge JSON     Issue an expiring task/session-scoped token

DATA_DIR selects the private data directory. Tokens are displayed once.
Credential issuance is a local administrator operation, never an HTTP setup API.`);
} else {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  const auth = new AuthStore(join(config.dataDir, 'auth.sqlite'));
  try {
    switch (operation) {
      case 'bootstrap':
        console.log(`Administrator token (save it now):\n${auth.bootstrap('user-admin')}`);
        break;
      case 'credential': {
        const [userId] = args;
        if (!userId) throw new BootstrapError('credential requires an existing user ID.');
        console.log(`User token (save it now):\n${auth.issueUser(userId)}`);
        break;
      }
      case 'bridge': {
        const [json] = args;
        if (!json) throw new BootstrapError('bridge requires a JSON scope.');
        console.log(`Runtime bridge token (save it now):\n${auth.issueBridge(bridgeScopeSchema.parse(JSON.parse(json)))}`);
        break;
      }
      default:
        throw new BootstrapError(`Unknown operation: ${operation}. Use --help.`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    auth.close();
  }
}
