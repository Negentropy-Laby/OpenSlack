import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { format } from 'prettier';
import {
  prepareWorkflowEffectControlEnvelope,
  validateWorkflowEffectControlEnvelope,
  type WorkflowEffectControlEnvelope,
} from '../../packages/workflows/src/workflow-effect-control-contract.js';
import {
  WORKFLOW_EFFECT_SHADOW_ERROR_CODES,
  WORKFLOW_EFFECT_SHADOW_ERROR_SCHEMA,
  WORKFLOW_EFFECT_SHADOW_HEAD_SCHEMA,
  WORKFLOW_EFFECT_SHADOW_IDEMPOTENCY_PREFIX,
  WORKFLOW_EFFECT_SHADOW_MAX_ERROR_BYTES,
  WORKFLOW_EFFECT_SHADOW_MAX_RECEIPT_BYTES,
  WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA,
  WORKFLOW_EFFECT_SHADOW_ROUTE,
  validateWorkflowEffectShadowError,
  validateWorkflowEffectShadowHead,
  validateWorkflowEffectShadowReceipt,
  workflowEffectShadowCanonicalJson,
  type WorkflowEffectShadowHead,
  type WorkflowEffectShadowReceipt,
} from '../../packages/workflows/src/workflow-effect-shadow-contract.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const contractRoot = resolve(repoRoot, 'packages/workflows/contracts/workflow-effect-shadow/v1');
const effectControlRoot = resolve(
  repoRoot,
  'packages/workflows/contracts/workflow-effect-control/v1',
);
const expectedPaths = Object.freeze([
  'schemas/workflow-effect-shadow-accepted-receipt.v1.schema.json',
  'schemas/workflow-effect-shadow-reconciliation-receipt.v1.schema.json',
  'schemas/workflow-effect-shadow-receipt.v1.schema.json',
  'schemas/workflow-effect-shadow-head.v1.schema.json',
  'schemas/workflow-effect-shadow-error.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
]);

const SAFE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const OCCURRENCE_PATTERN = '^WFOCCURRENCE-[0-9a-f]{64}$';
const HASH_PATTERN = '^[0-9a-f]{64}$';
const CODE_PATTERN = '^[A-Z][A-Z0-9_]{0,127}$';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const IDEMPOTENCY_PATTERN = '^openslack\\.workflow-effect-control-shadow\\.v1\\.[0-9a-f]{64}$';

function strictObject(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const idSchema = { type: 'string', pattern: SAFE_ID_PATTERN };
const occurrenceSchema = { type: 'string', pattern: OCCURRENCE_PATTERN };
const hashSchema = { type: 'string', pattern: HASH_PATTERN };
const codeSchema = { type: 'string', pattern: CODE_PATTERN };
const timestampSchema = { type: 'string', pattern: TIMESTAMP_PATTERN };
const sequenceSchema = { type: 'integer', minimum: 1, maximum: 3 };
const operationSchema = {
  enum: ['approval_created', 'approval_decided', 'audit_recorded'],
};

const receiptCommon = {
  schema: { const: WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA },
  idempotencyKey: { type: 'string', pattern: IDEMPOTENCY_PATTERN },
  receiptId: idSchema,
  workspaceId: idSchema,
  runId: idSchema,
  occurrenceId: occurrenceSchema,
  approvalId: idSchema,
  sourceSequence: sequenceSchema,
  operation: operationSchema,
  envelopeHash: hashSchema,
  observationHash: hashSchema,
  serviceBuildHash: hashSchema,
};

const acceptedReceiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-shadow/v1/schemas/workflow-effect-shadow-accepted-receipt.v1.schema.json',
  title: 'OpenSlack accepted Workflow effect shadow receipt v1',
  ...strictObject({
    ...receiptCommon,
    status: { const: 'accepted' },
    observationId: idSchema,
    parity: { enum: ['matched', 'mismatched'] },
    mismatchCode: { oneOf: [codeSchema, { type: 'null' }] },
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
      properties: { parity: { const: 'mismatched' }, mismatchCode: codeSchema },
    },
  ],
};

const reconciliationReceiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-shadow/v1/schemas/workflow-effect-shadow-reconciliation-receipt.v1.schema.json',
  title: 'OpenSlack reconciliation-required Workflow effect shadow receipt v1',
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

