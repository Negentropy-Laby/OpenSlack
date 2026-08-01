import { readFileSync } from 'node:fs';
import {
  GraphReadMirrorHttpClient,
  assertGraphSnapshotIntegrity,
  canonicalJson,
  explainGraph,
  queryGraph,
  type GraphExplainInput,
  type GraphQueryInput,
  type GraphReadMirrorObservation,
} from '../../packages/organization-graph/dist/index.js';

function argument(name: '--origin' | '--snapshot'): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required.`);
  }
  return value;
}

const origin = argument('--origin');
const snapshotPath = argument('--snapshot');
const snapshotBytes = readFileSync(snapshotPath);
if (snapshotBytes.byteLength > 64 * 1024 * 1024) {
  throw new TypeError('Qualification snapshot exceeds 64 MiB.');
}
const snapshot = assertGraphSnapshotIntegrity(
  JSON.parse(snapshotBytes.toString('utf8')) as unknown,
);
const target = snapshot.nodes[0];
if (target === undefined) throw new TypeError('Qualification snapshot must contain one target.');

const queryInput: GraphQueryInput = {
  scenarioInstanceId: snapshot.scenarioInstanceId,
  rootNodeIds: [target.id],
  direction: 'both',
  depth: 3,
  maxNodes: 200,
  maxEdges: 500,
};
const explainInput: GraphExplainInput = {
  scenarioInstanceId: snapshot.scenarioInstanceId,
  targetId: target.id,
  depth: 3,
};
const observations: GraphReadMirrorObservation[] = [];
const client = new GraphReadMirrorHttpClient({
  origin,
  timeoutMs: 5_000,
  auditSink: (observation) => {
    observations.push(observation);
  },
});

const queryObservation = await client.observeQuery(
  queryInput,
  queryGraph(snapshot, queryInput, {
    cursorSecret: 'gs3a-real-go-read-mirror-cursor-secret-v1',
    now: new Date('2026-08-01T00:00:00.000Z'),
  }),
);
const explainObservation = await client.observeExplain(
  explainInput,
  explainGraph(snapshot, explainInput),
);

if (
  queryObservation.outcome !== 'matched' ||
  queryObservation.parity !== 'matched' ||
  explainObservation.outcome !== 'matched' ||
  explainObservation.parity !== 'matched' ||
  observations.length !== 2
) {
  throw new Error('Real Go Graph read mirror did not match the TypeScript authority.');
}

process.stdout.write(
  `${canonicalJson({
    schema: 'openslack.gs3a_cross_language_qualification.v1',
    status: 'passed',
    operations: observations.map(({ operation, outcome, parity }) => ({
      operation,
      outcome,
      parity,
    })),
  })}\n`,
);
