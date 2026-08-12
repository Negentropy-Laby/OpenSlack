import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  validateWorkflowCheckpointShadowEnvelope,
  validateWorkflowCheckpointShadowReceipt,
  workflowCheckpointBytesHash,
  workflowCheckpointCanonicalJson,
  workflowCheckpointHash,
  WORKFLOW_CHECKPOINT_CONTROL_SCHEMA,
  WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE,
  WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
  WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX,
  WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA,
  WORKFLOW_CHECKPOINT_SHADOW_ROUTE,
  WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
  type WorkflowCheckpointRecord,
  type WorkflowCheckpointShadowEnvelope,
  type WorkflowCheckpointShadowObservation,
  type WorkflowCheckpointShadowReceipt,
} from '../../packages/workflows/src/workflow-checkpoint-shadow-contract.js';
import { WORKFLOW_CONTROL_SHADOW_POLICY } from '../../packages/workflows/src/workflow-control-shadow.js';

type JsonRecord = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const outputRoot =
  process.env.OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CONTRACTS_OUTPUT_ROOT === undefined
    ? repositoryRoot
    : resolve(process.env.OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CONTRACTS_OUTPUT_ROOT);
const contractRoot = resolve(
  outputRoot,
  'packages/workflows/contracts/workflow-checkpoint-shadow/v1',
);
const expectedPaths = Object.freeze([
  'schemas/workflow-checkpoint-artifact.v1.schema.json',
  'schemas/workflow-checkpoint-control.v1.schema.json',
  'schemas/workflow-checkpoint-shadow-observation.v1.schema.json',
  'schemas/workflow-checkpoint-shadow-envelope.v1.schema.json',
  'schemas/workflow-checkpoint-shadow-accepted-receipt.v1.schema.json',
  'schemas/workflow-checkpoint-shadow-reconciliation-receipt.v1.schema.json',
  'schemas/workflow-checkpoint-shadow-receipt.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

const HASH_PATTERN = '^[0-9a-f]{64}$';
const SAFE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const SAFE_REF_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const IDEMPOTENCY_PATTERN = '^openslack\\.workflow-checkpoint-shadow\\.v1\\.[0-9a-f]{64}$';
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PENDING_OBSERVATIONS = 1024;

function strictObject(properties: JsonRecord, required = Object.keys(properties)): JsonRecord {
  return { type: 'object', additionalProperties: false, properties, required };
}

const idSchema = { type: 'string', pattern: SAFE_ID_PATTERN };
const refSchema = { type: 'string', pattern: SAFE_REF_PATTERN };
const hashSchema = { type: 'string', pattern: HASH_PATTERN };
const timestampSchema = { type: 'string', format: 'date-time', pattern: TIMESTAMP_PATTERN };
const nonNegativeIntegerSchema = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_SAFE_INTEGER,
};
const positiveIntegerSchema = { ...nonNegativeIntegerSchema, minimum: 1 };
const sourceSequenceSchema = {
  type: 'integer',
  minimum: 1,
  maximum: WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE,
};
const nullableHashSchema = { oneOf: [hashSchema, { type: 'null' }] };

const checkpointSchema = strictObject({
  checkpointId: idSchema,
  phaseId: idSchema,
  phaseIndex: nonNegativeIntegerSchema,
  commitPoint: { const: 'after_phase_work' },
  artifactRef: refSchema,
  artifactHash: hashSchema,
  resultHash: nullableHashSchema,
  cacheKeyHash: nullableHashSchema,
  committedRevision: positiveIntegerSchema,
  resumeGeneration: nonNegativeIntegerSchema,
  committedAt: timestampSchema,
});

const runnerSchema = strictObject({
  workspaceId: idSchema,
  jobId: idSchema,
  attemptId: idSchema,
  leaseId: idSchema,
  fencingToken: positiveIntegerSchema,
  correlationId: idSchema,
  runnerBuildHash: hashSchema,
});

const checkpointCommitVariant = {
  type: 'object',
  properties: {
    checkpoint: { $ref: '#/$defs/checkpoint' },
    priorCheckpoint: { type: 'null' },
    nextPhaseId: { type: 'null' },
    nextPhaseIndex: { type: 'null' },
  },
};
const resumeAdvanceVariant = {
  type: 'object',
  properties: {
    checkpoint: { type: 'null' },
    priorCheckpoint: { oneOf: [{ $ref: '#/$defs/checkpoint' }, { type: 'null' }] },
    nextPhaseId: idSchema,
    nextPhaseIndex: nonNegativeIntegerSchema,
  },
  oneOf: [
    {
      type: 'object',
      properties: {
        priorCheckpoint: { type: 'null' },
        nextPhaseId: { const: 'phase-0' },
        nextPhaseIndex: { const: 0 },
      },
    },
    {
      type: 'object',
      properties: {
        priorCheckpoint: { $ref: '#/$defs/checkpoint' },
      },
    },
  ],
};

const observationProperties = {
  schema: { const: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA },
  authority: { const: 'typescript' },
  goRole: { const: 'observer_only' },
  runId: idSchema,
  revision: positiveIntegerSchema,
  resumeGeneration: nonNegativeIntegerSchema,
  workflowSourceHash: hashSchema,
  manifestHash: hashSchema,
  inputHash: hashSchema,
  runner: { $ref: '#/$defs/runner' },
  checkpoint: { oneOf: [{ $ref: '#/$defs/checkpoint' }, { type: 'null' }] },
  priorCheckpoint: { oneOf: [{ $ref: '#/$defs/checkpoint' }, { type: 'null' }] },
  nextPhaseId: { oneOf: [idSchema, { type: 'null' }] },
  nextPhaseIndex: { oneOf: [nonNegativeIntegerSchema, { type: 'null' }] },
};
const observationShape = {
  ...strictObject(observationProperties),
  oneOf: [checkpointCommitVariant, resumeAdvanceVariant],
};
const observationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-checkpoint-shadow/v1/schemas/workflow-checkpoint-shadow-observation.v1.schema.json',
  title: 'OpenSlack TypeScript-authoritative Workflow checkpoint observation v1',
  $comment:
    'Runtime validation additionally enforces phase-index, revision, generation, and immutable binding relationships that JSON Schema cannot express arithmetically.',
  ...observationShape,
  $defs: {
    checkpoint: checkpointSchema,
    runner: runnerSchema,
    checkpointCommitVariant,
    resumeAdvanceVariant,
  },
};