const acceptedReceiptReference = 'workflow-effect-shadow-accepted-receipt.v1.schema.json';
const reconciliationReceiptReference =
  'workflow-effect-shadow-reconciliation-receipt.v1.schema.json';
const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-shadow/v1/schemas/workflow-effect-shadow-receipt.v1.schema.json',
  title: 'OpenSlack Workflow effect shadow receipt v1',
  oneOf: [{ $ref: acceptedReceiptReference }, { $ref: reconciliationReceiptReference }],
};

const nullableMatchedHead = {
  oneOf: [
    {
      required: ['matchedSourceSequence', 'matchedOperation', 'matchedObservationHash'],
      properties: {
        matchedSourceSequence: { type: 'null' },
        matchedOperation: { type: 'null' },
        matchedObservationHash: { type: 'null' },
      },
    },
    {
      required: ['matchedSourceSequence', 'matchedOperation', 'matchedObservationHash'],
      properties: {
        matchedSourceSequence: sequenceSchema,
        matchedOperation: operationSchema,
        matchedObservationHash: hashSchema,
      },
    },
  ],
};

const headSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-shadow/v1/schemas/workflow-effect-shadow-head.v1.schema.json',
  title: 'OpenSlack Workflow effect shadow head v1',
  $comment:
    'Runtime validation additionally enforces contiguous source sequence and matched-prefix operation relationships.',
  ...strictObject({
    schema: { const: WORKFLOW_EFFECT_SHADOW_HEAD_SCHEMA },
    workspaceId: idSchema,
    runId: idSchema,
    occurrenceId: occurrenceSchema,
    approvalId: idSchema,
    lastSourceSequence: sequenceSchema,
    lastOperation: operationSchema,
    lastObservationHash: hashSchema,
    matchedSourceSequence: { oneOf: [sequenceSchema, { type: 'null' }] },
    matchedOperation: { oneOf: [operationSchema, { type: 'null' }] },
    matchedObservationHash: { oneOf: [hashSchema, { type: 'null' }] },
    mismatchLatched: { type: 'boolean' },
    mismatchCode: { oneOf: [codeSchema, { type: 'null' }] },
    serviceBuildHash: hashSchema,
    updatedAt: timestampSchema,
  }),
  allOf: [
    nullableMatchedHead,
    {
      oneOf: [
        {
          required: [
            'mismatchLatched',
            'mismatchCode',
            'matchedSourceSequence',
            'matchedOperation',
            'matchedObservationHash',
          ],
          properties: {
            mismatchLatched: { const: false },
            mismatchCode: { type: 'null' },
            matchedSourceSequence: sequenceSchema,
            matchedOperation: operationSchema,
            matchedObservationHash: hashSchema,
          },
        },
        {
          required: ['mismatchLatched', 'mismatchCode'],
          properties: {
            mismatchLatched: { const: true },
            mismatchCode: codeSchema,
          },
        },
      ],
    },
  ],
};

const errorSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-shadow/v1/schemas/workflow-effect-shadow-error.v1.schema.json',
  title: 'OpenSlack Workflow effect shadow error v1',
  ...strictObject({
    schema: { const: WORKFLOW_EFFECT_SHADOW_ERROR_SCHEMA },
    code: { enum: WORKFLOW_EFFECT_SHADOW_ERROR_CODES },
    message: {
      type: 'string',
      minLength: 1,
      maxLength: 1024,
      pattern: '^[^\\r\\n\\u0000]+$',
    },
  }),
};

async function loadEffectControlEnvelope(
  name: 'approvalCreated' | 'approvalDecided' | 'auditRecorded',
): Promise<WorkflowEffectControlEnvelope> {
  const golden = JSON.parse(
    await readFile(resolve(effectControlRoot, 'golden-vectors.json'), 'utf8'),
  ) as {
    vectors: {
      observer: Record<string, { value: unknown }>;
    };
  };
  return validateWorkflowEffectControlEnvelope(golden.vectors.observer[name]!.value);
}

