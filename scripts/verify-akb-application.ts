import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import ky from 'ky';
import { z } from 'zod';

import { readPrivateConfiguration } from '../application/connectors/private-config.ts';
import { akbConnectionSchema, akbContextRequestSchema } from '../application/connectors/akb/schema.ts';
import { akbContextResponseSchema, akbDocumentsResponseSchema, akbKnowledgeRevisionSchema } from '../application/connectors/akb/context-schema.ts';
import { digest } from '../application/persistence/codec.ts';
import { createIsolatedAkbApplication } from './akb-verification-app.ts';

const ownerSource = '4f6b9704c776877c594408e49f944ff169ccf238';
const ownerDirectory = '/home/dim/tasks/verification-results-20261106/akb-owner-response';
const akbOrigin = 'https://akb--akb-verify.mj-y.com';
const referencesSchema = z.object({ references: z.array(z.object({ kind: z.literal('reference'),
  id: z.string(), revision: z.literal(1) })) });

export async function verifyAkbApplication(): Promise<void> {
  process.umask(0o077);
  const capability = z.object({ workspaceId: z.string(), principalId: z.string(), token: z.string().min(1),
    expiresAt: z.iso.datetime(), permissions: z.array(z.string()) }).parse(readPrivateConfiguration(
    '/home/dim/.config/work-hub/verification-results-20261106/akb-connector-capability.json'));
  assert.ok(Date.parse(capability.expiresAt) > Date.now(), 'Scoped owner refresh is required after expiry.');
  assert.deepEqual([...capability.permissions].sort(), ['content.read', 'knowledge.propose', 'knowledge.read']);
  const request = akbContextRequestSchema.parse(JSON.parse(readFileSync(join(ownerDirectory, 'akb-context-request.json'), 'utf8')));
  assert.ok('references' in request);
  const selected = request.references;
  const contractPages = z.object({ sourceHead: z.literal(ownerSource), workspaceId: z.string(),
    origin: z.literal(akbOrigin), records: z.array(z.object({ pageId: z.string() })) }).parse(JSON.parse(readFileSync(
    join(ownerDirectory, 'akb-scoped-contract-pages.json'), 'utf8')));
  assert.equal(contractPages.workspaceId, capability.workspaceId);
  const ownerContext = akbContextResponseSchema.parse(JSON.parse(readFileSync(join(ownerDirectory, 'akb-context-success.json'), 'utf8')));
  assert.ok(isDeepStrictEqual(ownerContext.references, selected));
  const page = selected.find((reference) => reference.kind === 'page');
  const knowledge = selected.find((reference) => reference.kind === 'knowledge');
  assert.ok(page && knowledge);
  const contract = readFileSync(join(ownerDirectory, 'akb-owner-handoff-response.md'));
  const installationId = `akb-paired-${randomUUID()}`;
  const app = await createIsolatedAkbApplication((actor, projectId) => akbConnectionSchema.parse({
    installationId, label: 'Actual disposable AKB application pairing', origin: akbOrigin,
    authorization: `Bearer ${capability.token}`, workspaceId: capability.workspaceId,
    sourcePrincipalId: capability.principalId, workHubWorkspaceId: actor.workspaceId,
    allowedProjectIds: [projectId], allowedUserIds: [actor.id],
    allowedPageIds: [...new Set([...selected.filter((reference) => reference.kind === 'page').map((reference) => reference.id),
      ...contractPages.records.map((record) => record.pageId)])],
    allowedSpaceIds: [],
    allowedKnowledgeIds: selected.filter((reference) => reference.kind === 'knowledge').map((reference) => reference.id),
  }));
  const cases: { name: string; status: number; code?: string }[] = [];
  const record = (name: string, status: number, code?: string) => {
    cases.push({ name, status, ...(code === undefined ? {} : { code }) });
    process.stdout.write(`${JSON.stringify({ stage: name, status, ...(code === undefined ? {} : { code }) })}\n`);
  };
  const errorCode = async (response: Response) => z.object({ error: z.object({ code: z.string() }) })
    .parse(await response.json()).error.code;
  const scope = `/external-context/akb/${installationId}`;
  const capturePath = `/tasks/${app.taskId}/external-context/akb/context`;
  const capture = { commandId: `capture-${randomUUID()}`, installationId, contextRequest: request };
  const pinnedReferences: { id: string; revision: number }[] = [];
  try {
    const me = await app.api({ path: '/me' });
    assert.equal(me.status, 200);
    assert.equal(z.object({ id: z.string() }).parse(await me.json()).id, app.administratorId);
    const metadata = await app.api({ path: '/integrations' });
    assert.equal(metadata.status, 200);
    assert.ok(!(await metadata.text()).includes(capability.token), 'Backend credential must not enter public integration metadata.');
    record('public-integration-metadata-without-credential', metadata.status);
    const documents = await app.api({ path: `${scope}/documents?projectId=${app.projectId}&kind=page&limit=1` });
    assert.equal(documents.status, 200);
    const first = akbDocumentsResponseSchema.parse(await documents.json());
    record('mapped-documents', documents.status);
    if (first.nextAfterId !== null) {
      const next = await app.api({ path: `${scope}/documents?projectId=${app.projectId}&kind=page&limit=1&afterId=${encodeURIComponent(first.nextAfterId)}` });
      assert.equal(next.status, 200);
      akbDocumentsResponseSchema.parse(await next.json());
      record('live-pagination', next.status);
    }
    const knowledgeDocuments = await app.api({ path: `${scope}/documents?projectId=${app.projectId}&kind=knowledge&limit=20` });
    assert.equal(knowledgeDocuments.status, 200);
    assert.ok(akbDocumentsResponseSchema.parse(await knowledgeDocuments.json()).items.some((item) => item.id === knowledge.id));
    record('knowledge-discovery', knowledgeDocuments.status);
    const exactPage = await app.api({ path: `${scope}/pages/${encodeURIComponent(page.id)}/revisions/${page.revision}?projectId=${app.projectId}` });
    assert.equal(exactPage.status, 200);
    assert.equal(z.object({ page: z.object({ revision: z.number() }) }).parse(await exactPage.json()).page.revision, page.revision);
    record('exact-page-revision', exactPage.status);
    const exactKnowledge = await app.api({ path: `${scope}/knowledge/${encodeURIComponent(knowledge.id)}/revisions/${knowledge.revision}?projectId=${app.projectId}` });
    assert.equal(exactKnowledge.status, 200);
    const acceptedKnowledge = akbKnowledgeRevisionSchema.parse(await exactKnowledge.json());
    const ownerKnowledge = akbKnowledgeRevisionSchema.parse(JSON.parse(readFileSync(
      join(ownerDirectory, 'akb-knowledge-exact-revision.json'), 'utf8')));
    assert.ok(isDeepStrictEqual(acceptedKnowledge, ownerKnowledge), 'Exact Knowledge differs from the immutable owner observation.');
    assert.equal(acceptedKnowledge.revision, knowledge.revision);
    assert.ok(acceptedKnowledge.acceptedProposalId && acceptedKnowledge.acceptedReviewId);
    record('exact-knowledge-result', exactKnowledge.status);
    const memberMe = await app.api({ path: '/me', principal: 'member' });
    assert.equal(memberMe.status, 200);
    assert.equal(z.object({ id: z.string() }).parse(await memberMe.json()).id, app.memberId);
    record('unmapped-principal-authenticated-locally', memberMe.status);
    const denied = await app.api({ path: `${scope}/documents?projectId=${app.projectId}&kind=page`, principal: 'member' });
    assert.equal(denied.status, 403);
    assert.equal(await errorCode(denied), 'akb_connection_unavailable');
    record('workhub-principal-mapping-denied', denied.status);
    const projectDenied = await app.api({ path: `${scope}/documents?projectId=project-default&kind=page` });
    assert.equal(projectDenied.status, 403);
    record('workhub-project-mapping-denied', projectDenied.status, await errorCode(projectDenied));
    const installationDenied = await app.api({ path: `/external-context/akb/not-installed/documents?projectId=${app.projectId}&kind=page` });
    assert.equal(installationDenied.status, 403);
    record('workhub-installation-mapping-denied', installationDenied.status, await errorCode(installationDenied));
    await app.restart({ workHubWorkspaceId: 'not-the-authenticated-application-workspace' });
    const workspaceDenied = await app.api({ path: `${scope}/documents?projectId=${app.projectId}&kind=page` });
    assert.equal(workspaceDenied.status, 403);
    record('workhub-workspace-mapping-denied', workspaceDenied.status, await errorCode(workspaceDenied));
    await app.restart();
    const sourceDenied = await app.api({ path: capturePath, body: { ...capture, commandId: randomUUID(),
      contextRequest: { references: [{ kind: 'page', id: 'not-in-source-allowlist', revision: 1 }], maxBytes: 65536 } } });
    assert.equal(sourceDenied.status, 403);
    assert.equal(await errorCode(sourceDenied), 'akb_source_outside_scope');
    record('source-allowlist-denied', sourceDenied.status);
    const unavailable = await app.api({ path: capturePath, body: { ...capture, commandId: randomUUID(),
      contextRequest: { references: [{ ...page, revision: 999999 }], maxBytes: 65536 } } });
    assert.equal(await errorCode(unavailable), 'akb_context_unavailable');
    record('actual-missing-revision-denied', unavailable.status);
    const unavailableKnowledge = await app.api({ path: `${scope}/knowledge/${encodeURIComponent(knowledge.id)}/revisions/999999?projectId=${app.projectId}` });
    assert.equal(await errorCode(unavailableKnowledge), 'akb_source_unavailable');
    record('actual-missing-knowledge-revision-denied', unavailableKnowledge.status);
    const budget = await app.api({ path: capturePath, body: { ...capture, commandId: randomUUID(),
      contextRequest: { ...request, maxBytes: 1 } } });
    assert.equal(await errorCode(budget), 'akb_context_invalid');
    record('actual-byte-budget-denied', budget.status);
    const captured = await app.api({ path: capturePath, body: capture });
    assert.equal(captured.status, 201);
    const retained = referencesSchema.parse(await captured.json()).references;
    assert.equal(retained.length, selected.length);
    const snapshots: string[] = [];
    for (const [index, reference] of retained.entries()) {
      const response = await app.api({ path: `/references/${reference.id}` });
      assert.equal(response.status, 200);
      const stored = z.object({ retainedText: z.string(), provenance: z.object({ provider: z.literal('akb'),
        installationId: z.string(), id: z.string(), revision: z.number(), schemaVersion: z.string(),
        revisionCreatedAt: z.string(), sourceWorkspaceId: z.string(), contextDigest: z.string() }) })
        .parse(await response.json());
      assert.equal(stored.provenance.installationId, installationId);
      assert.equal(stored.provenance.id, selected[index]?.id);
      assert.equal(stored.provenance.revision, selected[index]?.revision);
      assert.equal(stored.provenance.sourceWorkspaceId, capability.workspaceId);
      assert.equal(stored.provenance.schemaVersion, ownerContext.items[index]?.schemaVersion);
      assert.equal(stored.provenance.revisionCreatedAt, ownerContext.items[index]?.revisionCreatedAt);
      assert.equal(stored.provenance.contextDigest, digest(ownerContext));
      assert.ok(isDeepStrictEqual(JSON.parse(stored.retainedText), ownerContext.items[index]?.snapshot),
        'Retained canonical snapshot differs from the actual immutable owner observation.');
      assert.ok(!stored.retainedText.includes(capability.token), 'Backend credential must not enter a retained reference.');
      snapshots.push(stored.retainedText);
      pinnedReferences.push({ id: reference.id, revision: stored.provenance.revision });
    }
    record('application-capture-and-persisted-retrieval', captured.status);
    const changed = await app.api({ path: capturePath, body: { ...capture, contextRequest: { ...request, maxBytes: request.maxBytes - 1 } } });
    assert.equal(changed.status, 409);
    assert.equal(await errorCode(changed), 'idempotency_key_conflict');
    record('changed-command-conflict', changed.status);
    await app.restart({ authorization: 'Bearer verification-invalid-token' });
    const replay = await app.api({ path: capturePath, body: capture });
    assert.equal(replay.status, 201);
    assert.deepEqual(referencesSchema.parse(await replay.json()).references, retained);
    record('durable-replay-with-unusable-provider-credential', replay.status);
    const retryInput = { ...capture, commandId: `retry-${randomUUID()}` };
    const failedRead = await app.api({ path: capturePath, body: retryInput });
    assert.equal(await errorCode(failedRead), 'akb_authentication_failed');
    record('actual-backend-authentication-failure', failedRead.status);
    await app.restart();
    const retry = await app.api({ path: capturePath, body: retryInput });
    assert.equal(retry.status, 201);
    assert.equal(referencesSchema.parse(await retry.json()).references.length, selected.length);
    record('same-command-read-recovery', retry.status);
    for (const [index, reference] of retained.entries()) {
      const response = await app.api({ path: `/references/${reference.id}` });
      assert.equal(z.object({ retainedText: z.string() }).parse(await response.json()).retainedText, snapshots[index]);
    }
    record('retained-snapshots-after-restart', 200);
    const reviewerOnly = await ky.get(`${akbOrigin}/api/knowledge/v1/workspaces/${encodeURIComponent(capability.workspaceId)}` +
      `/proposals/${encodeURIComponent(acceptedKnowledge.acceptedProposalId)}`, {
      headers: { authorization: `Bearer ${capability.token}` }, retry: 0, timeout: 10000, redirect: 'error', throwHttpErrors: false });
    assert.equal(reviewerOnly.status, 404);
    record('actual-reviewer-detail-permission-denied', reviewerOnly.status);
    await reviewerOnly.body?.cancel();
    process.stdout.write(`${JSON.stringify({ actual: true, stage: 'paired-application', akbSource: ownerSource,
      ownerContractDigest: createHash('sha256').update(contract).digest('hex'),
      workHub: { workspaceId: app.workspaceId, projectId: app.projectId, principalId: app.administratorId,
        installationId, taskId: app.taskId }, akbWorkspaceId: capability.workspaceId,
      akbPrincipalId: capability.principalId, references: pinnedReferences,
      retainedDigest: digest(snapshots), cases, modelCalls: 0, externalMutations: 0,
      applicationSuccessParserQualified: true, credentialsOutput: false, proposalAcceptanceClaimed: false })}\n`);
  } finally { await app.close(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--run') throw new TypeError('Explicit --run is required for actual paired AKB reads.');
  await verifyAkbApplication().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ stage: 'paired-application-failed',
      errorKind: error instanceof Error ? error.name : 'unknown' })}\n`);
    process.exitCode = 1;
  });
}
