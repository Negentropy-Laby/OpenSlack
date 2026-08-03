import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  WORKFLOW_CONTROL_APPROVAL_STATES,
  WORKFLOW_CONTROL_AUTHORITY,
  WORKFLOW_CONTROL_CHECKPOINT_STATES,
  WORKFLOW_CONTROL_CONTRACT_ERROR_CODES,
  WORKFLOW_CONTROL_CONTRACT_LIMITS,
  WORKFLOW_CONTROL_DORMANT_STATES,
  WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
  WORKFLOW_CONTROL_EXECUTION_MODES,
  WORKFLOW_CONTROL_FORBIDDEN_RAW_FIELDS,
  WORKFLOW_CONTROL_GO_ROLE,
  WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
  WORKFLOW_CONTROL_PRODUCTION_INITIAL_STATE,
  WORKFLOW_CONTROL_QUALIFICATION_GAPS,
  WORKFLOW_CONTROL_READ_MODEL_SCHEMA,
  WORKFLOW_CONTROL_RUN_STATES,
  WORKFLOW_CONTROL_STATE_TRANSITIONS,
  WorkflowControlContractError,
  hashWorkflowControlValue,
  projectWorkflowControlReadModel,
  validateWorkflowControlObservation,
  validateWorkflowControlTransition,
  type WorkflowControlObservation,
} from '../../packages/workflows/src/workflow-control-contract.js';

type JsonRecord = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const outputRoot =
  process.env.OPENSLACK_WORKFLOW_CONTROL_CONTRACTS_OUTPUT_ROOT === undefined
    ? repositoryRoot
    : resolve(process.env.OPENSLACK_WORKFLOW_CONTROL_CONTRACTS_OUTPUT_ROOT);
