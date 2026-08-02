import {
  GraphReadCanaryRouter,
  canonicalJson,
  type GraphQueryResult,
} from '../../packages/organization-graph/dist/index.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const origin = argument('--origin');
const scenarioInstanceId = argument('--scenario');
const targetId = argument('--target');
const buildSha = argument('--build-sha');
const epochText = argument('--routing-epoch');
const nowText = argument('--now');
if (!/^[1-9]\d*$/u.test(epochText)) throw new Error('routing epoch is not canonical');
const routingEpoch = Number(epochText);
const now = Date.parse(nowText);
if (!Number.isFinite(now)) throw new Error('qualification clock is invalid');
const expiresAt = new Date(now + 5 * 60 * 1_000).toISOString();

const router = new GraphReadCanaryRouter({
  backend: 'go',
  tenantId: 'qualification-workspace',
  expectedTenantId: 'qualification-workspace',
  scenarioInstanceIds: [scenarioInstanceId],
  routingEpoch,
  expiresAt,
  origin,
  expectedBuildSha: buildSha,
  now: () => now,
});

const first = await router.query({ scenarioInstanceId, maxNodes: 1 });
if (!first.nextCursor || first.nodes.length !== 1) {
  throw new Error('canary query did not issue one bounded epoch cursor');
}
const second = await router.query({
  scenarioInstanceId,
  maxNodes: 1,
  cursor: first.nextCursor,
});
if (second.nodes.length !== 1) throw new Error('canary cursor continuation failed');

const explanation = await router.explain({ scenarioInstanceId, targetId });
if (explanation.targetId !== targetId || explanation.snapshotCursor !== first.snapshotCursor) {
  throw new Error('canary explanation scope drifted');
}

const legacyResponse = await fetch(`${origin}/v1/graph:query`, {
  method: 'POST',
  redirect: 'manual',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: canonicalJson({ scenarioInstanceId, maxNodes: 1 }),
});
if (legacyResponse.status !== 200) throw new Error('legacy cursor qualification query failed');
const legacy = (await legacyResponse.json()) as GraphQueryResult;
if (!legacy.nextCursor) throw new Error('legacy query did not issue a v1 cursor');
let legacyCursorCode = '';
try {
  await router.query({ scenarioInstanceId, maxNodes: 1, cursor: legacy.nextCursor });
} catch (error) {
  legacyCursorCode = (error as { code?: string }).code ?? '';
}
if (legacyCursorCode !== 'GRAPH_QUERY_CURSOR_MISMATCH') {
  throw new Error(`legacy cursor did not fail with explicit mismatch: ${legacyCursorCode}`);
}

const wrongBuild = new GraphReadCanaryRouter({
  backend: 'go',
  tenantId: 'qualification-workspace',
  expectedTenantId: 'qualification-workspace',
  scenarioInstanceIds: [scenarioInstanceId],
  routingEpoch,
  expiresAt,
  origin,
  expectedBuildSha: 'f'.repeat(64),
  now: () => now,
});
let buildDriftCode = '';
try {
  await wrongBuild.query({ scenarioInstanceId });
} catch (error) {
  buildDriftCode = (error as { code?: string }).code ?? '';
}
if (buildDriftCode !== 'GRAPH_READ_CANARY_ROUTE_MISMATCH') {
  throw new Error(`build drift did not fail closed: ${buildDriftCode}`);
}

const rollback = new GraphReadCanaryRouter({
  backend: 'ts-local',
  tenantId: 'qualification-workspace',
  expectedTenantId: 'qualification-workspace',
  scenarioInstanceIds: [scenarioInstanceId],
  routingEpoch: routingEpoch + 1,
  expiresAt,
  now: () => now,
});
if (rollback.route(scenarioInstanceId)?.backend !== 'ts-local') {
  throw new Error('explicit rollback epoch did not select TypeScript');
}

console.log(
  canonicalJson({
    schema: 'openslack.gs3b_cross_language_qualification.v1',
    status: 'LOCAL_PASS',
    operations: [
      { operation: 'query', status: 'passed' },
      { operation: 'explain', status: 'passed' },
      { operation: 'epoch_cursor_continue', status: 'passed' },
      { operation: 'legacy_cursor_rejected', status: legacyCursorCode },
      { operation: 'build_drift_rejected', status: buildDriftCode },
      { operation: 'explicit_rollback', status: 'ts-local' },
    ],
  }),
);
