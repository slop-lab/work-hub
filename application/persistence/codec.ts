import { createHash, randomUUID } from "node:crypto";

import { invalid } from "../domain/errors.ts";

export type Clock = { readonly now: () => Date };

export const systemClock: Clock = { now: () => new Date() };

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw invalid("undefined_json", "Undefined is not valid canonical JSON.");
  }
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw invalid("invalid_json", "Value cannot be encoded as JSON.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}