const contractRoot = resolve(outputRoot, 'packages/workflows/contracts/workflow-control/v1');
const serviceMirrorRoot = resolve(
  outputRoot,
  'services/workflow-control/internal/contractmirror/generated/v1',
);
const expectedPaths = Object.freeze([
  'schemas/workflow-control-observation.v1.schema.json',
  'schemas/workflow-control-read-model.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

const HASH_PATTERN = '^[0-9a-f]{64}$';
const SAFE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

function strictObject(properties: JsonRecord, required: readonly string[]): JsonRecord {
  return { type: 'object', additionalProperties: false, properties, required };
}

const countSchema = {
  type: 'integer',
  minimum: 0,
  maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCount,
};
const hashSchema = { type: 'string', pattern: HASH_PATTERN };
const nullableHashSchema = { anyOf: [hashSchema, { type: 'null' }] };
const timestampSchema = { type: 'string', pattern: TIMESTAMP_PATTERN };
const approvalCountsSchema = strictObject(
  { pending: countSchema, approved: countSchema, rejected: countSchema },
  WORKFLOW_CONTROL_APPROVAL_STATES,
);
const approvalsSchema = strictObject(
  {
    legacyRunGate: strictObject(
      {
        plane: { const: 'legacy-run-gate' },
        semantics: { const: 'run-gate-only' },
        counts: approvalCountsSchema,
      },
      ['plane', 'semantics', 'counts'],
    ),
    effectV2: strictObject(
      {
        plane: { const: 'workflow-effect-v2' },
        semantics: { const: 'effect-decision-only' },
        schema: { const: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA },
        counts: approvalCountsSchema,
      },
      ['plane', 'semantics', 'schema', 'counts'],
    ),
  },
  ['legacyRunGate', 'effectV2'],
);

const budgetWarningSchema = strictObject(
  {
    observedAt: timestampSchema,
    kind: { enum: ['threshold', 'exceeded'] },
    tokensUsed: {
      type: 'integer',
      minimum: 0,
      maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
    },
    tokenBudget: {
      type: 'integer',
      minimum: 0,
      maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
    },
    percent: { type: 'number', minimum: 0, maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCount },
    costUsd: {
      anyOf: [
        { type: 'number', minimum: 0, maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCostUsd },
        { type: 'null' },
      ],
    },
  },
  ['observedAt', 'kind', 'tokensUsed', 'tokenBudget', 'percent', 'costUsd'],
);

const budgetSchema = {
  ...strictObject(
    {
      configured: { type: 'boolean' },
      policyHash: nullableHashSchema,
      tokenBudget: {
        anyOf: [
          { type: 'integer', minimum: 0, maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens },
          { type: 'null' },
        ],
      },
      tokensUsed: {
        type: 'integer',
        minimum: 0,
        maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
      },
      costUsd: {
        anyOf: [
          { type: 'number', minimum: 0, maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCostUsd },
          { type: 'null' },
        ],
      },
      agentCalls: countSchema,
      warnings: {
        type: 'array',
        maxItems: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxBudgetWarnings,
        items: budgetWarningSchema,
      },
    },
    ['configured', 'policyHash', 'tokenBudget', 'tokensUsed', 'costUsd', 'agentCalls', 'warnings'],
  ),
  allOf: [
    {
      if: { properties: { configured: { const: false } }, required: ['configured'] },
      then: { properties: { policyHash: { type: 'null' }, tokenBudget: { type: 'null' } } },
    },
  ],
};

const phaseSchema = strictObject(
  {
    phase: {
      type: 'string',
      minLength: 1,
      maxLength: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
    },
    observedAt: timestampSchema,
    status: { enum: WORKFLOW_CONTROL_CHECKPOINT_STATES },
    resultHash: nullableHashSchema,
    cacheKeyHash: nullableHashSchema,
  },
  ['phase', 'observedAt', 'status', 'resultHash', 'cacheKeyHash'],
);

const observationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-control/v1/workflow-control-observation.v1.schema.json',
  title: 'OpenSlack Workflow Control credential-free observation v1',
  $comment:
    'Structural prefilter. Runtime validation additionally enforces UTF-8 byte bounds, inert values, unique phase names, canonical timestamps, and sensitive-field rejection.',
  ...strictObject(
    {
      schema: { const: WORKFLOW_CONTROL_OBSERVATION_SCHEMA },
      authority: { const: WORKFLOW_CONTROL_AUTHORITY },
      runId: { type: 'string', pattern: SAFE_ID_PATTERN },
      workflowName: {
        type: 'string',
        minLength: 1,
        maxLength: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxWorkflowNameBytes,
      },
      mode: { enum: WORKFLOW_CONTROL_EXECUTION_MODES },
      status: { enum: WORKFLOW_CONTROL_RUN_STATES },
      startedAt: timestampSchema,
      updatedAt: timestampSchema,
      manifestHash: hashSchema,
      currentPhase: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
          },
          { type: 'null' },
        ],
      },
      phases: {
        type: 'array',
        maxItems: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseCheckpoints,
        items: phaseSchema,
      },
      approvals: approvalsSchema,
      budget: budgetSchema,
    },
    [
      'schema',
      'authority',
      'runId',
      'workflowName',
      'mode',
      'status',
      'startedAt',
      'updatedAt',
      'manifestHash',
      'currentPhase',
      'phases',
      'approvals',
      'budget',
    ],
  ),
};

const readModelSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-control/v1/workflow-control-read-model.v1.schema.json',
  title: 'OpenSlack Workflow Control deterministic credential-free read model v1',
  ...strictObject(
    {
      schema: { const: WORKFLOW_CONTROL_READ_MODEL_SCHEMA },
      authority: { const: WORKFLOW_CONTROL_AUTHORITY },
      goRole: { const: WORKFLOW_CONTROL_GO_ROLE },
      authorityEligible: { const: false },
      runId: { type: 'string', pattern: SAFE_ID_PATTERN },
      workflowName: {
        type: 'string',
        minLength: 1,
        maxLength: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxWorkflowNameBytes,
      },
      mode: { enum: WORKFLOW_CONTROL_EXECUTION_MODES },
      status: { enum: WORKFLOW_CONTROL_RUN_STATES },
      startedAt: timestampSchema,
      updatedAt: timestampSchema,
      manifestHash: hashSchema,
      currentPhase: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
          },
          { type: 'null' },
        ],
      },
      terminal: { type: 'boolean' },
      phaseCounts: strictObject(
        {
          total: countSchema,
          completed: countSchema,
          failed: countSchema,
          skipped: countSchema,
          resultHashBound: countSchema,
          cacheKeyHashBound: countSchema,
        },
        ['total', 'completed', 'failed', 'skipped', 'resultHashBound', 'cacheKeyHashBound'],
      ),
      approvals: approvalsSchema,
      budget: strictObject(
        {
          configured: { type: 'boolean' },
          policyHash: nullableHashSchema,
          tokenBudget: {
            anyOf: [
              { type: 'integer', minimum: 0, maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens },
              { type: 'null' },
            ],
          },
          tokensUsed: {
            type: 'integer',
            minimum: 0,
            maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
          },
          costUsd: {
            anyOf: [
              { type: 'number', minimum: 0, maximum: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCostUsd },
              { type: 'null' },
            ],
          },
          agentCalls: countSchema,
          warningCounts: strictObject({ threshold: countSchema, exceeded: countSchema }, [
            'threshold',
            'exceeded',
          ]),
        },
        [
          'configured',
          'policyHash',
          'tokenBudget',
          'tokensUsed',
          'costUsd',
          'agentCalls',
          'warningCounts',
        ],
      ),
      qualificationGaps: {
        type: 'array',
        prefixItems: WORKFLOW_CONTROL_QUALIFICATION_GAPS.map((value) => ({ const: value })),
        minItems: WORKFLOW_CONTROL_QUALIFICATION_GAPS.length,
        maxItems: WORKFLOW_CONTROL_QUALIFICATION_GAPS.length,
      },
      observationHash: hashSchema,
    },
    [
      'schema',
      'authority',
      'goRole',
      'authorityEligible',
      'runId',
      'workflowName',
      'mode',
      'status',
      'startedAt',
      'updatedAt',
      'manifestHash',
      'currentPhase',
      'terminal',
      'phaseCounts',
      'approvals',
      'budget',
      'qualificationGaps',
      'observationHash',
    ],
  ),
};

function baseObservation(): WorkflowControlObservation {
  return validateWorkflowControlObservation({
    schema: WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
    authority: WORKFLOW_CONTROL_AUTHORITY,
    runId: 'run-gs7-001',
    workflowName: 'contract-delivery-lite',
    mode: 'execute',
    status: 'running',
    startedAt: '2026-08-03T01:00:00.000Z',
    updatedAt: '2026-08-03T01:02:00.000Z',
    manifestHash: 'a'.repeat(64),
    currentPhase: 'verify',
    phases: [
      {
        phase: 'discover',
        observedAt: '2026-08-03T01:01:00.000Z',
        status: 'completed',
        resultHash: 'b'.repeat(64),
        cacheKeyHash: 'c'.repeat(64),
      },
      {
        phase: 'verify',
        observedAt: '2026-08-03T01:02:00.000Z',
        status: 'skipped',
        resultHash: null,
        cacheKeyHash: null,
      },
    ],
    approvals: {
      legacyRunGate: {
        plane: 'legacy-run-gate',
        semantics: 'run-gate-only',
        counts: { pending: 1, approved: 2, rejected: 0 },
      },
      effectV2: {
        plane: 'workflow-effect-v2',
        semantics: 'effect-decision-only',
        schema: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
        counts: { pending: 2, approved: 1, rejected: 1 },
      },
    },
    budget: {
      configured: true,
      policyHash: 'd'.repeat(64),
      tokenBudget: 10_000,
      tokensUsed: 8_000,
      costUsd: 1.25,
      agentCalls: 3,
      warnings: [
        {
          observedAt: '2026-08-03T01:02:00.000Z',
          kind: 'threshold',
          tokensUsed: 8_000,
          tokenBudget: 10_000,
          percent: 0.8,
          costUsd: 1.25,
        },
      ],
    },
  });
}

function errorOf(operation: () => unknown): JsonRecord {
  try {
    operation();
  } catch (error) {
    if (error instanceof WorkflowControlContractError) {
      return { name: error.name, code: error.code, path: error.path, message: error.message };
    }
    throw error;
  }
  throw new Error('Golden error case unexpectedly succeeded.');
}

