import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  WORKFLOW_RUNNER_ADVANCEMENT_RULES,
  WORKFLOW_RUNNER_CANCEL_ACK_STATES,
  WORKFLOW_RUNNER_CANCEL_REASONS,
  WORKFLOW_RUNNER_CAPABILITIES,
  WORKFLOW_RUNNER_CONTRACT_ERROR_CODES,
  WORKFLOW_RUNNER_CONTRACT_LIMITS,
  WORKFLOW_RUNNER_DIRECTIONS,
  WORKFLOW_RUNNER_EFFECT_OUTCOMES,
  WORKFLOW_RUNNER_FINGERPRINT_SCHEMA,
  WORKFLOW_RUNNER_HANDSHAKE_KINDS,
  WORKFLOW_RUNNER_HEARTBEAT_STATES,
  WORKFLOW_RUNNER_IDEMPOTENCY_PREFIX,
  WORKFLOW_RUNNER_LEASE_REJECT_REASONS,
  WORKFLOW_RUNNER_MESSAGE_KINDS,
  WORKFLOW_RUNNER_PREPARED_SCHEMA,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  WORKFLOW_RUNNER_RECEIPT_IDENTITY_SCHEMA,
  WORKFLOW_RUNNER_RECEIPT_ERROR_CODES,
  WORKFLOW_RUNNER_RECEIPT_STATUSES,
  WORKFLOW_RUNNER_RECEIPTABLE_KINDS,
  WORKFLOW_RUNNER_RUNTIME_NAME,
  WORKFLOW_RUNNER_RUNTIME_VERSION_PATTERN,
  WORKFLOW_RUNNER_TERMINAL_REASONS,
  WORKFLOW_RUNNER_TERMINAL_STATES,
  WorkflowRunnerContractError,
  createWorkflowRunnerEventReceipt,
  parseWorkflowRunnerMessageBytes,
  prepareWorkflowRunnerMessage,
  validateWorkflowRunnerEventReceipt,
  validateWorkflowRunnerMessage,
  type WorkflowRunnerMessage,
} from '../../packages/workflows/src/workflow-runner-contract.js';

type JsonRecord = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const outputRoot =
  process.env.OPENSLACK_WORKFLOW_RUNNER_CONTRACTS_OUTPUT_ROOT === undefined
    ? repositoryRoot
    : resolve(process.env.OPENSLACK_WORKFLOW_RUNNER_CONTRACTS_OUTPUT_ROOT);
