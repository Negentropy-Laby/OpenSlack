import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { threadId } from 'node:worker_threads';
import {
  WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA,
  WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
  canonicalWorkflowEffectControlJson,
  deriveWorkflowEffectApprovalId,
  deriveWorkflowEffectOccurrenceId,
  hashWorkflowEffectApprovalDecision,
  hashWorkflowEffectApprovalRecord,
  hashWorkflowEffectControlDomain,
  hashWorkflowEffectIntentBinding,
  projectWorkflowEffectHumanDecision,
  validateWorkflowEffectControlArtifact,
  type WorkflowEffectAuditRecordedArtifact,
  type WorkflowEffectApprovalPendingArtifact,
  type WorkflowEffectControlHumanDecisionProjection,
  type WorkflowEffectControlValidationContext,
  type WorkflowEffectDecisionCommittedArtifact,
  type WorkflowEffectExecutionClaimArtifact,
  type WorkflowEffectIntentArtifact,
} from './workflow-effect-control-contract.js';
import {
  validateWorkflowEffectApproval,
  type HumanWorkflowEffectDecisionBinding,
  type WorkflowEffectApprovalRecord,
} from './workflow-effect-approval.js';
import { parseWorkflowEffectJson } from './workflow-effect-json.js';
import {
  atomicWrite as atomicWriteOwnerFile,
  ensureOwnerDirectory,
  productionJournalSecurity,
  readOwnerFile,
  syncDirectory,
  writeExclusive,
} from './workflow-control-shadow.js';
import {
  prepareWorkflowRunnerMessage,
  validateWorkflowRunnerMessage,
  type WorkflowRunnerEffectIntentMessage,
  type WorkflowRunnerPreparedMessage,
} from './workflow-runner-contract.js';
import type {
  WorkflowEffectIntentEvidence,
  WorkflowEffectIntentPreparation,
  WorkflowEffectLeaseBinding,
} from './internal/workflow-effect-lease-authority.js';

const AUTHORITY_RECORD_SCHEMA = 'openslack.workflow_effect_authority_record.v1' as const;
const EXECUTION_RECORD_SCHEMA = 'openslack.workflow_effect_execution_record.v1' as const;
const LOCK_SCHEMA = 'openslack.workflow_effect_authority_lock.v1' as const;
const AUTHORITY_DIRECTORY = 'effect-authority';
const MAX_AUTHORITY_BYTES = 640 * 1024;
const MAX_EXECUTION_BYTES = 768 * 1024;
const MAX_REPLAY_BYTES = 64 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHORITY_FILE = /^[0-9a-f]{64}\.json$/u;
const SESSION_ID = randomUUID();
const JOURNAL_SECURITY = productionJournalSecurity();

type AuthorityState =
  | 'provisional'
  | 'intent_accepted'
  | 'approval_committed'
  | 'decision_prepared';
type AuthorityExecutionState = 'unclaimed' | 'claimed' | 'executed' | 'reconciliation_required';

interface ExecutionOwner {
  readonly pid: number;
  readonly sessionId: string;
  readonly threadId: number;
  readonly nonce: string;
}

interface PreparedDecision {
  readonly nextApproval: WorkflowEffectApprovalRecord;
  readonly nextApprovalRecordHash: string;
  readonly humanDecision: WorkflowEffectControlHumanDecisionProjection;
  readonly approvalDecisionHash: string;
  readonly owner: ExecutionOwner;
}

interface AuthorityIdentity {
  readonly workspaceId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly descriptorExpiresAt: string;
  readonly effectKind: string;
  readonly effectId: string;
  readonly effectHash: string;
}

interface AuthorityRecord extends AuthorityIdentity {
  readonly schema: typeof AUTHORITY_RECORD_SCHEMA;
  readonly evaluationIndex: number;
  readonly identityHash: string;
  readonly validationContext: WorkflowEffectControlValidationContext;
  readonly validationContextHash: string;
  readonly state: AuthorityState;
  readonly executionState: AuthorityExecutionState;
  readonly executionId: string | null;
  readonly provisionalMessage: WorkflowRunnerEffectIntentMessage | null;
  readonly provisionalPrepared: WorkflowRunnerPreparedMessage | null;
  readonly preparedDecision: PreparedDecision | null;
  readonly artifact:
    | WorkflowEffectIntentArtifact
    | Extract<
        ReturnType<typeof validateWorkflowEffectControlArtifact>,
        {
          readonly kind:
            | 'effect_approval_pending'
            | 'effect_decision_committed'
            | 'effect_audit_recorded';
        }
      >
    | null;
}

type ExecutionReplay =
  | { readonly kind: 'undefined' }
  | { readonly kind: 'json'; readonly value: unknown; readonly resultHash: string };

interface ExecutionRecord {
  readonly schema: typeof EXECUTION_RECORD_SCHEMA;
  readonly artifact: WorkflowEffectExecutionClaimArtifact;
  readonly owner: ExecutionOwner | null;
  readonly replay: ExecutionReplay | null;
}

interface StorePaths {
  readonly root: string;
  readonly records: string;
  readonly claims: string;
  readonly locks: string;
}

interface ClaimedAuthority {
  readonly executionId: string;
}

const CLAIM_AUTHORITIES = new WeakMap<
  object,
  {
    readonly root: string;
    readonly owner: ExecutionOwner;
    readonly runId: string;
    readonly evaluationIndex: number;
    readonly occurrenceId: string;
    readonly executionId: string;
    readonly expectedControlBuildHash: string;
  }
>();

export class WorkflowEffectAuthorityStoreError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE'
      | 'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE'
      | 'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID'
      | 'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH'
      | 'WORKFLOW_EFFECT_AUTHORITY_BUSY'
      | 'WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED'
      | 'WORKFLOW_EFFECT_AUTHORITY_PENDING'
      | 'WORKFLOW_EFFECT_AUTHORITY_REJECTED'
      | 'WORKFLOW_EFFECT_AUTHORITY_EXPIRED'
      | 'WORKFLOW_EFFECT_AUTHORITY_ALREADY_CLAIMED'
      | 'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowEffectAuthorityStoreError';
  }
}

function fail(
  code: WorkflowEffectAuthorityStoreError['code'],
  message: string,
  cause?: unknown,
): never {
  throw new WorkflowEffectAuthorityStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function authorityRoot(approvalStoreRoot: string): string | undefined {
  if (!isAbsolute(approvalStoreRoot) || resolve(approvalStoreRoot) !== approvalStoreRoot) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE', 'Approval store root is unsafe.');
  }
  if (basename(approvalStoreRoot) !== 'effect-approvals') return undefined;
  return join(dirname(approvalStoreRoot), AUTHORITY_DIRECTORY);
}

/** @internal Exact authority recovery is enabled only for the canonical runtime store. */
export function hasWorkflowEffectAuthorityRoot(approvalStoreRoot: string): boolean {
  return authorityRoot(approvalStoreRoot) !== undefined;
}

async function present(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function approvalEvidenceExists(approvalStoreRoot: string): Promise<boolean> {
  const records = join(approvalStoreRoot, 'records');
  const stat = await present(records);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE', 'Approval evidence directory is unsafe.');
  }
  return (await readdir(records)).length > 0;
}

async function preparePaths(approvalStoreRoot: string, create: boolean): Promise<StorePaths> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root)
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE',
      'Approval store root is not the authenticated workflow authority root.',
    );
  const existingRoot = await present(root);
  if (!create && !existingRoot) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE', 'Authority root is missing.');
  }
  if (!existingRoot && create && (await approvalEvidenceExists(approvalStoreRoot))) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Approval evidence exists but its authority lineage is missing.',
    );
  }
  try {
    await ensureOwnerDirectory(root, JOURNAL_SECURITY);
  } catch (error) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE', 'Authority root is unsafe.', error);
  }
  const paths = {
    root,
    records: join(root, 'records'),
    claims: join(root, 'claims'),
    locks: join(root, 'locks'),
  };
  for (const path of [paths.records, paths.claims, paths.locks]) {
    try {
      await ensureOwnerDirectory(path, JOURNAL_SECURITY, root);
    } catch (error) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE',
        'Authority child directory is unsafe.',
        error,
      );
    }
  }
  const names = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name).sort();
  if (names.join('\0') !== ['claims', 'locks', 'records'].join('\0')) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
      'Authority root contains unknown entries.',
    );
  }
  return Object.freeze(paths);
}

