import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

// Explicit wire-field rules. Embedded historical frames remain exact strings;
// their existing frozen validators perform contextual identity/hash checks.
type Rule = Record<string, unknown>;
const object = (properties: Record<string, Rule>): Rule => ({
  type: 'object',
  additionalProperties: false,
  unevaluatedProperties: false,
  required: Object.keys(properties),
  properties,
});
const text = { type: 'string', minLength: 1 };
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$' };
const hash = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const bindingId = { type: 'string', pattern: '^WFRUNNER-BINDING-[0-9a-f]{64}$' };
const positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const generation = { ...positive, minimum: 0 };
const timestamp = {
  type: 'string',
  format: 'date-time',
  pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$',
};
const nullableText = { type: ['string', 'null'], minLength: 1 };
const outcome = { enum: ['committed', 'not_committed'] };
const proofKind = {
  enum: ['resolution', 'source_receipt', 'source_fence', 'budget_source_result'],
};
const request = object({
  schema: { const: 'openslack.workflow_runner_binding_reconciliation.v1' },
  workspaceId: id,
  runId: id,
  bindingId,
  stageHash: hash,
  outcome,
  rulesVersion: { const: 1 },
});
const settlement = {
  ...object({
    schema: { const: 'openslack.workflow_runner_binding_settlement_receipt.v1' },
    workspaceId: id,
    runId: id,
    bindingId,
    stageHash: hash,
    outcome,
    proofKind,
    proof: text,
    idempotencyKey: {
      type: 'string',
      pattern: '^openslack\\.workflow-runner-reconciliation\\.v1\\.[0-9a-f]{64}$',
    },
    requestHash: hash,
    callerId: id,
    rulesVersion: { const: 1 },
    committedAt: timestamp,
  }),
  oneOf: [
    { properties: { outcome: { const: 'not_committed' }, proofKind: { const: 'source_fence' } } },
    {
      properties: {
        outcome: { const: 'committed' },
        proofKind: { enum: ['resolution', 'source_receipt', 'budget_source_result'] },
      },
    },
  ],
};
const binding = object({
  bindingId,
  state: {
    enum: [
      'staged',
      'resolved',
      'runner_committed',
      'completed',
      'aborted',
      'reconciliation_required',
    ],
  },
  stage: text,
  stageReceipt: text,
  resolution: nullableText,
  resolutionReceipt: nullableText,
});
const diagnostic = object({
  bindingId,
  operation: {
    enum: [
      'checkpoint_commit',
      'resume_advance',
      'effect_authorize',
      'effect_complete',
      'budget_reserve',
      'budget_settle',
    ],
  },
  state: { enum: ['staged', 'resolved', 'runner_committed', 'aborted', 'reconciliation_required'] },
});
const key = {
  type: 'string',
  pattern:
    '^(attempt\\.[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}|(binding|diagnostic|settlement)\\.WFRUNNER-BINDING-[0-9a-f]{64})$',
};
const record = {
  oneOf: [
    ['binding', binding],
    ['diagnostic', diagnostic],
    ['settlement', text],
    ['active_attempt', id],
  ].map(([kind, value]) => object({ key, kind: { const: kind }, value: value as Rule })),
};
const schemas: Record<string, Rule> = {
  BindingReconciliationRequest: request,
  BindingSettlementReceipt: settlement,
  BindingReconciliationPreview: object({
    schema: { const: 'openslack.workflow_runner_binding_reconciliation_preview.v1' },
    workspaceId: id,
    runId: id,
    items: {
      type: 'array',
      items: object({
        bindingId,
        stageHash: hash,
        outcome: { enum: ['committed', 'not_committed', 'unknown'] },
        code: {
          enum: [
            'WORKFLOW_RUNNER_BINDING_SETTLED',
            'WORKFLOW_RUNNER_BINDING_RECONCILABLE',
            'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',
          ],
        },
        proofKind: { enum: ['', ...proofKind.enum] },
        receipt: nullableText,
      }),
    },
    nextCursor: { ...bindingId, type: ['string', 'null'] },
  }),
  RecoveryEvidenceV2: object({
    schema: { const: 'openslack.workflow_runner_recovery_evidence.v2' },
    workspaceId: id,
    runId: id,
    route: object({
      backend: { const: 'go' },
      authority: { const: 'workflow-control' },
      routingEpoch: positive,
      authorityBuildHash: hash,
    }),
    complete: { type: 'boolean' },
    snapshot: hash,
    nextCursor: { ...key, type: ['string', 'null'] },
    records: { type: 'array', items: record },
  }),
  RecoveryPauseRequest: object({
    schema: { const: 'openslack.workflow_runner_recovery_pause.v1' },
    workspaceId: id,
    runId: id,
    expectedRevision: positive,
    expectedRecordHash: hash,
  }),
  RecoveryPauseReceipt: object({
    schema: { const: 'openslack.workflow_runner_recovery_pause_receipt.v1' },
    workspaceId: id,
    runId: id,
    expectedRevision: positive,
    acceptedRevision: positive,
    resumeGeneration: generation,
    priorRecordHash: hash,
    record: text,
    recordHash: hash,
    committedAt: timestamp,
  }),
};
// A recovery version is a positive PostgreSQL BIGINT serialized without JS rounding.
const maxVersion = '9223372036854775807';
const versionAlternatives = ['[1-9][0-9]{0,17}', maxVersion];
for (let index = 0; index < maxVersion.length; index++) {
  const minimum = index === 0 ? 1 : 0,
    last = Number(maxVersion[index]) - 1;
  if (last < minimum) continue;
  const digit = last === minimum ? String(minimum) : '[' + minimum + '-' + last + ']';
  versionAlternatives.push(
    maxVersion.slice(0, index) + digit + '[0-9]{' + (maxVersion.length - index - 1) + '}',
  );
}
const v3Schemas = {
  RecoveryEvidenceV3: object({
    ...(schemas.RecoveryEvidenceV2!.properties as Record<string, Rule>),
    schema: { const: 'openslack.workflow_runner_recovery_evidence.v3' },
    recoveryVersion: { type: 'string', pattern: '^(?:' + versionAlternatives.join('|') + ')$' },
    readAt: timestamp,
  }),
};
const allSchemas = { ...schemas, ...v3Schemas };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pretty = async (value: unknown) =>
  format(JSON.stringify(value), {
    ...(await resolveConfig(resolve(root, 'package.json'))),
    parser: 'json',
  });
