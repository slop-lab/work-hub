import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIntegrationInventory } from "../web/integrations.ts";
import { referenceSchema } from "../web/state-schema.ts";

test("browser integration inventory preserves each provider kind", () => {
	const inventory = parseIntegrationInventory({
		runtime: [
			{
				installationId: "runtime-codex",
				kind: "codex",
				label: "Codex workspace",
				status: "available",
				value: {
					version: "1.0.0",
					directory: "/workspace/main",
					agents: ["review"],
					environment: null,
					models: [{ providerID: "openai", modelID: "gpt-5" }],
					sessions: [],
					capabilities: [],
					limitations: ["Existing sessions are listed only when verified."],
				},
			},
		],
		execution: [],
	});

	assert.equal(inventory.runtime[0]?.kind, "codex");
	assert.deepEqual(inventory.runtime[0]?.status === "available" ? inventory.runtime[0].value.limitations : [], ["Existing sessions are listed only when verified."]);
});

test("captured AKB references preserve immutable source provenance", () => {
	const reference = referenceSchema.parse({
		id: "ref-akb",
		taskId: "task-1",
		kind: "text",
		title: "Release process",
		mimeType: "text/plain",
		availability: "available",
		contentRevision: "42",
		createdAt: "2026-10-27T10:00:00.000Z",
		provenance: { provider: "akb", installationId: "akb-docs", workspaceId: "workspace-1", pageId: "page-release", revision: 42, sourceUpdatedAt: "2026-10-27T09:00:00.000Z", retainedByHub: true },
	});

	assert.equal(reference.provenance?.pageId, "page-release");
	assert.equal(String(reference.provenance?.revision), reference.contentRevision);
});
