type Json = Record<string, unknown>;

const HASH = '^[0-9a-f]{64}$';
const PREFIXED_HASH = '^sha256:[0-9a-f]{64}$';
const ID = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const REF = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$';
const TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const INTEGER = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

// Explicit wire fields. New fields require a reviewed rule; names and fixture values do not infer types.
const hashes = new Set([
  'approvalDecisionHash',
  'approvalRecordHash',
  'artifactHash',
  'attestationHash',
  'authorityBuildHash',
  'cacheKeyHash',
  'capabilityHash',
  'claimHash',
  'controlBuildHash',
  'effectHash',
  'envelopeHash',
  'evidenceHash',
  'grantHash',
  'humanBindingHash',
  'inputHash',
  'intentBindingHash',
  'jobSpecHash',
  'manifestHash',
  'messageDigest',
  'observationHash',
  'outcomeHash',
  'policyHash',
  'priorCheckpointHash',
  'receiptHash',
  'recordHash',
  'requestHash',
  'resultHash',
  'runnerBuildHash',
  'stageHash',
  'stageReceiptHash',
  'targetBodyHash',
  'workflowSourceHash',
]);
const prefixedHashes = new Set([
  'modelHash',
  'providerHash',
  'providerRunHash',
  'providerUsageReceiptHash',
  'requestFingerprint',
]);
const ids = new Set([
  'accountId',
  'approvalId',
  'attemptId',
  'bindingId',
  'callerId',
  'checkpointId',
  'controlEventId',
  'correlationId',
  'effectId',
  'eventId',
  'executionId',
  'jobId',
  'leaseId',
  'logicalResumeAttemptId',
  'nextPhaseId',
  'occurrenceId',
  'phaseId',
  'priorCheckpointId',
  'runId',
  'runnerAttemptId',
  'targetEventId',
  'workflowRunId',
  'workspaceId',
]);
const times = new Set(['committedAt', 'expiresAt', 'processedAt', 'sentAt']);
const integers = new Set([
  'acceptedGlobalRunRevision',
  'acceptedResumeGeneration',
  'acceptedRevision',
  'committedRevision',
  'controlSequence',
  'decisionRevision',
  'expectedGlobalRunRevision',
  'expectedResumeGeneration',
  'expectedRevision',
  'fencingToken',
  'nextPhaseIndex',
  'phaseIndex',
  'resumeGeneration',
  'revision',
  'routingEpoch',
  'sequence',
  'sourceSequence',
]);
const positiveIntegers = new Set([
  'expectedGlobalRunRevision',
  'acceptedGlobalRunRevision',
  'acceptedRevision',
  'committedRevision',
  'controlSequence',
  'fencingToken',
  'revision',
  'routingEpoch',
  'sequence',
  'sourceSequence',
]);
const constants = new Set([
  'schema',
  'contractVersion',
  'profile',
  'phase',
  'direction',
  'operation',
  'kind',
  'plane',
  'evidenceState',
  'receiptSchema',
  'protocolVersion',
  'authority',
  'goRole',
  'goAuthorityClaim',
  'writer',
  'method',
  'path',
  'commitPoint',
  'companionSequence',
]);
const objects = new Set([
  'runnerAuthority',
  'target',
  'evidence',
  'sourceAuthority',
  'envelope',
  'observation',
  'runner',
  'checkpoint',
  'priorCheckpoint',
  'preparedRequest',
]);
const nullOnly = new Set([
  'acceptedRevision',
  'nextPhaseIndex',
  'checkpoint',
  'priorCheckpoint',
  'operation',
]);
const nullable = new Set([
  'approvalDecisionHash',
  'approvalRecordHash',
  'attestationHash',
  'bindingId',
  'claimHash',
  'committedAt',
  'evidenceHash',
  'executionId',
  'grantHash',
  'humanBindingHash',
  'nextPhaseId',
  'priorCheckpointHash',
  'priorCheckpointId',
  'providerUsageReceiptHash',
  'receiptHash',
  'receiptSchema',
  'reconciliationToken',
  'recordHash',
]);

function stringRule(key: string, path: readonly string[]): Json {
  if (hashes.has(key)) return { type: 'string', pattern: HASH };
  if (prefixedHashes.has(key)) return { type: 'string', pattern: PREFIXED_HASH };
  if (ids.has(key)) return { type: 'string', pattern: ID, maxLength: 256 };
  if (times.has(key)) return { type: 'string', pattern: TIME, format: 'date-time' };
  if (key === 'artifactRef' || key === 'receiptSchema' || key === 'reconciliationToken')
    return { type: 'string', pattern: REF, maxLength: 512 };
  if (key === 'providerAttempt') return { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 19 };
  if (key === 'rateNanoUsdPerToken')
    return {
      type: 'string',
      pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{0,17}[1-9])?$',
      maxLength: 64,
    };
  if (key === 'body') return { type: 'string', minLength: 2, maxLength: 524_288 };
  if (key === 'message')
    return {
      type: 'string',
      minLength: 1,
      maxLength: 512,
      pattern: '^[^\\r\\n\\u2028\\u2029]+$',
      format: 'openslack-utf8-512',
      description:
        'Single-line error message, at most 512 UTF-8 bytes. The named format must be asserted.',
    };
  if (key === 'status') return { type: 'string', minLength: 1, maxLength: 64 };
  if (key === 'approvalStatus') return { enum: ['approved', 'rejected', 'expired'] };
  if (key === 'disposition') return { enum: ['accepted', 'reconciliation_required'] };
  if (key === 'controlKind')
    return {
      enum: [
        'event_receipt',
        'budget_authorization',
        'effect_authorization',
        'resume_offer',
        'cancel_request',
      ],
    };
  if (key === 'code') return { type: 'string', minLength: 1, maxLength: 524_288 };
  if (key === 'idempotencyKey') {
    const parent = path.at(-2);
    return {
      type: 'string',
      pattern:
        parent === 'target'
          ? '^openslack\\.workflow-control-authority\\.v2\\.[0-9a-f]{64}$'
          : parent === 'preparedRequest'
            ? '^openslack\\.workflow-budget-authority\\.v1\\.[0-9a-f]{64}$'
            : '^openslack\\.workflow-runner-v2-runtime-admission\\.v1\\.[0-9a-f]{64}$',
    };
  }
  throw new Error(`No explicit authority-binding string rule for ${path.join('/')}.`);
}

/** Returns null only for declared nested records, whose closed fields are visited by the generator. */
export function authorityBindingFieldSchema(value: unknown, path: readonly string[]): Json | null {
  const key = path.at(-1) ?? '';
  if (value === null) {
    if (nullOnly.has(key)) return { type: 'null' };
    if (nullable.has(key)) return { oneOf: [stringRule(key, path), { type: 'null' }] };
    throw new Error(`No explicit authority-binding null rule for ${path.join('/')}.`);
  }
  if (typeof value === 'object' && !Array.isArray(value) && (path.length === 0 || objects.has(key)))
    return null;
  if (constants.has(key)) return { const: value };
  if (typeof value === 'number' && integers.has(key))
    return { ...INTEGER, minimum: positiveIntegers.has(key) ? 1 : 0 };
  if (typeof value === 'string') return stringRule(key, path);
  throw new Error(`No explicit authority-binding field rule for ${path.join('/')}.`);
}