const contractRoot = resolve(outputRoot, 'packages/workflows/contracts/workflow-runner/v1');
const expectedPaths = Object.freeze([
  'schemas/workflow-runner-message.v1.schema.json',
  'schemas/workflow-runner-prepared-message.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

const HASH_PATTERN = '^[0-9a-f]{64}$';
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const CODE_PATTERN = '^[a-z0-9][a-z0-9._:-]{0,127}$';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

function strictObject(properties: JsonRecord, required: readonly string[]): JsonRecord {
  return { type: 'object', additionalProperties: false, properties, required };
}

const identifierSchema = { type: 'string', pattern: ID_PATTERN };
const hashSchema = { type: 'string', pattern: HASH_PATTERN };
const codeSchema = { type: 'string', pattern: CODE_PATTERN };
const timestampSchema = { type: 'string', pattern: TIMESTAMP_PATTERN };
const positiveSafeInteger = {
  type: 'integer',
  minimum: 1,
  maximum: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxSafeInteger,
};

const payloadSchemas: Readonly<Record<(typeof WORKFLOW_RUNNER_MESSAGE_KINDS)[number], JsonRecord>> =
  {
    hello: strictObject(
      {
        runtimeName: { const: WORKFLOW_RUNNER_RUNTIME_NAME },
        runtimeVersion: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          pattern: WORKFLOW_RUNNER_RUNTIME_VERSION_PATTERN,
        },
        runnerBuildHash: hashSchema,
        supportedProtocolVersions: {
          type: 'array',
          prefixItems: [{ const: WORKFLOW_RUNNER_PROTOCOL_VERSION }],
          minItems: 1,
          maxItems: 1,
        },
        capabilities: {
          type: 'array',
          uniqueItems: true,
          maxItems: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxCapabilities,
          items: { enum: WORKFLOW_RUNNER_CAPABILITIES },
        },
        maxConcurrentJobs: {
          type: 'integer',
          minimum: 1,
          maximum: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxConcurrentJobs,
        },
      },
      [
        'runtimeName',
        'runtimeVersion',
        'runnerBuildHash',
        'supportedProtocolVersions',
        'capabilities',
        'maxConcurrentJobs',
      ],
    ),
    hello_ack: strictObject(
      {
        controlBuildHash: hashSchema,
        selectedProtocolVersion: { const: WORKFLOW_RUNNER_PROTOCOL_VERSION },
        heartbeatIntervalMs: {
          type: 'integer',
          minimum: WORKFLOW_RUNNER_CONTRACT_LIMITS.minHeartbeatIntervalMs,
          maximum: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxHeartbeatIntervalMs,
        },
        leaseOfferTimeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxLeaseDurationMs,
        },
      },
      ['controlBuildHash', 'selectedProtocolVersion', 'heartbeatIntervalMs', 'leaseOfferTimeoutMs'],
    ),
    lease_offer: strictObject(
      {
        executionDescriptorRef: identifierSchema,
        executionDescriptorHash: hashSchema,
        jobSpecHash: hashSchema,
        workflowId: identifierSchema,
        workflowVersion: identifierSchema,
        workflowSourceHash: hashSchema,
        manifestHash: hashSchema,
        inputHash: hashSchema,
        offeredAt: timestampSchema,
        expiresAt: timestampSchema,
      },
      [
        'executionDescriptorRef',
        'executionDescriptorHash',
        'jobSpecHash',
        'workflowId',
        'workflowVersion',
        'workflowSourceHash',
        'manifestHash',
        'inputHash',
        'offeredAt',
        'expiresAt',
      ],
    ),
    lease_accept: strictObject({ acceptedAt: timestampSchema, leaseExpiresAt: timestampSchema }, [
      'acceptedAt',
      'leaseExpiresAt',
    ]),
    lease_reject: strictObject(
      { rejectedAt: timestampSchema, reason: { enum: WORKFLOW_RUNNER_LEASE_REJECT_REASONS } },
      ['rejectedAt', 'reason'],
    ),
    heartbeat: strictObject(
      {
        observedAt: timestampSchema,
        leaseExpiresAt: timestampSchema,
        state: { enum: WORKFLOW_RUNNER_HEARTBEAT_STATES },
        lastReceiptSequence: {
          type: 'integer',
          minimum: 0,
          maximum: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxSafeInteger,
        },
      },
      ['observedAt', 'leaseExpiresAt', 'state', 'lastReceiptSequence'],
    ),
    effect_intent: strictObject(
      {
        effectId: identifierSchema,
        effectKind: codeSchema,
        effectHash: hashSchema,
        capabilityHash: hashSchema,
        requiresHumanDecision: { type: 'boolean' },
      },
      ['effectId', 'effectKind', 'effectHash', 'capabilityHash', 'requiresHumanDecision'],
    ),
    effect_outcome: strictObject(
      {
        effectId: identifierSchema,
        status: { enum: WORKFLOW_RUNNER_EFFECT_OUTCOMES },
        outcomeHash: hashSchema,
      },
      ['effectId', 'status', 'outcomeHash'],
    ),
    cancel_request: strictObject(
      {
        cancelId: identifierSchema,
        requestedAt: timestampSchema,
        expiresAt: timestampSchema,
        reason: { enum: WORKFLOW_RUNNER_CANCEL_REASONS },
      },
      ['cancelId', 'requestedAt', 'expiresAt', 'reason'],
    ),
    cancel_ack: strictObject(
      {
        cancelId: identifierSchema,
        acknowledgedAt: timestampSchema,
        status: { enum: WORKFLOW_RUNNER_CANCEL_ACK_STATES },
      },
      ['cancelId', 'acknowledgedAt', 'status'],
    ),
    terminal: {
      ...strictObject(
        {
          status: { enum: WORKFLOW_RUNNER_TERMINAL_STATES },
          finishedAt: timestampSchema,
          resultHash: { anyOf: [hashSchema, { type: 'null' }] },
          terminalReason: {
            anyOf: [{ enum: WORKFLOW_RUNNER_TERMINAL_REASONS }, { type: 'null' }],
          },
        },
        ['status', 'finishedAt', 'resultHash', 'terminalReason'],
      ),
      allOf: [
        {
          if: { properties: { status: { const: 'completed' } }, required: ['status'] },
          then: {
            properties: { resultHash: hashSchema, terminalReason: { type: 'null' } },
          },
        },
        {
          if: { properties: { status: { const: 'failed' } }, required: ['status'] },
          then: {
            properties: {
              resultHash: { type: 'null' },
              terminalReason: { enum: ['workflow_failed', 'process_crash'] },
            },
          },
        },
        {
          if: { properties: { status: { const: 'cancelled' } }, required: ['status'] },
          then: {
            properties: {
              resultHash: { type: 'null' },
              terminalReason: { const: 'cancelled_by_control' },
            },
          },
        },
        {
          if: { properties: { status: { const: 'timed_out' } }, required: ['status'] },
          then: {
            properties: { resultHash: { type: 'null' }, terminalReason: { const: 'timeout' } },
          },
        },
        {
          if: {
            properties: { status: { const: 'reconciliation_required' } },
            required: ['status'],
          },
          then: {
            properties: {
              resultHash: { type: 'null' },
              terminalReason: { const: 'commit_outcome_unknown' },
            },
          },
        },
      ],
    },
    event_receipt: {
      ...strictObject(
        {
          receivedEventId: identifierSchema,
          receivedKind: { enum: WORKFLOW_RUNNER_RECEIPTABLE_KINDS },
          receivedSequence: positiveSafeInteger,
          receivedDigest: hashSchema,
          receivedIdempotencyKey: {
            type: 'string',
            pattern: '^openslack\\.workflow-runner\\.v1\\.[0-9a-f]{64}$',
          },
          receivedFingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          status: { enum: WORKFLOW_RUNNER_RECEIPT_STATUSES },
          controlBuildHash: hashSchema,
          committedAt: timestampSchema,
          errorCode: {
            anyOf: [{ enum: WORKFLOW_RUNNER_RECEIPT_ERROR_CODES }, { type: 'null' }],
          },
        },
        [
          'receivedEventId',
          'receivedKind',
          'receivedSequence',
          'receivedDigest',
          'receivedIdempotencyKey',
          'receivedFingerprint',
          'status',
          'controlBuildHash',
          'committedAt',
          'errorCode',
        ],
      ),
      allOf: [
        {
          if: {
            properties: { status: { const: 'reconciliation_required' } },
            required: ['status'],
          },
          then: { properties: { errorCode: { enum: WORKFLOW_RUNNER_RECEIPT_ERROR_CODES } } },
          else: { properties: { errorCode: { type: 'null' } } },
        },
      ],
    },
  };

