import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS,
  WORKFLOW_CONTROL_AUTHORITY_CLAIM,
  WORKFLOW_CONTROL_AUTHORITY_MAX_INT64,
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS,
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA,
  WorkflowControlAuthorityContractError,
  parseWorkflowControlAuthorityMessageBytes,
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityDecimal,
  validateWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityReceipt,
  validateWorkflowControlAuthorityState,
  validateWorkflowControlAuthorityTransition,
  workflowControlAuthorityDirectionForKind,
  workflowControlAuthorityUsdToNanoUsd,
} from '../workflow-control-authority-contract.js';

const H = (value: string): string => createHash('sha256').update(value).digest('hex');
const HASHES = Object.freeze({
  source: H('source'),
  manifest: H('manifest'),
  input: H('input'),
  build: H('build'),
  artifact: H('artifact'),
  result: H('result'),
  cache: H('cache'),
  policy: H('policy'),
  approval: H('approval'),
  effect: H('effect'),
  receipt: H('receipt'),
  request: H('request'),
  record: H('record'),
  provider: H('provider'),
  checkpoint: H('checkpoint'),
  grant: H('grant'),
});

function route() {
  return {
    backend: 'ts-local',
    authority: 'typescript',
    routingEpoch: 1,
    authorityBuildHash: HASHES.build,
  } as const;
}

function state() {
  return {
    schema: WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA,
    contractVersion: 'v2',
    contractAuthority: 'typescript',
    goRole: 'validator-only',
    authorityClaim: WORKFLOW_CONTROL_AUTHORITY_CLAIM,
    workspaceId: 'workspace-gs9',
    runId: 'run-gs9-001',
    workflowId: 'contract-delivery-lite',
    workflowVersion: '1.0.0',
    workflowSourceHash: HASHES.source,
    manifestHash: HASHES.manifest,
    inputHash: HASHES.input,
    route: route(),
    state: 'running',
    revision: 4,
    resumeGeneration: 1,
    currentPhaseId: 'verify',
    currentPhaseIndex: 1,
    checkpointHead: {
      checkpointId: 'checkpoint-discover-1',
      phaseId: 'discover',
      phaseIndex: 0,
      commitPoint: 'after_phase_work',
      artifactRef: 'artifact/checkpoint-discover-1',
      artifactHash: HASHES.artifact,
      resultHash: HASHES.result,
      cacheKeyHash: HASHES.cache,
      committedRevision: 3,
      resumeGeneration: 1,
    },
    approvals: {
      legacyRunGate: {
        plane: 'legacy_run_gate',
        status: 'pending',
        revision: 0,
        effectDecisionAuthority: false,
      },
      effectV2: {
        plane: 'workflow_effect_v2',
        schema: 'openslack.workflow_effect_approval.v2',
        status: 'approved',
        revision: 2,
        approvalHash: HASHES.approval,
      },
    },
    budget: {
      policyHash: HASHES.policy,
      tokenLimit: WORKFLOW_CONTROL_AUTHORITY_MAX_INT64,
      costLimitNanoUsd: '1000000000',
      callLimit: '100',
      reservedTokens: '9007199254740993',
      settledTokens: '9007199254740992',
      reservedCostNanoUsd: '125000001',
      settledCostNanoUsd: '125000000',
      reservedCalls: '3',
      settledCalls: '2',
    },
    reconciliationRequired: false,
    updatedAt: '2026-08-04T03:00:00.000Z',
  } as const;
}

function message(kind: string, payload: Record<string, unknown>) {
  return {
    schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
    protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    kind,
    workspaceId: 'workspace-gs9',
    jobId: 'job-gs9-001',
    workflowRunId: 'run-gs9-001',
    attemptId: 'attempt-gs9-001',
    leaseId: 'lease-gs9-001',
    fencingToken: 7,
    sequence: 11,
    authorityBackend: 'ts-local',
    authority: 'typescript',
    routingEpoch: 1,
    authorityBuildHash: HASHES.build,
    runRevision: 4,
    resumeGeneration: 1,
    eventId: `event-${kind}`,
    correlationId: 'corr-gs9-001',
    sentAt: '2026-08-04T03:01:00.000Z',
    payload,
  };
}

function checkpointMessage() {
  return message('checkpoint_commit', {
    checkpointId: 'checkpoint-verify-1',
    phaseId: 'verify',
    phaseIndex: 1,
    commitPoint: 'after_phase_work',
    artifactRef: 'artifact/checkpoint-verify-1',
    artifactHash: HASHES.artifact,
    resultHash: HASHES.result,
    cacheKeyHash: HASHES.cache,
    workflowSourceHash: HASHES.source,
    manifestHash: HASHES.manifest,
    inputHash: HASHES.input,
  });
}

