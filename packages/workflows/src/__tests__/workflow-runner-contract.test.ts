import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_RUNNER_ADVANCEMENT_RULES,
  WORKFLOW_RUNNER_CONTRACT_ERROR_CODES,
  WORKFLOW_RUNNER_CONTRACT_LIMITS,
  WORKFLOW_RUNNER_DIRECTIONS,
  WORKFLOW_RUNNER_HANDSHAKE_KINDS,
  WORKFLOW_RUNNER_MESSAGE_KINDS,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  WORKFLOW_RUNNER_RECEIPTABLE_KINDS,
  WorkflowRunnerContractError,
  createWorkflowRunnerEventReceipt,
  encodeWorkflowRunnerMessage,
  parseWorkflowRunnerMessageBytes,
  prepareWorkflowRunnerMessage,
  validateWorkflowRunnerEventReceipt,
  validateWorkflowRunnerMessage,
  workflowRunnerDirectionForKind,
  type WorkflowRunnerMessage,
  type WorkflowRunnerPreparedMessage,
} from '../workflow-runner-contract.js';

const contractRoot = new URL('../../contracts/workflow-runner/v1/', import.meta.url);
const CONTROL_BUILD_HASH = '7'.repeat(64);

function bytes(relativePath: string): Buffer {
  return readFileSync(new URL(relativePath, contractRoot));
}

function json(relativePath: string): Record<string, unknown> {
  return JSON.parse(bytes(relativePath).toString('utf8')) as Record<string, unknown>;
}

interface GoldenError {
  readonly name: string;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface PositiveVector {
  readonly id: string;
  readonly input: WorkflowRunnerMessage;
  readonly expected: WorkflowRunnerPreparedMessage;
}

interface ReceiptVector {
  readonly id: string;
  readonly received: WorkflowRunnerMessage;
  readonly receipt: WorkflowRunnerMessage;
  readonly expected: WorkflowRunnerPreparedMessage;
}

interface NegativeVector {
  readonly id: string;
  readonly operation: 'validate' | 'parse_bytes' | 'receipt' | 'create_receipt';
  readonly input: unknown;
  readonly received?: unknown;
  readonly expectedError: GoldenError;
}

interface GoldenVectors {
  readonly schema: string;
  readonly protocolVersion: string;
  readonly positive: PositiveVector[];
  readonly receipts: ReceiptVector[];
  readonly negative: NegativeVector[];
}

function vectors(): GoldenVectors {
  return json('golden-vectors.json') as unknown as GoldenVectors;
}

function capturedError(operation: () => unknown): GoldenError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowRunnerContractError);
    const contractError = error as WorkflowRunnerContractError;
    return {
      name: contractError.name,
      code: contractError.code,
      path: contractError.path,
      message: contractError.message,
    };
  }
  throw new Error('Expected WorkflowRunnerContractError.');
}

