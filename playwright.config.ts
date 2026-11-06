import { defineConfig } from "@playwright/test";

const executablePath = process.env['PLAYWRIGHT_EXECUTABLE_PATH'];

export default defineConfig({
	testDir: "./tests",
	testMatch: "browser*.spec.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: process.env['CI'] === 'true',
	failOnFlakyTests: process.env['CI'] === 'true',
	retries: 0,
	timeout: 30_000,
	outputDir: process.env['CI'] === 'true' ? 'test-results/browser-ci/artifacts' : `test-results/${process.pid}`,
	projects: [
		{ name: 'simulator', testIgnore: '**/browser-live-*.spec.ts' },
		{ name: 'live-opencode', testMatch: '**/browser-live-opencode.spec.ts' },
	],
	use: {
		browserName: "chromium",
		headless: true,
		screenshot: "only-on-failure",
		trace: "off",
		launchOptions: {
			...(executablePath ? { executablePath } : {}),
			args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
		},
	},
});
