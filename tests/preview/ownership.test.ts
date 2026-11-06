import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimPreviewDirectory, resetPreviewData } from "../../scripts/ui-preview-ownership.ts";
import { previewServiceStatus, requireStopped, writeServiceIdentity } from "../../scripts/ui-preview-process.ts";

process.umask(0o077);

test("claimPreviewDirectory owns only a new empty canonical directory", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-preview-owner-"));
  const repositoryRoot = join(root, "repository");
  const directory = join(root, "preview");
  mkdirSync(repositoryRoot);

  // When
  const paths = claimPreviewDirectory({ directory, repositoryRoot });

  // Then
  assert.equal(paths.directory, directory);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const marker: unknown = JSON.parse(readFileSync(paths.ownershipPath, "utf8"));
  assert.deepEqual(marker, {
    kind: "work-hub-ui-preview",
    version: 1,
    directory,
    repositoryRoot,
  });
});

test("claimPreviewDirectory refuses symlinks and unknown preexisting contents", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-preview-refuse-"));
  const repositoryRoot = join(root, "repository");
  const target = join(root, "target");
  const linked = join(root, "linked");
  const occupied = join(root, "occupied");
  mkdirSync(repositoryRoot);
  mkdirSync(target);
  symlinkSync(target, linked);
  mkdirSync(occupied);
  chmodSync(occupied, 0o755);
  writeFileSync(join(occupied, "unknown.txt"), "do not touch");

  // When / Then
  assert.throws(() => claimPreviewDirectory({ directory: linked, repositoryRoot }), /symbolic link/i);
  assert.throws(() => claimPreviewDirectory({ directory: occupied, repositoryRoot }), /not an owned preview directory/i);
  assert.equal(statSync(occupied).mode & 0o777, 0o755);
});

test("owned preview refuses linked authentication files without changing their target", () => {
  const root = mkdtempSync(join(tmpdir(), "work-hub-preview-links-"));
  const paths = claimPreviewDirectory({ directory: join(root, "preview"), repositoryRoot: root });
  const unrelated = join(root, "unrelated-auth");
  writeFileSync(unrelated, "preserve", { mode: 0o600 });
  symlinkSync(unrelated, paths.authPath);
  assert.throws(() => claimPreviewDirectory({ directory: paths.directory, repositoryRoot: root }), /regular.*file/i);
  assert.equal(readFileSync(unrelated, "utf8"), "preserve");
});

test("resetPreviewData archives only owned Hub and simulator databases", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-preview-reset-"));
  const repositoryRoot = join(root, "repository");
  mkdirSync(repositoryRoot);
  const paths = claimPreviewDirectory({ directory: join(root, "preview"), repositoryRoot });
  writeFileSync(paths.authPath, "auth");
  writeFileSync(paths.tokenPath, "token", { mode: 0o600 });
  writeFileSync(paths.hubPath, "hub");
  writeFileSync(`${paths.hubPath}-wal`, "hub-wal");
  writeFileSync(paths.simulatorPath, "sim");

  // When
  const archivePath = resetPreviewData(paths);

  // Then
  assert.equal(readFileSync(paths.authPath, "utf8"), "auth");
  assert.equal(readFileSync(paths.tokenPath, "utf8"), "token");
  assert.equal(readFileSync(join(archivePath, "hub.sqlite"), "utf8"), "hub");
  assert.equal(readFileSync(join(archivePath, "hub.sqlite-wal"), "utf8"), "hub-wal");
  assert.equal(readFileSync(join(archivePath, "hub.sqlite.sim"), "utf8"), "sim");
});

test("requireStopped removes only a stale marker with matching ownership identity", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "work-hub-preview-stale-"));
  const repositoryRoot = join(root, "repository");
  mkdirSync(repositoryRoot);
  const paths = claimPreviewDirectory({ directory: join(root, "preview"), repositoryRoot });
  writeServiceIdentity(paths, { kind: "work-hub-ui-preview-service", version: 1, pid: 2_147_483_647,
    directory: paths.directory, repositoryRoot: paths.repositoryRoot,
    serverScript: join(repositoryRoot, "application/api/server.ts"), port: 4317,
    origin: "http://localhost:4317", startedAt: new Date().toISOString(), startTicks: "1" });
  assert.equal(previewServiceStatus(paths).state, "stale");

  // When
  requireStopped(paths);

  // Then
  assert.equal(previewServiceStatus(paths).state, "stopped");
});
