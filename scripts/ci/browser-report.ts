import { readFileSync } from "node:fs";
import { z } from "zod";

type BrowserSuite = {
  readonly suites?: readonly BrowserSuite[] | undefined;
  readonly specs?: readonly {
    readonly tests: readonly {
      readonly projectName: "simulator";
      readonly expectedStatus: "passed";
      readonly results: readonly { readonly status: "passed" }[];
    }[];
  }[] | undefined;
};

const suiteSchema: z.ZodType<BrowserSuite> = z.object({
  suites: z.array(z.lazy(() => suiteSchema)).optional(),
  specs: z.array(z.object({ tests: z.array(z.object({
    projectName: z.literal("simulator"), expectedStatus: z.literal("passed"),
    results: z.array(z.object({ status: z.literal("passed") })).length(1),
  })).min(1) })).optional(),
});
const reportSchema = z.object({
  stats: z.object({ expected: z.number().int().positive(), skipped: z.literal(0), unexpected: z.literal(0), flaky: z.literal(0) }),
  errors: z.array(z.never()), suites: z.array(suiteSchema).min(1),
});

export class BrowserReportError extends Error {}

function countTests(suite: BrowserSuite): number {
  return (suite.specs?.reduce((count, spec) => count + spec.tests.length, 0) ?? 0)
    + (suite.suites?.reduce((count, child) => count + countTests(child), 0) ?? 0);
}

export function verifyBrowserReport(input: unknown): number {
  const report = reportSchema.parse(input);
  const count = report.suites.reduce((total, suite) => total + countTests(suite), 0);
  if (count !== report.stats.expected) throw new BrowserReportError("Executed simulator tests do not match the reported pass count.");
  return count;
}

if (import.meta.main) {
  const path = z.string().min(1).parse(process.argv[2]);
  const passed = verifyBrowserReport(JSON.parse(readFileSync(path, "utf8")));
  console.log(JSON.stringify({ kind: "simulator-browser-ci", passed, skipped: 0, liveProviderQualification: false }));
}
