import { JsonValueSchema, type JsonValue } from '../contracts/index.ts';

const privateFields = new Set(['route', 'routes', 'bridgeAccessHandle', 'locator', 'locatorJson', 'secretRefs', 'secretRefsJson', 'token', 'tokenHash', 'password', 'authorization', 'cookie']);

export function exportSafeRecords(input: unknown): JsonValue {
  const value = JsonValueSchema.parse(input);
  return sanitize(value);
}

function sanitize(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item: JsonValue) => sanitize(item));
  const result: { [key: string]: JsonValue } = {};
  for (const [key, child] of Object.entries(value)) {
    if (privateFields.has(key)) continue;
    if (key === 'receiptJson' && typeof child === 'string') {
      result['receipt'] = sanitize(JsonValueSchema.parse(JSON.parse(child)));
    } else {
      result[key] = sanitize(JsonValueSchema.parse(child));
    }
  }
  return result;
}