function goldenVectors(): JsonRecord {
  const base = baseObservation();
  const terminal = validateWorkflowControlObservation({
    ...base,
    status: 'completed',
    currentPhase: null,
    updatedAt: '2026-08-03T01:03:00.000Z',
  });
  const invalidSchema = { ...base, schema: 'openslack.workflow_control_observation.v0' };
  const invalidStatus = { ...base, status: 'waiting' };
  const planeMismatch = {
    ...base,
    approvals: {
      ...base.approvals,
      legacyRunGate: { ...base.approvals.legacyRunGate, plane: 'workflow-effect-v2' },
    },
  };
  const sensitive = { ...base, args: { apiKey: 'not-for-golden-export' } };
  const unicodeAndNumberEdges = validateWorkflowControlObservation({
    ...base,
    workflowName: 'control-\u0000\u0007\u000b\u001f\u007f-😀',
    currentPhase: '阶段-\u000b-😀',
    phases: [
      {
        ...base.phases[0],
        phase: '阶段-\u000b-😀',
      },
    ],
    budget: {
      ...base.budget,
      costUsd: 1e-7,
      warnings: [
        {
          ...base.budget.warnings[0],
          percent: 0.000001,
          costUsd: 1e-7,
        },
      ],
    },
  });
  const tooManyPhases = {
    ...base,
    phases: Array.from(
      { length: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseCheckpoints + 1 },
      (_, index) => ({
        phase: `phase-${index}`,
        observedAt: '2026-08-03T01:01:00.000Z',
        status: 'completed',
        resultHash: null,
        cacheKeyHash: null,
      }),
    ),
  };
  return {
    schema: 'openslack.workflow_control_golden_vectors.v1',
    authority: WORKFLOW_CONTROL_AUTHORITY,
    hashAlgorithm: 'sha256(canonical-json-utf8)',
    cases: [
      {
        id: 'valid-projection',
        operation: 'project',
        input: base,
        expected: projectWorkflowControlReadModel(base),
      },
      {
        id: 'terminal-run-projection',
        operation: 'project',
        input: terminal,
        expected: projectWorkflowControlReadModel(terminal),
      },
      {
        id: 'invalid-schema',
        operation: 'validate',
        input: invalidSchema,
        expectedError: errorOf(() => validateWorkflowControlObservation(invalidSchema)),
      },
      {
        id: 'invalid-status',
        operation: 'validate',
        input: invalidStatus,
        expectedError: errorOf(() => validateWorkflowControlObservation(invalidStatus)),
      },
      {
        id: 'invalid-terminal-transition',
        operation: 'transition',
        input: { from: 'completed', to: 'running' },
        expectedError: errorOf(() => validateWorkflowControlTransition('completed', 'running')),
      },
      {
        id: 'legacy-run-gate-is-not-effect-approval',
        operation: 'validate',
        input: planeMismatch,
        expectedError: errorOf(() => validateWorkflowControlObservation(planeMismatch)),
      },
      {
        id: 'secret-like-raw-field-rejected',
        operation: 'validate',
        input: sensitive,
        expectedError: errorOf(() => validateWorkflowControlObservation(sensitive)),
      },
      {
        id: 'phase-bound-enforced',
        operation: 'validate',
        input: tooManyPhases,
        expectedError: errorOf(() => validateWorkflowControlObservation(tooManyPhases)),
      },
      {
        id: 'valid-observation-full-sha256',
        operation: 'hash',
        input: base,
        expected: hashWorkflowControlValue(base),
      },
      {
        id: 'unicode-control-and-number-edge-sha256',
        operation: 'hash',
        input: unicodeAndNumberEdges,
        expected: hashWorkflowControlValue(unicodeAndNumberEdges),
      },
    ],
  };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), { parser: 'json', printWidth: 100, tabWidth: 2 }),
    'utf8',
  );
}

