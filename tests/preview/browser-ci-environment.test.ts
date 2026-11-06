import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

const observationSchema = z.object({ keys: z.array(z.string()), home: z.string(), ci: z.literal("true") });

function invoke(exitCode: number) {
  const directory = mkdtempSync(join(tmpdir(), "work-hub-ci-env-test-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bash"), `#!${process.execPath}\nconsole.log(JSON.stringify({keys:Object.keys(process.env),home:process.env.HOME,ci:process.env.CI}));process.exit(${exitCode});\n`, { mode: 0o755 });
  try {
    return spawnSync("/bin/bash", ["scripts/ci/browser.bash"], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      WORK_HUB_CONNECTIONS: "/nonexistent/private-connections.json", OPENAI_API_KEY: "synthetic-ci-secret",
      WORK_HUB_LIVE_AGENT: "must-not-run", WORK_HUB_LIVE_MODEL: "must-not-run",
      PLAYWRIGHT_EXECUTABLE_PATH: "/nonexistent/inherited-browser", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      NODE_OPTIONS: "--import=/nonexistent/ci-sentinel.mjs", NPM_CONFIG_USERCONFIG: "/nonexistent/private-npmrc",
    } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("Given inherited provider and setup overrides, when browser CI starts its child, then only the clean environment reaches it", () => {
  const result = invoke(0);
  assert.equal(result.status, 0, result.stderr);
  const observed = observationSchema.parse(JSON.parse(result.stdout));
  for (const key of ["WORK_HUB_CONNECTIONS", "OPENAI_API_KEY", "WORK_HUB_LIVE_AGENT", "WORK_HUB_LIVE_MODEL",
    "PLAYWRIGHT_EXECUTABLE_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "NODE_OPTIONS", "NPM_CONFIG_USERCONFIG"]) {
    assert.equal(observed.keys.includes(key), false);
  }
  assert.notEqual(observed.home, process.env["HOME"]);
  assert.equal(observed.keys.includes("PLAYWRIGHT_BROWSERS_PATH"), true);
});

test("Given failed browser setup or execution, when the child exits nonzero, then the CI entrypoint propagates failure", () => {
  const result = invoke(37);
  assert.equal(result.status, 37, result.stderr);
});