const envelopeFields = [
  'protocolVersion',
  'kind',
  'workspaceId',
  'jobId',
  'workflowRunId',
  'attemptId',
  'leaseId',
  'fencingToken',
  'sequence',
  'eventId',
  'correlationId',
  'sentAt',
  'payload',
] as const;

function envelopeSchema(kind: (typeof WORKFLOW_RUNNER_MESSAGE_KINDS)[number]): JsonRecord {
  const handshake = WORKFLOW_RUNNER_HANDSHAKE_KINDS.includes(kind as 'hello');
  const identitySchema = handshake ? { type: 'null' } : identifierSchema;
  const counterSchema = handshake ? { type: 'null' } : positiveSafeInteger;
  return strictObject(
    {
      protocolVersion: { const: WORKFLOW_RUNNER_PROTOCOL_VERSION },
      kind: { const: kind },
      workspaceId: identifierSchema,
      jobId: identitySchema,
      workflowRunId: identitySchema,
      attemptId: identitySchema,
      leaseId: identitySchema,
      fencingToken: counterSchema,
      sequence: counterSchema,
      eventId: identifierSchema,
      correlationId: identifierSchema,
      sentAt: timestampSchema,
      payload: payloadSchemas[kind],
    },
    envelopeFields,
  );
}

const messageSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-runner/v1/workflow-runner-message.v1.schema.json',
  title: 'OpenSlack GS8-A closed JavaScript runner protocol message v1',
  $comment:
    'Runtime validation additionally enforces canonical timestamps, UTF-8 byte bounds, lease duration bounds, inert values, receipt bindings, and exact canonical JSON plus one LF.',
  oneOf: WORKFLOW_RUNNER_MESSAGE_KINDS.map(envelopeSchema),
};

const preparedMessageSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-runner/v1/workflow-runner-prepared-message.v1.schema.json',
  title: 'OpenSlack GS8-A exact-byte prepared runner message v1',
  ...strictObject(
    {
      schema: { const: WORKFLOW_RUNNER_PREPARED_SCHEMA },
      body: {
        type: 'string',
        minLength: 2,
        maxLength: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes,
        pattern: '^[^\\r\\n]*(?:\\n)$',
      },
      messageDigest: hashSchema,
      idempotencyKey: {
        type: 'string',
        pattern: '^openslack\\.workflow-runner\\.v1\\.[0-9a-f]{64}$',
      },
      requestFingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    },
    ['schema', 'body', 'messageDigest', 'idempotencyKey', 'requestFingerprint'],
  ),
};

const hash = (character: string): string => character.repeat(64);

function handshakeBase(kind: 'hello' | 'hello_ack', payload: JsonRecord): JsonRecord {
  return {
    protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
    kind,
    workspaceId: 'workspace.demo',
    jobId: null,
    workflowRunId: null,
    attemptId: null,
    leaseId: null,
    fencingToken: null,
    sequence: null,
    eventId: `event.${kind}.001`,
    correlationId: 'correlation.gs8.001',
    sentAt: '2026-08-03T02:00:00.000Z',
    payload,
  };
}

function leaseBase(
  kind: Exclude<(typeof WORKFLOW_RUNNER_MESSAGE_KINDS)[number], 'hello' | 'hello_ack'>,
  sequence: number,
  payload: JsonRecord,
): JsonRecord {
  return {
    protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
    kind,
    workspaceId: 'workspace.demo',
    jobId: 'job.gs8.001',
    workflowRunId: 'run.gs8.001',
    attemptId: 'attempt.001',
    leaseId: 'lease.001',
    fencingToken: 7,
    sequence,
    eventId: `event.${kind}.${String(sequence).padStart(3, '0')}`,
    correlationId: 'correlation.gs8.001',
    sentAt: `2026-08-03T02:00:${String(sequence).padStart(2, '0')}.000Z`,
    payload,
  };
}