const observationReference = 'workflow-checkpoint-shadow-observation.v1.schema.json';
const checkpointVariantReference = `${observationReference}#/$defs/checkpointCommitVariant`;
const resumeVariantReference = `${observationReference}#/$defs/resumeAdvanceVariant`;
const checkpointObservationReference = {
  allOf: [{ $ref: observationReference }, { $ref: checkpointVariantReference }],
};
const resumeObservationReference = {
  allOf: [{ $ref: observationReference }, { $ref: resumeVariantReference }],
};
const envelopeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-checkpoint-shadow/v1/schemas/workflow-checkpoint-shadow-envelope.v1.schema.json',
  title: 'OpenSlack Workflow checkpoint shadow envelope v1',
  $comment:
    'Runtime validation additionally requires revision = sourceSequence + 1 and observationHash = sha256(canonical observation bytes).',
  ...strictObject({
    schema: { const: WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA },
    goRole: { const: 'observer_only' },
    sourceSequence: sourceSequenceSchema,
    operation: { enum: ['checkpoint_commit', 'resume_advance'] },
    observation: { $ref: observationReference },
    observationHash: hashSchema,
  }),
  oneOf: [
    {
      type: 'object',
      properties: {
        operation: { const: 'checkpoint_commit' },
        observation: checkpointObservationReference,
      },
    },
    {
      type: 'object',
      properties: {
        operation: { const: 'resume_advance' },
        observation: resumeObservationReference,
      },
    },
  ],
};

