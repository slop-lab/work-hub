import { resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  DATA_DIR: z.string().default('./data'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_ORIGIN: z.url().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});
export function loadConfig() {
  const value = configSchema.parse(process.env);
  if (value.HOST !== '127.0.0.1' && value.HOST !== 'localhost' && !value.PUBLIC_ORIGIN?.startsWith('https://')) {
    throw new ConfigurationError('Non-loopback binding requires an https PUBLIC_ORIGIN and TLS reverse proxy.');
  }
  return {
    dataDir: resolve(value.DATA_DIR), host: value.HOST, port: value.PORT,
    origin: value.PUBLIC_ORIGIN ?? `http://localhost:${value.PORT}`,
    secureCookies: value.PUBLIC_ORIGIN?.startsWith('https://') ?? false,
    production: value.NODE_ENV === 'production',
  };
}
export class ConfigurationError extends Error {}
