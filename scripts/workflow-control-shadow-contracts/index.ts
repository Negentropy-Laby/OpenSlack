import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  WORKFLOW_CONTROL_SHADOW_IDEMPOTENCY_PREFIX,
  WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA,
  WORKFLOW_CONTROL_SHADOW_POLICY,
  WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
  WORKFLOW_CONTROL_SHADOW_ROUTE,
  prepareWorkflowControlShadowRequest,
  validateWorkflowControlShadowEnvelope,
  type WorkflowControlShadowEnvelope,
} from '../../packages/workflows/src/workflow-control-shadow.js';
import {
  WORKFLOW_CONTROL_AUTHORITY,
  WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
  WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
  projectWorkflowControlReadModel,
  type WorkflowControlObservation,
} from '../../packages/workflows/src/workflow-control-contract.js';

type JsonRecord = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const outputRoot =
  process.env.OPENSLACK_WORKFLOW_CONTROL_SHADOW_CONTRACTS_OUTPUT_ROOT === undefined
    ? repositoryRoot
    : resolve(process.env.OPENSLACK_WORKFLOW_CONTROL_SHADOW_CONTRACTS_OUTPUT_ROOT);
const contractRoot = resolve(outputRoot, 'packages/workflows/contracts/workflow-control-shadow/v1');
const expectedPaths = Object.freeze([
  'schemas/workflow-control-shadow-observation.v1.schema.json',
  'schemas/workflow-control-shadow-receipt.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

function strictObject(properties: JsonRecord, required: readonly string[]): JsonRecord {
  return { type: 'object', additionalProperties: false, properties, required };
}

const identifierSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$',
};
const hashSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const sourceSchema = strictObject(
  {
    runId: identifierSchema,
    sourceSequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    workspaceId: identifierSchema,
  },
  ['runId', 'sourceSequence', 'workspaceId'],
);

const observationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-control-shadow/v1/workflow-control-shadow-observation.v1.schema.json',
  title: 'OpenSlack Workflow Control GS7-B shadow observation envelope',
  $comment:
    'Runtime validation additionally requires source.runId to match observation.runId and projection to equal the deterministic TypeScript projection byte-for-byte.',
  ...strictObject(
    {
      authority: { const: 'typescript' },
      observation: {
        $ref: 'https://openslack.dev/contracts/workflow-control/v1/workflow-control-observation.v1.schema.json',
      },
      projection: {
        $ref: 'https://openslack.dev/contracts/workflow-control/v1/workflow-control-read-model.v1.schema.json',
      },
      schema: { const: WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA },
      source: sourceSchema,
    },
    ['authority', 'observation', 'projection', 'schema', 'source'],
  ),
};

const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-control-shadow/v1/workflow-control-shadow-receipt.v1.schema.json',
  title: 'OpenSlack Workflow Control GS7-B strict ingestion receipt',
  ...strictObject(
    {
      schema: { const: WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA },
      operation: { const: 'observation_ingest' },
      status: { enum: ['accepted', 'duplicate', 'reconciliation_required'] },
      parity: { enum: ['matched', 'mismatched', 'unknown'] },
      idempotencyKey: {
        type: 'string',
        pattern: '^openslack\\.workflow-control-shadow\\.v1\\.[0-9a-f]{64}$',
      },
      requestFingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      workspaceId: identifierSchema,
      runId: identifierSchema,
      sourceSequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      observationDigest: hashSchema,
      observationHash: hashSchema,
      mismatchCode: { type: 'string', pattern: '^[a-z0-9][a-z0-9._:-]{0,255}$' },
      committedAt: {
        type: 'string',
        pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$',
      },
      reconciliationToken: { type: 'string', minLength: 1 },
    },
    [
      'schema',
      'operation',
      'status',
      'parity',
      'idempotencyKey',
      'requestFingerprint',
      'workspaceId',
      'runId',
      'sourceSequence',
      'observationDigest',
    ],
  ),
  allOf: [
    {
      if: { properties: { status: { const: 'reconciliation_required' } }, required: ['status'] },
      then: {
        properties: { parity: { const: 'unknown' } },
        required: ['reconciliationToken'],
        not: {
          anyOf: [
            { required: ['observationHash'] },
            { required: ['mismatchCode'] },
            { required: ['committedAt'] },
          ],
        },
      },
      else: {
        properties: { parity: { enum: ['matched', 'mismatched'] } },
        required: ['observationHash', 'committedAt'],
        not: { required: ['reconciliationToken'] },
      },
    },
    {
      if: { properties: { parity: { const: 'mismatched' } }, required: ['parity'] },
      then: { required: ['mismatchCode'] },
      else: { not: { required: ['mismatchCode'] } },
    },
  ],
};

function goldenObservation(): WorkflowControlObservation {
  const hash = 'a'.repeat(64);
  return {
    schema: WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
    authority: WORKFLOW_CONTROL_AUTHORITY,
    runId: 'run-gs7b-shadow',
    workflowName: 'contract-to-delivery-lite',
    mode: 'execute',
    status: 'paused_waiting_approval',
    startedAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:02.000Z',
    manifestHash: hash,
    currentPhase: 'review',
    phases: [
      {
        phase: 'prepare',
        observedAt: '2026-08-03T00:00:01.000Z',
        status: 'completed',
        resultHash: 'b'.repeat(64),
        cacheKeyHash: null,
      },
    ],
    approvals: {
      legacyRunGate: {
        plane: 'legacy-run-gate',
        semantics: 'run-gate-only',
        counts: { pending: 1, approved: 0, rejected: 0 },
      },
      effectV2: {
        plane: 'workflow-effect-v2',
        semantics: 'effect-decision-only',
        schema: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
        counts: { pending: 1, approved: 1, rejected: 0 },
      },
    },
    budget: {
      configured: true,
      policyHash: 'c'.repeat(64),
      tokenBudget: 100_000,
      tokensUsed: 12_345,
      costUsd: 0.42,
      agentCalls: 2,
      warnings: [],
    },
  };
}

