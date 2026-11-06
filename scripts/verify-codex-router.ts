import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ky from 'ky';
import { z } from 'zod';

import { readPrivateConfiguration } from '../application/connectors/private-config.ts';
import { ConnectorLedger } from '../application/connectors/ledger.ts';
import { CodexRuntimeConnector } from '../application/connectors/codex/runtime.ts';
import { digest } from '../application/persistence/codec.ts';
import type { ActionContext } from '../application/contracts/index.ts';

process.umask(0o077);
const action = process.argv[2];
if (action !== '--run' && action !== '--probe') {
  throw new TypeError('Use --probe for metadata only or explicit --run for one authorized model turn.');
}
const router = z.object({ endpoint: z.url(), token: z.string().min(1) }).parse(
  readPrivateConfiguration(join(homedir(), '.config/dim/llm-router.json')));
const endpoint = new URL(router.endpoint);
assert.ok(endpoint.origin === 'http://127.0.0.1:19420' && endpoint.pathname === '/services/llm-router' &&
  endpoint.username === '' && endpoint.password === '' && endpoint.search === '' && endpoint.hash === '',
  'Use only the normal scoped DIM guest router endpoint without embedded credentials.');
const capabilities = z.object({ models: z.array(z.object({ id: z.string(), api: z.string(),
  context: z.number().int().positive().optional() })) }).parse(
  await ky.get(`${router.endpoint}/v1/capabilities`, { headers: { authorization: `Bearer ${router.token}` },
    timeout: 10_000, retry: 0, redirect: 'error' }).json<unknown>());
const model = process.env['WORK_HUB_CODEX_MODEL'] ?? 'gpt-6.1-sol';
const selectedModel = capabilities.models.find((entry) => entry.id === model && entry.api === 'responses');
assert.ok(selectedModel);
const root = mkdtempSync(join(tmpdir(), 'workhub-codex-router-'));
const directory = join(root, 'work');
const codexHome = join(root, 'codex');
mkdirSync(directory, { mode: 0o700 });
mkdirSync(codexHome, { mode: 0o700 });
const executable = join(homedir(), '.local/bin/codex');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
const modelProvider = 'workhub_dim_scoped';
const catalogPath = join(codexHome, 'router-models.json');
writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: model, display_name: model,
  description: 'DIM advertised Responses model', default_reasoning_level: null,
  base_instructions: 'Follow the user task. Preserve approval and sandbox restrictions. Report limitations honestly.',
  supported_reasoning_levels: [], shell_type: 'unified_exec', visibility: 'list',
  supported_in_api: true, priority: 0, availability_nux: null, upgrade: null,
  model_messages: null, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
  truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
  input_modalities: ['text'], ...(selectedModel.context === undefined ? {} : { context_window: selectedModel.context }),
}] }), { mode: 0o600 });
writeFileSync(join(codexHome, 'config.toml'), `model = ${JSON.stringify(model)}
model_provider = ${JSON.stringify(modelProvider)}
model_catalog_json = ${JSON.stringify(catalogPath)}
sandbox_mode = "read-only"
disable_response_storage = true
[model_providers.${modelProvider}]
name = "Work Hub disposable DIM verification"
base_url = ${JSON.stringify(`${router.endpoint}/v1`)}
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
const installationId = 'verification-codex-router';
const ledger = new ConnectorLedger(join(root, 'connector.sqlite'));
const connector = new CodexRuntimeConnector(ledger, { kind: 'codex', installationId,
  label: 'Disposable real Codex router verification', executable, directory, codexHome,
  runtimePath: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', modelProvider, model,
  openaiApiKey: router.token });
const context = (operationId: string): ActionContext => ({ workspaceId: 'verification-only', installationId,
  correlationId: operationId, commandId: operationId, operationId, inputDigest: digest(operationId),
  authorizedGrantRefs: ['codex:logical'] });
try {
  const route = { kind: 'external', route: { id: 'disposable-stdio',
    ownerInstallationId: installationId, kind: 'stdio' } } as const;
  const catalog = z.object({ models: z.array(z.object({ slug: z.string() })) }).parse(JSON.parse(
    execFileSync(executable, ['debug', 'models'], { encoding: 'utf8',
      env: { HOME: codexHome, CODEX_HOME: codexHome, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } })));
  assert.ok(catalog.models.some((entry) => entry.slug === model));
  const inventory = await connector.discover(context('discover'));
  const probe = await connector.probe(context('probe'), route);
  assert.equal(probe.value.ready, true, 'Validate scoped model configuration before any turn.');
  if (action === '--probe') {
    process.stdout.write(`${JSON.stringify({ actual: true, stage: 'metadata-only', version,
      modelProvider, model, ready: probe.value.ready, unmetRequirements: probe.value.unmetRequirements,
      modelCount: inventory.models.length, sessionCount: inventory.sessions.length,
      chatgptAccountLoginVerified: false, modelCalls: 0 })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ stage: 'open', version, model, modelProvider })}\n`);
    const opened = await connector.openSession(context('open'), { hubSessionId: 'logical', mode: 'create',
      sessionLaunchOwner: 'runtime_connector', requestedControl: 'control',
      configuration: { agent: 'codex', model: { providerID: modelProvider, modelID: model }, projectId: 'verification-only' },
      route });
    assert.equal(opened.status, 'confirmed');
    if (opened.status !== 'confirmed') throw new TypeError('Actual Codex thread did not open.');
    const target = { hubSessionId: 'logical', hubAttemptId: 'attempt', bindingGeneration: 1,
      controlGrantRef: 'codex:logical', nativeSession: opened.result.nativeSession };
    const started = await connector.startAttempt(context('start'), { target, workAreas: [], input: {
      id: 'snapshot', digest: digest('disposable-router-input'), taskId: 'task', taskRevision: 1,
      profileId: 'verification', profileRevision: 1,
      instruction: 'Reply with exactly WORK_HUB_CODEX_ROUTER_OK. Do not use tools, read files, run commands, or change files.',
      selectedReferenceIds: [], selectedResponseIds: [], contextItems: [], authorizedEffectKinds: [],
      assembledAt: new Date().toISOString(),
    } });
    process.stdout.write(`${JSON.stringify({ stage: 'submitted', status: started.status })}\n`);
    assert.ok(started.status === 'confirmed' || started.status === 'unknown');
    const deadline = Date.now() + 120_000;
    let completed = false;
    while (Date.now() < deadline) {
      const observed = await connector.inspectSession(context('inspect'), target);
      if (observed.value.execution.phase === 'ended') {
        assert.equal(observed.value.execution.termination, 'completed');
        completed = true;
        break;
      }
      await delay(500);
    }
    assert.ok(completed, 'Actual Codex turn did not complete within its bounded verification window.');
    const output = await connector.readOutput(context('output'), { target, limit: 50 });
    assert.ok(output.items.some((item) => item.role === 'agent' && item.text?.trim() === 'WORK_HUB_CODEX_ROUTER_OK'));
    const events = [];
    for await (const event of connector.subscribe(context('events'), { target })) events.push(event);
    assert.ok(events.some((event) => event.payload.type === 'result.submitted'));
    process.stdout.write(`${JSON.stringify({ actual: true, version, modelProvider, model,
      nativeSessionId: target.nativeSession.id, customProviderTurn: 'passed',
      chatgptAccountLoginVerified: false, finalObserved: true, outputItems: output.items.length,
      outputDigest: digest(output.items), childCoverage: 'unknown', productionWrites: 0 })}\n`);
  }
} finally {
  await connector.close();
  ledger.close();
  rmSync(root, { recursive: true, force: true });
}
