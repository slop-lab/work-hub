import { defineConfig } from "@playwright/test";

const executablePath = process.env['PLAYWRIGHT_EXECUTABLE_PATH'];

export default defineConfig({
	testDir: "./tests",
	testMatch: "browser*.spec.ts",
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	outputDir: `test-results/${process.pid}`,
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