function receipt(status: 'accepted' | 'duplicate' | 'reconciliation_required') {
  return {
    schema: WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA,
    operation: 'checkpoint_commit',
    status,
    workspaceId: 'workspace-gs9',
    runId: 'run-gs9-001',
    expectedRevision: 4,
    acceptedRevision: status === 'reconciliation_required' ? null : 5,
    resumeGeneration: 1,
    route: route(),
    idempotencyKey: `openslack.workflow-control-authority.v2.${HASHES.request}`,
    requestFingerprint: `sha256:${HASHES.request}`,
    requestHash: HASHES.request,
    recordHash: status === 'reconciliation_required' ? null : HASHES.record,
    correlationId: 'corr-gs9-001',
    serviceBuildHash: HASHES.build,
    committedAt: status === 'reconciliation_required' ? null : '2026-08-04T03:02:00.000Z',
    reconciliationToken: status === 'reconciliation_required' ? 'reconcile-gs9-001' : null,
  };
}

describe('Workflow Control authority v2 contract', () => {
  it('freezes a full 18-kind v2 vocabulary while naming exactly six additions', () => {
    expect(WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS).toHaveLength(18);
    expect(WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS).toEqual([
      'checkpoint_commit',
      'budget_reserve_request',
      'budget_usage_report',
      'budget_authorization',
      'effect_authorization',
      'resume_offer',
    ]);
  });

  it('validates the future state without transferring authority', () => {
    const validated = validateWorkflowControlAuthorityState(state());
    expect(validated.contractAuthority).toBe('typescript');
    expect(validated.goRole).toBe('validator-only');
    expect(validated.authorityClaim).toBe('NO_AUTHORITY');
    expect(validated.budget.tokenLimit).toBe(WORKFLOW_CONTROL_AUTHORITY_MAX_INT64);

    const resumed = structuredClone(state()) as unknown as {
      resumeGeneration: number;
      checkpointHead: null | { resumeGeneration: number };
    };
    resumed.resumeGeneration = 2;
    expect(validateWorkflowControlAuthorityState(resumed).checkpointHead?.resumeGeneration).toBe(1);
    if (!resumed.checkpointHead) throw new Error('fixture checkpoint is required');
    resumed.checkpointHead.resumeGeneration = 3;
    expect(() => validateWorkflowControlAuthorityState(resumed)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_STALE_REVISION' }),
    );
  });

  it('keeps the approval planes non-interchangeable', () => {
    const invalid = structuredClone(state()) as unknown as {
      approvals: { legacyRunGate: { effectDecisionAuthority: boolean } };
    };
    invalid.approvals.legacyRunGate.effectDecisionAuthority = true;
    expect(() => validateWorkflowControlAuthorityState(invalid)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANE_MISMATCH' }),
    );
  });

  it('rejects calendar-invalid timestamps through the frozen contract error surface', () => {
    const invalid = structuredClone(state()) as unknown as { updatedAt: string };
    invalid.updatedAt = '2026-13-01T00:00:00.000Z';
    expect(() => validateWorkflowControlAuthorityState(invalid)).toThrowError(
      expect.objectContaining({
        name: 'WorkflowControlAuthorityContractError',
        code: 'WORKFLOW_CONTROL_AUTHORITY_INVALID',
        path: '$/updatedAt',
        message: '$/updatedAt is not a valid timestamp.',
      }),
    );
  });

  it('freezes revisioned run transitions including reconciliation terminality', () => {
    expect(() => validateWorkflowControlAuthorityTransition('running', 'completed')).not.toThrow();
    expect(() => validateWorkflowControlAuthorityTransition('completed', 'running')).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_INVALID_TRANSITION' }),
    );
    expect(() =>
      validateWorkflowControlAuthorityTransition('reconciliation_required', 'running'),
    ).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_INVALID_TRANSITION' }),
    );
  });

  it('uses canonical signed-int64 decimal strings beyond JavaScript safe integers', () => {
    expect(validateWorkflowControlAuthorityDecimal('9007199254740993')).toBe('9007199254740993');
    expect(validateWorkflowControlAuthorityDecimal(WORKFLOW_CONTROL_AUTHORITY_MAX_INT64)).toBe(
      WORKFLOW_CONTROL_AUTHORITY_MAX_INT64,
    );
    for (const invalid of ['00', '01', '-1', '1.0', '9223372036854775808']) {
      expect(() => validateWorkflowControlAuthorityDecimal(invalid)).toThrowError(
        WorkflowControlAuthorityContractError,
      );
    }

    expect(() =>
      validateWorkflowControlAuthorityMessage(
        message('budget_authorization', {
          reservationId: 'reservation-1',
          status: 'rejected',
          authorizedTokens: '1',
          authorizedCostNanoUsd: '0',
          authorizedCalls: '0',
          authorityReceiptHash: HASHES.receipt,
          committedRunRevision: 4,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_INVALID' }));
  });

  it('rounds non-negative decimal USD to nano_usd with half-up semantics', () => {
    expect(workflowControlAuthorityUsdToNanoUsd('0')).toBe('0');
    expect(workflowControlAuthorityUsdToNanoUsd('0.0000000004')).toBe('0');
    expect(workflowControlAuthorityUsdToNanoUsd('0.0000000005')).toBe('1');
    expect(workflowControlAuthorityUsdToNanoUsd('1.2345678914')).toBe('1234567891');
    expect(workflowControlAuthorityUsdToNanoUsd('1.2345678915')).toBe('1234567892');
    expect(() => workflowControlAuthorityUsdToNanoUsd('01.0')).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_INVALID_DECIMAL' }),
    );
  });

  it('validates and prepares checkpoint messages with exact one-LF bytes', () => {
    const validated = validateWorkflowControlAuthorityMessage(checkpointMessage());
    const prepared = prepareWorkflowControlAuthorityMessage(validated);
    expect(validated.kind).toBe('checkpoint_commit');
    expect(workflowControlAuthorityDirectionForKind(validated.kind)).toBe('runner-to-control');
    expect(prepared.body.endsWith('\n')).toBe(true);
    expect(prepared.body.endsWith('\n\n')).toBe(false);
    expect(prepared.messageDigest).toBe(H(prepared.body));
    expect(prepared.idempotencyKey).toBe(
      `openslack.workflow-control-authority.v2.${prepared.messageDigest}`,
    );
  });

  it('retains v1 payload semantics inside the v2 envelope', () => {
    const heartbeat = message('heartbeat', {
      state: 'running',
      observedAt: '2026-08-04T03:01:00.000Z',
      leaseExpiresAt: '2026-08-04T03:02:00.000Z',
      lastReceiptSequence: 3,
    });
    expect(validateWorkflowControlAuthorityMessage(heartbeat).kind).toBe('heartbeat');
    expect(() =>
      validateWorkflowControlAuthorityMessage({
        ...heartbeat,
        payload: { ...heartbeat.payload, approvalDecision: 'approved' },
      }),
    ).toThrow();
  });

  it('requires exact v1+v2 hello advertisement and v2 selection', () => {
    const hello = {
      ...message('hello', {
        runtimeName: 'node',
        runtimeVersion: '22.14.0',
        runnerBuildHash: HASHES.build,
        supportedProtocolVersions: ['openslack.workflow_runner.v1', 'openslack.workflow_runner.v2'],
        capabilities: ['cancel_ack', 'effect_receipts', 'lease_heartbeat'],
        maxConcurrentJobs: 1,
      }),
      jobId: null,
      workflowRunId: null,
      attemptId: null,
      leaseId: null,
      fencingToken: null,
      sequence: null,
      authorityBackend: null,
      authority: null,
      routingEpoch: null,
      authorityBuildHash: null,
      runRevision: null,
      resumeGeneration: null,
    };
    expect(validateWorkflowControlAuthorityMessage(hello).kind).toBe('hello');
    expect(() =>
      validateWorkflowControlAuthorityMessage({
        ...hello,
        payload: { ...hello.payload, supportedProtocolVersions: ['openslack.workflow_runner.v1'] },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_UNSUPPORTED_VERSION' }),
    );
  });

  it('binds v2 hello_ack and extended event receipts without a downgrade', () => {
    const handshakeNulls = {
      jobId: null,
      workflowRunId: null,
      attemptId: null,
      leaseId: null,
      fencingToken: null,
      sequence: null,
      authorityBackend: null,
      authority: null,
      routingEpoch: null,
      authorityBuildHash: null,
      runRevision: null,
      resumeGeneration: null,
    } as const;
    const ack = {
      ...message('hello_ack', {
        controlBuildHash: HASHES.build,
        selectedProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        heartbeatIntervalMs: 1_000,
        leaseOfferTimeoutMs: 1,
      }),
      ...handshakeNulls,
    };
    expect(validateWorkflowControlAuthorityMessage(ack).kind).toBe('hello_ack');

    const source = prepareWorkflowControlAuthorityMessage(checkpointMessage());
    const eventReceipt = message('event_receipt', {
      receivedEventId: 'event-checkpoint_commit',
      receivedKind: 'checkpoint_commit',
      receivedSequence: 11,
      receivedDigest: source.messageDigest,
      receivedIdempotencyKey: source.idempotencyKey,
      receivedFingerprint: source.requestFingerprint,
      status: 'accepted',
      controlBuildHash: HASHES.build,
      committedAt: '2026-08-04T03:01:00.000Z',
      errorCode: null,
    });
    expect(validateWorkflowControlAuthorityMessage(eventReceipt).kind).toBe('event_receipt');
    expect(() =>
      validateWorkflowControlAuthorityMessage({
        ...eventReceipt,
        payload: {
          ...eventReceipt.payload,
          committedAt: '2026-08-04T03:01:00.001Z',
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH' }),
    );
  });

  it('keeps effect authorization closed and distinct from human attestation', () => {
    const effect = message('effect_authorization', {
      effectId: 'effect-gs9-001',
      effectHash: HASHES.effect,
      approvalId: 'approval-gs9-001',
      approvalStatus: 'approved',
      decisionRevision: 1,
      grantHash: HASHES.grant,
      authorityReceiptHash: HASHES.receipt,
      expiresAt: '2026-08-04T03:05:00.000Z',
    });
    expect(validateWorkflowControlAuthorityMessage(effect).kind).toBe('effect_authorization');
    expect(() =>
      validateWorkflowControlAuthorityMessage({
        ...effect,
        payload: { ...effect.payload, attestationNonce: 'secret' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_UNKNOWN_FIELD' }));
  });

  it('validates accepted, duplicate, and reconciliation receipts without conflating them', () => {
    expect(validateWorkflowControlAuthorityReceipt(receipt('accepted')).acceptedRevision).toBe(5);
    expect(validateWorkflowControlAuthorityReceipt(receipt('duplicate')).acceptedRevision).toBe(5);
    const reconciliation = validateWorkflowControlAuthorityReceipt(
      receipt('reconciliation_required'),
    );
    expect(reconciliation.acceptedRevision).toBeNull();
    expect(reconciliation.recordHash).toBeNull();
  });

  it('rejects unknown envelope fields and duplicate JSON keys', () => {
    expect(() =>
      validateWorkflowControlAuthorityMessage({ ...checkpointMessage(), command: 'sh' }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_CONTROL_AUTHORITY_UNKNOWN_FIELD' }));
    const duplicate = Buffer.from(
      '{"schema":"openslack.workflow_control_authority_message.v2","schema":"x"}',
      'utf8',
    );
    expect(() => parseWorkflowControlAuthorityMessageBytes(duplicate)).toThrow();
  });

  it('locks the merged v1 bundles byte-for-byte', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const expected = {
      'packages/workflows/contracts/workflow-control/v1/manifest.json':
        '3c7440ae6254337a6e1d93beb2e531d591fa2f781717d3a8e96d0d2e5d872d86',
      'packages/workflows/contracts/workflow-control/v1/golden-vectors.json':
        '342c877a46adc5f533d9c9c8b25d1c30c5809d8f219115af3f4e97260f9da023',
      'packages/workflows/contracts/workflow-runner/v1/manifest.json':
        '908ff368f35033206b975a0421396f49e588098f040aecef2fdd18cd8b67ece6',
      'packages/workflows/contracts/workflow-runner/v1/golden-vectors.json':
        'b4569ca9e9e3f9b027c1bf3d531760ca9fbf87ecd3f7818204eca367a7fce844',
    };
    for (const [path, digest] of Object.entries(expected)) {
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex'),
      ).toBe(digest);
    }
  });

  it('keeps all four generated schemas closed and aligned with runtime positives', () => {
    const root = resolve(import.meta.dirname, '../../contracts/workflow-control-authority/v2');
    const load = (name: string) =>
      JSON.parse(readFileSync(resolve(root, 'schemas', name), 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
    const validateState = ajv.compile(load('workflow-control-authority-state.v2.schema.json'));
    const validateMessage = ajv.compile(load('workflow-control-authority-message.v2.schema.json'));
    const validatePrepared = ajv.compile(
      load('workflow-control-authority-prepared-message.v2.schema.json'),
    );
    const validateReceipt = ajv.compile(load('workflow-control-authority-receipt.v2.schema.json'));
    const prepared = prepareWorkflowControlAuthorityMessage(checkpointMessage());
    expect(validateState(state()), JSON.stringify(validateState.errors)).toBe(true);
    expect(validateMessage(checkpointMessage()), JSON.stringify(validateMessage.errors)).toBe(true);
    expect(validatePrepared(prepared), JSON.stringify(validatePrepared.errors)).toBe(true);
    expect(validateReceipt(receipt('accepted')), JSON.stringify(validateReceipt.errors)).toBe(true);
    expect(validateMessage({ ...checkpointMessage(), command: 'forbidden' })).toBe(false);
  });
});
