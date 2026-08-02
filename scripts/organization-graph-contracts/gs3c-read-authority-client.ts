import {
  GraphAuthorityHttpPublisher,
  GraphReadAuthorityRouter,
  canonicalJson,
  parseStrictGraphJson,
  projectContractToDeliverySnapshot,
  validateContractToDeliverySourceSnapshot,
  type GraphQueryResult,
} from '../../packages/organization-graph/dist/index.js';
import { readFile } from 'node:fs/promises';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const origin = argument('--origin');
const laterOrigin = argument('--later-origin');
const reconciliationOrigin = argument('--reconciliation-origin');
const sourcePath = argument('--source');
const tenantId = argument('--tenant');
const buildSha = argument('--build-sha');
const epochText = argument('--routing-epoch');
const nowText = argument('--now');
if (!/^[1-9]\d*$/u.test(epochText)) throw new Error('routing epoch is not canonical');
const routingEpoch = Number(epochText);
const now = Date.parse(nowText);
if (!Number.isFinite(now)) throw new Error('qualification clock is invalid');
const expiresAt = new Date(now + 5 * 60 * 1_000).toISOString();

const sourceBytes = await readFile(sourcePath);
const source = validateContractToDeliverySourceSnapshot(parseStrictGraphJson(sourceBytes));
const { snapshot } = projectContractToDeliverySnapshot(source);
const targetId = snapshot.nodes[0]?.id;
if (!targetId) throw new Error('qualification projection emitted no target node');

const publisher = new GraphAuthorityHttpPublisher({
  origin,
  tenantId,
  expectedTenantId: tenantId,
  routingEpoch,
  expectedBuildSha: buildSha,
});
const accepted = await publisher.publishSnapshot(snapshot, { expectedCursor: null });
const duplicate = await publisher.publishSnapshot(snapshot, { expectedCursor: null });
if (accepted.receiptStatus !== 'accepted' || duplicate.receiptStatus !== 'duplicate') {
  throw new Error('authority publication did not return accepted then duplicate receipts');
}

const router = new GraphReadAuthorityRouter({
  backend: 'go',
  tenantId,
  expectedTenantId: tenantId,
  routingEpoch,
  expiresAt,
  origin,
  expectedBuildSha: buildSha,
  now: () => now,
});
const first = await router.query({ scenarioInstanceId: snapshot.scenarioInstanceId, maxNodes: 1 });
if (!first.nextCursor || first.nodes.length !== 1 || first.snapshotCursor !== snapshot.cursor) {
  throw new Error('authority query did not read the durably accepted Go head');
}
const continued = await router.query({
  scenarioInstanceId: snapshot.scenarioInstanceId,
  maxNodes: 1,
  cursor: first.nextCursor,
});
if (continued.nodes.length !== 1) throw new Error('authority cursor continuation failed');
const explanation = await router.explain({
  scenarioInstanceId: snapshot.scenarioInstanceId,
  targetId,
});
if (explanation.targetId !== targetId || explanation.snapshotCursor !== snapshot.cursor) {
  throw new Error('authority explanation did not bind the accepted Go head');
}

const legacyResponse = await fetch(`${origin}/v1/graph:query`, {
  method: 'POST',
  redirect: 'manual',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: canonicalJson({ scenarioInstanceId: snapshot.scenarioInstanceId, maxNodes: 1 }),
});
if (legacyResponse.status !== 200) throw new Error('legacy cursor qualification query failed');
const legacy = (await legacyResponse.json()) as GraphQueryResult;
if (!legacy.nextCursor) throw new Error('legacy query did not issue a v1 cursor');
let legacyCursorCode = '';
try {
  await router.query({
    scenarioInstanceId: snapshot.scenarioInstanceId,
    maxNodes: 1,
    cursor: legacy.nextCursor,
  });
} catch (error) {
  legacyCursorCode = (error as { code?: string }).code ?? '';
}
if (legacyCursorCode !== 'GRAPH_QUERY_CURSOR_MISMATCH') {
  throw new Error(`legacy cursor did not fail explicitly: ${legacyCursorCode}`);
}

const laterRouter = new GraphReadAuthorityRouter({
  backend: 'go',
  tenantId,
  expectedTenantId: tenantId,
  routingEpoch: routingEpoch + 1,
  expiresAt,
  origin: laterOrigin,
  expectedBuildSha: buildSha,
  now: () => now,
});
let crossEpochCode = '';
try {
  await laterRouter.query({
    scenarioInstanceId: snapshot.scenarioInstanceId,
    maxNodes: 1,
    cursor: first.nextCursor,
  });
} catch (error) {
  crossEpochCode = (error as { code?: string }).code ?? '';
}
if (crossEpochCode !== 'GRAPH_QUERY_CURSOR_MISMATCH') {
  throw new Error(`cross-epoch cursor did not fail explicitly: ${crossEpochCode}`);
}

const reconciliationPublisher = new GraphAuthorityHttpPublisher({
  origin: reconciliationOrigin,
  tenantId,
  expectedTenantId: tenantId,
  routingEpoch,
  expectedBuildSha: buildSha,
});
let reconciliationCode = '';
try {
  await reconciliationPublisher.publishSnapshot(snapshot, { expectedCursor: null });
} catch (error) {
  reconciliationCode = (error as { code?: string }).code ?? '';
}
if (reconciliationCode !== 'GRAPH_AUTHORITY_RECONCILIATION_REQUIRED') {
  throw new Error(`ambiguous publication did not require reconciliation: ${reconciliationCode}`);
}

const rollback = new GraphReadAuthorityRouter({
  backend: 'ts-local',
  tenantId,
  expectedTenantId: tenantId,
  routingEpoch: routingEpoch + 2,
  expiresAt,
  now: () => now,
});
if (rollback.route('any-canonical-scenario').backend !== 'ts-local') {
  throw new Error('explicit global rollback did not select TypeScript');
}

console.log(
  canonicalJson({
    schema: 'openslack.gs3c_cross_language_qualification.v1',
    status: 'LOCAL_PASS',
    operations: [
      { operation: 'durable_ingest', status: accepted.receiptStatus },
      { operation: 'receipt_replay', status: duplicate.receiptStatus },
      { operation: 'query_go_head', status: 'passed' },
      { operation: 'explain_go_head', status: 'passed' },
      { operation: 'epoch_cursor_continue', status: 'passed' },
      { operation: 'legacy_cursor_rejected', status: legacyCursorCode },
      { operation: 'cross_epoch_cursor_rejected', status: crossEpochCode },
      { operation: 'reconciliation_blocked', status: reconciliationCode },
      { operation: 'explicit_global_rollback', status: 'ts-local' },
    ],
  }),
);