describe('Workflow runner GS8-A frozen protocol', () => {
  it('freezes the exact message inventory, directions, handshake identity, and receipt asymmetry', () => {
    expect(WORKFLOW_RUNNER_PROTOCOL_VERSION).toBe('openslack.workflow_runner.v1');
    expect(WORKFLOW_RUNNER_MESSAGE_KINDS).toEqual([
      'hello',
      'hello_ack',
      'lease_offer',
      'lease_accept',
      'lease_reject',
      'heartbeat',
      'effect_intent',
      'effect_outcome',
      'cancel_request',
      'cancel_ack',
      'terminal',
      'event_receipt',
    ]);
    expect(WORKFLOW_RUNNER_HANDSHAKE_KINDS).toEqual(['hello', 'hello_ack']);
    expect(WORKFLOW_RUNNER_RECEIPTABLE_KINDS).toEqual([
      'lease_accept',
      'lease_reject',
      'heartbeat',
      'effect_intent',
      'effect_outcome',
      'cancel_ack',
      'terminal',
    ]);
    expect(WORKFLOW_RUNNER_DIRECTIONS.runnerToControl).toContain('effect_outcome');
    expect(WORKFLOW_RUNNER_DIRECTIONS.controlToRunner).not.toContain('effect_outcome');
    expect(workflowRunnerDirectionForKind('effect_outcome')).toBe('runner-to-control');
    expect(workflowRunnerDirectionForKind('event_receipt')).toBe('control-to-runner');
    expect(() => workflowRunnerDirectionForKind('unknown' as never)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_RUNNER_INVALID_MESSAGE', path: '$/kind' }),
    );
    expect(WORKFLOW_RUNNER_ADVANCEMENT_RULES).toEqual({
      helloRequires: 'hello_ack',
      leaseOfferRequiresOneOf: ['lease_accept', 'lease_reject'],
      receiptRequiredFor: WORKFLOW_RUNNER_RECEIPTABLE_KINDS,
      advancingReceiptStatuses: ['accepted', 'duplicate'],
      stoppingReceiptStatus: 'reconciliation_required',
      receiptIsReceiptable: false,
      oneOutstandingWorkerEvent: true,
      leaseAcceptReceiptBeforeJavascriptExecution: true,
      terminalReceiptBeforeSuccessfulRunnerExit: true,
      cancelRequestPreemptsReceiptWait: true,
      cancelAckQueuedBehindOutstandingWorkerEvent: true,
      cancelValidityEvaluatedAtRunnerReceipt: true,
      appliedCancelAckMayFollowExpiry: true,
    });
  });

  it('locks generated artifacts by exact byte length and full SHA-256', () => {
    const manifest = json('manifest.json') as {
      canonicalization: { hashHexLength: number; framing: string };
      artifacts: Record<string, { path: string; byteLength: number; sha256: string }>;
      errorCodes: string[];
      advancementRules: unknown;
    };
    expect(manifest.canonicalization.hashHexLength).toBe(64);
    expect(manifest.canonicalization.framing).toBe('canonical JSON followed by exactly one LF');
    expect(manifest.errorCodes).toEqual(WORKFLOW_RUNNER_CONTRACT_ERROR_CODES);
    expect(manifest.advancementRules).toEqual(WORKFLOW_RUNNER_ADVANCEMENT_RULES);
    expect(manifest.errorCodes).toHaveLength(15);
    for (const artifact of Object.values(manifest.artifacts)) {
      const value = bytes(artifact.path);
      expect(value.byteLength).toBe(artifact.byteLength);
      expect(createHash('sha256').update(value).digest('hex')).toBe(artifact.sha256);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('compiles both closed schemas and accepts every generated positive vector', () => {
    const fixture = vectors();
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validateMessage = ajv.compile(json('schemas/workflow-runner-message.v1.schema.json'));
    const validatePrepared = ajv.compile(
      json('schemas/workflow-runner-prepared-message.v1.schema.json'),
    );
    for (const vector of fixture.positive) {
      expect(validateMessage(vector.input), JSON.stringify(validateMessage.errors)).toBe(true);
      expect(validatePrepared(vector.expected), JSON.stringify(validatePrepared.errors)).toBe(true);
    }
    for (const vector of fixture.receipts) {
      expect(validateMessage(vector.receipt), JSON.stringify(validateMessage.errors)).toBe(true);
      expect(validatePrepared(vector.expected), JSON.stringify(validatePrepared.errors)).toBe(true);
    }
    const offer = fixture.positive.find((item) => item.input.kind === 'lease_offer')!.input;
    expect(validateMessage({ ...offer, extension: {} })).toBe(false);
    expect(validateMessage({ ...offer, payload: { ...offer.payload, prompt: 'forbidden' } })).toBe(
      false,
    );
  });

  it('replays all 12 kinds with canonical JSON, exactly one LF, full hashes, and stable fingerprints', () => {
    const fixture = vectors();
    expect(fixture.positive.map((item) => item.input.kind)).toEqual(WORKFLOW_RUNNER_MESSAGE_KINDS);
    for (const vector of fixture.positive) {
      const prepared = prepareWorkflowRunnerMessage(vector.input);
      expect(prepared).toEqual(vector.expected);
      expect(prepared.body).toBe(encodeWorkflowRunnerMessage(vector.input));
      expect(prepared.body.endsWith('\n')).toBe(true);
      expect(prepared.body.endsWith('\n\n')).toBe(false);
      expect(prepared.body).not.toContain('\r');
      expect(prepared.messageDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(prepared.idempotencyKey).toMatch(/^openslack\.workflow-runner\.v1\.[0-9a-f]{64}$/u);
      expect(prepared.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(parseWorkflowRunnerMessageBytes(Buffer.from(prepared.body, 'utf8'))).toEqual(
        vector.input,
      );
    }
  });

  it('creates and rebinds receipts for exactly the seven runner-originating durable events', () => {
    const fixture = vectors();
    expect(fixture.receipts.map((item) => item.received.kind)).toEqual(
      WORKFLOW_RUNNER_RECEIPTABLE_KINDS,
    );
    for (const vector of fixture.receipts) {
      expect(
        validateWorkflowRunnerEventReceipt(vector.receipt, vector.received, CONTROL_BUILD_HASH),
      ).toEqual(vector.receipt);
      expect(prepareWorkflowRunnerMessage(vector.receipt)).toEqual(vector.expected);
      expect(vector.receipt.kind).toBe('event_receipt');
      if (vector.receipt.kind === 'event_receipt') {
        expect(vector.receipt.sentAt).toBe(vector.receipt.payload.committedAt);
        expect(vector.receipt.payload.controlBuildHash).toBe(CONTROL_BUILD_HASH);
      }
    }
  });

  it('replays all negative canonical, identity, payload, terminal, timing, and receipt vectors', () => {
    const fixture = vectors();
    expect(fixture.negative).toHaveLength(36);
    for (const vector of fixture.negative) {
      const actual = capturedError(() => {
        if (vector.operation === 'parse_bytes') {
          parseWorkflowRunnerMessageBytes(Buffer.from(vector.input as string, 'utf8'));
        } else if (vector.operation === 'receipt') {
          validateWorkflowRunnerEventReceipt(vector.input, vector.received, CONTROL_BUILD_HASH);
        } else if (vector.operation === 'create_receipt') {
          createWorkflowRunnerEventReceipt(vector.input, {
            sequence: 999,
            sentAt: '2026-08-03T04:00:00.000Z',
            status: 'accepted',
            controlBuildHash: CONTROL_BUILD_HASH,
            errorCode: null,
          });
        } else {
          validateWorkflowRunnerMessage(vector.input);
        }
      });
      expect(actual, vector.id).toEqual(vector.expectedError);
    }
  });

  it('rejects Proxy/accessor arrays before reading their elements', () => {
    const hello = vectors().positive.find((item) => item.input.kind === 'hello')!.input;
    if (hello.kind !== 'hello') throw new Error('Golden hello vector drift.');
    const proxy = new Proxy([...hello.payload.capabilities], {});
    expect(() =>
      validateWorkflowRunnerMessage({
        ...hello,
        payload: { ...hello.payload, capabilities: proxy },
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_RUNNER_INVALID_MESSAGE' }));

    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => 'cancel_ack' });
    accessor.length = 1;
    expect(() =>
      validateWorkflowRunnerMessage({
        ...hello,
        payload: { ...hello.payload, capabilities: accessor },
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_RUNNER_INVALID_MESSAGE' }));
  });

  it('keeps the frozen bounds finite and safe-integer compatible', () => {
    expect(WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes).toBe(256 * 1024);
    expect(WORKFLOW_RUNNER_CONTRACT_LIMITS.maxJsonDepth).toBe(12);
    expect(WORKFLOW_RUNNER_CONTRACT_LIMITS.maxJsonNodes).toBe(2_048);
    expect(WORKFLOW_RUNNER_CONTRACT_LIMITS.maxSafeInteger).toBe(Number.MAX_SAFE_INTEGER);
  });
});
