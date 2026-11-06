import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { buildPreviewEnvironment, parsePreviewArguments, type PreviewStartOptions } from "./ui-preview-options.ts";
import { claimPreviewDirectory, resetPreviewData, withPreviewLock, type PreviewPaths } from "./ui-preview-ownership.ts";
import { PreviewProcessError, previewServiceStatus, processStartTicks, removeServiceIdentity, requireStopped, stopPreviewService, writeServiceIdentity } from "./ui-preview-process.ts";
import { seedPreview, type PreviewScenarioManifest } from "./ui-preview-seed.ts";

process.umask(0o077);
const repositoryRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

async function main(): Promise<void> {
  const options = parsePreviewArguments(process.argv.slice(2));
  if (options.operation === "help") {
    printHelp();
    return;
  }
  const paths = claimPreviewDirectory({ directory: options.directory, repositoryRoot });
  switch (options.operation) {
    case "start":
      await startPreview(paths, options);
      return;
    case "status":
      printStatus(paths);
      return;
    case "reset":
      await withPreviewLock(paths, () => resetPreview(paths));
      return;
    case "stop":
      await withPreviewLock(paths, () => stopPreviewService(paths));
      console.log("Owned preview stopped; data and credentials preserved.");
      return;
    default:
      return assertNever(options);
  }
}

async function startPreview(paths: PreviewPaths, options: PreviewStartOptions): Promise<void> {
  const running = await withPreviewLock(paths, async () => {
  requireStopped(paths);
  verifyBuiltApplication(paths.repositoryRoot);
  const manifest = await seedPreview(paths);
  const serverScript = join(paths.repositoryRoot, "application/api/server.ts");
  const child = spawn(process.execPath, [serverScript], {
    cwd: paths.repositoryRoot,
    env: buildPreviewEnvironment(options),
    stdio: "inherit",
  });
  const pid = child.pid;
  if (pid === undefined) throw new PreviewProcessError("The preview server process did not start.");
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1)));
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  try {
    writeServiceIdentity(paths, { kind: "work-hub-ui-preview-service", version: 1, pid,
      directory: paths.directory, repositoryRoot: paths.repositoryRoot, serverScript,
      port: options.port, origin: options.origin, startedAt: new Date().toISOString(), startTicks: processStartTicks(pid) });
  } catch (error) {
    child.kill("SIGTERM");
    await exited;
    throw error;
  }
  printLaunch(paths, options.origin, manifest);
  return { child, exited, pid };
  });
  const { child, exited, pid } = running;
  const forwardInterrupt = (): void => { child.kill("SIGINT"); };
  const forwardTermination = (): void => { child.kill("SIGTERM"); };
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  const exitCode = await exited;
  process.removeListener("SIGINT", forwardInterrupt);
  process.removeListener("SIGTERM", forwardTermination);
  removeServiceIdentity(paths, pid);
  process.exitCode = exitCode;
}

function printStatus(paths: PreviewPaths): void {
  const status = previewServiceStatus(paths);
  switch (status.state) {
    case "running":
      console.log(`running pid=${status.service.pid} origin=${status.service.origin}`);
      return;
    case "stale":
      console.log(`stopped stale-marker-pid=${status.service.pid}`);
      process.exitCode = 1;
      return;
    case "stopped":
      console.log("stopped");
      process.exitCode = 1;
      return;
    default:
      return assertNever(status);
  }
}

async function resetPreview(paths: PreviewPaths): Promise<void> {
  requireStopped(paths);
  const archivePath = resetPreviewData(paths);
  const manifest = await seedPreview(paths);
  console.log(`Preview data reset. Previous owned data archive: ${archivePath}`);
  printManifest(paths, manifest);
}

function verifyBuiltApplication(root: string): void {
  for (const path of ["dist/web/index.html", "dist/web/app.js", "dist/web/app.css"] as const) {
    accessSync(join(root, path), constants.R_OK);
  }
}

function printLaunch(paths: PreviewPaths, origin: string, manifest: PreviewScenarioManifest): void {
  console.log(`Work Hub UI preview starting in the foreground at ${origin}`);
  console.log("Stop with Ctrl-C or npm run preview -- stop --directory PATH (verified process identity).");
  printManifest(paths, manifest);
}

function printManifest(paths: PreviewPaths, manifest: PreviewScenarioManifest): void {
  console.log(`Private data directory: ${paths.directory}`);
  console.log(`Administrator token file: ${paths.tokenPath}`);
  for (const [name, scenario] of Object.entries(manifest.scenarios)) {
    const predecessor = scenario.predecessorAttemptId === undefined ? "" : ` predecessor=${scenario.predecessorAttemptId}`;
    console.log(`Scenario ${name}: task=${scenario.taskId} session=${scenario.sessionId} attempt=${scenario.attemptId}${predecessor}`);
  }
}

function printHelp(): void {
  console.log(`Work Hub real UI preview

npm run preview -- start  --directory PATH --port PORT --origin ORIGIN
npm run preview -- status --directory PATH
npm run preview -- reset  --directory PATH
npm run preview -- stop   --directory PATH

start runs application/api/server.ts in the foreground with the built UI, simulator-only data,
and a scrubbed child environment. The directory must be new/empty or already owned by this repo.
The administrator token is written mode 0600 and only its path is printed.
Stop with Ctrl-C or the stop command, which verifies process start identity before signaling.`);
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected preview variant ${String(value)}`);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
});
