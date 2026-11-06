import assert from "node:assert/strict";
import test from "node:test";

import { buildPreviewEnvironment, parsePreviewArguments } from "../../scripts/ui-preview-options.ts";

test("parsePreviewArguments requires an explicit directory and canonical origin", () => {
  // Given / When
  const parsed = parsePreviewArguments([
    "start",
    "--directory", "/tmp/work-hub-preview",
    "--port", "4317",
    "--origin", "http://localhost:4317",
  ]);

  // Then
  assert.deepEqual(parsed, {
    operation: "start",
    directory: "/tmp/work-hub-preview",
    port: 4317,
    origin: "http://localhost:4317",
  });
  assert.throws(() => parsePreviewArguments(["start", "--port", "4317", "--origin", "http://localhost:4317"]), /directory/i);
  assert.throws(() => parsePreviewArguments(["start", "--directory", "/tmp/demo", "--port", "4317", "--origin", "http://localhost:4317/"]), /canonical origin/i);
});

test("buildPreviewEnvironment does not inherit provider router or authentication variables", () => {
  // Given
  const inherited = {
    PATH: "/usr/bin",
    HOME: "/private/home",
    WORK_HUB_CONNECTIONS: "/private/connections.json",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    OPENCODE_SERVER_PASSWORD: "secret",
    NODE_OPTIONS: "--inspect",
  };

  // When
  const environment = buildPreviewEnvironment({
    directory: "/tmp/work-hub-preview",
    port: 4317,
    origin: "http://localhost:4317",
  }, inherited);

  // Then
  assert.deepEqual(environment, {
    DATA_DIR: "/tmp/work-hub-preview",
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PORT: "4317",
    PUBLIC_ORIGIN: "http://localhost:4317",
    WORKER_INTERVAL_MS: "250",
  });
});