const bundle = 'packages/workflows/contracts/workflow-recovery/v2';
const outputs = new Map<string, string>();
const schemaBytes = await pretty(schemas);
const allSchemaBytes = await pretty(allSchemas);
const v3SchemaBytes = await pretty(v3Schemas);
outputs.set(`${bundle}/schemas.json`, schemaBytes);
outputs.set(
  'services/workflow-control/internal/runnerstore/recovery_contract.generated.go',
  `// Code generated by scripts/workflow-recovery-contracts/index.ts; DO NOT EDIT.\npackage runnerstore\n\n// RecoverySchemasJSON mirrors the explicit TS recovery wire rules.\nconst RecoverySchemasJSON = \`${allSchemaBytes}\`\n`,
);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
const requestValue = {
  schema: 'openslack.workflow_runner_binding_reconciliation.v1',
  workspaceId: 'workspace.test',
  runId: 'run.test',
  bindingId: 'WFRUNNER-BINDING-' + 'a'.repeat(64),
  stageHash: 'b'.repeat(64),
  outcome: 'not_committed',
  rulesVersion: 1,
};
const requestHash = createHash('sha256')
  .update(canonical(requestValue) + '\n')
  .digest('hex');
const receiptValue = {
  ...requestValue,
  schema: 'openslack.workflow_runner_binding_settlement_receipt.v1',
  proofKind: 'source_fence',
  proof: '{}\n',
  idempotencyKey: 'openslack.workflow-runner-reconciliation.v1.' + requestHash,
  requestHash,
  callerId: 'caller.test',
  committedAt: '2026-09-07T00:00:00.000Z',
};
const vectors: unknown[] = [];
for (const [schema, value] of [
  ['BindingReconciliationRequest', requestValue],
  ['BindingSettlementReceipt', receiptValue],
] as const) {
  const cases: [string, unknown, boolean][] = [
    ['valid', value, true],
    ['unknown field', { ...value, unrelated: 1 }, false],
    ['null run', { ...value, runId: null }, false],
    ['unknown outcome', { ...value, outcome: 'unknown' }, false],
    ['future rules', { ...value, rulesVersion: 2 }, false],
    ['unsafe identity', { ...value, workspaceId: '../workspace' }, false],
  ];
  if (schema === 'BindingSettlementReceipt')
    cases.push(
      ['invalid date', { ...value, committedAt: '2026-02-30T00:00:00.000Z' }, false],
      ['wrong proof category', { ...value, proofKind: 'source_receipt' }, false],
    );
  for (const [name, value, valid] of cases)
    vectors.push({ schema, name, valid, bytes: canonical(value) + '\n' });
}
const vectorBytes = await pretty(vectors);
outputs.set(`${bundle}/golden-vectors.json`, vectorBytes);
outputs.set(
  `${bundle}/manifest.json`,
  await pretty({
    schema: 'openslack.workflow_recovery_contract.v2',
    minimumWriteSchemaVersion: 10,
    readSchemas: [
      'openslack.workflow_runner_recovery_evidence.v1',
      'openslack.workflow_runner_recovery_evidence.v2',
    ],
    maxResponseBytes: 2097152,
    artifacts: {
      'schemas.json': createHash('sha256').update(schemaBytes).digest('hex'),
      'golden-vectors.json': createHash('sha256').update(vectorBytes).digest('hex'),
    },
  }),
);
const v3Bundle = 'packages/workflows/contracts/workflow-recovery/v3';
const v3Value = {
  schema: 'openslack.workflow_runner_recovery_evidence.v3',
  workspaceId: 'workspace.test',
  runId: 'run.test',
  route: {
    backend: 'go',
    authority: 'workflow-control',
    routingEpoch: 1,
    authorityBuildHash: 'c'.repeat(64),
  },
  complete: true,
  nextCursor: null,
  records: [],
  recoveryVersion: '9007199254740993',
  readAt: '2026-09-08T00:00:00.000Z',
  snapshot: '',
};
v3Value.snapshot = createHash('sha256')
  .update(
    canonical([
      v3Value.schema,
      v3Value.workspaceId,
      v3Value.runId,
      '',
      v3Value.route,
      v3Value.recoveryVersion,
      v3Value.readAt,
    ]),
  )
  .digest('hex');
