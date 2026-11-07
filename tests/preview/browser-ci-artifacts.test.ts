import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

test("failed browser child preserves exit23, exports report/PNG/context and removes temporary state", () => {
  const root = mkdtempSync(join(tmpdir(), "work-hub-browser-export-test-"));
  const source = join(root, "source"), bin = join(root, "bin"), artifacts = join(root, "artifacts");
  mkdirSync(join(source, "scripts/ci"), { recursive: true }); mkdirSync(bin);
  copyFileSync(resolve("scripts/ci/browser.bash"), join(source, "scripts/ci/browser.bash"));
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  writeFileSync(join(bin, "bash"), `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const report=process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
fs.mkdirSync(path.join(path.dirname(report),'artifacts/failure'),{recursive:true});
fs.writeFileSync(report,JSON.stringify({failure:'reviewed browser fixture'}));
fs.writeFileSync(path.join(path.dirname(report),'artifacts/failure/test-failed.png'),Buffer.from(${JSON.stringify(png)}));
fs.writeFileSync(path.join(path.dirname(report),'artifacts/failure/error-context.md'),'# Deliberate fixture failure');
console.log(JSON.stringify({home:process.env.HOME}));
process.exit(23);
`, { mode: 0o755 });
  try {
    const result = spawnSync("/bin/bash", ["scripts/ci/browser.bash"], { cwd: source, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, DIM_ARTIFACTS_DIR: artifacts,
    } });
    assert.equal(result.status, 23, result.stderr);
    const observed: unknown = JSON.parse(result.stdout);
    assert.ok(observed && typeof observed === "object" && "home" in observed && typeof observed.home === "string");
    assert.equal(existsSync(dirname(observed.home)), false);
    assert.deepEqual(readFileSync(join(artifacts, "browser/artifacts/failure/test-failed.png")), Buffer.from(png));
    assert.match(readFileSync(join(artifacts, "browser/artifacts/failure/error-context.md"), "utf8"), /Deliberate fixture failure/);
    assert.equal(readFileSync(join(artifacts, "browser/results.json"), "utf8"), readFileSync(join(source, "test-results/browser-ci/results.json"), "utf8"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
