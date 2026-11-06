import assert from "node:assert/strict";
import test from "node:test";
import { verifyBrowserReport } from "../../scripts/ci/browser-report.ts";

function report() {
  return { stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 }, errors: [],
    suites: [{ suites: [{ specs: [{ tests: [{ projectName: "simulator", expectedStatus: "passed",
      results: [{ status: "passed" }] }] }] }] }] };
}

test("Given a native Playwright JSON report, when simulator tests all pass, then the executed count is accepted", () => {
  assert.equal(verifyBrowserReport(report()), 1);
});

test("Given skipped, flaky, failed or empty execution, when CI verifies it, then it cannot become a green simulator result", () => {
  for (const stats of [
    { expected: 1, skipped: 1, unexpected: 0, flaky: 0 },
    { expected: 1, skipped: 0, unexpected: 1, flaky: 0 },
    { expected: 1, skipped: 0, unexpected: 0, flaky: 1 },
    { expected: 0, skipped: 0, unexpected: 0, flaky: 0 },
  ]) assert.throws(() => verifyBrowserReport({ ...report(), stats }));
});

test("Given a live or expected-failure result, when CI verifies it, then it is not simulator pass evidence", () => {
  for (const execution of [
    { projectName: "live-opencode", expectedStatus: "passed", results: [{ status: "passed" }] },
    { projectName: "simulator", expectedStatus: "failed", results: [{ status: "failed" }] },
    { projectName: "simulator", expectedStatus: "passed", results: [{ status: "skipped" }] },
  ]) assert.throws(() => verifyBrowserReport({ ...report(), suites: [{ specs: [{ tests: [execution] }] }] }));
});

test("Given missing results, a count mismatch or global setup failure, when CI verifies it, then it fails closed", () => {
  assert.throws(() => verifyBrowserReport({ ...report(), suites: [] }));
  assert.throws(() => verifyBrowserReport({ ...report(), errors: [{ message: "Browser startup failed" }] }));
  assert.throws(() => verifyBrowserReport({}));
});