const v3Vectors = [
  { name: 'positive BIGINT above JS safe integer', value: v3Value, valid: true },
  ...['0', '-1', '01', '9223372036854775808', '1e3'].map((version) => ({
    name: 'invalid version ' + version,
    value: { ...v3Value, recoveryVersion: version },
    valid: false,
  })),
  ...['2026-02-30T00:00:00.000Z', '2026-09-08T00:00:00Z', '2026-09-08T08:00:00.000+08:00'].map(
    (readAt) => ({
      name: 'invalid read point ' + readAt,
      value: { ...v3Value, readAt },
      valid: false,
    }),
  ),
  { name: 'unknown field', value: { ...v3Value, extra: 1 }, valid: false },
].map(({ name, value, valid }) => ({
  schema: 'RecoveryEvidenceV3',
  name,
  valid,
  bytes: canonical(value) + '\n',
}));
const v3VectorBytes = await pretty(v3Vectors);
outputs.set(v3Bundle + '/schemas.json', v3SchemaBytes);
outputs.set(v3Bundle + '/golden-vectors.json', v3VectorBytes);
outputs.set(
  v3Bundle + '/manifest.json',
  await pretty({
    schema: 'openslack.workflow_recovery_contract.v3',
    minimumWriteSchemaVersion: 10,
    minimumV3ReadSchemaVersion: 11,
    accept: 'application/vnd.openslack.workflow-run-recovery-evidence.v3+json',
    readSchemas: ['v1', 'v2', 'v3'].map(
      (version) => 'openslack.workflow_runner_recovery_evidence.' + version,
    ),
    maxResponseBytes: 2097152,
    artifacts: {
      'schemas.json': createHash('sha256').update(v3SchemaBytes).digest('hex'),
      'golden-vectors.json': createHash('sha256').update(v3VectorBytes).digest('hex'),
    },
  }),
);
const openapiPath = 'services/workflow-control/docs/api/runner-openapi.yaml';
const current = await readFile(resolve(root, openapiPath), 'utf8');
const begin = '    # BEGIN GENERATED RECOVERY SCHEMAS';
const end = '    # END GENERATED RECOVERY SCHEMAS';
if (!current.includes(begin) || !current.includes(end))
  throw new Error('Missing recovery OpenAPI projection markers.');
const block = [
  begin,
  ...Object.entries(allSchemas).flatMap(([name, schema]) => [
    `    ${name}:`,
    ...JSON.stringify(schema, null, 2)
      .split('\n')
      .map((line) => `      ${line}`),
  ]),
  end,
].join('\n');
outputs.set(
  openapiPath,
  current.slice(0, current.indexOf(begin)) +
    block +
    current.slice(current.indexOf(end) + end.length),
);
if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--check'))
  throw new Error('Usage: workflow-recovery-contracts/index.ts [--check]');
for (const [path, bytes] of outputs) {
  const absolute = resolve(root, path);
  if (process.argv[2] === '--check') {
    if ((await readFile(absolute, 'utf8')) !== bytes)
      throw new Error(`Recovery contract drift: ${path}`);
  } else {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}
console.log(
  `Recovery contract ${process.argv[2] === '--check' ? 'verified' : 'generated'} (${outputs.size} files).`,
);