const executionBindingSchema = strictObject({
  workspaceId: idSchema,
  jobId: idSchema,
  workflowRunId: idSchema,
  attemptId: idSchema,
  leaseId: idSchema,
  fencingToken: positiveIntegerSchema,
  correlationId: idSchema,
  runnerBuildHash: hashSchema,
  workflowSourceHash: hashSchema,
  manifestHash: hashSchema,
  inputHash: hashSchema,
});
const pendingObservationSchema = {
  ...strictObject({
    sourceSequence: sourceSequenceSchema,
    operation: { enum: ['checkpoint_commit', 'resume_advance'] },
    observation: { $ref: observationReference },
  }),
  oneOf: [
    {
      type: 'object',
      properties: {
        operation: { const: 'checkpoint_commit' },
        observation: checkpointObservationReference,
      },
    },
    {
      type: 'object',
      properties: {
        operation: { const: 'resume_advance' },
        observation: resumeObservationReference,
      },
    },
  ],
};
const controlSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-checkpoint-shadow/v1/schemas/workflow-checkpoint-control.v1.schema.json',
  title: 'OpenSlack local TypeScript Workflow checkpoint control v1',
  $comment:
    'Local-only authority state. Runtime validation additionally enforces revision, ordered checkpoint prefix, binding lineage, and pending-observation sequence relationships.',
  ...strictObject({
    schema: { const: WORKFLOW_CHECKPOINT_CONTROL_SCHEMA },
    runId: idSchema,
    revision: positiveIntegerSchema,
    resumeGeneration: nonNegativeIntegerSchema,
    sourceSequence: {
      type: 'integer',
      minimum: 0,
      maximum: WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE,
    },
    shadowEnabled: { type: 'boolean' },
    shadowOverflowed: { type: 'boolean' },
    activeBinding: executionBindingSchema,
    seenBindingHashes: {
      type: 'array',
      minItems: 1,
      maxItems: 1024,
      uniqueItems: true,
      items: hashSchema,
    },
    checkpoints: {
      type: 'array',
      maxItems: 1024,
      items: { $ref: `${observationReference}#/$defs/checkpoint` },
    },
    pendingObservations: {
      type: 'array',
      maxItems: MAX_PENDING_OBSERVATIONS,
      uniqueItems: true,
      items: pendingObservationSchema,
    },
    updatedAt: timestampSchema,
  }),
};

const artifactSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-checkpoint-shadow/v1/schemas/workflow-checkpoint-artifact.v1.schema.json',
  title: 'OpenSlack local Workflow checkpoint artifact v1',
  $comment:
    'Local-only opaque bytes. artifactHash is sha256(decoded bytes); artifact content never crosses the Go observation boundary.',
  ...strictObject({
    schema: { const: 'openslack.workflow_checkpoint_artifact.v1' },
    artifactHash: hashSchema,
    bytesBase64: {
      type: 'string',
      maxLength: Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4,
      pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    },
  }),
};

const receiptCommon = {
  schema: { const: WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA },
  idempotencyKey: { type: 'string', pattern: IDEMPOTENCY_PATTERN },
  receiptId: idSchema,
  workspaceId: idSchema,
  runId: idSchema,
  sourceSequence: sourceSequenceSchema,
  operation: { enum: ['checkpoint_commit', 'resume_advance'] },
  envelopeHash: hashSchema,
  observationHash: hashSchema,
  serviceBuildHash: hashSchema,
};
const acceptedReceiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-checkpoint-shadow/v1/schemas/workflow-checkpoint-shadow-accepted-receipt.v1.schema.json',
  title: 'OpenSlack accepted Workflow checkpoint shadow receipt v1',
  ...strictObject({
    ...receiptCommon,
    status: { const: 'accepted' },
    observationId: idSchema,
    parity: { enum: ['matched', 'mismatched'] },
    mismatchCode: { oneOf: [idSchema, { type: 'null' }] },
    reconciliationToken: { type: 'null' },
    committedAt: timestampSchema,
  }),
  oneOf: [
    {
      type: 'object',
      properties: { parity: { const: 'matched' }, mismatchCode: { type: 'null' } },
    },
    {
      type: 'object',
      properties: { parity: { const: 'mismatched' }, mismatchCode: idSchema },
    },
  ],
};
const reconciliationReceiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-checkpoint-shadow/v1/schemas/workflow-checkpoint-shadow-reconciliation-receipt.v1.schema.json',
  title: 'OpenSlack reconciliation-required Workflow checkpoint shadow receipt v1',
  ...strictObject({
    ...receiptCommon,
    status: { const: 'reconciliation_required' },
    observationId: { type: 'null' },
    parity: { const: 'unknown' },
    mismatchCode: { type: 'null' },
    reconciliationToken: idSchema,
    committedAt: { type: 'null' },
  }),
};
const acceptedReceiptReference = 'workflow-checkpoint-shadow-accepted-receipt.v1.schema.json';
const reconciliationReceiptReference =
  'workflow-checkpoint-shadow-reconciliation-receipt.v1.schema.json';