function positiveMessages(): WorkflowRunnerMessage[] {
  const messages: WorkflowRunnerMessage[] = [
    validateWorkflowRunnerMessage(
      handshakeBase('hello', {
        runtimeName: 'node',
        runtimeVersion: '22.14.0',
        runnerBuildHash: hash('a'),
        supportedProtocolVersions: [WORKFLOW_RUNNER_PROTOCOL_VERSION],
        capabilities: ['cancel_ack', 'effect_receipts', 'lease_heartbeat'],
        maxConcurrentJobs: 4,
      }),
    ),
    validateWorkflowRunnerMessage(
      handshakeBase('hello_ack', {
        controlBuildHash: hash('b'),
        selectedProtocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
        heartbeatIntervalMs: 5_000,
        leaseOfferTimeoutMs: 30_000,
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('lease_offer', 1, {
        executionDescriptorRef: 'sealed.workflow.gs8.001',
        executionDescriptorHash: hash('c'),
        jobSpecHash: hash('6'),
        workflowId: 'contract-to-delivery-lite',
        workflowVersion: 'v1',
        workflowSourceHash: hash('d'),
        manifestHash: hash('e'),
        inputHash: hash('f'),
        offeredAt: '2026-08-03T02:00:01.000Z',
        expiresAt: '2026-08-03T02:01:01.000Z',
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('lease_accept', 2, {
        acceptedAt: '2026-08-03T02:00:02.000Z',
        leaseExpiresAt: '2026-08-03T02:05:02.000Z',
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('lease_reject', 3, {
        rejectedAt: '2026-08-03T02:00:03.000Z',
        reason: 'busy',
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('heartbeat', 4, {
        observedAt: '2026-08-03T02:00:04.000Z',
        leaseExpiresAt: '2026-08-03T02:05:04.000Z',
        state: 'running',
        lastReceiptSequence: 3,
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('effect_intent', 5, {
        effectId: 'effect.001',
        effectKind: 'collaboration.event',
        effectHash: hash('1'),
        capabilityHash: hash('2'),
        requiresHumanDecision: true,
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('effect_outcome', 6, {
        effectId: 'effect.001',
        status: 'executed',
        outcomeHash: hash('3'),
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('cancel_request', 7, {
        cancelId: 'cancel.001',
        requestedAt: '2026-08-03T02:00:07.000Z',
        expiresAt: '2026-08-03T02:01:07.000Z',
        reason: 'operator',
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('cancel_ack', 8, {
        cancelId: 'cancel.001',
        acknowledgedAt: '2026-08-03T02:00:08.000Z',
        status: 'cancelling',
      }),
    ),
    validateWorkflowRunnerMessage(
      leaseBase('terminal', 9, {
        status: 'completed',
        finishedAt: '2026-08-03T02:00:09.000Z',
        resultHash: hash('4'),
        terminalReason: null,
      }),
    ),
  ];
  messages.push(
    createWorkflowRunnerEventReceipt(messages[5], {
      sequence: 10,
      sentAt: '2026-08-03T02:00:10.000Z',
      status: 'accepted',
      controlBuildHash: hash('7'),
      errorCode: null,
    }),
  );
  return messages;
}

function errorOf(operation: () => unknown): JsonRecord {
  try {
    operation();
  } catch (error) {
    if (error instanceof WorkflowRunnerContractError) {
      return { name: error.name, code: error.code, path: error.path, message: error.message };
    }
    throw error;
  }
  throw new Error('Negative workflow runner vector unexpectedly succeeded.');
}

function goldenVectors(): JsonRecord {
  const messages = positiveMessages();
  const hello = messages[0]!;
  const offer = messages[2]!;
  const heartbeat = messages[5]!;
  const cancelRequest = messages[8]!;
  const controlBuildHash = hash('7');
  const receiptable = messages.filter((message) =>
    WORKFLOW_RUNNER_RECEIPTABLE_KINDS.includes(
      message.kind as (typeof WORKFLOW_RUNNER_RECEIPTABLE_KINDS)[number],
    ),
  );
  const receipts = receiptable.map((received, index) => {
    const status = index === 1 ? 'duplicate' : index === 6 ? 'reconciliation_required' : 'accepted';
    const receipt = createWorkflowRunnerEventReceipt(received, {
      sequence: 100 + index,
      sentAt: `2026-08-03T03:00:${String(index).padStart(2, '0')}.000Z`,
      status,
      controlBuildHash,
      errorCode:
        status === 'reconciliation_required' ? 'WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN' : null,
    });
    validateWorkflowRunnerEventReceipt(receipt, received, controlBuildHash);
    return {
      id: `receipt-${received.kind}`,
      received,
      receipt,
      expected: prepareWorkflowRunnerMessage(receipt),
    };
  });
  const receipt = receipts.find((item) => item.received.kind === 'heartbeat')!.receipt;
  const canonicalHeartbeat = prepareWorkflowRunnerMessage(heartbeat).body;
  let deepJson = 'null';
  for (let index = 0; index <= WORKFLOW_RUNNER_CONTRACT_LIMITS.maxJsonDepth; index += 1) {
    deepJson = `{"nested":${deepJson}}`;
  }
  const nodeJson = `[${Array.from(
    { length: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxJsonNodes + 1 },
    () => 'null',
  ).join(',')}]\n`;
  const parseCase = (id: string, input: string) => ({
    id,
    operation: 'parse_bytes' as const,
    input,
  });
  const negativeInputs: readonly {
    id: string;
    operation: 'validate' | 'parse_bytes' | 'receipt' | 'create_receipt';
    input: unknown;
    received?: unknown;
  }[] = [
    {
      id: 'hello-runtime-identity-forbidden',
      operation: 'validate',
      input: { ...hello, jobId: 'job.invalid' },
    },
    {
      id: 'unsupported-protocol-version',
      operation: 'validate',
      input: { ...hello, protocolVersion: 'openslack.workflow_runner.v2' },
    },
    {
      id: 'lease-null-identity-forbidden',
      operation: 'validate',
      input: { ...offer, leaseId: null },
    },
    {
      id: 'zero-fencing-token-forbidden',
      operation: 'validate',
      input: { ...offer, fencingToken: 0 },
    },
    { id: 'zero-sequence-forbidden', operation: 'validate', input: { ...offer, sequence: 0 } },
    {
      id: 'generic-envelope-extension-forbidden',
      operation: 'validate',
      input: { ...offer, extension: {} },
    },
    {
      id: 'raw-command-forbidden',
      operation: 'validate',
      input: { ...offer, payload: { ...offer.payload, command: 'do-not-run' } },
    },
    {
      id: 'raw-prompt-forbidden',
      operation: 'validate',
      input: { ...offer, payload: { ...offer.payload, prompt: 'do-not-export' } },
    },
    {
      id: 'raw-token-forbidden',
      operation: 'validate',
      input: { ...offer, payload: { ...offer.payload, token: 'do-not-export' } },
    },
    {
      id: 'raw-url-forbidden',
      operation: 'validate',
      input: { ...offer, payload: { ...offer.payload, url: 'https://example.invalid' } },
    },
    {
      id: 'descriptor-path-forbidden',
      operation: 'validate',
      input: { ...offer, payload: { ...offer.payload, executionDescriptorRef: '../workflow.mjs' } },
    },
    {
      id: 'capability-order-is-canonical',
      operation: 'validate',
      input: {
        ...hello,
        payload: {
          ...hello.payload,
          capabilities: ['lease_heartbeat', 'effect_receipts', 'cancel_ack'],
        },
      },
    },
    {
      id: 'payload-time-must-match-envelope',
      operation: 'validate',
      input: {
        ...heartbeat,
        payload: { ...heartbeat.payload, observedAt: '2026-08-03T02:00:05.000Z' },
      },
    },
    {
      id: 'cancel-expiry-must-follow-request',
      operation: 'validate',
      input: {
        ...cancelRequest,
        payload: { ...cancelRequest.payload, expiresAt: '2026-08-03T02:00:07.000Z' },
      },
    },
    {
      id: 'terminal-completed-requires-result',
      operation: 'validate',
      input: leaseBase('terminal', 11, {
        status: 'completed',
        finishedAt: '2026-08-03T02:00:11.000Z',
        resultHash: null,
        terminalReason: null,
      }),
    },
    {
      id: 'terminal-failed-forbids-result',
      operation: 'validate',
      input: leaseBase('terminal', 12, {
        status: 'failed',
        finishedAt: '2026-08-03T02:00:12.000Z',
        resultHash: hash('5'),
        terminalReason: 'workflow_failed',
      }),
    },
    {
      id: 'terminal-cancelled-reason-closed',
      operation: 'validate',
      input: leaseBase('terminal', 13, {
        status: 'cancelled',
        finishedAt: '2026-08-03T02:00:13.000Z',
        resultHash: null,
        terminalReason: 'timeout',
      }),
    },
    {
      id: 'terminal-timeout-reason-closed',
      operation: 'validate',
      input: leaseBase('terminal', 14, {
        status: 'timed_out',
        finishedAt: '2026-08-03T02:00:14.000Z',
        resultHash: null,
        terminalReason: 'process_crash',
      }),
    },
    {
      id: 'terminal-reconciliation-reason-closed',
      operation: 'validate',
      input: leaseBase('terminal', 15, {
        status: 'reconciliation_required',
        finishedAt: '2026-08-03T02:00:15.000Z',
        resultHash: null,
        terminalReason: 'workflow_failed',
      }),
    },
    parseCase('non-canonical-pretty-json-forbidden', `${JSON.stringify(heartbeat, null, 2)}\n`),
    parseCase(
      'duplicate-json-key-forbidden',
      `{"protocolVersion":"${WORKFLOW_RUNNER_PROTOCOL_VERSION}","protocolVersion":"${WORKFLOW_RUNNER_PROTOCOL_VERSION}"}\n`,
    ),
    parseCase('utf8-bom-forbidden', `\ufeff${canonicalHeartbeat}`),
    parseCase('crlf-forbidden', `${canonicalHeartbeat.slice(0, -1)}\r\n`),
    parseCase('double-lf-forbidden', `${canonicalHeartbeat}\n`),
    parseCase(
      'non-canonical-number-forbidden',
      canonicalHeartbeat.replace('"fencingToken":7', '"fencingToken":7.0'),
    ),
    parseCase(
      'lone-surrogate-forbidden',
      canonicalHeartbeat.replace('"workspaceId":"workspace.demo"', '"workspaceId":"\\ud800"'),
    ),
    parseCase(
      'oversize-message-forbidden',
      `${'x'.repeat(WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes)}\n`,
    ),
    parseCase('json-depth-bound', `${deepJson}\n`),
    parseCase('json-node-bound', nodeJson),
    {
      id: 'receipt-digest-mismatch',
      operation: 'receipt',
      input: { ...receipt, payload: { ...receipt.payload, receivedDigest: hash('9') } },
      received: heartbeat,
    },
    {
      id: 'receipt-fingerprint-mismatch',
      operation: 'receipt',
      input: {
        ...receipt,
        payload: { ...receipt.payload, receivedFingerprint: `sha256:${hash('8')}` },
      },
      received: heartbeat,
    },
    {
      id: 'receipt-correlation-mismatch',
      operation: 'receipt',
      input: { ...receipt, correlationId: 'correlation.wrong' },
      received: heartbeat,
    },
    {
      id: 'receipt-build-mismatch',
      operation: 'receipt',
      input: { ...receipt, payload: { ...receipt.payload, controlBuildHash: hash('8') } },
      received: heartbeat,
    },
    {
      id: 'receipt-commit-time-must-match-envelope',
      operation: 'receipt',
      input: {
        ...receipt,
        payload: { ...receipt.payload, committedAt: '2026-08-03T03:00:59.000Z' },
      },
      received: heartbeat,
    },
    { id: 'receipt-lease-offer-forbidden', operation: 'create_receipt', input: offer },
    { id: 'receipt-cancel-request-forbidden', operation: 'create_receipt', input: cancelRequest },
  ];
  const negative = negativeInputs.map((item) => ({
    id: item.id,
    operation: item.operation,
    input: item.input,
    ...(item.received === undefined ? {} : { received: item.received }),
    expectedError: errorOf(() => {
      if (item.operation === 'parse_bytes') {
        parseWorkflowRunnerMessageBytes(Buffer.from(item.input as string, 'utf8'));
      } else if (item.operation === 'receipt') {
        validateWorkflowRunnerEventReceipt(item.input, item.received, controlBuildHash);
      } else if (item.operation === 'create_receipt') {
        createWorkflowRunnerEventReceipt(item.input, {
          sequence: 999,
          sentAt: '2026-08-03T04:00:00.000Z',
          status: 'accepted',
          controlBuildHash,
          errorCode: null,
        });
      } else {
        validateWorkflowRunnerMessage(item.input);
      }
    }),
  }));
  return {
    schema: 'openslack.workflow_runner_golden_vectors.v1',
    protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
    positive: messages.map((message) => ({
      id: `valid-${message.kind}`,
      input: message,
      expected: prepareWorkflowRunnerMessage(message),
    })),
    receipts,
    negative,
  };
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
  outputs.set(expectedPaths[0], await prettyJson(messageSchema));
  outputs.set(expectedPaths[1], await prettyJson(preparedMessageSchema));
  const vectors = goldenVectors();
  outputs.set(expectedPaths[2], await prettyJson(vectors));
  const artifacts = Object.fromEntries(
    [...outputs.entries()].map(([path, bytes]) => [
      path,
      { path, byteLength: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  );
  outputs.set(
    expectedPaths[3],
    await prettyJson({
      schema: 'openslack.workflow_runner_contract_manifest.v1',
      protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
      authority: 'typescript',
      authorityBoundary: {
        contractOwner: '@openslack/workflows',
        javascriptRunnerRemains: true,
        workflowCodeAndAgentCallsRemainTypescript: true,
        durableAuthorityTransferred: false,
        runtimeAdded: false,
      },
      envelopeFields,
      handshakeIdentity: {
        kinds: WORKFLOW_RUNNER_HANDSHAKE_KINDS,
        requiredNullFields: [
          'jobId',
          'workflowRunId',
          'attemptId',
          'leaseId',
          'fencingToken',
          'sequence',
        ],
        requiredNonEmptyFields: ['workspaceId', 'eventId', 'correlationId', 'sentAt'],
      },
      leaseIdentity: {
        requiredNonEmptyFields: ['jobId', 'workflowRunId', 'attemptId', 'leaseId'],
        requiredPositiveSafeIntegerFields: ['fencingToken', 'sequence'],
        emptyStringOrZeroSentinelAllowed: false,
      },
      messages: {
        kinds: WORKFLOW_RUNNER_MESSAGE_KINDS,
        directions: WORKFLOW_RUNNER_DIRECTIONS,
        directionVocabulary: ['runner-to-control', 'control-to-runner'],
        receiptableKinds: WORKFLOW_RUNNER_RECEIPTABLE_KINDS,
        payloadFields: Object.fromEntries(
          Object.entries(payloadSchemas).map(([kind, schema]) => [
            kind,
            Object.keys((schema.properties ?? {}) as JsonRecord),
          ]),
        ),
      },
      advancementRules: WORKFLOW_RUNNER_ADVANCEMENT_RULES,
      leaseOfferBoundary: {
        sealedDescriptorOnly: true,
        descriptorReferencePattern: ID_PATTERN,
        forbiddenRawFields: [
          'args',
          'prompt',
          'result',
          'transcript',
          'credential',
          'token',
          'secret',
          'command',
          'modulePath',
          'url',
        ],
        genericExtensionAllowed: false,
      },
      canonicalization: {
        objectKeyOrder: 'ECMAScript UTF-16 code-unit lexicographic',
        wireEncoding: 'UTF-8',
        framing: 'canonical JSON followed by exactly one LF',
        bomAllowed: false,
        carriageReturnAllowed: false,
        hashAlgorithm: 'SHA-256',
        hashHexLength: 64,
      },
      algorithms: {
        messageDigest: 'lowerhex(SHA-256(exact canonical message body including one LF))',
        idempotencyKey: `${WORKFLOW_RUNNER_IDEMPOTENCY_PREFIX}<messageDigest>`,
        requestFingerprint: {
          schema: WORKFLOW_RUNNER_FINGERPRINT_SCHEMA,
          formula: 'sha256:lowerhex(SHA-256(canonical JSON fingerprint preimage without LF))',
          fields: [
            'schema',
            'protocolVersion',
            'kind',
            'direction',
            'workspaceId',
            'jobId',
            'workflowRunId',
            'attemptId',
            'leaseId',
            'fencingToken',
            'sequence',
            'eventId',
            'correlationId',
            'messageDigest',
          ],
        },
        receiptEventId: {
          schema: WORKFLOW_RUNNER_RECEIPT_IDENTITY_SCHEMA,
          formula: 'receipt.lowerhex(SHA-256(canonical JSON receipt identity without LF))',
          fields: [
            'schema',
            'workspaceId',
            'eventId',
            'messageDigest',
            'status',
            'controlBuildHash',
            'committedAt',
            'errorCode',
          ],
        },
      },
      vocabularies: {
        runtimeName: WORKFLOW_RUNNER_RUNTIME_NAME,
        runtimeVersionPattern: WORKFLOW_RUNNER_RUNTIME_VERSION_PATTERN,
        capabilities: WORKFLOW_RUNNER_CAPABILITIES,
        leaseRejectReasons: WORKFLOW_RUNNER_LEASE_REJECT_REASONS,
        heartbeatStates: WORKFLOW_RUNNER_HEARTBEAT_STATES,
        effectOutcomes: WORKFLOW_RUNNER_EFFECT_OUTCOMES,
        cancelReasons: WORKFLOW_RUNNER_CANCEL_REASONS,
        cancelAckStates: WORKFLOW_RUNNER_CANCEL_ACK_STATES,
        terminalStates: WORKFLOW_RUNNER_TERMINAL_STATES,
        terminalReasons: WORKFLOW_RUNNER_TERMINAL_REASONS,
        receiptStatuses: WORKFLOW_RUNNER_RECEIPT_STATUSES,
        receiptErrorCodes: WORKFLOW_RUNNER_RECEIPT_ERROR_CODES,
      },
      limits: WORKFLOW_RUNNER_CONTRACT_LIMITS,
      errorCodes: WORKFLOW_RUNNER_CONTRACT_ERROR_CODES,
      vectors: {
        positive: (vectors.positive as unknown[]).length,
        receipts: (vectors.receipts as unknown[]).length,
        negative: (vectors.negative as unknown[]).length,
      },
      artifacts,
    }),
  );
  return outputs;
}

function ensureInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path) {
    throw new Error(`Workflow runner contract path escapes output root: ${path}.`);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = resolve(directory, name);
      ensureInside(root, absolute);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`Symlink forbidden in contract bundle: ${absolute}.`);
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) result.push(relative(root, absolute).split(sep).join('/'));
      else throw new Error(`Unsupported contract artifact: ${absolute}.`);
    }
  }
  await visit(root);
  return result.sort();
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
      `Workflow runner contract inventory drift. Expected ${wantedPaths.join(', ')}, got ${actualPaths.join(', ')}.`,
    );
  }
  for (const [path, expected] of outputs) {
    const actual = await readFile(resolve(root, path));
    if (!actual.equals(expected)) throw new Error(`Workflow runner exact-byte drift: ${path}.`);
  }
}

const outputs = await buildOutputs();
if (process.argv.includes('--check')) {
  await checkOutputs(contractRoot, outputs);
  console.log(`Workflow runner contract bundle verified (${outputs.size} exact-byte files).`);
} else {
  await writeOutputs(contractRoot, outputs);
  console.log(`Workflow runner contract bundle generated (${outputs.size} exact-byte files).`);
}