function acceptedReceipt(
  envelope: WorkflowEffectControlEnvelope,
  parity: 'matched' | 'mismatched',
): WorkflowEffectShadowReceipt {
  const prepared = prepareWorkflowEffectControlEnvelope(envelope);
  return validateWorkflowEffectShadowReceipt(
    {
      schema: WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA,
      status: 'accepted',
      idempotencyKey: prepared.idempotencyKey,
      receiptId: `receipt.gs9d.${parity}.1`,
      observationId: 'observation.gs9d.1',
      workspaceId: envelope.observation.workspaceId,
      runId: envelope.observation.runId,
      occurrenceId: envelope.observation.occurrenceId,
      approvalId: envelope.observation.approvalId,
      sourceSequence: envelope.sourceSequence,
      operation: envelope.operation,
      parity,
      mismatchCode: parity === 'matched' ? null : 'APPROVAL_HASH_DRIFT',
      reconciliationToken: null,
      envelopeHash: prepared.bodyHash,
      observationHash: envelope.observationHash,
      serviceBuildHash: '8'.repeat(64),
      committedAt: '2026-08-14T00:00:01.000Z',
    },
    envelope,
  );
}

function reconciliationReceipt(
  envelope: WorkflowEffectControlEnvelope,
): WorkflowEffectShadowReceipt {
  const prepared = prepareWorkflowEffectControlEnvelope(envelope);
  return validateWorkflowEffectShadowReceipt(
    {
      schema: WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA,
      status: 'reconciliation_required',
      idempotencyKey: prepared.idempotencyKey,
      receiptId: 'receipt.gs9d.reconciliation.1',
      observationId: null,
      workspaceId: envelope.observation.workspaceId,
      runId: envelope.observation.runId,
      occurrenceId: envelope.observation.occurrenceId,
      approvalId: envelope.observation.approvalId,
      sourceSequence: envelope.sourceSequence,
      operation: envelope.operation,
      parity: 'unknown',
      mismatchCode: null,
      reconciliationToken: 'reconciliation.gs9d.1',
      envelopeHash: prepared.bodyHash,
      observationHash: envelope.observationHash,
      serviceBuildHash: '8'.repeat(64),
      committedAt: null,
    },
    envelope,
  );
}

function head(envelope: WorkflowEffectControlEnvelope): WorkflowEffectShadowHead {
  return validateWorkflowEffectShadowHead({
    schema: WORKFLOW_EFFECT_SHADOW_HEAD_SCHEMA,
    workspaceId: envelope.observation.workspaceId,
    runId: envelope.observation.runId,
    occurrenceId: envelope.observation.occurrenceId,
    approvalId: envelope.observation.approvalId,
    lastSourceSequence: envelope.sourceSequence,
    lastOperation: envelope.operation,
    lastObservationHash: envelope.observationHash,
    matchedSourceSequence: envelope.sourceSequence,
    matchedOperation: envelope.operation,
    matchedObservationHash: envelope.observationHash,
    mismatchLatched: false,
    mismatchCode: null,
    serviceBuildHash: '8'.repeat(64),
    updatedAt: '2026-08-14T00:00:01.000Z',
  });
}