function goldenEnvelope(): WorkflowControlShadowEnvelope {
  const observation = goldenObservation();
  return validateWorkflowControlShadowEnvelope({
    authority: 'typescript',
    observation,
    projection: projectWorkflowControlReadModel(observation),
    schema: WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA,
    source: { runId: observation.runId, sourceSequence: 7, workspaceId: 'workspace.demo' },
  });
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(`${JSON.stringify(value)}\n`, { parser: 'json', printWidth: 100, tabWidth: 2 }),
    'utf8',
  );
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function buildOutputs(): Promise<Map<string, Buffer>> {
  const outputs = new Map<string, Buffer>();
  outputs.set(expectedPaths[0], await prettyJson(observationSchema));
  outputs.set(expectedPaths[1], await prettyJson(receiptSchema));
  const envelope = goldenEnvelope();
  outputs.set(
    expectedPaths[2],
    await prettyJson({
      schema: 'openslack.workflow_control_shadow_golden_vectors.v1',
      authority: 'typescript',
      vectors: [
        {
          id: 'paused-effect-approval-sequence-7',
          envelope,
          expected: prepareWorkflowControlShadowRequest(envelope),
        },
      ],
    }),
  );
  const artifacts = Object.fromEntries(
    [...outputs.entries()].map(([path, bytes]) => [
      path,
      { path, byteLength: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  );
  outputs.set(
    expectedPaths[3],
    await prettyJson({
      schema: 'openslack.workflow_control_shadow_contract_manifest.v1',
      contractVersion: 'v1',
      authority: 'typescript',
      authorityBoundary: {
        writer: '@openslack/workflows',
        typescriptRemainsSoleWriter: true,
        goRole: 'credential-free-shadow-observer-only',
        shadowDefault: 'disabled',
        journalIndependentFromRunStore: true,
      },
      envelopeFields: ['authority', 'observation', 'projection', 'schema', 'source'],
      sourceFields: ['runId', 'sourceSequence', 'workspaceId'],
      transport: {
        method: 'POST',
        path: WORKFLOW_CONTROL_SHADOW_ROUTE,
        redirect: 'forbidden',
        dns: 'forbidden',
        defaultNetworkMode: 'loopback-ip-literal',
        optionalNetworkMode: 'private-link-local-ip-literal',
      },
      algorithms: {
        body: 'ecmascript_canonical_json_utf8_plus_single_lf',
        idempotencyKey: `${WORKFLOW_CONTROL_SHADOW_IDEMPOTENCY_PREFIX}sha256(body)`,
        requestBinding: 'typescript/{workspaceId}/{runId}/{sourceSequence}',
        requestFingerprint: 'sha256:sha256(POST\\n/path\\n/requestBinding\\n/body)',
        sourceSequence: 'monotonic_per_workspace_run_shadow_stream_only',
        duplicateCoalescing: 'sha256(canonical_observation_json)',
      },
      failureBoundary: {
        authority: 'fail-closed-on-authority-write-errors',
        shadowRelativeToAuthority: 'fail-open',
        shadowInternal: 'fail-closed-before-journal-and-receipt-binding',
        legacyManifestHash: 'diagnostic-and-skip-never-pad-or-fabricate',
      },
      deferred: {
        gs8: 'worker protocol, scheduler, lease, cancellation receipts',
        gs9: 'PostgreSQL workflow authority cutover',
      },
      limits: WORKFLOW_CONTROL_SHADOW_POLICY,
      artifacts,
      bundleFiles: expectedPaths,
    }),
  );
  return outputs;
}

function ensureInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) {
    throw new Error(`Output path escapes the Workflow Control shadow root: ${candidate}`);
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    ensureInside(root, absolute);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) throw new Error(`Shadow bundle rejects symlink ${absolute}.`);
    if (stats.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (stats.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error(`Shadow bundle rejects non-file entry ${absolute}.`);
  }
  return files.sort();
}

async function writeOutputs(outputs: Map<string, Buffer>): Promise<void> {
  for (const [path, bytes] of outputs) {
    const absolute = resolve(contractRoot, path);
    ensureInside(contractRoot, absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}

async function checkOutputs(outputs: Map<string, Buffer>): Promise<void> {
  const actualPaths = await listFiles(contractRoot);
  const wantedPaths = [...outputs.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(wantedPaths)) {
    throw new Error(
      `Workflow Control shadow inventory drift. Expected ${wantedPaths.join(', ')}, got ${actualPaths.join(', ')}.`,
    );
  }
  for (const [path, expected] of outputs) {
    if (!(await readFile(resolve(contractRoot, path))).equals(expected)) {
      throw new Error(`Workflow Control shadow exact-byte drift: ${path}.`);
    }
  }
}

const outputs = await buildOutputs();
if (process.argv.includes('--check')) {
  await checkOutputs(outputs);
  console.log(`Workflow Control shadow bundle verified (${outputs.size} exact-byte files).`);
} else {
  await writeOutputs(outputs);
  console.log(`Workflow Control shadow bundle generated (${outputs.size} exact-byte files).`);
}
