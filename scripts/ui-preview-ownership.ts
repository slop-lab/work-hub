import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const markerSchema = z.strictObject({
  kind: z.literal("work-hub-ui-preview"),
  version: z.literal(1),
  directory: z.string(),
  repositoryRoot: z.string(),
});

export type PreviewPaths = {
  readonly directory: string;
  readonly repositoryRoot: string;
  readonly ownershipPath: string;
  readonly servicePath: string;
  readonly scenariosPath: string;
  readonly tokenPath: string;
  readonly authPath: string;
  readonly hubPath: string;
  readonly simulatorPath: string;
};

export function claimPreviewDirectory(input: {
  readonly directory: string;
  readonly repositoryRoot: string;
}): PreviewPaths {
  const repositoryRoot = realpathSync(resolve(input.repositoryRoot));
  const requested = resolve(input.directory);
  const directory = canonicalPreviewPath(requested);
  const ownershipPath = join(directory, ".work-hub-ui-preview.json");
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const details = lstatSync(directory);
  if (details.isSymbolicLink()) throw new PreviewOwnershipError("The preview directory must not be a symbolic link.");
  if (!details.isDirectory()) throw new PreviewOwnershipError("The preview path must be a directory.");
  if (details.uid !== process.getuid?.()) throw new PreviewOwnershipError("The preview directory must belong to the current user.");
  assertPrivateFiles(directory);
  if (existsSync(ownershipPath)) {
    const marker = markerSchema.parse(JSON.parse(readFileSync(ownershipPath, "utf8")));
    if (marker.directory !== directory || marker.repositoryRoot !== repositoryRoot) {
      throw new PreviewOwnershipError("The preview ownership marker does not match this canonical directory and repository.");
    }
  } else {
    if (readdirSync(directory).length !== 0) {
      throw new PreviewOwnershipError("The selected path is not an owned preview directory and is not empty.");
    }
    writeFileSync(ownershipPath, `${JSON.stringify({
      kind: "work-hub-ui-preview",
      version: 1,
      directory,
      repositoryRoot,
    } satisfies z.infer<typeof markerSchema>, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  chmodSync(directory, 0o700);
  return {
    directory,
    repositoryRoot,
    ownershipPath,
    servicePath: join(directory, ".preview-service.json"),
    scenariosPath: join(directory, "preview-scenarios.json"),
    tokenPath: join(directory, "preview-admin-token"),
    authPath: join(directory, "auth.sqlite"),
    hubPath: join(directory, "hub.sqlite"),
    simulatorPath: join(directory, "hub.sqlite.sim"),
  };
}

export function resetPreviewData(paths: PreviewPaths): string {
  assertOwned(paths);
  const archivePath = join(paths.directory, "archive", new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(join(paths.directory, "archive"), { recursive: true, mode: 0o700 });
  mkdirSync(archivePath, { mode: 0o700 });
  for (const source of ownedResetPaths(paths)) {
    if (existsSync(source)) renameSync(source, join(archivePath, basename(source)));
  }
  if (readdirSync(archivePath).length === 0) rmSync(archivePath, { recursive: true });
  return archivePath;
}

export function assertOwned(paths: PreviewPaths): void {
  canonicalPreviewPath(paths.directory);
  assertPrivateFiles(paths.directory);
  const marker = markerSchema.parse(JSON.parse(readFileSync(paths.ownershipPath, "utf8")));
  if (marker.directory !== paths.directory || marker.repositoryRoot !== paths.repositoryRoot) {
    throw new PreviewOwnershipError("Preview ownership identity changed; refusing to continue.");
  }
}

export async function withPreviewLock<T>(paths: PreviewPaths, action: () => Promise<T>): Promise<T> {
  const lock = join(paths.directory, ".preview-operation-lock");
  mkdirSync(lock, { mode: 0o700 });
  try { return await action(); }
  finally { rmSync(lock, { recursive: true }); }
}

function assertPrivateFiles(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (![".work-hub-ui-preview.json", ".preview-service.json", "preview-scenarios.json", "preview-admin-token",
      "auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm", "hub.sqlite", "hub.sqlite-wal", "hub.sqlite-shm",
      "hub.sqlite.sim", "hub.sqlite.sim-wal", "hub.sqlite.sim-shm"].includes(name)) continue;
    const details = lstatSync(join(directory, name));
    if (!details.isFile() || details.nlink !== 1 || details.uid !== process.getuid?.()) {
      throw new PreviewOwnershipError("Preview state must be a user-owned regular unlinked file.");
    }
    if ((details.mode & 0o077) !== 0) throw new PreviewOwnershipError("Preview state files must be private (mode 0600).");
  }
  const archive = join(directory, "archive");
  if (existsSync(archive) && (!lstatSync(archive).isDirectory() || lstatSync(archive).isSymbolicLink())) {
    throw new PreviewOwnershipError("The preview archive must be a real directory.");
  }
}

function canonicalPreviewPath(requested: string): string {
  if (existsSync(requested)) {
    const details = lstatSync(requested);
    if (details.isSymbolicLink()) throw new PreviewOwnershipError("The preview directory must not be a symbolic link.");
    const canonical = realpathSync(requested);
    if (canonical !== requested) throw new PreviewOwnershipError("The preview directory must use its canonical path without symbolic links.");
    return canonical;
  }
  const parent = dirname(requested);
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent) throw new PreviewOwnershipError("The preview directory parent must use its canonical path without symbolic links.");
  return join(canonicalParent, basename(requested));
}

function ownedResetPaths(paths: PreviewPaths): readonly string[] {
  return [
    paths.hubPath,
    `${paths.hubPath}-wal`,
    `${paths.hubPath}-shm`,
    paths.simulatorPath,
    `${paths.simulatorPath}-wal`,
    `${paths.simulatorPath}-shm`,
    paths.scenariosPath,
  ];
}

export class PreviewOwnershipError extends Error {
  readonly name = "PreviewOwnershipError";
}
