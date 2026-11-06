import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Page } from "@playwright/test";
import { createApplication } from "../application/api/app.ts";
import { AuthStore } from "../application/api/auth-store.ts";
import { Hub } from "../application/orchestration/hub.ts";

export type BrowserHub = {
	readonly url: string;
	readonly token: string;
	readonly hub: Hub;
	readonly close: () => Promise<void>;
};

export async function startBrowserHub(page: Page, options: { readonly mode?: "simulator" | "external" } = {}): Promise<BrowserHub> {
	const directory = mkdtempSync(join(tmpdir(), "work-hub-browser-"));
	const hub = new Hub(join(directory, "hub.sqlite"), options);
	const auth = new AuthStore(join(directory, "auth.sqlite"));
	const token = auth.bootstrap("user-admin");
	const port = await reservePort();
	const url = `http://127.0.0.1:${port}`;
	const app = createApplication({ hub, auth, origin: url, secureCookies: false });
	const webRoot = fileURLToPath(new URL("../dist/web/", import.meta.url));
	app.get("/app.js", serveStatic({ root: webRoot }));
	app.get("/app.css", serveStatic({ root: webRoot }));
	app.get("/", serveStatic({ path: join(webRoot, "index.html") }));
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const timer = setInterval(() => {
		void hub.reconcile().then(() => hub.drain());
	}, 100);
	await page.goto(url);
	await page.getByLabel("Bootstrap token").fill(token);
	await page.getByRole("button", { name: "Sign in" }).click();
	return {
		url,
		token,
		hub,
		close: async () => {
			clearInterval(timer);
			await new Promise<void>((resolve) => server.close(() => resolve()));
			hub.close();
			auth.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

async function reservePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return address.port;
}