const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-checkpoint-shadow/v1/schemas/workflow-checkpoint-shadow-receipt.v1.schema.json',
  title: 'OpenSlack Workflow checkpoint shadow receipt v1',
  oneOf: [{ $ref: acceptedReceiptReference }, { $ref: reconciliationReceiptReference }],
};

const HASHES = Object.freeze({
  runner: '1'.repeat(64),
  artifact: '2'.repeat(64),
  result: '3'.repeat(64),
  cache: '4'.repeat(64),
  workflow: '5'.repeat(64),
  manifest: '6'.repeat(64),
  input: '7'.repeat(64),
  service: '8'.repeat(64),
});

function checkpointRecord(): WorkflowCheckpointRecord {
  return {
    checkpointId: `checkpoint-${HASHES.artifact}`,
    phaseId: 'phase-0',
    phaseIndex: 0,
    commitPoint: 'after_phase_work',
    artifactRef: `checkpoint-control/artifacts/${HASHES.artifact}.json`,
    artifactHash: HASHES.artifact,
    resultHash: HASHES.result,
    cacheKeyHash: HASHES.cache,
    committedRevision: 2,
    resumeGeneration: 0,
    committedAt: '2026-08-12T00:00:00.000Z',
  };
}

function checkpointObservation(): WorkflowCheckpointShadowObservation {
  return {
    schema: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
    authority: 'typescript',
    goRole: 'observer_only',
    runId: 'run.gs9c.1',
    revision: 2,
    resumeGeneration: 0,
    workflowSourceHash: HASHES.workflow,
    manifestHash: HASHES.manifest,
    inputHash: HASHES.input,
    runner: {
      workspaceId: 'workspace.test',
      jobId: 'job.1',
      attemptId: 'attempt.1',
      leaseId: 'lease.1',
      fencingToken: 1,
      correlationId: 'correlation.gs9c.1',
      runnerBuildHash: HASHES.runner,
    },
    checkpoint: checkpointRecord(),
    priorCheckpoint: null,
    nextPhaseId: null,
    nextPhaseIndex: null,
  };
}

function resumeObservation(): WorkflowCheckpointShadowObservation {
  return {
    schema: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
    authority: 'typescript',
    goRole: 'observer_only',
    runId: 'run.gs9c.1',
    revision: 3,
    resumeGeneration: 1,
    workflowSourceHash: HASHES.workflow,
    manifestHash: HASHES.manifest,
    inputHash: HASHES.input,
    runner: {
      workspaceId: 'workspace.test',
      jobId: 'job.2',
      attemptId: 'attempt.2',
      leaseId: 'lease.2',
      fencingToken: 2,
      correlationId: 'correlation.gs9c.1',
      runnerBuildHash: HASHES.runner,
    },
    checkpoint: null,
    priorCheckpoint: checkpointRecord(),
    nextPhaseId: 'phase-1',
    nextPhaseIndex: 1,
  };
}

function preCheckpointResumeObservation(): WorkflowCheckpointShadowObservation {
  return {
    ...resumeObservation(),
    runId: 'run.gs9c.pre-checkpoint',
    revision: 2,
    resumeGeneration: 1,
    priorCheckpoint: null,
    nextPhaseId: 'phase-0',
    nextPhaseIndex: 0,
  };
}

function envelope(
  sourceSequence: number,
  operation: WorkflowCheckpointShadowEnvelope['operation'],
  observation: WorkflowCheckpointShadowObservation,
): WorkflowCheckpointShadowEnvelope {
  return validateWorkflowCheckpointShadowEnvelope({
    schema: WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
    goRole: 'observer_only',
    sourceSequence,
    operation,
    observation,
    observationHash: workflowCheckpointHash(observation),
  });
}