function exactVector<T>(value: T) {
  const canonicalBytes = workflowEffectShadowCanonicalJson(value);
  return { value, canonicalBytes, sha256: sha256(Buffer.from(canonicalBytes, 'utf8')) };
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(`${JSON.stringify(value)}\n`, {
      parser: 'json',
      printWidth: 100,
      tabWidth: 2,
    }),
    'utf8',
  );
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function buildOutputs(): Promise<Map<string, Buffer>> {
  const outputs = new Map<string, Buffer>();
  const schemas = [
    acceptedReceiptSchema,
    reconciliationReceiptSchema,
    receiptSchema,
    headSchema,
    errorSchema,
  ];
  for (const [index, schema] of schemas.entries()) {
    outputs.set(expectedPaths[index]!, await prettyJson(schema));
  }
  const created = await loadEffectControlEnvelope('approvalCreated');
  const decided = await loadEffectControlEnvelope('approvalDecided');
  const recorded = await loadEffectControlEnvelope('auditRecorded');
  const matched = acceptedReceipt(created, 'matched');
  const mismatched = acceptedReceipt(decided, 'mismatched');
  const reconciliation = reconciliationReceipt(recorded);
  const currentHead = head(created);
  const error = validateWorkflowEffectShadowError({
    schema: WORKFLOW_EFFECT_SHADOW_ERROR_SCHEMA,
    code: 'WORKFLOW_EFFECT_SHADOW_CONFLICT',
    message: 'effect observation is out of order',
  });
  outputs.set(
    'golden-vectors.json',
    await prettyJson({
      schema: 'openslack.workflow_effect_shadow_golden_vectors.v1',
      authority: 'typescript',
      goRole: 'observer_only',
      sourceEnvelopes: {
        approvalCreated: exactVector(created),
        approvalDecided: exactVector(decided),
        auditRecorded: exactVector(recorded),
      },
      responses: {
        acceptedMatched: {
          transport: { httpStatus: 201, idempotencyReplayed: false },
          ...exactVector(matched),
        },
        acceptedReplay: {
          transport: { httpStatus: 200, idempotencyReplayed: true },
          ...exactVector(matched),
        },
        acceptedMismatched: {
          transport: { httpStatus: 201, idempotencyReplayed: false },
          ...exactVector(mismatched),
        },
        reconciliation: {
          transport: { httpStatus: 202, idempotencyReplayed: false },
          ...exactVector(reconciliation),
        },
        head: exactVector(currentHead),
        error: exactVector(error),
      },
    }),
  );
  const sourceLocks = {
    effectControlManifest: sha256(await readFile(resolve(effectControlRoot, 'manifest.json'))),
    effectControlGolden: sha256(await readFile(resolve(effectControlRoot, 'golden-vectors.json'))),
  };
  const artifacts = Object.fromEntries(
    [...outputs.entries()].map(([path, bytes]) => [
      path,
      { path, byteLength: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  );
  outputs.set(
    'manifest.json',
    await prettyJson({
      schema: 'openslack.workflow_effect_shadow_contract_manifest.v1',
      contractVersion: 'v1',
      authority: 'typescript',
      authorityBoundary: {
        writer: '@openslack/workflows',
        goRole: 'observer_only',
        goEffectDecisionAuthority: false,
        goEffectExecutionAuthority: false,
        nonAuthorizingObservation: true,
        defaultMode: 'disabled',
      },
      sourceLocks,
      operations: ['approval_created', 'approval_decided', 'audit_recorded'],
      transport: {
        method: 'POST',
        path: WORKFLOW_EFFECT_SHADOW_ROUTE,
        idempotencyKey: `${WORKFLOW_EFFECT_SHADOW_IDEMPOTENCY_PREFIX}{sha256(exact-envelope-bytes)}`,
        acceptedStatuses: [200, 201],
        reconciliationStatus: 202,
        replayHeader: 'Idempotency-Replayed: true',
      },
      variants: {
        receipt: ['accepted_matched', 'accepted_mismatched', 'reconciliation_required'],
      },
      limits: {
        maxReceiptBytes: WORKFLOW_EFFECT_SHADOW_MAX_RECEIPT_BYTES,
        maxErrorBytes: WORKFLOW_EFFECT_SHADOW_MAX_ERROR_BYTES,
        maxSourceSequence: 3,
        maxJournalEntries: 16_384,
        maxJournalBytes: 536_870_912,
      },
      rawDataForbidden: [
        'effectDetail',
        'workflowInput',
        'prompt',
        'providerRequest',
        'providerResponse',
        'effectPayload',
        'effectResult',
        'humanReason',
        'attestationNonce',
        'credential',
        'bearerToken',
        'keychainReference',
        'endpoint',
        'transcript',
        'stack',
        'command',
        'absolutePath',
      ],
      crossLanguageSchemas: expectedPaths.slice(0, 5),
      artifacts,
      bundleFiles: expectedPaths,
    }),
  );
  return outputs;
}

function ensureInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) {
    throw new Error(`Output path escapes the Workflow effect shadow root: ${candidate}`);
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
      throw new Error(`Workflow effect shadow bundle rejects symlink ${absolute}.`);
    }
    if (stats.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (stats.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error(`Workflow effect shadow bundle rejects non-file entry ${absolute}.`);
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
      `Workflow effect shadow inventory drift. Expected ${wantedPaths.join(', ')}, got ${actualPaths.join(', ')}.`,
    );
  }
  for (const [path, expected] of outputs) {
    if (!(await readFile(resolve(contractRoot, path))).equals(expected)) {
      throw new Error(`Workflow effect shadow exact-byte or hash drift: ${path}.`);
    }
  }
}

if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--check')) {
  throw new Error('Usage: bun scripts/workflow-effect-shadow-contracts/index.ts [--check]');
}
const outputs = await buildOutputs();
if (process.argv[2] === '--check') {
  await checkOutputs(outputs);
  console.log(`Workflow effect shadow bundle verified (${outputs.size} exact-byte files).`);
} else {
  await writeOutputs(outputs);
  console.log(`Workflow effect shadow bundle generated (${outputs.size} exact-byte files).`);
}