async function buildOutputs(): Promise<Map<string, Buffer>> {
  const outputs = new Map<string, Buffer>();
  outputs.set(expectedPaths[0], await prettyJson(observationSchema));
  outputs.set(expectedPaths[1], await prettyJson(readModelSchema));
  outputs.set(expectedPaths[2], await prettyJson(goldenVectors()));
  const artifacts = Object.fromEntries(
    [...outputs.entries()].map(([path, bytes]) => [
      path,
      { path, byteLength: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  );
  outputs.set(
    expectedPaths[3],
    await prettyJson({
      schema: 'openslack.workflow_control_contract_manifest.v1',
      contractVersion: 'v1',
      authority: WORKFLOW_CONTROL_AUTHORITY,
      authorityBoundary: {
        writer: '@openslack/workflows',
        localStore: '.openslack.local/workflows/runs',
        typescriptRemainsSoleWriter: true,
        goRole: WORKFLOW_CONTROL_GO_ROLE,
        authorityEligible: false,
      },
      observedBehavior: {
        productionInitialState: WORKFLOW_CONTROL_PRODUCTION_INITIAL_STATE,
        dormantStatesWithoutProductionWriter: WORKFLOW_CONTROL_DORMANT_STATES,
        states: WORKFLOW_CONTROL_RUN_STATES,
        transitions: WORKFLOW_CONTROL_STATE_TRANSITIONS,
        checkpointStates: WORKFLOW_CONTROL_CHECKPOINT_STATES,
        checkpointPersistenceAtomic: false,
        controlPathsCanBypassTransitionTable: true,
        budgetWarningKinds: ['threshold', 'exceeded'],
      },
      approvalPlanes: {
        legacyRunGate: {
          persistedAs: 'pending-approvals.json',
          semantics: 'run-gate-only',
          statuses: WORKFLOW_CONTROL_APPROVAL_STATES,
          effectDecisionAuthority: false,
        },
        effectV2: {
          schema: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
          semantics: 'effect-decision-only',
          statuses: WORKFLOW_CONTROL_APPROVAL_STATES,
          normative: true,
        },
        interchangeable: false,
      },
      projectionBoundary: {
        credentialFree: true,
        allowedSensitiveRepresentations: ['sha256-hash', 'status-count'],
        forbiddenRawFields: WORKFLOW_CONTROL_FORBIDDEN_RAW_FIELDS,
      },
      canonicalization: {
        encoding: 'utf-8',
        objectKeys: 'lexicographic-ecmascript-code-unit',
        hash: 'sha256(canonical-json-utf8)',
        hashHexLength: 64,
      },
      limits: WORKFLOW_CONTROL_CONTRACT_LIMITS,
      errorCodes: WORKFLOW_CONTROL_CONTRACT_ERROR_CODES,
      qualificationGaps: WORKFLOW_CONTROL_QUALIFICATION_GAPS,
      deferred: {
        gs8: 'JS runner worker protocol, scheduling, lease, cancellation receipts',
        gs9: 'PostgreSQL authority cutover for checkpoint, approval, and budget state',
      },
      artifacts,
      bundleFiles: expectedPaths,
    }),
  );
  return outputs;
}

function ensureInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) {
    throw new Error(`Output path escapes the contract root: ${candidate}`);
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    ensureInside(root, absolute);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) throw new Error(`Contract bundle rejects symlink ${absolute}.`);
    if (stats.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (stats.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error(`Contract bundle rejects non-file entry ${absolute}.`);
  }
  return files.sort();
}

async function writeOutputs(root: string, outputs: Map<string, Buffer>): Promise<void> {
  for (const [path, bytes] of outputs) {
    const absolute = resolve(root, path);
    ensureInside(root, absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}

async function checkOutputs(root: string, outputs: Map<string, Buffer>): Promise<void> {
  const actualPaths = await listFiles(root);
  const wantedPaths = [...outputs.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(wantedPaths)) {
    throw new Error(
      `Workflow Control contract file inventory drift. Expected ${wantedPaths.join(', ')}, got ${actualPaths.join(', ')}.`,
    );
  }
  for (const [path, expected] of outputs) {
    const actual = await readFile(resolve(root, path));
    if (!actual.equals(expected)) {
      throw new Error(`Workflow Control exact-byte contract drift: ${path}.`);
    }
  }
}

const outputs = await buildOutputs();
if (process.argv.includes('--check')) {
  await checkOutputs(contractRoot, outputs);
  await checkOutputs(serviceMirrorRoot, outputs);
  console.log(
    `Workflow Control contract bundle and Go mirror verified (${outputs.size} exact-byte files each).`,
  );
} else {
  await writeOutputs(contractRoot, outputs);
  await writeOutputs(serviceMirrorRoot, outputs);
  console.log(
    `Workflow Control contract bundle and Go mirror generated (${outputs.size} exact-byte files each).`,
  );
}
