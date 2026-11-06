import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { z } from "zod";

const operationSchema = z.enum(["start", "status", "reset", "stop"]);
const portSchema = z.coerce.number().int().min(1).max(65535);

export type PreviewStartOptions = {
  readonly operation: "start";
  readonly directory: string;
  readonly port: number;
  readonly origin: string;
};

export type PreviewDirectoryOptions = {
  readonly operation: "status" | "reset" | "stop";
  readonly directory: string;
};

export type PreviewArguments = PreviewStartOptions | PreviewDirectoryOptions | { readonly operation: "help" };

export function parsePreviewArguments(args: readonly string[]): PreviewArguments {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      directory: { type: "string" },
      help: { type: "boolean", short: "h" },
      origin: { type: "string" },
      port: { type: "string" },
    },
  });
  if (parsed.values.help === true) return { operation: "help" };
  const operation = operationSchema.parse(parsed.positionals[0]);
   if (parsed.positionals.length !== 1) throw new PreviewOptionError("Provide exactly one operation: start, status, reset, or stop.");
  const directory = parsed.values.directory;
  if (directory === undefined) throw new PreviewOptionError("--directory is required.");
  const canonicalDirectory = resolve(directory);
  if (operation !== "start") return { operation, directory: canonicalDirectory };
  if (parsed.values.port === undefined) throw new PreviewOptionError("start requires --port.");
  if (parsed.values.origin === undefined) throw new PreviewOptionError("start requires --origin.");
  const port = portSchema.parse(parsed.values.port);
  const origin = canonicalOrigin(parsed.values.origin);
  return { operation, directory: canonicalDirectory, port, origin };
}

export function buildPreviewEnvironment(
  options: Readonly<Omit<PreviewStartOptions, "operation">>,
  _inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    DATA_DIR: options.directory,
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PORT: String(options.port),
    PUBLIC_ORIGIN: options.origin,
    WORKER_INTERVAL_MS: "250",
  };
}

function canonicalOrigin(input: string): string {
  const url = z.url().parse(input);
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewOptionError("--origin must use http or https.");
  }
  if (parsed.origin !== input || parsed.username !== "" || parsed.password !== "") {
    throw new PreviewOptionError("--origin must be a canonical origin without a path, credentials, query, or fragment.");
  }
  return parsed.origin;
}

export class PreviewOptionError extends Error {
  readonly name = "PreviewOptionError";
}
