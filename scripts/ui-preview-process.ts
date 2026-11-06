import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { setTimeout } from "node:timers/promises";

import type { PreviewPaths } from "./ui-preview-ownership.ts";

const serviceSchema = z.strictObject({
  kind: z.literal("work-hub-ui-preview-service"),
  version: z.literal(1),
  pid: z.number().int().positive(),
  directory: z.string(),
  repositoryRoot: z.string(),
  serverScript: z.string(),
  port: z.number().int().min(1).max(65535),
  origin: z.string(),
  startedAt: z.iso.datetime(),
  startTicks: z.string().regex(/^\d+$/),
});
export type PreviewService = z.infer<typeof serviceSchema>;

export type PreviewServiceStatus =
  | { readonly state: "stopped" }
  | { readonly state: "stale"; readonly service: PreviewService }
  | { readonly state: "running"; readonly service: PreviewService };

export function writeServiceIdentity(paths: PreviewPaths, service: PreviewService): void {
  const parsed = serviceSchema.parse(service);
  if (parsed.directory !== paths.directory || parsed.repositoryRoot !== paths.repositoryRoot) {
    throw new PreviewProcessError("Service identity does not match the owned preview directory.");
  }
  writeFileSync(paths.servicePath, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export function previewServiceStatus(paths: PreviewPaths): PreviewServiceStatus {
  if (!existsSync(paths.servicePath)) return { state: "stopped" };
  const service = serviceSchema.parse(JSON.parse(readFileSync(paths.servicePath, "utf8")));
  if (service.directory !== paths.directory || service.repositoryRoot !== paths.repositoryRoot) {
    throw new PreviewProcessError("Service marker ownership does not match the selected preview directory.");
  }
  return processMatches(service) ? { state: "running", service } : { state: "stale", service };
}

export function requireStopped(paths: PreviewPaths): void {
  const status = previewServiceStatus(paths);
  if (status.state === "running") {
    throw new PreviewProcessError(`Preview service ${status.service.pid} is running; stop it with Ctrl-C or the DIM process lifecycle first.`);
  }
  if (status.state === "stale") rmSync(paths.servicePath);
}

export function removeServiceIdentity(paths: PreviewPaths, pid: number): void {
  if (!existsSync(paths.servicePath)) return;
  const service = serviceSchema.parse(JSON.parse(readFileSync(paths.servicePath, "utf8")));
  if (service.pid === pid && service.directory === paths.directory && service.repositoryRoot === paths.repositoryRoot) {
    rmSync(paths.servicePath);
  }
}

function processMatches(service: PreviewService): boolean {
  const processRoot = `/proc/${service.pid}`;
  if (!existsSync(processRoot)) return false;
  try {
    if (processStartTicks(service.pid) !== service.startTicks) return false;
    const command = readFileSync(`${processRoot}/cmdline`, "utf8").split("\0");
    if (!command.includes(service.serverScript)) return false;
    const environment = readFileSync(`${processRoot}/environ`, "utf8").split("\0");
    return environment.includes(`DATA_DIR=${service.directory}`)
      && environment.includes(`PUBLIC_ORIGIN=${service.origin}`)
      && environment.includes(`PORT=${service.port}`);
  } catch (error) {
    if (error instanceof Error && "code" in error
      && ["ENOENT", "ESRCH"].includes(String(Reflect.get(error, "code")))) return false;
    throw error;
  }
}

export function processStartTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return z.string().regex(/^\d+$/).parse(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

export async function stopPreviewService(paths: PreviewPaths): Promise<void> {
  const status = previewServiceStatus(paths);
  if (status.state !== "running") { requireStopped(paths); return; }
  if (!processMatches(status.service)) throw new PreviewProcessError("Preview process identity changed before stop.");
  process.kill(status.service.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (processMatches(status.service)) {
    if (Date.now() >= deadline) throw new PreviewProcessError("Preview has not exited; refusing reset or forced termination.");
    await setTimeout(100);
  }
  removeServiceIdentity(paths, status.service.pid);
}

export class PreviewProcessError extends Error {
  readonly name = "PreviewProcessError";
}