function acceptedReceipt(value: WorkflowCheckpointShadowEnvelope): WorkflowCheckpointShadowReceipt {
  return validateWorkflowCheckpointShadowReceipt({
    schema: WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA,
    status: 'accepted',
    idempotencyKey: `${WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX}${value.observationHash}`,
    receiptId: 'receipt.gs9c.accepted.1',
    observationId: 'observation.gs9c.1',
    workspaceId: value.observation.runner.workspaceId,
    runId: value.observation.runId,
    sourceSequence: value.sourceSequence,
    operation: value.operation,
    parity: 'matched',
    mismatchCode: null,
    reconciliationToken: null,
    envelopeHash: workflowCheckpointHash(value),
    observationHash: value.observationHash,
    serviceBuildHash: HASHES.service,
    committedAt: '2026-08-12T00:00:01.000Z',
  });
}

function reconciliationReceipt(
  value: WorkflowCheckpointShadowEnvelope,
): WorkflowCheckpointShadowReceipt {
  return validateWorkflowCheckpointShadowReceipt({
    schema: WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA,
    status: 'reconciliation_required',
    idempotencyKey: `${WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX}${value.observationHash}`,
    receiptId: 'receipt.gs9c.reconciliation.1',
    observationId: null,
    workspaceId: value.observation.runner.workspaceId,
    runId: value.observation.runId,
    sourceSequence: value.sourceSequence,
    operation: value.operation,
    parity: 'unknown',
    mismatchCode: null,
    reconciliationToken: 'reconciliation.gs9c.1',
    envelopeHash: workflowCheckpointHash(value),
    observationHash: value.observationHash,
    serviceBuildHash: HASHES.service,
    committedAt: null,
  });
}