async function validateAuthorityTree(paths: StorePaths): Promise<void> {
  let entries = 0;
  let totalBytes = 0;
  for (const [directory, allowed] of [
    [paths.records, (name: string) => AUTHORITY_FILE.test(name)],
    [paths.claims, (name: string) => AUTHORITY_FILE.test(name)],
    [paths.locks, (name: string) => name === 'authority.lock'],
  ] as const) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED',
          'Authority store entry limit exceeded.',
        );
      }
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (
        !allowed(entry.name) ||
        entry.isSymbolicLink() ||
        stat.isSymbolicLink() ||
        !entry.isFile() ||
        !stat.isFile()
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
          'Authority store contains an unsafe entry.',
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED',
          'Authority store byte limit exceeded.',
        );
      }
    }
  }
}

function key(...parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

function recordPath(paths: StorePaths, runId: string, evaluationIndex: number): string {
  return join(paths.records, `${key(runId, evaluationIndex)}.json`);
}

function claimPath(paths: StorePaths, runId: string, occurrenceId: string): string {
  return join(paths.claims, `${key(runId, occurrenceId)}.json`);
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalWorkflowEffectControlJson(value)}\n`, 'utf8');
}

async function readBounded(
  path: string,
  _root: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const initial = await present(path);
  if (!initial) return undefined;
  try {
    const text = await readOwnerFile(path, JOURNAL_SECURITY, maxBytes);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length < 2 || bytes.length > maxBytes) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority file is unsafe.');
    }
    return bytes;
  } catch (error) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority file is unsafe.', error);
  }
}

async function atomicWrite(
  path: string,
  _directory: string,
  bytes: Buffer,
  maxBytes: number,
): Promise<void> {
  if (bytes.length < 2 || bytes.length > maxBytes) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Authority record exceeds its byte limit.',
    );
  }
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    await atomicWriteOwnerFile(path, body, JOURNAL_SECURITY);
  } catch (error) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority record write failed.', error);
  }
}

interface LockOwner extends ExecutionOwner {
  readonly schema: typeof LOCK_SCHEMA;
  readonly createdAt: string;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function transientLockRead(error: unknown): boolean {
  if (
    !(error instanceof WorkflowEffectAuthorityStoreError) ||
    error.code !== 'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE'
  ) {
    return false;
  }
  const cause = error.cause;
  if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return true;
  if (!(cause instanceof Error)) return false;
  return [
    'Workflow Control shadow journal file changed during validation.',
    'Owner-only file identity changed before read.',
    'Owner-only file changed during read.',
  ].includes(cause.message);
}

function parseLockOwner(bytes: Buffer): LockOwner {
  const value = parseWorkflowEffectJson(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority lock is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 6 ||
    !['schema', 'pid', 'sessionId', 'threadId', 'nonce', 'createdAt'].every((field) =>
      Object.hasOwn(record, field),
    ) ||
    record.schema !== LOCK_SCHEMA ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    new Date(Date.parse(record.createdAt)).toISOString() !== record.createdAt
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority lock is invalid.');
  }
  const owner = validateExecutionOwner({
    pid: record.pid,
    sessionId: record.sessionId,
    threadId: record.threadId,
    nonce: record.nonce,
  });
  const result = Object.freeze({ schema: LOCK_SCHEMA, ...owner, createdAt: record.createdAt });
  if (!bytes.equals(canonicalBytes(result))) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority lock is not canonical.');
  }
  return result;
}

async function withLock<T>(paths: StorePaths, operation: () => Promise<T>): Promise<T> {
  const path = join(paths.locks, 'authority.lock');
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const owner: LockOwner = {
      schema: LOCK_SCHEMA,
      pid: process.pid,
      sessionId: SESSION_ID,
      threadId,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    try {
      await writeExclusive(
        path,
        new TextDecoder('utf-8', { fatal: true }).decode(canonicalBytes(owner)),
        JOURNAL_SECURITY,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = await present(path);
      if (!before) continue;
      let bytes: Buffer | undefined;
      try {
        bytes = await readBounded(path, paths.locks, 1024);
      } catch (readError) {
        if (transientLockRead(readError)) continue;
        const repeated = await present(path);
        if (!repeated || !sameFileIdentity(before, repeated)) continue;
        throw readError;
      }
      if (!bytes) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
        continue;
      }
      const existing = parseLockOwner(bytes);
      if (ownerIsProvablyDead(existing)) {
        const repeated = await present(path);
        if (!repeated || !sameFileIdentity(before, repeated)) continue;
        await rm(path);
        await syncDirectory(paths.locks);
        continue;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      continue;
    }
    await syncDirectory(paths.locks);
    const acquired = await lstat(path);
    try {
      await validateAuthorityTree(paths);
      return await operation();
    } finally {
      const current = await lstat(path);
      if (!sameFileIdentity(acquired, current)) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
          'Authority lock changed before release.',
        );
      }
      await rm(path);
      await syncDirectory(paths.locks);
    }
  }
  return fail('WORKFLOW_EFFECT_AUTHORITY_BUSY', 'Authority lock retry limit exceeded.');
}

function assertIdentity(
  record: AuthorityRecord,
  expected: AuthorityIdentity & { evaluationIndex: number },
): void {
  for (const field of [
    'workspaceId',
    'runId',
    'correlationId',
    'workflowId',
    'workflowVersion',
    'workflowSourceHash',
    'manifestHash',
    'inputHash',
    'descriptorExpiresAt',
    'effectKind',
    'effectId',
    'effectHash',
  ] as const) {
    if (record[field] !== expected[field]) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
        `${field} changed for a durable effect occurrence.`,
      );
    }
  }
  if (record.evaluationIndex !== expected.evaluationIndex) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH', 'Effect evaluation index changed.');
  }
}

function authorityIdentityHash(
  identity: AuthorityIdentity & { readonly evaluationIndex: number },
): string {
  return hashWorkflowEffectControlDomain('authority-record-identity', identity);
}

function assertArtifactLineage(
  identity: AuthorityIdentity,
  artifact: NonNullable<AuthorityRecord['artifact']>,
): void {
  const intent = artifact.kind === 'effect_intent' ? artifact : artifact.intentArtifact;
  const message = intent.runnerV1Message;
  if (
    intent.workspaceId !== identity.workspaceId ||
    intent.runId !== identity.runId ||
    message.workspaceId !== identity.workspaceId ||
    message.workflowRunId !== identity.runId ||
    message.correlationId !== identity.correlationId ||
    message.payload.effectKind !== identity.effectKind ||
    message.payload.effectId !== identity.effectId ||
    message.payload.effectHash !== identity.effectHash ||
    message.payload.requiresHumanDecision !== true
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
      'Runner intent and authority identity differ.',
    );
  }
  if (artifact.kind === 'effect_intent') return;
  if (
    artifact.workspaceId !== identity.workspaceId ||
    artifact.runId !== identity.runId ||
    artifact.correlationId !== identity.correlationId ||
    artifact.intentEffectId !== identity.effectId ||
    artifact.intentEffectHash !== identity.effectHash ||
    artifact.approval.runId !== identity.runId ||
    artifact.approval.correlationId !== identity.correlationId ||
    artifact.approval.workflowId !== identity.workflowId ||
    artifact.approval.workflowVersion !== identity.workflowVersion ||
    artifact.approval.workflowHash !== identity.workflowSourceHash ||
    artifact.approval.inputHash !== identity.inputHash ||
    artifact.approval.effectId !== identity.effectId ||
    artifact.approval.effectHash !== identity.effectHash ||
    artifact.approval.requiredCapability !== 'workflow.effect.decide'
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
      'Approval artifact and authority identity differ.',
    );
  }
}

function validateExecutionOwner(value: unknown): ExecutionOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution owner is invalid.');
  }
  const owner = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(owner).length !== 4 ||
    !['pid', 'sessionId', 'threadId', 'nonce'].every((field) => Object.hasOwn(owner, field)) ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) < 1 ||
    (owner.pid as number) > 2_147_483_647 ||
    typeof owner.sessionId !== 'string' ||
    !UUID_V4.test(owner.sessionId) ||
    !Number.isSafeInteger(owner.threadId) ||
    (owner.threadId as number) < 0 ||
    (owner.threadId as number) > 2_147_483_647 ||
    typeof owner.nonce !== 'string' ||
    !UUID_V4.test(owner.nonce)
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution owner is invalid.');
  }
  return Object.freeze({
    pid: owner.pid as number,
    sessionId: owner.sessionId,
    threadId: owner.threadId as number,
    nonce: owner.nonce,
  });
}

function validateAuthorityRecord(value: unknown): AuthorityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Authority record must be an object.');
  }
  const record = value as Record<string, unknown>;
  const fields = [
    'schema',
    'evaluationIndex',
    'identityHash',
    'validationContext',
    'validationContextHash',
    'state',
    'executionState',
    'executionId',
    'workspaceId',
    'runId',
    'correlationId',
    'workflowId',
    'workflowVersion',
    'workflowSourceHash',
    'manifestHash',
    'inputHash',
    'descriptorExpiresAt',
    'effectKind',
    'effectId',
    'effectHash',
    'provisionalMessage',
    'provisionalPrepared',
    'preparedDecision',
    'artifact',
  ];
  if (
    Reflect.ownKeys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Authority record is not closed.');
  }
  if (
    record.schema !== AUTHORITY_RECORD_SCHEMA ||
    !Number.isSafeInteger(record.evaluationIndex) ||
    (record.evaluationIndex as number) < 1 ||
    !['provisional', 'intent_accepted', 'approval_committed', 'decision_prepared'].includes(
      record.state as string,
    ) ||
    !['unclaimed', 'claimed', 'executed', 'reconciliation_required'].includes(
      record.executionState as string,
    ) ||
    (record.executionState === 'unclaimed'
      ? record.executionId !== null
      : typeof record.executionId !== 'string' ||
        !/^WFEXECUTION-[0-9a-f]{64}$/u.test(record.executionId))
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Authority record state is invalid.');
  }
  const identityFields = [
    'workspaceId',
    'runId',
    'correlationId',
    'workflowId',
    'workflowVersion',
    'effectKind',
    'effectId',
  ] as const;
  if (
    identityFields.some(
      (field) => typeof record[field] !== 'string' || !SAFE_ID.test(record[field] as string),
    )
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Authority record identity is invalid.',
    );
  }
  const hashFields = ['workflowSourceHash', 'manifestHash', 'inputHash', 'effectHash'] as const;
  if (
    hashFields.some(
      (field) => typeof record[field] !== 'string' || !HASH.test(record[field] as string),
    )
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Authority record hash is invalid.');
  }
  if (
    typeof record.descriptorExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(record.descriptorExpiresAt)) ||
    new Date(Date.parse(record.descriptorExpiresAt)).toISOString() !== record.descriptorExpiresAt
  )
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Descriptor expiry is invalid.');
  const identity = Object.freeze({
    workspaceId: record.workspaceId as string,
    runId: record.runId as string,
    correlationId: record.correlationId as string,
    workflowId: record.workflowId as string,
    workflowVersion: record.workflowVersion as string,
    workflowSourceHash: record.workflowSourceHash as string,
    manifestHash: record.manifestHash as string,
    inputHash: record.inputHash as string,
    descriptorExpiresAt: record.descriptorExpiresAt as string,
    effectKind: record.effectKind as string,
    effectId: record.effectId as string,
    effectHash: record.effectHash as string,
  });
  const identityHash = authorityIdentityHash({
    ...identity,
    evaluationIndex: record.evaluationIndex as number,
  });
  if (record.identityHash !== identityHash) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Authority identity hash changed.');
  }
  const validationContextValue = record.validationContext;
  if (
    !validationContextValue ||
    typeof validationContextValue !== 'object' ||
    Array.isArray(validationContextValue) ||
    Reflect.ownKeys(validationContextValue).length !== 1 ||
    !Object.hasOwn(validationContextValue, 'expectedControlBuildHash')
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Authority validation context is invalid.',
    );
  }
  const validationContext = validationContextValue as WorkflowEffectControlValidationContext;
  if (!HASH.test(validationContext.expectedControlBuildHash)) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Control build hash is invalid.');
  }
  const validationContextHash = record.validationContextHash;
  if (
    typeof validationContextHash !== 'string' ||
    validationContextHash !==
      hashWorkflowEffectControlDomain('validation-context', validationContext)
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Validation context hash changed.');
  }
  let provisionalMessage: WorkflowRunnerEffectIntentMessage | null = null;
  let provisionalPrepared: WorkflowRunnerPreparedMessage | null = null;
  let preparedDecision: PreparedDecision | null = null;
  let artifact: AuthorityRecord['artifact'] = null;
  if (record.state === 'provisional') {
    const message = validateWorkflowRunnerMessage(record.provisionalMessage);
    if (message.kind !== 'effect_intent')
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Provisional intent kind is invalid.',
      );
    provisionalMessage = message;
    provisionalPrepared = prepareWorkflowRunnerMessage(message);
    if (
      canonicalWorkflowEffectControlJson(provisionalPrepared) !==
      canonicalWorkflowEffectControlJson(record.provisionalPrepared)
    ) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Provisional prepared evidence changed.',
      );
    }
    if (record.artifact !== null || record.preparedDecision !== null)
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Provisional record cannot contain committed data.',
      );
  } else {
    if (record.provisionalMessage !== null || record.provisionalPrepared !== null) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Committed authority record retains provisional data.',
      );
    }
    artifact = validateWorkflowEffectControlArtifact(
      record.artifact,
      validationContext,
    ) as AuthorityRecord['artifact'];
    if (
      !artifact ||
      (record.state === 'intent_accepted' && artifact.kind !== 'effect_intent') ||
      (record.state === 'approval_committed' &&
        !['effect_approval_pending', 'effect_decision_committed', 'effect_audit_recorded'].includes(
          artifact.kind,
        )) ||
      (record.state === 'decision_prepared' && artifact.kind !== 'effect_approval_pending')
    ) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Authority artifact state is invalid.',
      );
    }
    assertArtifactLineage(identity, artifact);
    if (record.state === 'decision_prepared') {
      if (!record.preparedDecision || typeof record.preparedDecision !== 'object') {
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Prepared decision is missing.');
      }
      const pending = artifact as WorkflowEffectApprovalPendingArtifact;
      const candidate = record.preparedDecision as PreparedDecision;
      const nextApproval = validateWorkflowEffectApproval(candidate.nextApproval);
      const nextApprovalRecordHash = hashWorkflowEffectApprovalRecord(nextApproval);
      const humanDecision = projectWorkflowEffectHumanDecision({
        approval: nextApproval,
        issuedAt: candidate.humanDecision.issuedAt,
        expiresAt: candidate.humanDecision.expiresAt,
      });
      const approvalDecisionHash = hashWorkflowEffectApprovalDecision(nextApproval, humanDecision);
      const owner = validateExecutionOwner(candidate.owner);
      if (
        candidate.nextApprovalRecordHash !== nextApprovalRecordHash ||
        canonicalWorkflowEffectControlJson(candidate.humanDecision) !==
          canonicalWorkflowEffectControlJson(humanDecision) ||
        candidate.approvalDecisionHash !== approvalDecisionHash
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
          'Prepared decision hashes changed.',
        );
      }
      const validated = validateWorkflowEffectControlArtifact(
        {
          ...pending,
          kind: 'effect_decision_committed',
          approval: nextApproval,
          approvalRecordHash: nextApprovalRecordHash,
          approvalDecisionHash,
          humanDecision,
        },
        validationContext,
      );
      if (validated.kind !== 'effect_decision_committed') {
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Prepared decision is invalid.');
      }
      preparedDecision = Object.freeze({
        nextApproval,
        nextApprovalRecordHash,
        humanDecision,
        approvalDecisionHash,
        owner,
      });
    } else if (record.preparedDecision !== null) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Committed record retains prepared decision data.',
      );
    }
  }
  if (record.executionState !== 'unclaimed') {
    if (
      record.state !== 'approval_committed' ||
      !artifact ||
      (artifact.kind !== 'effect_decision_committed' &&
        artifact.kind !== 'effect_audit_recorded') ||
      artifact.approval.status !== 'approved' ||
      artifact.approvalDecisionHash === null
    ) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Execution high-watermark is not backed by an approved decision.',
      );
    }
    const expectedExecutionId = `WFEXECUTION-${hashWorkflowEffectControlDomain('execution-id', {
      approvalDecisionHash: artifact.approvalDecisionHash,
      occurrenceId: artifact.occurrenceId,
    })}`;
    if (record.executionId !== expectedExecutionId) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Execution high-watermark identity changed.',
      );
    }
  }
  const result = Object.freeze({
    schema: AUTHORITY_RECORD_SCHEMA,
    evaluationIndex: record.evaluationIndex as number,
    identityHash,
    validationContext: Object.freeze({
      expectedControlBuildHash: validationContext.expectedControlBuildHash,
    }),
    validationContextHash,
    state: record.state as AuthorityState,
    executionState: record.executionState as AuthorityExecutionState,
    executionId: record.executionId as string | null,
    workspaceId: record.workspaceId as string,
    runId: record.runId as string,
    correlationId: record.correlationId as string,
    workflowId: record.workflowId as string,
    workflowVersion: record.workflowVersion as string,
    workflowSourceHash: record.workflowSourceHash as string,
    manifestHash: record.manifestHash as string,
    inputHash: record.inputHash as string,
    descriptorExpiresAt: record.descriptorExpiresAt as string,
    effectKind: record.effectKind as string,
    effectId: record.effectId as string,
    effectHash: record.effectHash as string,
    provisionalMessage,
    provisionalPrepared,
    preparedDecision,
    artifact,
  });
  return result;
}

function parseAuthorityRecord(bytes: Buffer): AuthorityRecord {
  const record = validateAuthorityRecord(
    parseWorkflowEffectJson(bytes, {
      maxDepth: 24,
      maxNodes: 8_192,
      maxStringLength: 256 * 1024,
    }),
  );
  if (!bytes.equals(canonicalBytes(record))) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Authority record bytes are not canonical.',
    );
  }
  return record;
}

async function readAuthority(
  paths: StorePaths,
  runId: string,
  evaluationIndex: number,
): Promise<AuthorityRecord | undefined> {
  const path = recordPath(paths, runId, evaluationIndex);
  const bytes = await readBounded(path, paths.records, MAX_AUTHORITY_BYTES);
  return bytes ? parseAuthorityRecord(bytes) : undefined;
}

async function writeAuthority(paths: StorePaths, record: AuthorityRecord): Promise<void> {
  const validated = validateAuthorityRecord(record);
  await atomicWrite(
    recordPath(paths, record.runId, record.evaluationIndex),
    paths.records,
    canonicalBytes(validated),
    MAX_AUTHORITY_BYTES,
  );
}

async function writeAuthorityExecutionState(
  paths: StorePaths,
  record: AuthorityRecord,
  executionState: AuthorityExecutionState,
  executionId: string,
): Promise<AuthorityRecord> {
  const next = validateAuthorityRecord({ ...record, executionState, executionId });
  await writeAuthority(paths, next);
  return next;
}

async function assertRunExecutionClear(paths: StorePaths, runId: string): Promise<void> {
  for (const entry of await readdir(paths.records, { withFileTypes: true })) {
    if (!AUTHORITY_FILE.test(entry.name)) continue;
    const bytes = await readBounded(
      join(paths.records, entry.name),
      paths.records,
      MAX_AUTHORITY_BYTES,
    );
    if (!bytes) continue;
    const record = parseAuthorityRecord(bytes);
    if (record.runId !== runId) continue;
    if (record.executionState === 'reconciliation_required') {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'A prior workflow effect requires reconciliation before any successor action.',
      );
    }
    if (record.executionState === 'claimed') {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'A prior workflow effect claim has no proved terminal outcome.',
      );
    }
  }
}

function authorityBase(
  binding: WorkflowEffectLeaseBinding,
  evaluationIndex: number,
  effectKind: string,
  effectId: string,
  effectHash: string,
) {
  const validationContext = Object.freeze({
    expectedControlBuildHash: binding.expectedControlBuildHash,
  });
  const identity = Object.freeze({
    workspaceId: binding.workspaceId,
    runId: binding.runId,
    correlationId: binding.correlationId,
    workflowId: binding.workflowId,
    workflowVersion: binding.workflowVersion,
    workflowSourceHash: binding.workflowSourceHash,
    manifestHash: binding.manifestHash,
    inputHash: binding.inputHash,
    descriptorExpiresAt: binding.descriptorExpiresAt,
    effectKind,
    effectId,
    effectHash,
  });
  return {
    schema: AUTHORITY_RECORD_SCHEMA,
    evaluationIndex,
    identityHash: authorityIdentityHash({ ...identity, evaluationIndex }),
    validationContext,
    validationContextHash: hashWorkflowEffectControlDomain('validation-context', validationContext),
    executionState: 'unclaimed' as const,
    executionId: null,
    ...identity,
  } as const;
}

export interface PreparedWorkflowEffectOccurrence {
  readonly record: AuthorityRecord;
}

export class LocalWorkflowEffectAuthorityStore {
  readonly #approvalRoot: string;
  readonly #now: () => string;

  constructor(approvalStoreRoot: string, now: () => string = () => new Date().toISOString()) {
    if (!authorityRoot(approvalStoreRoot)) {
      fail(
        'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE',
        'Approval store root is not the authenticated workflow authority root.',
      );
    }
    this.#approvalRoot = approvalStoreRoot;
    this.#now = now;
  }

  async find(
    binding: WorkflowEffectLeaseBinding,
    evaluationIndex: number,
    effectKind: string,
    effectId: string,
    effectHash: string,
  ): Promise<PreparedWorkflowEffectOccurrence | undefined> {
    const paths = await preparePaths(this.#approvalRoot, true);
    return withLock(paths, async () => {
      await assertRunExecutionClear(paths, binding.runId);
      const record = await readAuthority(paths, binding.runId, evaluationIndex);
      if (!record) return undefined;
      assertIdentity(record, {
        ...authorityBase(binding, evaluationIndex, effectKind, effectId, effectHash),
        evaluationIndex,
      });
      if (record.state === 'provisional') {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'An effect intent was not durably receipted before restart.',
        );
      }
      return Object.freeze({ record });
    });
  }

  async recoverPreparedDecision(
    prepared: PreparedWorkflowEffectOccurrence,
    approvalValue: WorkflowEffectApprovalRecord | undefined,
  ): Promise<PreparedWorkflowEffectOccurrence> {
    const paths = await preparePaths(this.#approvalRoot, false);
    return withLock(paths, async () => {
      const current = await readAuthority(
        paths,
        prepared.record.runId,
        prepared.record.evaluationIndex,
      );
      if (!current) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Prepared workflow effect decision disappeared during recovery.',
        );
      }
      if (current.identityHash !== prepared.record.identityHash) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Prepared workflow effect decision identity changed during recovery.',
        );
      }
      if (current.state !== 'decision_prepared') {
        return Object.freeze({ record: current });
      }
      if (current.artifact?.kind !== 'effect_approval_pending' || !current.preparedDecision) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Prepared workflow effect decision is incomplete.',
        );
      }
      const pending = current.artifact;
      const decision = current.preparedDecision;
      if (!approvalValue) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'The v2 approval record is unavailable during decision recovery.',
        );
      }
      const approval = validateWorkflowEffectApproval(approvalValue);
      if (approval.revision === 0 && approval.status === 'pending') {
        if (
          canonicalWorkflowEffectControlJson(approval) !==
          canonicalWorkflowEffectControlJson(pending.approval)
        ) {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
            'Pending v2 approval changed during decision recovery.',
          );
        }
        if (!ownerIsProvablyDead(decision.owner)) {
          return Object.freeze({ record: current });
        }
        const rolledBack = validateAuthorityRecord({
          ...current,
          state: 'approval_committed',
          preparedDecision: null,
        });
        await writeAuthority(paths, rolledBack);
        return Object.freeze({ record: rolledBack });
      }
      if (
        approval.status !== decision.nextApproval.status ||
        approval.status === 'pending' ||
        approval.decision === null ||
        hashWorkflowEffectApprovalDecision(approval, decision.humanDecision) !==
          decision.approvalDecisionHash
      ) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'The committed v2 decision differs from its prepared authority evidence.',
        );
      }
      const committed = validateWorkflowEffectControlArtifact(
        {
          ...pending,
          kind: 'effect_decision_committed',
          approval: decision.nextApproval,
          approvalRecordHash: decision.nextApprovalRecordHash,
          approvalDecisionHash: decision.approvalDecisionHash,
          humanDecision: decision.humanDecision,
        },
        current.validationContext,
      );
      if (committed.kind !== 'effect_decision_committed') {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
          'Recovered workflow effect decision changed kind.',
        );
      }
      let artifact: WorkflowEffectDecisionCommittedArtifact | WorkflowEffectAuditRecordedArtifact =
        committed;
      if (approval.revision === 2) {
        const recorded = validateWorkflowEffectControlArtifact(
          {
            ...committed,
            kind: 'effect_audit_recorded',
            approval,
            approvalRecordHash: hashWorkflowEffectApprovalRecord(approval),
          },
          current.validationContext,
        );
        if (recorded.kind !== 'effect_audit_recorded') {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
            'Recovered workflow effect audit changed kind.',
          );
        }
        artifact = recorded;
      } else if (
        canonicalWorkflowEffectControlJson(approval) !==
        canonicalWorkflowEffectControlJson(decision.nextApproval)
      ) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'The revision-one v2 decision differs from prepared exact bytes.',
        );
      }
      const recovered = validateAuthorityRecord({
        ...current,
        state: 'approval_committed',
        preparedDecision: null,
        artifact,
      });
      await writeAuthority(paths, recovered);
      return Object.freeze({ record: recovered });
    });
  }

  async persistProvisional(
    binding: WorkflowEffectLeaseBinding,
    evaluationIndex: number,
    effectKind: string,
    effectId: string,
    effectHash: string,
    preparation: WorkflowEffectIntentPreparation,
  ): Promise<void> {
    const paths = await preparePaths(this.#approvalRoot, true);
    await withLock(paths, async () => {
      const existing = await readAuthority(paths, binding.runId, evaluationIndex);
      if (existing)
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Effect occurrence already exists.',
        );
      const record = validateAuthorityRecord({
        ...authorityBase(binding, evaluationIndex, effectKind, effectId, effectHash),
        state: 'provisional',
        provisionalMessage: preparation.message,
        provisionalPrepared: preparation.prepared,
        preparedDecision: null,
        artifact: null,
      });
      await writeAuthority(paths, record);
    });
  }

  async acceptIntent(
    binding: WorkflowEffectLeaseBinding,
    evaluationIndex: number,
    effectKind: string,
    effectId: string,
    effectHash: string,
    evidence: WorkflowEffectIntentEvidence,
  ): Promise<PreparedWorkflowEffectOccurrence> {
    const paths = await preparePaths(this.#approvalRoot, true);
    return withLock(paths, async () => {
      const current = await readAuthority(paths, binding.runId, evaluationIndex);
      if (!current || current.state !== 'provisional') {
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Provisional intent is missing.');
      }
      assertIdentity(current, {
        ...authorityBase(binding, evaluationIndex, effectKind, effectId, effectHash),
        evaluationIndex,
      });
      if (
        canonicalWorkflowEffectControlJson(current.provisionalMessage) !==
          canonicalWorkflowEffectControlJson(evidence.message) ||
        canonicalWorkflowEffectControlJson(current.provisionalPrepared) !==
          canonicalWorkflowEffectControlJson(evidence.prepared)
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Accepted intent differs from its provisional bytes.',
        );
      }
      const occurrenceIndex = evidence.message.sequence;
      const intent = validateWorkflowEffectControlArtifact(
        {
          schema: WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA,
          contractVersion: WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
          authority: 'typescript',
          writer: '@openslack/workflows',
          goRole: 'validator_only',
          goAuthorityClaim: 'NO_AUTHORITY',
          goAuthorityEligible: false,
          kind: 'effect_intent',
          workspaceId: binding.workspaceId,
          runId: binding.runId,
          occurrenceIndex,
          occurrenceId: deriveWorkflowEffectOccurrenceId(binding.runId, occurrenceIndex),
          runnerV1Message: evidence.message,
          runnerV1Prepared: evidence.prepared,
          runnerV1Receipt: evidence.receipt,
        },
        current.validationContext,
      );
      if (intent.kind !== 'effect_intent')
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Intent artifact kind changed.');
      const next = validateAuthorityRecord({
        ...current,
        state: 'intent_accepted',
        provisionalMessage: null,
        provisionalPrepared: null,
        preparedDecision: null,
        artifact: intent,
      });
      await writeAuthority(paths, next);
      return Object.freeze({ record: next });
    });
  }

  async commitPending(
    prepared: PreparedWorkflowEffectOccurrence,
    approvalValue: WorkflowEffectApprovalRecord,
  ): Promise<PreparedWorkflowEffectOccurrence> {
    const approval = validateWorkflowEffectApproval(approvalValue);
    const paths = await preparePaths(this.#approvalRoot, true);
    return withLock(paths, async () => {
      const current = await readAuthority(
        paths,
        prepared.record.runId,
        prepared.record.evaluationIndex,
      );
      if (
        !current ||
        current.state !== 'intent_accepted' ||
        current.artifact?.kind !== 'effect_intent'
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
          'Accepted intent is unavailable for pending approval.',
        );
      }
      const intent = current.artifact;
      const intentBindingHash = hashWorkflowEffectIntentBinding(intent, current.validationContext);
      if (
        approval.approvalId !==
          deriveWorkflowEffectApprovalId(intent.occurrenceId, intentBindingHash) ||
        approval.runId !== current.runId ||
        approval.correlationId !== current.correlationId ||
        approval.workflowId !== current.workflowId ||
        approval.workflowVersion !== current.workflowVersion ||
        approval.workflowHash !== current.workflowSourceHash ||
        approval.inputHash !== current.inputHash ||
        approval.effectId !== current.effectId ||
        approval.effectHash !== current.effectHash ||
        approval.requiredCapability !== 'workflow.effect.decide'
      )
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Pending approval identity changed.',
        );
      const artifact = validateWorkflowEffectControlArtifact(
        {
          schema: intent.schema,
          contractVersion: intent.contractVersion,
          authority: intent.authority,
          writer: intent.writer,
          goRole: intent.goRole,
          goAuthorityClaim: intent.goAuthorityClaim,
          goAuthorityEligible: intent.goAuthorityEligible,
          kind: 'effect_approval_pending',
          workspaceId: intent.workspaceId,
          runId: intent.runId,
          occurrenceIndex: intent.occurrenceIndex,
          occurrenceId: intent.occurrenceId,
          intentArtifact: intent,
          intentBindingHash,
          intentEffectId: current.effectId,
          intentEffectHash: current.effectHash,
          correlationId: current.correlationId,
          approval,
          approvalRecordHash: hashWorkflowEffectApprovalRecord(approval),
          approvalDecisionHash: null,
        },
        current.validationContext,
      );
      if (artifact.kind !== 'effect_approval_pending')
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Pending artifact kind changed.');
      const next = validateAuthorityRecord({
        ...current,
        state: 'approval_committed',
        preparedDecision: null,
        artifact,
      });
      await writeAuthority(paths, next);
      return Object.freeze({ record: next });
    });
  }

  async claim(
    prepared: PreparedWorkflowEffectOccurrence,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly disposition: 'created';
        readonly authority: ClaimedAuthority;
        readonly artifact: WorkflowEffectExecutionClaimArtifact;
      }
    | {
        readonly disposition: 'replay';
        readonly value: unknown;
        readonly artifact: WorkflowEffectExecutionClaimArtifact;
      }
  > {
    const paths = await preparePaths(this.#approvalRoot, true);
    return withLock(paths, async () => {
      if (signal?.aborted)
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_REJECTED',
          'Effect claim was cancelled before acquisition.',
        );
      const current = await readAuthority(
        paths,
        prepared.record.runId,
        prepared.record.evaluationIndex,
      );
      if (
        !current ||
        current.identityHash !== prepared.record.identityHash ||
        current.validationContextHash !== prepared.record.validationContextHash
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Prepared effect identity changed before claim acquisition.',
        );
      }
      if (
        current.state !== 'approval_committed' ||
        !current.artifact ||
        !['effect_decision_committed', 'effect_audit_recorded'].includes(current.artifact.kind)
      ) {
        if (current?.artifact?.kind === 'effect_approval_pending')
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_PENDING',
            'Workflow effect approval is pending or committing.',
          );
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
          'Terminal approval artifact is unavailable.',
        );
      }
      const approvalArtifact = current.artifact as
        | WorkflowEffectDecisionCommittedArtifact
        | WorkflowEffectAuditRecordedArtifact;
      if (approvalArtifact.approval.status === 'rejected')
        return fail('WORKFLOW_EFFECT_AUTHORITY_REJECTED', 'Workflow effect approval was rejected.');
      const path = claimPath(paths, current.runId, approvalArtifact.occurrenceId);
      const existingBytes = await readBounded(path, paths.claims, MAX_EXECUTION_BYTES);
      if (existingBytes) {
        const existing = parseExecutionRecord(
          existingBytes,
          current.validationContext,
          approvalArtifact,
        );
        if (current.executionId !== null && current.executionId !== existing.artifact.executionId) {
          return fail(
            'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
            'Execution claim and authority high-watermark differ.',
          );
        }
        if (existing.artifact.claimStatus === 'executed' && existing.replay) {
          if (current.executionState !== 'executed') {
            await writeAuthorityExecutionState(
              paths,
              current,
              'executed',
              existing.artifact.executionId,
            );
          }
          return Object.freeze({
            disposition: 'replay' as const,
            value: existing.replay.kind === 'undefined' ? undefined : existing.replay.value,
            artifact: existing.artifact,
          });
        }
        if (existing.artifact.claimStatus === 'reconciliation_required') {
          if (current.executionState !== 'reconciliation_required') {
            await writeAuthorityExecutionState(
              paths,
              current,
              'reconciliation_required',
              existing.artifact.executionId,
            );
          }
          return fail(
            'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
            'Workflow effect execution requires reconciliation.',
          );
        }
        if (current.executionState === 'unclaimed') {
          const reconciled = reconcileExecutionRecord(
            existing,
            current.validationContext,
            this.#now(),
            'claim_head_commit_incomplete',
          );
          await atomicWrite(path, paths.claims, canonicalBytes(reconciled), MAX_EXECUTION_BYTES);
          await writeAuthorityExecutionState(
            paths,
            current,
            'reconciliation_required',
            existing.artifact.executionId,
          );
          return fail(
            'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
            'Execution claim exists without its authority high-watermark.',
          );
        }
        if (
          existing.owner &&
          (existing.owner.pid !== process.pid || existing.owner.sessionId !== SESSION_ID) &&
          ownerIsProvablyDead(existing.owner)
        ) {
          const reconciled = reconcileExecutionRecord(
            existing,
            current.validationContext,
            this.#now(),
            'orphaned_execution_claim',
          );
          await atomicWrite(path, paths.claims, canonicalBytes(reconciled), MAX_EXECUTION_BYTES);
          return fail(
            'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
            'An orphaned workflow effect claim requires reconciliation.',
          );
        }
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_ALREADY_CLAIMED',
          'Workflow effect execution was already claimed.',
        );
      }
      if (current.executionState !== 'unclaimed' || current.executionId !== null) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Execution claim evidence is missing after prior consumption.',
        );
      }
      const now = this.#now();
      if (Date.parse(now) >= Date.parse(current.descriptorExpiresAt)) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_EXPIRED',
          'Accepted runner descriptor expired before claim.',
        );
      }
      if (Date.parse(now) >= Date.parse(approvalArtifact.approval.expiresAt)) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_EXPIRED',
          'Workflow effect approval expired before claim.',
        );
      }
      const approvalDecisionHash = approvalArtifact.approvalDecisionHash;
      const executionId = `WFEXECUTION-${hashWorkflowEffectControlDomain('execution-id', { approvalDecisionHash, occurrenceId: approvalArtifact.occurrenceId })}`;
      const claimedAt = now;
      const artifact = validateWorkflowEffectControlArtifact(
        {
          ...approvalArtifact,
          kind: 'effect_execution_claim',
          executionId,
          consumedApprovalRecordHash: approvalArtifact.approvalRecordHash,
          consumedApprovalRevision: approvalArtifact.approval.revision,
          claimRevision: 0,
          claimStatus: 'claimed',
          claimedAt,
          outcomeHash: null,
          committedAt: null,
          reconciliationToken: null,
        },
        current.validationContext,
      );
      if (artifact.kind !== 'effect_execution_claim')
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Claim artifact kind changed.');
      const owner = Object.freeze({
        pid: process.pid,
        sessionId: SESSION_ID,
        threadId,
        nonce: randomUUID(),
      });
      const execution = validateExecutionRecord(
        { schema: EXECUTION_RECORD_SCHEMA, artifact, owner, replay: null },
        current.validationContext,
      );
      const executionBytes = canonicalBytes(execution);
      try {
        await writeExclusive(
          path,
          new TextDecoder('utf-8', { fatal: true }).decode(executionBytes),
          JOURNAL_SECURITY,
        );
        await syncDirectory(paths.claims);
      } catch (commitError) {
        let observedBytes: Buffer | undefined;
        try {
          observedBytes = await readBounded(path, paths.claims, MAX_EXECUTION_BYTES);
        } catch (readError) {
          return fail(
            'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
            'Execution claim commit outcome could not be read back.',
            new AggregateError([commitError, readError]),
          );
        }
        if (!observedBytes) {
          return fail(
            'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
            'Execution claim publication outcome is unknown.',
            commitError,
          );
        }
        const observed = parseExecutionRecord(
          observedBytes,
          current.validationContext,
          approvalArtifact,
        );
        if (!observedBytes.equals(executionBytes)) {
          if (observed.artifact.claimStatus === 'reconciliation_required') {
            return fail(
              'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
              'Execution claim commit outcome requires reconciliation.',
              commitError,
            );
          }
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_ALREADY_CLAIMED',
            'Another exact workflow effect claim won during commit recovery.',
            commitError,
          );
        }
      }
      try {
        await writeAuthorityExecutionState(paths, current, 'claimed', executionId);
      } catch (headError) {
        const reconciled = reconcileExecutionRecord(
          execution,
          current.validationContext,
          this.#now(),
          'claim_head_commit_unknown',
        );
        await atomicWrite(
          path,
          paths.claims,
          canonicalBytes(reconciled),
          MAX_EXECUTION_BYTES,
        ).catch(() => undefined);
        await writeAuthorityExecutionState(
          paths,
          current,
          'reconciliation_required',
          executionId,
        ).catch(() => undefined);
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Execution claim authority high-watermark could not be committed.',
          headError,
        );
      }
      const authority = Object.freeze({ executionId });
      CLAIM_AUTHORITIES.set(authority, {
        root: this.#approvalRoot,
        owner,
        runId: current.runId,
        evaluationIndex: current.evaluationIndex,
        occurrenceId: artifact.occurrenceId,
        executionId,
        expectedControlBuildHash: current.validationContext.expectedControlBuildHash,
      });
      return Object.freeze({ disposition: 'created' as const, authority, artifact });
    });
  }

  async complete(
    authority: ClaimedAuthority,
    value: unknown,
  ): Promise<WorkflowEffectExecutionClaimArtifact> {
    const binding = CLAIM_AUTHORITIES.get(authority);
    if (!binding || binding.root !== this.#approvalRoot)
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
        'Execution authority is not host-minted.',
      );
    let replay: ExecutionReplay;
    try {
      if (value === undefined) replay = Object.freeze({ kind: 'undefined' as const });
      else {
        const canonical = canonicalWorkflowEffectControlJson(value);
        if (Buffer.byteLength(canonical, 'utf8') > MAX_REPLAY_BYTES)
          throw new Error('result exceeds replay limit');
        replay = Object.freeze({
          kind: 'json' as const,
          value: parseWorkflowEffectJson(Buffer.from(`${canonical}\n`)),
          resultHash: hashWorkflowEffectControlDomain('execution-result', canonical),
        });
      }
    } catch (error) {
      await this.reconcile(authority, 'result_not_replayable');
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Effect result could not be persisted for exact replay.',
        error,
      );
    }
    const paths = await preparePaths(this.#approvalRoot, false);
    return withLock(paths, async () => {
      const path = claimPath(paths, binding.runId, binding.occurrenceId);
      const bytes = await readBounded(path, paths.claims, MAX_EXECUTION_BYTES);
      if (!bytes)
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Execution claim disappeared before completion.',
        );
      const current = parseExecutionRecord(bytes, {
        expectedControlBuildHash: binding.expectedControlBuildHash,
      });
      assertClaimOwner(current, binding);
      const authorityHead = await readAuthority(paths, binding.runId, binding.evaluationIndex);
      if (
        !authorityHead ||
        authorityHead.executionState !== 'claimed' ||
        authorityHead.executionId !== binding.executionId
      ) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Execution authority high-watermark changed before completion.',
        );
      }
      const outcomeHash =
        replay.kind === 'undefined'
          ? hashWorkflowEffectControlDomain('execution-result', 'undefined')
          : replay.resultHash;
      const artifact = validateWorkflowEffectControlArtifact(
        {
          ...current.artifact,
          claimRevision: 1,
          claimStatus: 'executed',
          outcomeHash,
          committedAt: this.#now(),
          reconciliationToken: null,
        },
        { expectedControlBuildHash: binding.expectedControlBuildHash },
      );
      if (artifact.kind !== 'effect_execution_claim')
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Executed artifact kind changed.');
      const next = validateExecutionRecord(
        { schema: EXECUTION_RECORD_SCHEMA, artifact, owner: null, replay },
        { expectedControlBuildHash: binding.expectedControlBuildHash },
      );
      let commitError: unknown;
      try {
        await atomicWrite(path, paths.claims, canonicalBytes(next), MAX_EXECUTION_BYTES);
      } catch (error) {
        commitError = error;
        const observedBytes = await readBounded(path, paths.claims, MAX_EXECUTION_BYTES).catch(
          () => undefined,
        );
        if (observedBytes) {
          const observed = parseExecutionRecord(observedBytes, {
            expectedControlBuildHash: binding.expectedControlBuildHash,
          });
          if (
            canonicalWorkflowEffectControlJson(observed) ===
            canonicalWorkflowEffectControlJson(next)
          ) {
            commitError = undefined;
          } else if (observed.artifact.claimStatus === 'claimed') {
            assertClaimOwner(observed, binding);
            const reconciled = reconcileExecutionRecord(
              observed,
              { expectedControlBuildHash: binding.expectedControlBuildHash },
              this.#now(),
              'completion_commit_unknown',
            );
            await atomicWrite(path, paths.claims, canonicalBytes(reconciled), MAX_EXECUTION_BYTES);
          }
        }
      }
      if (commitError !== undefined) {
        await writeAuthorityExecutionState(
          paths,
          authorityHead,
          'reconciliation_required',
          binding.executionId,
        ).catch(() => undefined);
        CLAIM_AUTHORITIES.delete(authority);
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Workflow effect completion outcome requires reconciliation.',
          commitError,
        );
      }
      try {
        await writeAuthorityExecutionState(paths, authorityHead, 'executed', binding.executionId);
      } catch (headError) {
        CLAIM_AUTHORITIES.delete(authority);
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Executed claim was durable but its authority high-watermark could not be advanced.',
          headError,
        );
      }
      CLAIM_AUTHORITIES.delete(authority);
      return artifact;
    });
  }

  async reconcile(
    authority: ClaimedAuthority,
    causeCode: string,
  ): Promise<WorkflowEffectExecutionClaimArtifact> {
    const binding = CLAIM_AUTHORITIES.get(authority);
    if (!binding || binding.root !== this.#approvalRoot)
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
        'Execution authority is not host-minted.',
      );
    const paths = await preparePaths(this.#approvalRoot, false);
    return withLock(paths, async () => {
      const path = claimPath(paths, binding.runId, binding.occurrenceId);
      const bytes = await readBounded(path, paths.claims, MAX_EXECUTION_BYTES);
      if (!bytes)
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Execution claim disappeared before reconciliation.',
        );
      const build = binding.expectedControlBuildHash;
      const current = parseExecutionRecord(bytes, { expectedControlBuildHash: build });
      assertClaimOwner(current, binding);
      const authorityHead = await readAuthority(paths, binding.runId, binding.evaluationIndex);
      if (
        !authorityHead ||
        authorityHead.executionState !== 'claimed' ||
        authorityHead.executionId !== binding.executionId
      ) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Execution authority high-watermark changed before reconciliation.',
        );
      }
      const committedAt = this.#now();
      const reconciliationToken = `WFRECONCILIATION-${hashWorkflowEffectControlDomain('execution-reconciliation', { causeCode: String(causeCode).slice(0, 128), committedAt, executionId: binding.executionId })}`;
      const artifact = validateWorkflowEffectControlArtifact(
        {
          ...current.artifact,
          claimRevision: 1,
          claimStatus: 'reconciliation_required',
          outcomeHash: null,
          committedAt,
          reconciliationToken,
        },
        { expectedControlBuildHash: build },
      );
      if (artifact.kind !== 'effect_execution_claim')
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
          'Reconciliation artifact kind changed.',
        );
      const next = validateExecutionRecord(
        { schema: EXECUTION_RECORD_SCHEMA, artifact, owner: null, replay: null },
        { expectedControlBuildHash: build },
      );
      await atomicWrite(path, paths.claims, canonicalBytes(next), MAX_EXECUTION_BYTES);
      await writeAuthorityExecutionState(
        paths,
        authorityHead,
        'reconciliation_required',
        binding.executionId,
      );
      CLAIM_AUTHORITIES.delete(authority);
      return artifact;
    });
  }
}

function ownerIsProvablyDead(owner: ExecutionOwner): boolean {
  // Worker threads share a process ID while loading independent module
  // sessions. A different session ID in this process is therefore not proof
  // of death and must never authorize lock removal or claim recovery.
  if (owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function reconcileExecutionRecord(
  current: ExecutionRecord,
  context: WorkflowEffectControlValidationContext,
  committedAt: string,
  causeCode: string,
): ExecutionRecord {
  const reconciliationToken = `WFRECONCILIATION-${hashWorkflowEffectControlDomain(
    'execution-reconciliation',
    {
      causeCode: String(causeCode).slice(0, 128),
      committedAt,
      executionId: current.artifact.executionId,
    },
  )}`;
  const artifact = validateWorkflowEffectControlArtifact(
    {
      ...current.artifact,
      claimRevision: 1,
      claimStatus: 'reconciliation_required',
      outcomeHash: null,
      committedAt,
      reconciliationToken,
    },
    context,
  );
  if (artifact.kind !== 'effect_execution_claim') {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Reconciliation artifact kind changed.',
    );
  }
  return validateExecutionRecord(
    { schema: EXECUTION_RECORD_SCHEMA, artifact, owner: null, replay: null },
    context,
  );
}

function assertExecutionLineage(
  claim: WorkflowEffectExecutionClaimArtifact,
  approval: WorkflowEffectDecisionCommittedArtifact | WorkflowEffectAuditRecordedArtifact,
): void {
  if (
    claim.workspaceId !== approval.workspaceId ||
    claim.runId !== approval.runId ||
    claim.occurrenceIndex !== approval.occurrenceIndex ||
    claim.occurrenceId !== approval.occurrenceId ||
    claim.intentBindingHash !== approval.intentBindingHash ||
    claim.intentEffectId !== approval.intentEffectId ||
    claim.intentEffectHash !== approval.intentEffectHash ||
    claim.correlationId !== approval.correlationId ||
    claim.approval.approvalId !== approval.approval.approvalId ||
    claim.approvalDecisionHash !== approval.approvalDecisionHash ||
    claim.humanDecision.bindingHash !== approval.humanDecision.bindingHash ||
    claim.humanDecision.attestationHash !== approval.humanDecision.attestationHash
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
      'Execution claim and current approval lineage differ.',
    );
  }
}

function validateExecutionRecord(
  value: unknown,
  context: WorkflowEffectControlValidationContext,
  expectedApproval?: WorkflowEffectDecisionCommittedArtifact | WorkflowEffectAuditRecordedArtifact,
): ExecutionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution record is invalid.');
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 4 ||
    !['schema', 'artifact', 'owner', 'replay'].every((field) => Object.hasOwn(record, field)) ||
    record.schema !== EXECUTION_RECORD_SCHEMA
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution record is not closed.');
  }
  const artifact = validateWorkflowEffectControlArtifact(record.artifact, context);
  if (artifact.kind !== 'effect_execution_claim')
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Execution claim artifact is required.',
    );
  const owner = record.owner === null ? null : validateExecutionOwner(record.owner);
  let replay: ExecutionReplay | null = null;
  if (record.replay !== null) {
    if (!record.replay || typeof record.replay !== 'object' || Array.isArray(record.replay)) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution replay is invalid.');
    }
    const value = record.replay as Record<string, unknown>;
    if (value.kind === 'undefined' && Reflect.ownKeys(value).length === 1) {
      replay = Object.freeze({ kind: 'undefined' });
    } else if (
      value.kind === 'json' &&
      Reflect.ownKeys(value).length === 3 &&
      Object.hasOwn(value, 'value') &&
      typeof value.resultHash === 'string' &&
      HASH.test(value.resultHash)
    ) {
      const canonical = canonicalWorkflowEffectControlJson(value.value);
      if (
        Buffer.byteLength(canonical, 'utf8') > MAX_REPLAY_BYTES ||
        value.resultHash !== hashWorkflowEffectControlDomain('execution-result', canonical)
      )
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution replay hash changed.');
      replay = Object.freeze({ kind: 'json', value: value.value, resultHash: value.resultHash });
    } else {
      return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution replay is not closed.');
    }
  }
  if (
    (artifact.claimStatus === 'claimed') !== (owner !== null) ||
    (artifact.claimStatus === 'executed') !== (replay !== null) ||
    (artifact.claimStatus === 'reconciliation_required' && replay !== null)
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution wrapper state is invalid.');
  }
  if (artifact.claimStatus === 'executed') {
    const replayHash =
      replay?.kind === 'undefined'
        ? hashWorkflowEffectControlDomain('execution-result', 'undefined')
        : replay?.resultHash;
    if (!replayHash || artifact.outcomeHash !== replayHash) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
        'Execution replay and outcome hash differ.',
      );
    }
  }
  if (expectedApproval) assertExecutionLineage(artifact, expectedApproval);
  const result = Object.freeze({ schema: EXECUTION_RECORD_SCHEMA, artifact, owner, replay });
  return result;
}

function parseExecutionRecord(
  bytes: Buffer,
  context: WorkflowEffectControlValidationContext,
  expectedApproval?: WorkflowEffectDecisionCommittedArtifact | WorkflowEffectAuditRecordedArtifact,
): ExecutionRecord {
  const record = validateExecutionRecord(
    parseWorkflowEffectJson(bytes, {
      maxDepth: 24,
      maxNodes: 8_192,
      maxStringLength: 256 * 1024,
    }),
    context,
    expectedApproval,
  );
  if (!bytes.equals(canonicalBytes(record))) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Execution record bytes are not canonical.',
    );
  }
  return record;
}

function assertClaimOwner(
  record: ExecutionRecord,
  binding: NonNullable<ReturnType<typeof CLAIM_AUTHORITIES.get>>,
): void {
  if (
    record.artifact.claimStatus !== 'claimed' ||
    !record.owner ||
    record.artifact.executionId !== binding.executionId ||
    record.owner.pid !== binding.owner.pid ||
    record.owner.sessionId !== binding.owner.sessionId ||
    record.owner.threadId !== binding.owner.threadId ||
    record.owner.nonce !== binding.owner.nonce
  )
    return fail('WORKFLOW_EFFECT_RECONCILIATION_REQUIRED', 'Execution claim ownership changed.');
}

export async function prepareWorkflowEffectAuthorityDecision(
  approvalStoreRoot: string,
  previous: WorkflowEffectApprovalRecord,
  next: WorkflowEffectApprovalRecord,
  binding: HumanWorkflowEffectDecisionBinding,
): Promise<void> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root || !(await present(root))) return;
  const paths = await preparePaths(approvalStoreRoot, false);
  await withLock(paths, async () => {
    const entries = await readdir(paths.records);
    for (const name of entries) {
      if (!AUTHORITY_FILE.test(name))
        return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority record name is invalid.');
      const bytes = await readBounded(
        join(paths.records, name),
        paths.records,
        MAX_AUTHORITY_BYTES,
      );
      if (!bytes) continue;
      const current = parseAuthorityRecord(bytes);
      if (
        !['approval_committed', 'decision_prepared'].includes(current.state) ||
        current.artifact?.kind !== 'effect_approval_pending' ||
        current.artifact.approval.approvalId !== previous.approvalId ||
        current.runId !== previous.runId
      )
        continue;
      if (
        canonicalWorkflowEffectControlJson(current.artifact.approval) !==
        canonicalWorkflowEffectControlJson(previous)
      )
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Approval CAS source differs from authority chain.',
        );
      const humanDecision = projectWorkflowEffectHumanDecision({
        approval: next,
        issuedAt: binding.issuedAt,
        expiresAt: binding.expiresAt,
      });
      const decisionEvidence = Object.freeze({
        nextApproval: next,
        nextApprovalRecordHash: hashWorkflowEffectApprovalRecord(next),
        humanDecision,
        approvalDecisionHash: hashWorkflowEffectApprovalDecision(next, humanDecision),
      });
      if (current.state === 'decision_prepared') {
        const existing = current.preparedDecision!;
        if (
          canonicalWorkflowEffectControlJson({
            nextApproval: existing.nextApproval,
            nextApprovalRecordHash: existing.nextApprovalRecordHash,
            humanDecision: existing.humanDecision,
            approvalDecisionHash: existing.approvalDecisionHash,
          }) !== canonicalWorkflowEffectControlJson(decisionEvidence)
        ) {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
            'Prepared human decision changed across retry.',
          );
        }
        return;
      }
      const preparedDecision = Object.freeze({
        ...decisionEvidence,
        owner: Object.freeze({
          pid: process.pid,
          sessionId: SESSION_ID,
          threadId,
          nonce: randomUUID(),
        }),
      });
      await writeAuthority(
        paths,
        validateAuthorityRecord({ ...current, state: 'decision_prepared', preparedDecision }),
      );
      return;
    }
  });
}

export async function commitWorkflowEffectAuthorityDecision(
  approvalStoreRoot: string,
  nextValue: WorkflowEffectApprovalRecord,
): Promise<void> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root || !(await present(root))) return;
  const next = validateWorkflowEffectApproval(nextValue);
  const paths = await preparePaths(approvalStoreRoot, false);
  await withLock(paths, async () => {
    const entries = await readdir(paths.records);
    for (const name of entries) {
      if (!AUTHORITY_FILE.test(name))
        return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority record name is invalid.');
      const bytes = await readBounded(
        join(paths.records, name),
        paths.records,
        MAX_AUTHORITY_BYTES,
      );
      if (!bytes) continue;
      const current = parseAuthorityRecord(bytes);
      if (
        current.runId !== next.runId ||
        !current.artifact ||
        current.artifact.kind === 'effect_intent' ||
        current.artifact.approval.approvalId !== next.approvalId
      )
        continue;
      if (
        current.artifact.kind === 'effect_decision_committed' ||
        current.artifact.kind === 'effect_audit_recorded'
      ) {
        if (
          canonicalWorkflowEffectControlJson(current.artifact.approval) !==
          canonicalWorkflowEffectControlJson(next)
        ) {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
            'Committed approval differs from authority chain.',
          );
        }
        return;
      }
      if (
        current.state !== 'decision_prepared' ||
        current.artifact.kind !== 'effect_approval_pending' ||
        !current.preparedDecision
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
          'Prepared decision is unavailable for commit.',
        );
      }
      if (
        canonicalWorkflowEffectControlJson(current.preparedDecision.nextApproval) !==
        canonicalWorkflowEffectControlJson(next)
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Committed decision differs from prepared authority data.',
        );
      }
      const artifact = validateWorkflowEffectControlArtifact(
        {
          ...current.artifact,
          kind: 'effect_decision_committed',
          approval: next,
          approvalRecordHash: current.preparedDecision.nextApprovalRecordHash,
          approvalDecisionHash: current.preparedDecision.approvalDecisionHash,
          humanDecision: current.preparedDecision.humanDecision,
        },
        current.validationContext,
      );
      if (artifact.kind !== 'effect_decision_committed')
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Decision artifact kind changed.');
      await writeAuthority(
        paths,
        validateAuthorityRecord({
          ...current,
          state: 'approval_committed',
          preparedDecision: null,
          artifact,
        }),
      );
      return;
    }
  });
}

export async function updateWorkflowEffectAuthorityAudit(
  approvalStoreRoot: string,
  nextValue: WorkflowEffectApprovalRecord,
): Promise<void> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root || !(await present(root))) return;
  const next = validateWorkflowEffectApproval(nextValue);
  const paths = await preparePaths(approvalStoreRoot, false);
  await withLock(paths, async () => {
    const entries = await readdir(paths.records);
    for (const name of entries) {
      if (!AUTHORITY_FILE.test(name))
        return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority record name is invalid.');
      const bytes = await readBounded(
        join(paths.records, name),
        paths.records,
        MAX_AUTHORITY_BYTES,
      );
      if (!bytes) continue;
      const current = parseAuthorityRecord(bytes);
      if (
        current.state !== 'approval_committed' ||
        !current.artifact ||
        current.runId !== next.runId
      )
        continue;
      if (current.artifact.kind === 'effect_audit_recorded') {
        if (
          current.artifact.approval.approvalId === next.approvalId &&
          canonicalWorkflowEffectControlJson(current.artifact.approval) ===
            canonicalWorkflowEffectControlJson(next)
        )
          return;
        continue;
      }
      if (
        current.artifact.kind !== 'effect_decision_committed' ||
        current.artifact.approval.approvalId !== next.approvalId
      )
        continue;
      if (
        hashWorkflowEffectApprovalDecision(
          current.artifact.approval,
          current.artifact.humanDecision,
        ) !== hashWorkflowEffectApprovalDecision(next, current.artifact.humanDecision)
      )
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Audit transition changed the human decision.',
        );
      const artifact = validateWorkflowEffectControlArtifact(
        {
          ...current.artifact,
          kind: 'effect_audit_recorded',
          approval: next,
          approvalRecordHash: hashWorkflowEffectApprovalRecord(next),
        },
        current.validationContext,
      );
      if (artifact.kind !== 'effect_audit_recorded')
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Audit artifact kind changed.');
      await writeAuthority(paths, validateAuthorityRecord({ ...current, artifact }));
      return;
    }
  });
}
