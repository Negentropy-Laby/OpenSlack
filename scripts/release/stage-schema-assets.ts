import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EXPECTED_SHA256 = '45ca9bec47d8427d59fee4a949a32677beba81a468193f0bed4c24a3381b1c1f';
const root = resolve(import.meta.dirname, '..', '..');
const outputRoot =
  process.env.OPENSLACK_SCHEMA_STAGE_ROOT === undefined
    ? root
    : resolve(process.env.OPENSLACK_SCHEMA_STAGE_ROOT);
const source = resolve(
  root,
  'packages',
  'integration-negentropy',
  'src',
  'schema',
  'negentropy.slot-contribution.v1.schema.json',
);
const destination = resolve(
  outputRoot,
  'packages',
  'integration-negentropy',
  'dist',
  'schema',
  'negentropy.slot-contribution.v1.schema.json',
);
const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
if (actual !== EXPECTED_SHA256) {
  throw new Error(`Refusing to stage mismatched Negentropy schema: ${actual}`);
}
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);

const graphContractRoot = resolve(root, 'packages', 'organization-graph', 'contracts', 'v1');
const graphManifest = JSON.parse(
  readFileSync(resolve(graphContractRoot, 'manifest.json'), 'utf8'),
) as {
  artifacts: Record<string, { path: string; sha256: string }>;
};
const graphSchemaPaths = {
  snapshotSchema: 'schemas/graph-snapshot.v1.schema.json',
  deltaSchema: 'schemas/graph-delta.v1.schema.json',
} as const;
for (const artifactName of ['snapshotSchema', 'deltaSchema'] as const) {
  const artifact = graphManifest.artifacts[artifactName];
  if (
    artifact === undefined ||
    artifact.path !== graphSchemaPaths[artifactName] ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  ) {
    throw new Error(`Refusing to stage invalid Organization Graph ${artifactName} metadata.`);
  }
  const graphSource = resolve(graphContractRoot, artifact.path);
  const graphBytes = readFileSync(graphSource);
  const graphSHA256 = createHash('sha256').update(graphBytes).digest('hex');
  if (graphSHA256 !== artifact.sha256) {
    throw new Error(
      `Refusing to stage mismatched Organization Graph ${artifactName}: ${graphSHA256}`,
    );
  }
  const graphDestination = resolve(
    outputRoot,
    'packages',
    'organization-graph',
    'dist',
    'generated',
    'contracts',
    'v1',
    artifact.path,
  );
  mkdirSync(dirname(graphDestination), { recursive: true });
  copyFileSync(graphSource, graphDestination);
}