function exactVector<T>(value: T): {
  value: T;
  canonicalBytes: string;
  sha256: string;
} {
  const canonicalBytes = workflowCheckpointCanonicalJson(value);
  return { value, canonicalBytes, sha256: workflowCheckpointBytesHash(canonicalBytes) };
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
  const schemas = [
    artifactSchema,
    controlSchema,
    observationSchema,
    envelopeSchema,
    acceptedReceiptSchema,
    reconciliationReceiptSchema,
    receiptSchema,
  ];
  for (const [index, schema] of schemas.entries()) {
    outputs.set(expectedPaths[index]!, await prettyJson(schema));
  }

  const checkpointCommit = envelope(1, 'checkpoint_commit', checkpointObservation());
  const resumeAdvance = envelope(2, 'resume_advance', resumeObservation());
  const preCheckpointResume = envelope(1, 'resume_advance', preCheckpointResumeObservation());
  const acceptedReplay = acceptedReceipt(checkpointCommit);
  const reconciliation = reconciliationReceipt(resumeAdvance);
  outputs.set(
    'golden-vectors.json',
    await prettyJson({
      schema: 'openslack.workflow_checkpoint_shadow_golden_vectors.v1',
      authority: 'typescript',
      goRole: 'observer_only',
      vectors: {
        checkpointCommit: exactVector(checkpointCommit),
        resumeAdvance: exactVector(resumeAdvance),
        preCheckpointResume: exactVector(preCheckpointResume),
        acceptedReplay: {
          transport: { httpStatus: 200, idempotencyReplayed: true },
          ...exactVector(acceptedReplay),
        },
        reconciliation: {
          transport: { httpStatus: 202, idempotencyReplayed: false },
          ...exactVector(reconciliation),
        },
      },
    }),
  );

  const artifacts = Object.fromEntries(
    [...outputs.entries()].map(([path, bytes]) => [
      path,
      { path, byteLength: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  );
  outputs.set(
    'manifest.json',
    await prettyJson({
      schema: 'openslack.workflow_checkpoint_shadow_contract_manifest.v1',
      contractVersion: 'v1',
      authority: 'typescript',
      authorityBoundary: {
        writer: '@openslack/workflows',
        typescriptRemainsSoleWriter: true,
        goRole: 'observer_only',
        authorityEligible: false,
        shadowDefault: 'disabled',
        goParticipatesInResume: false,
        journalIndependentFromRunStore: true,
      },
      operations: ['checkpoint_commit', 'resume_advance'],
      transport: {
        method: 'POST',
        path: WORKFLOW_CHECKPOINT_SHADOW_ROUTE,
        networkMode: 'loopback-ip-literal',
        replayHeader: 'Idempotency-Replayed: true',
        acceptedStatuses: [200, 201],
        reconciliationStatus: 202,
      },
      algorithms: {
        body: 'ecmascript_canonical_json_utf8',
        hash: 'sha256',
        idempotencyKey: `${WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX}{observationHash}`,
        sourceSequence: 'independent_monotonic_per_run_event_stream_starting_at_1',
        phaseId: 'phase-{zero_based_manifest_index}',
        preCheckpointResume: 'prior_checkpoint_null_next_phase_0_generation_monotonic',
        checkpointCommitPoint: 'after_phase_work',
        duplicateReceipt: 'exact_stored_bytes_transport_header_only',
      },
      variants: {
        observation: ['checkpoint_commit', 'resume_advance'],
        receipt: ['accepted_matched', 'accepted_mismatched', 'reconciliation_required'],
      },
      limits: {
        maxSafeInteger: MAX_SAFE_INTEGER,
        maxSourceSequence: WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE,
        maxReceiptBytes: MAX_RECEIPT_BYTES,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        maxJournalFileBytes: WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalFileBytes,
        maxJournalEntries: WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalEntries,
        maxJournalBytes: WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalBytes,
        maxPendingObservations: MAX_PENDING_OBSERVATIONS,
        maxCanonicalDepth: 64,
      },
      localOnlySchemas: [
        'schemas/workflow-checkpoint-artifact.v1.schema.json',
        'schemas/workflow-checkpoint-control.v1.schema.json',
      ],
      crossLanguageSchemas: [
        'schemas/workflow-checkpoint-shadow-observation.v1.schema.json',
        'schemas/workflow-checkpoint-shadow-envelope.v1.schema.json',
        'schemas/workflow-checkpoint-shadow-accepted-receipt.v1.schema.json',
        'schemas/workflow-checkpoint-shadow-reconciliation-receipt.v1.schema.json',
        'schemas/workflow-checkpoint-shadow-receipt.v1.schema.json',
      ],
      rawDataForbidden: [
        'prompt',
        'providerRequest',
        'providerResponse',
        'workflowInput',
        'cacheKey',
        'cacheValue',
        'artifactBytes',
        'resultBytes',
        'credentials',
        'bearerToken',
        'endpoint',
        'environment',
        'absolutePath',
        'transcript',
        'stack',
      ],
      artifacts,
      bundleFiles: expectedPaths,
    }),
  );
  return outputs;
}

function ensureInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) {
    throw new Error(`Output path escapes the Workflow checkpoint shadow root: ${candidate}`);
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    ensureInside(root, absolute);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`Workflow checkpoint shadow bundle rejects symlink ${absolute}.`);
    }
    if (stats.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (stats.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error(`Workflow checkpoint shadow bundle rejects non-file entry ${absolute}.`);
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
      `Workflow checkpoint shadow inventory drift. Expected ${wantedPaths.join(', ')}, got ${actualPaths.join(', ')}.`,
    );
  }
  for (const [path, expected] of outputs) {
    if (!(await readFile(resolve(contractRoot, path))).equals(expected)) {
      throw new Error(`Workflow checkpoint shadow exact-byte or hash drift: ${path}.`);
    }
  }
}

if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--check')) {
  throw new Error('Usage: bun scripts/workflow-checkpoint-shadow-contracts/index.ts [--check]');
}
const outputs = await buildOutputs();
if (process.argv[2] === '--check') {
  await checkOutputs(outputs);
  console.log(`Workflow checkpoint shadow bundle verified (${outputs.size} exact-byte files).`);
} else {
  await writeOutputs(outputs);
  console.log(`Workflow checkpoint shadow bundle generated (${outputs.size} exact-byte files).`);
}
