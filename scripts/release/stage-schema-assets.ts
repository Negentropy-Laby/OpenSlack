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

const softwareDeliveryContractRoot = resolve(
  root,
  'packages',
  'organization-graph',
  'contracts',
  'software-delivery',
  'v1',
);
const softwareDeliveryManifest = JSON.parse(
  readFileSync(resolve(softwareDeliveryContractRoot, 'manifest.json'), 'utf8'),
) as {
  artifacts: Record<string, { path: string; sha256: string }>;
};
const softwareDeliverySourceSchemaPath = 'schemas/software-delivery-source-snapshot.v1.schema.json';
const softwareDeliverySourceSchema = softwareDeliveryManifest.artifacts.sourceSchema;
if (
  softwareDeliverySourceSchema === undefined ||
  softwareDeliverySourceSchema.path !== softwareDeliverySourceSchemaPath ||
  !/^[0-9a-f]{64}$/.test(softwareDeliverySourceSchema.sha256)
) {
  throw new Error('Refusing to stage invalid Software Delivery sourceSchema metadata.');
}
const softwareDeliverySchemaSource = resolve(
  softwareDeliveryContractRoot,
  softwareDeliverySourceSchema.path,
);
const softwareDeliverySchemaBytes = readFileSync(softwareDeliverySchemaSource);
const softwareDeliverySchemaSHA256 = createHash('sha256')
  .update(softwareDeliverySchemaBytes)
  .digest('hex');
if (softwareDeliverySchemaSHA256 !== softwareDeliverySourceSchema.sha256) {
  throw new Error(
    `Refusing to stage mismatched Software Delivery sourceSchema: ${softwareDeliverySchemaSHA256}`,
  );
}
const softwareDeliverySchemaDestination = resolve(
  outputRoot,
  'packages',
  'organization-graph',
  'dist',
  'generated',
  'contracts',
  'software-delivery',
  'v1',
  softwareDeliverySourceSchema.path,
);
mkdirSync(dirname(softwareDeliverySchemaDestination), { recursive: true });
copyFileSync(softwareDeliverySchemaSource, softwareDeliverySchemaDestination);

const contractToDeliveryContractRoot = resolve(
  root,
  'packages',
  'organization-graph',
  'contracts',
  'contract-to-delivery',
  'v1',
);
const contractToDeliveryManifest = JSON.parse(
  readFileSync(resolve(contractToDeliveryContractRoot, 'manifest.json'), 'utf8'),
) as {
  artifacts: Record<string, { path: string; sha256: string }>;
};
const contractToDeliverySourceSchemaPath =
  'schemas/contract-to-delivery-source-snapshot.v1.schema.json';
const contractToDeliverySourceSchema = contractToDeliveryManifest.artifacts.sourceSchema;
if (
  contractToDeliverySourceSchema === undefined ||
  contractToDeliverySourceSchema.path !== contractToDeliverySourceSchemaPath ||
  !/^[0-9a-f]{64}$/.test(contractToDeliverySourceSchema.sha256)
) {
  throw new Error('Refusing to stage invalid Contract-to-Delivery sourceSchema metadata.');
}
const contractToDeliverySchemaSource = resolve(
  contractToDeliveryContractRoot,
  contractToDeliverySourceSchema.path,
);
const contractToDeliverySchemaBytes = readFileSync(contractToDeliverySchemaSource);
const contractToDeliverySchemaSHA256 = createHash('sha256')
  .update(contractToDeliverySchemaBytes)
  .digest('hex');
if (contractToDeliverySchemaSHA256 !== contractToDeliverySourceSchema.sha256) {
  throw new Error(
    `Refusing to stage mismatched Contract-to-Delivery sourceSchema: ${contractToDeliverySchemaSHA256}`,
  );
}
const contractToDeliverySchemaDestination = resolve(
  outputRoot,
  'packages',
  'organization-graph',
  'dist',
  'generated',
  'contracts',
  'contract-to-delivery',
  'v1',
  contractToDeliverySourceSchema.path,
);
mkdirSync(dirname(contractToDeliverySchemaDestination), { recursive: true });
copyFileSync(contractToDeliverySchemaSource, contractToDeliverySchemaDestination);
