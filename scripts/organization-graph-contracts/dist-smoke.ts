import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const contractRoot = resolve(repositoryRoot, 'packages/organization-graph/contracts/v1');
const softwareDeliveryContractRoot = resolve(
  repositoryRoot,
  'packages/organization-graph/contracts/software-delivery/v1',
);
const distRoot = resolve(repositoryRoot, 'packages/organization-graph/dist');

const manifest = JSON.parse(await readFile(resolve(contractRoot, 'manifest.json'), 'utf8')) as {
  artifacts: Record<string, { path: string; sha256: string }>;
};

for (const artifactName of ['snapshotSchema', 'deltaSchema'] as const) {
  const artifact = manifest.artifacts[artifactName];
  if (artifact === undefined) throw new Error(`Missing ${artifactName} in graph manifest.`);
  const distPath = resolve(distRoot, 'generated/contracts/v1', artifact.path);
  const actual = createHash('sha256')
    .update(await readFile(distPath))
    .digest('hex');
  if (actual !== artifact.sha256) {
    throw new Error(
      `Organization Graph dist ${artifactName} hash mismatch: got ${actual}, want ${artifact.sha256}.`,
    );
  }
}

const softwareDeliveryManifest = JSON.parse(
  await readFile(resolve(softwareDeliveryContractRoot, 'manifest.json'), 'utf8'),
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
  throw new Error('Invalid sourceSchema metadata in Software Delivery manifest.');
}
const softwareDeliveryDistPath = resolve(
  distRoot,
  'generated/contracts/software-delivery/v1',
  softwareDeliverySourceSchema.path,
);
const softwareDeliveryDistSHA256 = createHash('sha256')
  .update(await readFile(softwareDeliveryDistPath))
  .digest('hex');
if (softwareDeliveryDistSHA256 !== softwareDeliverySourceSchema.sha256) {
  throw new Error(
    'Organization Graph dist Software Delivery sourceSchema hash mismatch: ' +
      `got ${softwareDeliveryDistSHA256}, want ${softwareDeliverySourceSchema.sha256}.`,
  );
}

function usableNode(binary: string): string | undefined {
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return undefined;
  const match = /^v(\d+)\./.exec(probe.stdout.trim());
  if (match === null || Number(match[1]) < 22) {
    throw new Error(`Organization Graph dist smoke requires Node 22+, got ${probe.stdout.trim()}.`);
  }
  return binary;
}

const nodeBinary =
  (process.env.OPENSLACK_NODE_BINARY === undefined
    ? undefined
    : usableNode(process.env.OPENSLACK_NODE_BINARY)) ??
  usableNode('node') ??
  usableNode('node.exe');
if (nodeBinary === undefined) {
  throw new Error('Organization Graph dist smoke requires a Node 22 executable.');
}

const indexPath = resolve(distRoot, 'index.js');
let importURL = pathToFileURL(indexPath).href;
if (process.platform === 'linux' && nodeBinary.toLowerCase().endsWith('.exe')) {
  const translated = spawnSync('wslpath', ['-w', indexPath], { encoding: 'utf8' });
  if (translated.status !== 0) {
    throw new Error(`Unable to translate Organization Graph dist path: ${translated.stderr}`);
  }
  importURL = encodeURI(`file:///${translated.stdout.trim().replaceAll('\\', '/')}`);
}
const smoke = spawnSync(
  nodeBinary,
  [
    '--input-type=module',
    '--eval',
    `const graph = await import(${JSON.stringify(importURL)});` +
      `if (graph.GRAPH_SNAPSHOT_SCHEMA !== 'openslack.graph_snapshot.v1') process.exit(3);`,
  ],
  { encoding: 'utf8' },
);
if (smoke.status !== 0) {
  throw new Error(
    `Organization Graph Node import smoke failed (${smoke.status}):\n${smoke.stdout}\n${smoke.stderr}`,
  );
}

console.log(
  'organization-graph dist schemas, Software Delivery schema, and Node 22 import verified',
);
