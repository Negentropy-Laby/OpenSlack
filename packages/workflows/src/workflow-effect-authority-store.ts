import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readFile, realpath, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';
import {
  WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA,
  WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
  canonicalWorkflowEffectControlJson,
  deriveWorkflowEffectApprovalId,
  deriveWorkflowEffectApprovalGenerationId,
  deriveWorkflowEffectOccurrenceId,
  hashWorkflowEffectApprovalDecision,
  hashWorkflowEffectApprovalRecord,
  hashWorkflowEffectControlDomain,
  hashWorkflowEffectIntentBinding,
  projectWorkflowEffectControlObservation,
  projectWorkflowEffectHumanDecision,
  validateWorkflowEffectControlArtifact,
  type WorkflowEffectAuditRecordedArtifact,
  type WorkflowEffectApprovalPendingArtifact,
  type WorkflowEffectControlHumanDecisionProjection,
  type WorkflowEffectControlObservation,
  type WorkflowEffectControlValidationContext,
  type WorkflowEffectDecisionCommittedArtifact,
  type WorkflowEffectExecutionClaimArtifact,
  type WorkflowEffectIntentArtifact,
} from './workflow-effect-control-contract.js';
import {
  createPendingWorkflowEffectApproval,
  validateWorkflowEffectApproval,
  workflowEffectApprovalBytes,
  type HumanWorkflowEffectDecisionBinding,
  type WorkflowEffectApprovalRecord,
} from './workflow-effect-approval.js';
import { readWorkflowEffectApprovalRecordExact } from './workflow-effect-approval-store.js';
import { parseWorkflowEffectJson } from './workflow-effect-json.js';
import {
  acquireOwnerJournalLock,
  assertOwnerDirectory,
  assertOwnerFile,
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
const OCCURRENCE_ANCHOR_SCHEMA = 'openslack.workflow_effect_occurrence_anchor.v1' as const;
const APPROVAL_GENERATION_ANCHOR_SCHEMA =
  'openslack.workflow_effect_approval_generation_anchor.v1' as const;
const EXECUTION_REPLAY_SCHEMA = 'openslack.workflow_effect_execution_replay.v1' as const;
const AUTHORITY_DIRECTORY = 'effect-authority';
const MAX_AUTHORITY_BYTES = 640 * 1024;
const MAX_EXECUTION_BYTES = 768 * 1024;
const MAX_ANCHOR_BYTES = 4 * 1024;
const MAX_REPLAY_BYTES = 256 * 1024;
const MAX_REPLAY_FILE_BYTES = MAX_REPLAY_BYTES + 4 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHORITY_FILE = /^[0-9a-f]{64}\.json$/u;
const AUTHORITY_TEMP = /^\.([0-9a-f]{64})\.[1-9][0-9]*\.[0-9a-f-]{36}\.tmp$/u;
const SESSION_ID = randomUUID();
const JOURNAL_SECURITY = productionJournalSecurity();
const AUTHORITY_TREE_CACHE_LIMIT = 2_048;

interface AuthorityTreeCacheEntry {
  readonly recordsIdentity: string;
  readonly claimsIdentity: string;
  readonly entries: number;
  readonly totalBytes: number;
}

const authorityTreeCache = new Map<string, AuthorityTreeCacheEntry>();
const authorityPathsCache = new Map<string, StorePaths>();
const authorityPathInitializers = new Map<string, Promise<StorePaths>>();

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

type ExecutionReplayReference =
  | { readonly kind: 'undefined' }
  | { readonly kind: 'artifact'; readonly replayRef: string; readonly resultHash: string };

interface ExecutionReplayArtifact {
  readonly schema: typeof EXECUTION_REPLAY_SCHEMA;
  readonly executionId: string;
  readonly kind: 'json';
  readonly value: unknown;
  readonly resultHash: string;
}

interface OccurrenceAnchor {
  readonly schema: typeof OCCURRENCE_ANCHOR_SCHEMA;
  readonly runId: string;
  readonly evaluationIndex: number;
  readonly identityHash: string;
}

interface ApprovalGenerationAnchor {
  readonly schema: typeof APPROVAL_GENERATION_ANCHOR_SCHEMA;
  readonly runId: string;
  readonly evaluationIndex: number;
  readonly occurrenceId: string;
  readonly approvalGeneration: number;
  readonly approvalId: string;
}

interface ExecutionRecord {
  readonly schema: typeof EXECUTION_RECORD_SCHEMA;
  readonly artifact: WorkflowEffectExecutionClaimArtifact;
  readonly owner: ExecutionOwner | null;
  readonly replay: ExecutionReplayReference | null;
}

interface StorePaths {
  readonly root: string;
  readonly records: string;
  readonly claims: string;
  readonly anchors: string;
  readonly replays: string;
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

async function preparePathsUncached(
  approvalStoreRoot: string,
  create: boolean,
): Promise<StorePaths> {
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
  let canonicalRoot: string;
  try {
    canonicalRoot = await ensureOwnerDirectory(root, JOURNAL_SECURITY);
  } catch (error) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE', 'Authority root is unsafe.', error);
  }
  const paths = {
    root,
    // Windows realpath may expand a safe 8.3 workspace path. Anchor child
    // creation to the verified canonical root so containment never compares
    // the host spelling with its expanded spelling.
    records: join(canonicalRoot, 'records'),
    claims: join(canonicalRoot, 'claims'),
    // Anchors and immutable replay artifacts share the owner-only claim
    // directory. Their domain-separated hash keys cannot collide, and this
    // avoids two extra Windows ACL processes for every new authority root.
    anchors: join(canonicalRoot, 'claims'),
    replays: join(canonicalRoot, 'claims'),
    locks: join(canonicalRoot, 'locks'),
  };
  for (const path of [paths.records, paths.claims, paths.locks]) {
    try {
      await ensureOwnerDirectory(path, JOURNAL_SECURITY, canonicalRoot);
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

async function preparePaths(approvalStoreRoot: string, create: boolean): Promise<StorePaths> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE',
      'Approval store root is not the authenticated workflow authority root.',
    );
  }
  const cached = authorityPathsCache.get(root);
  if (cached) {
    try {
      const canonicalRoot = await assertOwnerDirectory(root, JOURNAL_SECURITY);
      await Promise.all([
        assertOwnerDirectory(cached.records, JOURNAL_SECURITY, canonicalRoot),
        assertOwnerDirectory(cached.claims, JOURNAL_SECURITY, canonicalRoot),
        assertOwnerDirectory(cached.locks, JOURNAL_SECURITY, canonicalRoot),
      ]);
      return cached;
    } catch {
      authorityPathsCache.delete(root);
      authorityTreeCache.delete(root);
      // Re-run the complete initialization path after any identity drift. It
      // distinguishes a missing lineage from an unsafe replacement and keeps
      // the stable reconciliation error instead of exposing a cache artifact.
    }
  }
  const inFlight = authorityPathInitializers.get(root);
  if (inFlight) return inFlight;
  const initializing = preparePathsUncached(approvalStoreRoot, create).then((paths) => {
    if (authorityPathsCache.size >= AUTHORITY_TREE_CACHE_LIMIT) {
      const oldest = authorityPathsCache.keys().next().value;
      if (oldest !== undefined) {
        authorityPathsCache.delete(oldest);
        authorityTreeCache.delete(oldest);
      }
    }
    authorityPathsCache.set(root, paths);
    return paths;
  });
  authorityPathInitializers.set(root, initializing);
  try {
    return await initializing;
  } finally {
    authorityPathInitializers.delete(root);
  }
}

async function validateAuthorityTree(paths: StorePaths): Promise<void> {
  const directoryIdentity = (stat: Stats): string =>
    [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const [recordsStat, claimsStat] = await Promise.all([lstat(paths.records), lstat(paths.claims)]);
  if (
    !recordsStat.isDirectory() ||
    recordsStat.isSymbolicLink() ||
    !claimsStat.isDirectory() ||
    claimsStat.isSymbolicLink()
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority data directory is unsafe.');
  }
  const recordsIdentity = directoryIdentity(recordsStat);
  const claimsIdentity = directoryIdentity(claimsStat);
  const cached = authorityTreeCache.get(paths.root);
  let entries =
    cached?.recordsIdentity === recordsIdentity && cached.claimsIdentity === claimsIdentity
      ? cached.entries
      : 0;
  let totalBytes =
    cached?.recordsIdentity === recordsIdentity && cached.claimsIdentity === claimsIdentity
      ? cached.totalBytes
      : 0;
  if (
    !cached ||
    cached.recordsIdentity !== recordsIdentity ||
    cached.claimsIdentity !== claimsIdentity
  ) {
    for (const directory of [paths.records, paths.claims] as const) {
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
          !AUTHORITY_FILE.test(entry.name) ||
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
    authorityTreeCache.delete(paths.root);
    authorityTreeCache.set(paths.root, {
      recordsIdentity,
      claimsIdentity,
      entries,
      totalBytes,
    });
    if (authorityTreeCache.size > AUTHORITY_TREE_CACHE_LIMIT) {
      authorityTreeCache.delete(authorityTreeCache.keys().next().value!);
    }
  }
  for (const directory of [paths.locks] as const) {
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
        entry.name !== 'authority.lock' ||
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

function anchorPath(paths: StorePaths, runId: string, evaluationIndex: number): string {
  return join(paths.anchors, `${key(runId, evaluationIndex)}.json`);
}

function replayPath(paths: StorePaths, runId: string, executionId: string): string {
  return join(paths.replays, `${key(runId, executionId)}.json`);
}

function approvalGenerationAnchorPath(
  paths: StorePaths,
  runId: string,
  evaluationIndex: number,
): string {
  return join(paths.anchors, `${key('approval-generation', runId, evaluationIndex)}.json`);
}

function replayReference(runId: string, executionId: string, resultHash: string) {
  return Object.freeze({
    kind: 'artifact' as const,
    replayRef: key(runId, executionId),
    resultHash,
  });
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalWorkflowEffectControlJson(value)}\n`, 'utf8');
}

function validateOccurrenceAnchor(value: unknown): OccurrenceAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Occurrence anchor is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 4 ||
    !['schema', 'runId', 'evaluationIndex', 'identityHash'].every((field) =>
      Object.hasOwn(record, field),
    ) ||
    record.schema !== OCCURRENCE_ANCHOR_SCHEMA ||
    typeof record.runId !== 'string' ||
    !SAFE_ID.test(record.runId) ||
    !Number.isSafeInteger(record.evaluationIndex) ||
    (record.evaluationIndex as number) < 1 ||
    typeof record.identityHash !== 'string' ||
    !HASH.test(record.identityHash)
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Occurrence anchor is not closed.');
  }
  return Object.freeze({
    schema: OCCURRENCE_ANCHOR_SCHEMA,
    runId: record.runId,
    evaluationIndex: record.evaluationIndex as number,
    identityHash: record.identityHash,
  });
}

async function readOccurrenceAnchor(
  paths: StorePaths,
  runId: string,
  evaluationIndex: number,
): Promise<OccurrenceAnchor | undefined> {
  const bytes = await readBounded(
    anchorPath(paths, runId, evaluationIndex),
    paths.anchors,
    MAX_ANCHOR_BYTES,
  );
  if (!bytes) return undefined;
  const anchor = validateOccurrenceAnchor(parseWorkflowEffectJson(bytes));
  if (!bytes.equals(canonicalBytes(anchor))) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Occurrence anchor bytes are not canonical.',
    );
  }
  return anchor;
}

async function assertOccurrenceAnchor(paths: StorePaths, record: AuthorityRecord): Promise<void> {
  const anchor = await readOccurrenceAnchor(paths, record.runId, record.evaluationIndex);
  if (!anchor || anchor.identityHash !== record.identityHash) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Effect occurrence anchor and authority record differ.',
    );
  }
}

async function persistOccurrenceAnchor(paths: StorePaths, record: AuthorityRecord): Promise<void> {
  const anchor = validateOccurrenceAnchor({
    schema: OCCURRENCE_ANCHOR_SCHEMA,
    runId: record.runId,
    evaluationIndex: record.evaluationIndex,
    identityHash: record.identityHash,
  });
  const path = anchorPath(paths, record.runId, record.evaluationIndex);
  const bytes = canonicalBytes(anchor);
  const existing = await readBounded(path, paths.anchors, MAX_ANCHOR_BYTES);
  if (existing) {
    if (!existing.equals(bytes)) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
        'Effect occurrence anchor already binds another identity.',
      );
    }
    return;
  }
  try {
    await writeExclusive(
      path,
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      JOURNAL_SECURITY,
    );
    await syncDirectory(paths.anchors);
  } catch (error) {
    const observed = await readBounded(path, paths.anchors, MAX_ANCHOR_BYTES).catch(
      () => undefined,
    );
    if (!observed?.equals(bytes)) {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Effect occurrence anchor publication outcome is unknown.',
        error,
      );
    }
  }
}

function validateApprovalGenerationAnchor(value: unknown): ApprovalGenerationAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Approval generation anchor is invalid.',
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 6 ||
    ![
      'schema',
      'runId',
      'evaluationIndex',
      'occurrenceId',
      'approvalGeneration',
      'approvalId',
    ].every((field) => Object.hasOwn(record, field)) ||
    record.schema !== APPROVAL_GENERATION_ANCHOR_SCHEMA ||
    typeof record.runId !== 'string' ||
    !SAFE_ID.test(record.runId) ||
    !Number.isSafeInteger(record.evaluationIndex) ||
    (record.evaluationIndex as number) < 1 ||
    typeof record.occurrenceId !== 'string' ||
    !/^WFOCCURRENCE-[0-9a-f]{64}$/u.test(record.occurrenceId) ||
    !Number.isSafeInteger(record.approvalGeneration) ||
    (record.approvalGeneration as number) < 0 ||
    typeof record.approvalId !== 'string' ||
    !SAFE_ID.test(record.approvalId)
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Approval generation anchor is not closed.',
    );
  }
  return Object.freeze({
    schema: APPROVAL_GENERATION_ANCHOR_SCHEMA,
    runId: record.runId,
    evaluationIndex: record.evaluationIndex as number,
    occurrenceId: record.occurrenceId,
    approvalGeneration: record.approvalGeneration as number,
    approvalId: record.approvalId,
  });
}

async function readApprovalGenerationAnchor(
  paths: StorePaths,
  runId: string,
  evaluationIndex: number,
): Promise<ApprovalGenerationAnchor | undefined> {
  const bytes = await readBounded(
    approvalGenerationAnchorPath(paths, runId, evaluationIndex),
    paths.anchors,
    MAX_ANCHOR_BYTES,
  );
  if (!bytes) return undefined;
  const anchor = validateApprovalGenerationAnchor(parseWorkflowEffectJson(bytes));
  if (!bytes.equals(canonicalBytes(anchor))) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Approval generation anchor bytes are not canonical.',
    );
  }
  return anchor;
}

async function persistApprovalGenerationAnchor(
  paths: StorePaths,
  record: AuthorityRecord,
): Promise<void> {
  const artifact = record.artifact;
  if (!artifact || artifact.kind === 'effect_intent') {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Approval generation anchor requires an approval artifact.',
    );
  }
  const anchor = validateApprovalGenerationAnchor({
    schema: APPROVAL_GENERATION_ANCHOR_SCHEMA,
    runId: record.runId,
    evaluationIndex: record.evaluationIndex,
    occurrenceId: artifact.occurrenceId,
    approvalGeneration: artifact.approvalGeneration,
    approvalId: artifact.approval.approvalId,
  });
  const path = approvalGenerationAnchorPath(paths, record.runId, record.evaluationIndex);
  const bytes = canonicalBytes(anchor);
  const existing = await readBounded(path, paths.anchors, MAX_ANCHOR_BYTES);
  if (existing) {
    const current = validateApprovalGenerationAnchor(parseWorkflowEffectJson(existing));
    if (
      current.runId !== anchor.runId ||
      current.evaluationIndex !== anchor.evaluationIndex ||
      current.occurrenceId !== anchor.occurrenceId ||
      current.approvalGeneration > anchor.approvalGeneration ||
      (current.approvalGeneration === anchor.approvalGeneration &&
        current.approvalId !== anchor.approvalId)
    ) {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Approval generation anchor conflicts with durable authority.',
      );
    }
    if (existing.equals(bytes)) return;
  }
  await atomicWrite(path, paths.anchors, bytes, MAX_ANCHOR_BYTES);
}

async function assertApprovalGenerationAnchor(
  paths: StorePaths,
  record: AuthorityRecord,
): Promise<void> {
  const artifact = record.artifact;
  if (!artifact || artifact.kind === 'effect_intent') {
    return;
  }
  const anchor = await readApprovalGenerationAnchor(paths, record.runId, record.evaluationIndex);
  if (
    !anchor ||
    anchor.occurrenceId !== artifact.occurrenceId ||
    anchor.approvalGeneration !== artifact.approvalGeneration ||
    anchor.approvalId !== artifact.approval.approvalId
  ) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Approval generation anchor and authority record differ.',
    );
  }
}

function validateReplayArtifact(value: unknown, executionId: string): ExecutionReplayArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Execution replay artifact is invalid.',
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 5 ||
    !['schema', 'executionId', 'kind', 'value', 'resultHash'].every((field) =>
      Object.hasOwn(record, field),
    ) ||
    record.schema !== EXECUTION_REPLAY_SCHEMA ||
    record.executionId !== executionId ||
    record.kind !== 'json' ||
    typeof record.resultHash !== 'string' ||
    !HASH.test(record.resultHash)
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Execution replay artifact is not closed.',
    );
  }
  const canonical = canonicalWorkflowEffectControlJson(record.value);
  if (
    Buffer.byteLength(canonical, 'utf8') > MAX_REPLAY_BYTES ||
    record.resultHash !== hashWorkflowEffectControlDomain('execution-result', canonical)
  ) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution replay hash changed.');
  }
  return Object.freeze({
    schema: EXECUTION_REPLAY_SCHEMA,
    executionId,
    kind: 'json' as const,
    value: record.value,
    resultHash: record.resultHash,
  });
}

async function persistReplayArtifact(
  paths: StorePaths,
  runId: string,
  artifact: ExecutionReplayArtifact,
): Promise<ExecutionReplayReference> {
  const path = replayPath(paths, runId, artifact.executionId);
  const bytes = canonicalBytes(artifact);
  if (bytes.length > MAX_REPLAY_FILE_BYTES) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED',
      'Execution replay artifact exceeds its byte limit.',
    );
  }
  const existing = await readBounded(path, paths.replays, MAX_REPLAY_FILE_BYTES);
  if (existing) {
    if (!existing.equals(bytes)) {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Execution replay artifact changed across retry.',
      );
    }
  } else {
    try {
      await writeExclusive(
        path,
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        JOURNAL_SECURITY,
      );
      await syncDirectory(paths.replays);
    } catch (error) {
      const observed = await readBounded(path, paths.replays, MAX_REPLAY_FILE_BYTES).catch(
        () => undefined,
      );
      if (!observed?.equals(bytes)) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Execution replay artifact publication outcome is unknown.',
          error,
        );
      }
    }
  }
  return replayReference(runId, artifact.executionId, artifact.resultHash);
}

async function loadReplayArtifact(
  paths: StorePaths,
  runId: string,
  executionId: string,
  reference: Extract<ExecutionReplayReference, { readonly kind: 'artifact' }>,
): Promise<ExecutionReplayArtifact> {
  if (reference.replayRef !== key(runId, executionId)) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution replay reference changed.');
  }
  const bytes = await readBounded(
    replayPath(paths, runId, executionId),
    paths.replays,
    MAX_REPLAY_FILE_BYTES,
  );
  if (!bytes) {
    return fail('WORKFLOW_EFFECT_RECONCILIATION_REQUIRED', 'Execution replay artifact is missing.');
  }
  const artifact = validateReplayArtifact(
    parseWorkflowEffectJson(bytes, {
      maxDepth: 16,
      maxNodes: 4_096,
      maxStringLength: MAX_REPLAY_BYTES,
    }),
    executionId,
  );
  if (!bytes.equals(canonicalBytes(artifact)) || artifact.resultHash !== reference.resultHash) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Execution replay artifact no longer matches its claim.',
    );
  }
  return artifact;
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

/**
 * Extract only the embedded context needed for a first-pass schema parse.
 * Callers must revalidate the result against its authority record before the
 * parsed value can influence a repair decision.
 */
function embeddedExecutionContextForParsing(
  value: unknown,
): WorkflowEffectControlValidationContext {
  const buildHash = String(
    (
      (
        (value as { readonly artifact?: unknown })?.artifact as {
          readonly intentArtifact?: unknown;
        }
      )?.intentArtifact as {
        readonly runnerV1Receipt?: {
          readonly payload?: { readonly controlBuildHash?: unknown };
        };
      }
    )?.runnerV1Receipt?.payload?.controlBuildHash ?? '',
  );
  return Object.freeze({ expectedControlBuildHash: buildHash });
}

async function recoverableTemporary(
  paths: StorePaths,
  directory: string,
  bytes: Buffer,
): Promise<{ readonly target: string; readonly bytes: Buffer }> {
  const parsed = parseWorkflowEffectJson(bytes, {
    maxDepth: 24,
    maxNodes: 8_192,
    maxStringLength: MAX_REPLAY_BYTES,
  });
  const schema = (parsed as { readonly schema?: unknown })?.schema;
  if (schema === AUTHORITY_RECORD_SCHEMA) {
    if (bytes.length > MAX_AUTHORITY_BYTES) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED', 'Authority temporary is too large.');
    }
    const record = validateAuthorityRecord(parsed);
    const target = recordPath(paths, record.runId, record.evaluationIndex);
    if (dirname(target) !== directory) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority temporary target changed.');
    }
    return { target, bytes: canonicalBytes(record) };
  }
  if (schema === EXECUTION_RECORD_SCHEMA) {
    if (bytes.length > MAX_EXECUTION_BYTES) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED', 'Claim temporary is too large.');
    }
    const rawArtifact = (parsed as { readonly artifact?: unknown }).artifact;
    if (!rawArtifact || typeof rawArtifact !== 'object' || Array.isArray(rawArtifact)) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
        'Claim temporary has no authority lookup identity.',
      );
    }
    const runId = (rawArtifact as { readonly runId?: unknown }).runId;
    const occurrenceIndex = (rawArtifact as { readonly occurrenceIndex?: unknown }).occurrenceIndex;
    if (
      typeof runId !== 'string' ||
      !SAFE_ID.test(runId) ||
      !Number.isSafeInteger(occurrenceIndex) ||
      (occurrenceIndex as number) < 1
    ) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
        'Claim temporary authority lookup identity is invalid.',
      );
    }
    const authority = await readAuthorityRecord(paths, runId, occurrenceIndex as number);
    if (
      !authority ||
      !authority.artifact ||
      (authority.artifact.kind !== 'effect_decision_committed' &&
        authority.artifact.kind !== 'effect_audit_recorded')
    ) {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Claim temporary has no trusted authority lineage.',
      );
    }
    const record = validateExecutionRecord(parsed, authority.validationContext, authority.artifact);
    const target = claimPath(paths, record.artifact.runId, record.artifact.occurrenceId);
    if (dirname(target) !== directory) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Claim temporary target changed.');
    }
    return { target, bytes: canonicalBytes(record) };
  }
  if (schema === OCCURRENCE_ANCHOR_SCHEMA) {
    if (bytes.length > MAX_ANCHOR_BYTES) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED', 'Anchor temporary is too large.');
    }
    const anchor = validateOccurrenceAnchor(parsed);
    const target = anchorPath(paths, anchor.runId, anchor.evaluationIndex);
    if (dirname(target) !== directory) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Anchor temporary target changed.');
    }
    return { target, bytes: canonicalBytes(anchor) };
  }
  if (schema === APPROVAL_GENERATION_ANCHOR_SCHEMA) {
    if (bytes.length > MAX_ANCHOR_BYTES) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED', 'Anchor temporary is too large.');
    }
    const anchor = validateApprovalGenerationAnchor(parsed);
    const target = approvalGenerationAnchorPath(paths, anchor.runId, anchor.evaluationIndex);
    if (dirname(target) !== directory) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Anchor temporary target changed.');
    }
    return { target, bytes: canonicalBytes(anchor) };
  }
  return fail(
    'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
    'Authority temporary schema is not recoverable.',
  );
}

async function recoverAuthorityTemporaries(paths: StorePaths): Promise<void> {
  for (const directory of new Set([paths.records, paths.claims, paths.anchors, paths.replays])) {
    let removed = false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.startsWith('.')) continue;
      const matched = AUTHORITY_TEMP.exec(entry.name);
      if (!matched) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
          'Authority store temporary name is invalid.',
        );
      }
      const path = join(directory, entry.name);
      try {
        await assertOwnerFile(path, JOURNAL_SECURITY);
        const observed = await readBounded(path, directory, MAX_EXECUTION_BYTES);
        if (!observed) {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
            'Authority store temporary disappeared during recovery.',
          );
        }
        const recovered = await recoverableTemporary(paths, directory, observed);
        if (!observed.equals(recovered.bytes)) {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
            'Authority store temporary is not canonical.',
          );
        }
        const targetHash = createHash('sha256').update(recovered.target, 'utf8').digest('hex');
        if (matched[1] !== targetHash) {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
            'Authority store temporary target binding changed.',
          );
        }
        const current = await readBounded(recovered.target, directory, MAX_EXECUTION_BYTES);
        if (current && !current.equals(recovered.bytes)) {
          return fail(
            'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
            'Authority temporary conflicts with its formal record.',
          );
        }
        if (!current) {
          await rename(path, recovered.target);
          await assertOwnerFile(recovered.target, JOURNAL_SECURITY);
        } else {
          await rm(path);
        }
      } catch (error) {
        if (error instanceof WorkflowEffectAuthorityStoreError) throw error;
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
          'Authority store temporary is unsafe.',
          error,
        );
      }
      removed = true;
    }
    if (removed) await syncDirectory(directory);
  }
}

async function withLock<T>(paths: StorePaths, operation: () => Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireOwnerJournalLock(paths.locks, 'authority', JOURNAL_SECURITY);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('deadline exceeded')) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_BUSY', 'Authority lock deadline exceeded.', error);
    }
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority lock is unsafe.', error);
  }
  let operationError: unknown;
  try {
    await recoverAuthorityTemporaries(paths);
    await validateAuthorityTree(paths);
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          'Authority operation and lock release both failed.',
        );
      }
      fail(
        'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
        'Authority lock changed before release.',
        releaseError,
      );
    }
  }
}

function assertIdentity(
  record: AuthorityRecord,
  expected: AuthorityIdentity & { evaluationIndex: number; validationContextHash: string },
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
  if (record.validationContextHash !== expected.validationContextHash) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
      'Trusted control build hash changed for a durable effect occurrence.',
    );
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
  const identity = Object.freeze({
    workspaceId: record.workspaceId as string,
    runId: record.runId as string,
    correlationId: record.correlationId as string,
    workflowId: record.workflowId as string,
    workflowVersion: record.workflowVersion as string,
    workflowSourceHash: record.workflowSourceHash as string,
    manifestHash: record.manifestHash as string,
    inputHash: record.inputHash as string,
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

async function readAuthorityRecord(
  paths: StorePaths,
  runId: string,
  evaluationIndex: number,
): Promise<AuthorityRecord | undefined> {
  const path = recordPath(paths, runId, evaluationIndex);
  const bytes = await readBounded(path, paths.records, MAX_AUTHORITY_BYTES);
  if (!bytes) return undefined;
  return parseAuthorityRecord(bytes);
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

async function recoverApprovalGenerationHead(
  paths: StorePaths,
  approvalRoot: string,
  record: AuthorityRecord,
): Promise<AuthorityRecord> {
  const anchor = await readApprovalGenerationAnchor(paths, record.runId, record.evaluationIndex);
  const currentArtifact = record.artifact;
  if (!anchor) {
    if (currentArtifact && currentArtifact.kind !== 'effect_intent') {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Approval generation anchor and authority record differ.',
      );
    }
    return record;
  }
  const intent =
    currentArtifact?.kind === 'effect_intent' ? currentArtifact : currentArtifact?.intentArtifact;
  if (!intent || anchor.occurrenceId !== intent.occurrenceId) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Approval generation anchor and authority occurrence differ.',
    );
  }
  const currentGeneration =
    currentArtifact && currentArtifact.kind !== 'effect_intent'
      ? currentArtifact.approvalGeneration
      : -1;
  if (anchor.approvalGeneration === currentGeneration) {
    await assertApprovalGenerationAnchor(paths, record);
    return record;
  }
  if (
    anchor.approvalGeneration !== currentGeneration + 1 ||
    record.executionState !== 'unclaimed' ||
    !['intent_accepted', 'approval_committed'].includes(record.state) ||
    (currentArtifact?.kind !== 'effect_intent' &&
      currentArtifact?.kind !== 'effect_approval_pending')
  ) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Approval generation anchor advanced beyond recoverable authority.',
    );
  }
  const approval = await readWorkflowEffectApprovalRecordExact(
    approvalRoot,
    record.runId,
    anchor.approvalId,
  );
  if (!approval || approval.status !== 'pending' || approval.revision !== 0) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Approval generation evidence is unavailable during authority recovery.',
    );
  }
  const intentBindingHash = hashWorkflowEffectIntentBinding(intent, record.validationContext);
  if (
    approval.approvalId !==
      deriveWorkflowEffectApprovalGenerationId(
        intent.occurrenceId,
        intentBindingHash,
        anchor.approvalGeneration,
      ) ||
    approval.runId !== record.runId ||
    approval.correlationId !== record.correlationId ||
    approval.workflowId !== record.workflowId ||
    approval.workflowVersion !== record.workflowVersion ||
    approval.workflowHash !== record.workflowSourceHash ||
    approval.inputHash !== record.inputHash ||
    approval.effectId !== record.effectId ||
    approval.effectHash !== record.effectHash ||
    approval.requiredCapability !== 'workflow.effect.decide'
  ) {
    return fail(
      'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
      'Approval generation evidence changed during authority recovery.',
    );
  }
  const recoveredArtifact = validateWorkflowEffectControlArtifact(
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
      intentEffectId: record.effectId,
      intentEffectHash: record.effectHash,
      correlationId: record.correlationId,
      approvalGeneration: anchor.approvalGeneration,
      approval,
      approvalRecordHash: hashWorkflowEffectApprovalRecord(approval),
      approvalDecisionHash: null,
    },
    record.validationContext,
  );
  if (recoveredArtifact.kind !== 'effect_approval_pending') {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Recovered approval generation changed artifact kind.',
    );
  }
  const recovered = validateAuthorityRecord({
    ...record,
    state: 'approval_committed',
    preparedDecision: null,
    artifact: recoveredArtifact,
  });
  await writeAuthority(paths, recovered);
  return recovered;
}

async function readAuthority(
  paths: StorePaths,
  approvalRoot: string,
  runId: string,
  evaluationIndex: number,
): Promise<AuthorityRecord | undefined> {
  const record = await readAuthorityRecord(paths, runId, evaluationIndex);
  return record ? recoverApprovalGenerationHead(paths, approvalRoot, record) : undefined;
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

async function assertRunExecutionClear(
  paths: StorePaths,
  runId: string,
  retryEvaluationIndex?: number,
): Promise<void> {
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
    if (record.executionState === 'claimed' && record.evaluationIndex !== retryEvaluationIndex) {
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
  /** Current accepted runner lease; deliberately excluded from durable occurrence identity. */
  readonly leaseExpiresAt: string;
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
      await assertRunExecutionClear(paths, binding.runId, evaluationIndex);
      const record = await readAuthority(paths, this.#approvalRoot, binding.runId, evaluationIndex);
      const anchor = await readOccurrenceAnchor(paths, binding.runId, evaluationIndex);
      if (!record && !anchor) return undefined;
      if (!record || !anchor) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Effect occurrence anchor and authority record are incomplete.',
        );
      }
      assertIdentity(record, {
        ...authorityBase(binding, evaluationIndex, effectKind, effectId, effectHash),
        evaluationIndex,
      });
      if (anchor.identityHash !== record.identityHash) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Effect occurrence anchor and authority identity differ.',
        );
      }
      if (record.state === 'provisional') {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'An effect intent was not durably receipted before restart.',
        );
      }
      return Object.freeze({ record, leaseExpiresAt: binding.descriptorExpiresAt });
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
        this.#approvalRoot,
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
        return Object.freeze({ record: current, leaseExpiresAt: prepared.leaseExpiresAt });
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
          return Object.freeze({ record: current, leaseExpiresAt: prepared.leaseExpiresAt });
        }
        const rolledBack = validateAuthorityRecord({
          ...current,
          state: 'approval_committed',
          preparedDecision: null,
        });
        await writeAuthority(paths, rolledBack);
        return Object.freeze({ record: rolledBack, leaseExpiresAt: prepared.leaseExpiresAt });
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
      return Object.freeze({ record: recovered, leaseExpiresAt: prepared.leaseExpiresAt });
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
      const existing = await readAuthority(
        paths,
        this.#approvalRoot,
        binding.runId,
        evaluationIndex,
      );
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
      await persistOccurrenceAnchor(paths, record);
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
      const current = await readAuthority(
        paths,
        this.#approvalRoot,
        binding.runId,
        evaluationIndex,
      );
      if (!current || current.state !== 'provisional') {
        return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Provisional intent is missing.');
      }
      await assertOccurrenceAnchor(paths, current);
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
      return Object.freeze({ record: next, leaseExpiresAt: binding.descriptorExpiresAt });
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
        this.#approvalRoot,
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
      await assertOccurrenceAnchor(paths, current);
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
          approvalGeneration: 0,
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
      // Publish the immutable generation head before making the corresponding
      // pending approval authoritative. A crash between these writes leaves a
      // detectable mismatch instead of silently re-authorizing generation 0.
      await persistApprovalGenerationAnchor(paths, next);
      await writeAuthority(paths, next);
      return Object.freeze({ record: next, leaseExpiresAt: prepared.leaseExpiresAt });
    });
  }

  async renewPending(
    prepared: PreparedWorkflowEffectOccurrence,
    approvalValue: WorkflowEffectApprovalRecord,
  ): Promise<PreparedWorkflowEffectOccurrence> {
    const approval = validateWorkflowEffectApproval(approvalValue);
    const paths = await preparePaths(this.#approvalRoot, true);
    return withLock(paths, async () => {
      const current = await readAuthority(
        paths,
        this.#approvalRoot,
        prepared.record.runId,
        prepared.record.evaluationIndex,
      );
      if (
        !current ||
        current.identityHash !== prepared.record.identityHash ||
        current.state !== 'approval_committed' ||
        current.artifact?.kind !== 'effect_approval_pending'
      ) {
        return fail(
          'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
          'Expired pending approval is unavailable for renewal.',
        );
      }
      await assertOccurrenceAnchor(paths, current);
      const prior = current.artifact.approval;
      if (Date.parse(prior.expiresAt) > Date.parse(this.#now())) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'An active pending approval cannot be renewed.',
        );
      }
      const approvalGeneration = current.artifact.approvalGeneration + 1;
      const expectedApprovalId = deriveWorkflowEffectApprovalGenerationId(
        current.artifact.occurrenceId,
        current.artifact.intentBindingHash,
        approvalGeneration,
      );
      if (
        approval.approvalId !== expectedApprovalId ||
        approval.runId !== prior.runId ||
        approval.correlationId !== prior.correlationId ||
        approval.workflowId !== prior.workflowId ||
        approval.workflowVersion !== prior.workflowVersion ||
        approval.workflowHash !== prior.workflowHash ||
        approval.inputHash !== prior.inputHash ||
        approval.effectId !== prior.effectId ||
        approval.effectHash !== prior.effectHash ||
        approval.requiredCapability !== prior.requiredCapability ||
        approval.status !== 'pending' ||
        approval.revision !== 0 ||
        Date.parse(approval.createdAt) < Date.parse(prior.expiresAt)
      ) {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
          'Renewed approval changed the durable occurrence identity.',
        );
      }
      const artifact = validateWorkflowEffectControlArtifact(
        {
          ...current.artifact,
          approvalGeneration,
          approval,
          approvalRecordHash: hashWorkflowEffectApprovalRecord(approval),
          approvalDecisionHash: null,
        },
        current.validationContext,
      );
      if (artifact.kind !== 'effect_approval_pending') {
        return fail(
          'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
          'Renewed pending artifact changed kind.',
        );
      }
      const next = validateAuthorityRecord({ ...current, artifact });
      // Advance the generation anchor first. A crash before the authority head
      // update leaves a detectable mismatch and can never re-authorize the old
      // generation.
      await persistApprovalGenerationAnchor(paths, next);
      await writeAuthority(paths, next);
      return Object.freeze({ record: next, leaseExpiresAt: prepared.leaseExpiresAt });
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
        this.#approvalRoot,
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
          const replayValue =
            existing.replay.kind === 'undefined'
              ? undefined
              : (
                  await loadReplayArtifact(
                    paths,
                    current.runId,
                    existing.artifact.executionId,
                    existing.replay,
                  )
                ).value;
          return Object.freeze({
            disposition: 'replay' as const,
            value: replayValue,
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
      if (Date.parse(now) >= Date.parse(prepared.leaseExpiresAt)) {
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
    let replayValue:
      | { readonly kind: 'undefined' }
      | { readonly kind: 'json'; readonly value: unknown; readonly resultHash: string };
    try {
      if (value === undefined) replayValue = Object.freeze({ kind: 'undefined' as const });
      else {
        const canonical = canonicalWorkflowEffectControlJson(value);
        if (Buffer.byteLength(canonical, 'utf8') > MAX_REPLAY_BYTES)
          throw new Error('result exceeds replay limit');
        replayValue = Object.freeze({
          kind: 'json' as const,
          value: parseWorkflowEffectJson(Buffer.from(`${canonical}\n`), {
            maxDepth: 16,
            maxNodes: 4_096,
            maxStringLength: MAX_REPLAY_BYTES,
          }),
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
      const authorityHead = await readAuthority(
        paths,
        this.#approvalRoot,
        binding.runId,
        binding.evaluationIndex,
      );
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
        replayValue.kind === 'undefined'
          ? hashWorkflowEffectControlDomain('execution-result', 'undefined')
          : replayValue.resultHash;
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
      const replay =
        replayValue.kind === 'undefined'
          ? replayValue
          : await persistReplayArtifact(
              paths,
              binding.runId,
              validateReplayArtifact(
                {
                  schema: EXECUTION_REPLAY_SCHEMA,
                  executionId: binding.executionId,
                  kind: 'json',
                  value: replayValue.value,
                  resultHash: replayValue.resultHash,
                },
                binding.executionId,
              ),
            );
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
      const authorityHead = await readAuthority(
        paths,
        this.#approvalRoot,
        binding.runId,
        binding.evaluationIndex,
      );
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
  let replay: ExecutionReplayReference | null = null;
  if (record.replay !== null) {
    if (!record.replay || typeof record.replay !== 'object' || Array.isArray(record.replay)) {
      return fail('WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID', 'Execution replay is invalid.');
    }
    const value = record.replay as Record<string, unknown>;
    if (value.kind === 'undefined' && Reflect.ownKeys(value).length === 1) {
      replay = Object.freeze({ kind: 'undefined' });
    } else if (
      value.kind === 'artifact' &&
      Reflect.ownKeys(value).length === 3 &&
      typeof value.replayRef === 'string' &&
      HASH.test(value.replayRef) &&
      typeof value.resultHash === 'string' &&
      HASH.test(value.resultHash)
    ) {
      replay = Object.freeze({
        kind: 'artifact',
        replayRef: value.replayRef,
        resultHash: value.resultHash,
      });
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
): Promise<WorkflowEffectApprovalRecord> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root || !(await present(root))) return next;
  const paths = await preparePaths(approvalStoreRoot, false);
  const prepared = await withLock(paths, async () => {
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
          existing.nextApproval.status !== next.status ||
          existing.nextApproval.decision?.principalId !== next.decision?.principalId ||
          existing.nextApproval.decision?.workspaceId !== next.decision?.workspaceId ||
          existing.nextApproval.decision?.capability !== next.decision?.capability ||
          existing.nextApproval.decision?.reasonHash !== next.decision?.reasonHash
        ) {
          return fail(
            'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
            'Prepared human decision changed across retry.',
          );
        }
        return existing.nextApproval;
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
      return next;
    }
  });
  return prepared ?? next;
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

export interface WorkflowEffectAuthoritySecurityRepairReport {
  readonly platform: NodeJS.Platform;
  readonly status:
    | 'not_applicable'
    | 'secure'
    | 'repairable'
    | 'repaired'
    | 'reconciliation_required';
  readonly checkedPaths: number;
  readonly insecurePaths: number;
  readonly message: string;
}

/**
 * Audit or explicitly repair legacy Windows DACLs only after all durable
 * evidence has independently passed its canonical schema and lineage checks.
 * This never manufactures missing records or treats an unverified file as
 * trusted authority.
 */
export async function repairWorkflowEffectAuthoritySecurity(
  workspaceRoot: string,
  options: { readonly apply?: boolean } = {},
): Promise<WorkflowEffectAuthoritySecurityRepairReport> {
  if (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
    throw new TypeError('Workflow effect security repair requires a normalized workspace root.');
  }
  if (process.platform !== 'win32') {
    return Object.freeze({
      platform: process.platform,
      status: 'not_applicable' as const,
      checkedPaths: 0,
      insecurePaths: 0,
      message: 'Workflow effect ACL repair is only applicable on Windows.',
    });
  }
  const localRoot = join(workspaceRoot, '.openslack.local', 'workflows');
  const approvalRoot = join(localRoot, 'effect-approvals');
  const authorityRoot = join(localRoot, AUTHORITY_DIRECTORY);
  const roots = [approvalRoot, authorityRoot];
  const existingRoots: string[] = [];
  for (const root of roots) {
    const present = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (present) existingRoots.push(root);
  }
  if (existingRoots.length === 0) {
    return Object.freeze({
      platform: process.platform,
      status: 'secure' as const,
      checkedPaths: 0,
      insecurePaths: 0,
      message: 'No workflow effect authority store exists.',
    });
  }
  const security = productionJournalSecurity();
  const directories: string[] = [];
  const files: string[] = [];
  const approvals = new Map<string, WorkflowEffectApprovalRecord>();
  const authorities = new Map<string, AuthorityRecord>();
  const authoritiesByOccurrence = new Map<string, AuthorityRecord>();
  const executions = new Map<string, ExecutionRecord>();
  const occurrenceAnchors = new Map<string, OccurrenceAnchor>();
  const generationAnchors = new Map<string, ApprovalGenerationAnchor>();
  const replays = new Map<
    string,
    { readonly artifact: ExecutionReplayArtifact; readonly path: string }
  >();
  const referencedExecutions = new Set<string>();
  const referencedOccurrences = new Set<string>();
  const referencedGenerations = new Set<string>();
  const approvalLineages = new Set<string>();
  const repairSnapshots = new Map<string, string>();
  const snapshotIdentity = (stat: Stats): string =>
    [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const assertRepairSnapshot = async (): Promise<void> => {
    for (const [path, identity] of repairSnapshots) {
      const stat = await lstat(path).catch(() => undefined);
      if (!stat || snapshotIdentity(stat) !== identity) {
        throw new TypeError('Workflow effect security repair evidence changed during audit.');
      }
    }
  };
  const approvalLineageKey = (approval: WorkflowEffectApprovalRecord): string =>
    key(
      approval.runId,
      approval.correlationId,
      approval.workflowId,
      approval.workflowVersion,
      approval.workflowHash,
      approval.inputHash,
      approval.effectId,
      approval.effectHash,
      approval.requiredCapability,
    );
  let contentFailure: unknown;
  try {
    for (const root of existingRoots) {
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new TypeError('Workflow effect security repair root is unsafe.');
      }
      repairSnapshots.set(root, snapshotIdentity(rootStat));
      const canonicalRoot = await realpath(root);
      if (resolve(canonicalRoot).toLowerCase() !== resolve(root).toLowerCase()) {
        throw new TypeError('Workflow effect security repair root is non-canonical.');
      }
      const expected =
        root === approvalRoot ? ['locks', 'records'] : ['claims', 'locks', 'records'];
      const children = await readdir(root, { withFileTypes: true });
      if (
        children
          .map((entry) => entry.name)
          .sort()
          .join('\0') !== expected.join('\0')
      ) {
        throw new TypeError('Workflow effect security repair found unknown root entries.');
      }
      directories.push(root);
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink()) {
          throw new TypeError('Workflow effect security repair found an unsafe directory.');
        }
        const directory = join(root, child.name);
        const directoryReal = await realpath(directory);
        const directoryRelative = relative(canonicalRoot, directoryReal);
        if (
          (process.platform === 'win32'
            ? resolve(directoryReal).toLowerCase() !== resolve(directory).toLowerCase()
            : directoryReal !== directory) ||
          directoryRelative === '..' ||
          directoryRelative.startsWith(`..${sep}`)
        ) {
          throw new TypeError('Workflow effect security repair directory escapes its root.');
        }
        const directoryStat = await lstat(directory);
        repairSnapshots.set(directory, snapshotIdentity(directoryStat));
        directories.push(directory);
        const entries = await readdir(directory, { withFileTypes: true });
        if (child.name === 'locks' && entries.length > 0) {
          throw new TypeError('Workflow effect security repair requires an idle authority store.');
        }
        for (const entry of entries) {
          if (!AUTHORITY_FILE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
            throw new TypeError('Workflow effect security repair found an unsafe record entry.');
          }
          const path = join(directory, entry.name);
          const stat = await lstat(path);
          const canonicalPath = await realpath(path);
          const canonicalStat = await lstat(canonicalPath);
          const fileRelative = relative(directoryReal, canonicalPath);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            !canonicalStat.isFile() ||
            canonicalStat.isSymbolicLink() ||
            stat.dev !== canonicalStat.dev ||
            stat.ino !== canonicalStat.ino ||
            (process.platform === 'win32'
              ? resolve(canonicalPath).toLowerCase() !== resolve(path).toLowerCase()
              : canonicalPath !== path) ||
            fileRelative === '..' ||
            fileRelative.startsWith(`..${sep}`) ||
            stat.size > MAX_EXECUTION_BYTES
          ) {
            throw new TypeError('Workflow effect security repair record exceeds its safe shape.');
          }
          const bytes = await readFile(path);
          const after = await lstat(path);
          if (
            stat.dev !== after.dev ||
            stat.ino !== after.ino ||
            stat.size !== after.size ||
            stat.mtimeMs !== after.mtimeMs ||
            stat.ctimeMs !== after.ctimeMs
          ) {
            throw new TypeError(
              'Workflow effect security repair record changed during validation.',
            );
          }
          repairSnapshots.set(path, snapshotIdentity(after));
          const parsed = parseWorkflowEffectJson(bytes, {
            maxDepth: 24,
            maxNodes: 8_192,
            maxStringLength: 256 * 1024,
          });
          if (root === approvalRoot) {
            const record = validateWorkflowEffectApproval(parsed);
            if (!bytes.equals(workflowEffectApprovalBytes(record))) {
              throw new TypeError('Workflow effect approval record is not canonical.');
            }
            if (path !== join(directory, `${key(record.runId, record.approvalId)}.json`)) {
              throw new TypeError('Workflow effect approval record path is not canonical.');
            }
            approvals.set(`${record.runId}\0${record.approvalId}`, record);
          } else {
            const schema = (parsed as { readonly schema?: unknown })?.schema;
            const validated =
              schema === AUTHORITY_RECORD_SCHEMA
                ? validateAuthorityRecord(parsed)
                : schema === EXECUTION_RECORD_SCHEMA
                  ? validateExecutionRecord(parsed, embeddedExecutionContextForParsing(parsed))
                  : schema === OCCURRENCE_ANCHOR_SCHEMA
                    ? validateOccurrenceAnchor(parsed)
                    : schema === APPROVAL_GENERATION_ANCHOR_SCHEMA
                      ? validateApprovalGenerationAnchor(parsed)
                      : schema === EXECUTION_REPLAY_SCHEMA
                        ? validateReplayArtifact(
                            parsed,
                            (parsed as { readonly executionId?: string }).executionId ?? '',
                          )
                        : undefined;
            if (!validated || !bytes.equals(canonicalBytes(validated))) {
              throw new TypeError('Workflow effect authority record is invalid or non-canonical.');
            }
            if (schema === AUTHORITY_RECORD_SCHEMA) {
              const record = validated as AuthorityRecord;
              if (path !== join(directory, `${key(record.runId, record.evaluationIndex)}.json`)) {
                throw new TypeError('Workflow effect authority record path is not canonical.');
              }
              authorities.set(`${record.runId}\0${record.evaluationIndex}`, record);
            } else if (schema === EXECUTION_RECORD_SCHEMA) {
              const record = validated as ExecutionRecord;
              const artifact = record.artifact;
              if (path !== join(directory, `${key(artifact.runId, artifact.occurrenceId)}.json`)) {
                throw new TypeError('Workflow effect execution record path is not canonical.');
              }
              executions.set(`${artifact.runId}\0${artifact.occurrenceId}`, record);
            } else if (schema === OCCURRENCE_ANCHOR_SCHEMA) {
              const anchor = validated as OccurrenceAnchor;
              if (path !== join(directory, `${key(anchor.runId, anchor.evaluationIndex)}.json`)) {
                throw new TypeError('Workflow effect occurrence anchor path is not canonical.');
              }
              occurrenceAnchors.set(`${anchor.runId}\0${anchor.evaluationIndex}`, anchor);
            } else if (schema === APPROVAL_GENERATION_ANCHOR_SCHEMA) {
              const anchor = validated as ApprovalGenerationAnchor;
              if (
                path !==
                join(
                  directory,
                  `${key('approval-generation', anchor.runId, anchor.evaluationIndex)}.json`,
                )
              ) {
                throw new TypeError('Workflow effect generation anchor path is not canonical.');
              }
              generationAnchors.set(`${anchor.runId}\0${anchor.evaluationIndex}`, anchor);
            } else if (schema === EXECUTION_REPLAY_SCHEMA) {
              const artifact = validated as ExecutionReplayArtifact;
              replays.set(artifact.executionId, { artifact, path });
            }
          }
          files.push(path);
        }
      }
    }
    for (const authority of authorities.values()) {
      const artifact = authority.artifact;
      if (!artifact) continue;
      const occurrenceKey = `${authority.runId}\0${artifact.occurrenceId}`;
      if (authoritiesByOccurrence.has(occurrenceKey)) {
        throw new TypeError('Workflow effect occurrence authority is duplicated.');
      }
      authoritiesByOccurrence.set(occurrenceKey, authority);
    }
    for (const [executionKey, execution] of executions) {
      const artifact = execution.artifact;
      const authority = authoritiesByOccurrence.get(`${artifact.runId}\0${artifact.occurrenceId}`);
      if (
        !authority?.artifact ||
        (authority.artifact.kind !== 'effect_decision_committed' &&
          authority.artifact.kind !== 'effect_audit_recorded')
      ) {
        throw new TypeError('Workflow effect execution has no trusted authority context.');
      }
      executions.set(
        executionKey,
        validateExecutionRecord(execution, authority.validationContext, authority.artifact),
      );
    }
    for (const [authorityKey, authority] of authorities) {
      const occurrence = occurrenceAnchors.get(authorityKey);
      if (!occurrence || occurrence.identityHash !== authority.identityHash) {
        throw new TypeError('Workflow effect occurrence lineage is incomplete.');
      }
      referencedOccurrences.add(authorityKey);
      const artifact = authority.artifact;
      if (artifact && artifact.kind !== 'effect_intent') {
        const approvalKey = `${authority.runId}\0${artifact.approval.approvalId}`;
        const approval = approvals.get(approvalKey);
        const generation = generationAnchors.get(authorityKey);
        if (
          !approval ||
          canonicalWorkflowEffectControlJson(approval) !==
            canonicalWorkflowEffectControlJson(artifact.approval) ||
          !generation ||
          generation.occurrenceId !== artifact.occurrenceId ||
          generation.approvalGeneration !== artifact.approvalGeneration ||
          generation.approvalId !== artifact.approval.approvalId
        ) {
          throw new TypeError('Workflow effect approval lineage is incomplete.');
        }
        approvalLineages.add(approvalLineageKey(artifact.approval));
        referencedGenerations.add(authorityKey);
      }
      const occurrenceId = artifact?.occurrenceId;
      const executionKey = occurrenceId ? `${authority.runId}\0${occurrenceId}` : undefined;
      const execution = occurrenceId ? executions.get(executionKey!) : undefined;
      if (
        (authority.executionState === 'unclaimed') !== (execution === undefined) ||
        (execution && execution.artifact.executionId !== authority.executionId) ||
        (execution && execution.artifact.claimStatus !== authority.executionState)
      ) {
        throw new TypeError('Workflow effect execution lineage is incomplete.');
      }
      if (executionKey && execution) referencedExecutions.add(executionKey);
    }
    for (const [executionKey, execution] of executions) {
      const artifact = execution.artifact;
      const authority = authoritiesByOccurrence.get(`${artifact.runId}\0${artifact.occurrenceId}`);
      if (!authority || executionKey !== `${artifact.runId}\0${artifact.occurrenceId}`) {
        throw new TypeError('Workflow effect execution has no authority head.');
      }
      if (execution.replay?.kind === 'artifact') {
        const replay = replays.get(artifact.executionId);
        if (
          !replay ||
          replay.path !==
            join(dirname(replay.path), `${key(artifact.runId, artifact.executionId)}.json`) ||
          replay.artifact.resultHash !== execution.replay.resultHash
        ) {
          throw new TypeError('Workflow effect replay lineage is incomplete.');
        }
        replays.delete(artifact.executionId);
      }
    }
    if (
      replays.size > 0 ||
      [...approvals.values()].some(
        (approval) => !approvalLineages.has(approvalLineageKey(approval)),
      ) ||
      executions.size !== referencedExecutions.size ||
      occurrenceAnchors.size !== referencedOccurrences.size ||
      generationAnchors.size !== referencedGenerations.size
    ) {
      throw new TypeError('Workflow effect security repair found orphan authority evidence.');
    }
    await assertRepairSnapshot();
  } catch (error) {
    contentFailure = error;
  }
  if (contentFailure !== undefined) {
    return Object.freeze({
      platform: process.platform,
      status: 'reconciliation_required' as const,
      checkedPaths: directories.length + files.length,
      insecurePaths: 0,
      message: 'Workflow effect evidence could not be verified; no ACL was changed.',
    });
  }
  let insecurePaths = 0;
  for (const path of directories) {
    try {
      await ensureOwnerDirectory(path, security, dirname(path));
    } catch {
      insecurePaths += 1;
    }
  }
  for (const path of files) {
    try {
      await assertOwnerFile(path, security);
    } catch {
      insecurePaths += 1;
    }
  }
  try {
    await assertRepairSnapshot();
  } catch {
    return Object.freeze({
      platform: process.platform,
      status: 'reconciliation_required' as const,
      checkedPaths: directories.length + files.length,
      insecurePaths: 0,
      message: 'Workflow effect evidence changed during ACL audit; no ACL was changed.',
    });
  }
  if (!options.apply || insecurePaths === 0) {
    return Object.freeze({
      platform: process.platform,
      status: insecurePaths === 0 ? ('secure' as const) : ('repairable' as const),
      checkedPaths: directories.length + files.length,
      insecurePaths,
      message:
        insecurePaths === 0
          ? 'Workflow effect authority ACLs are exact.'
          : 'Workflow effect authority ACLs can be repaired after explicit --apply.',
    });
  }
  try {
    await assertRepairSnapshot();
  } catch {
    return Object.freeze({
      platform: process.platform,
      status: 'reconciliation_required' as const,
      checkedPaths: directories.length + files.length,
      insecurePaths: 0,
      message: 'Workflow effect evidence changed before ACL repair; no ACL was changed.',
    });
  }
  for (const path of directories) security.hardenPath(path, true);
  for (const path of files) security.hardenPath(path, false);
  for (const path of directories) await ensureOwnerDirectory(path, security, dirname(path));
  for (const path of files) await assertOwnerFile(path, security);
  if (existingRoots.includes(authorityRoot)) {
    const paths = await preparePaths(approvalRoot, false);
    await validateAuthorityTree(paths);
  }
  return Object.freeze({
    platform: process.platform,
    status: 'repaired' as const,
    checkedPaths: directories.length + files.length,
    insecurePaths,
    message: 'Workflow effect authority ACLs were rebuilt as owner plus SYSTEM only.',
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

export type WorkflowEffectAuthorityObservationArtifact =
  | WorkflowEffectApprovalPendingArtifact
  | WorkflowEffectDecisionCommittedArtifact
  | WorkflowEffectAuditRecordedArtifact;

function observationArtifactBase(
  artifact:
    | WorkflowEffectApprovalPendingArtifact
    | WorkflowEffectDecisionCommittedArtifact
    | WorkflowEffectAuditRecordedArtifact
    | WorkflowEffectExecutionClaimArtifact,
) {
  return {
    schema: artifact.schema,
    contractVersion: artifact.contractVersion,
    authority: artifact.authority,
    writer: artifact.writer,
    goRole: artifact.goRole,
    goAuthorityClaim: artifact.goAuthorityClaim,
    goAuthorityEligible: artifact.goAuthorityEligible,
    workspaceId: artifact.workspaceId,
    runId: artifact.runId,
    occurrenceIndex: artifact.occurrenceIndex,
    occurrenceId: artifact.occurrenceId,
    intentArtifact: artifact.intentArtifact,
    intentBindingHash: artifact.intentBindingHash,
    intentEffectId: artifact.intentEffectId,
    intentEffectHash: artifact.intentEffectHash,
    correlationId: artifact.correlationId,
    approvalGeneration: artifact.approvalGeneration,
  } as const;
}

function projectAuthorityObservationPrefix(
  record: AuthorityRecord,
): readonly WorkflowEffectAuthorityObservationArtifact[] {
  const artifact = record.artifact;
  if (!artifact || artifact.kind === 'effect_intent') return Object.freeze([]);
  const current = artifact as
    | WorkflowEffectApprovalPendingArtifact
    | WorkflowEffectDecisionCommittedArtifact
    | WorkflowEffectAuditRecordedArtifact
    | WorkflowEffectExecutionClaimArtifact;
  const base = observationArtifactBase(current);
  const approval = current.approval;
  const pendingApproval = createPendingWorkflowEffectApproval({
    runId: approval.runId,
    approvalId: approval.approvalId,
    correlationId: approval.correlationId,
    workflowId: approval.workflowId,
    workflowVersion: approval.workflowVersion,
    workflowHash: approval.workflowHash,
    inputHash: approval.inputHash,
    effectId: approval.effectId,
    effectHash: approval.effectHash,
    requiredCapability: approval.requiredCapability,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  });
  const pendingValue = validateWorkflowEffectControlArtifact(
    {
      ...base,
      kind: 'effect_approval_pending',
      approval: pendingApproval,
      approvalRecordHash: hashWorkflowEffectApprovalRecord(pendingApproval),
      approvalDecisionHash: null,
    },
    record.validationContext,
  );
  if (pendingValue.kind !== 'effect_approval_pending') {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Recovered observer prefix changed pending artifact kind.',
    );
  }
  if (current.kind === 'effect_approval_pending') return Object.freeze([pendingValue]);
  const humanDecision = current.humanDecision;
  const auditProjection = approval.auditProjection;
  if (!auditProjection) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Recovered terminal approval has no audit projection.',
    );
  }
  const decisionApproval = validateWorkflowEffectApproval({
    ...approval,
    revision: 1,
    auditProjection: { status: 'pending', eventId: auditProjection.eventId },
  });
  const decisionValue = validateWorkflowEffectControlArtifact(
    {
      ...base,
      kind: 'effect_decision_committed',
      approval: decisionApproval,
      approvalRecordHash: hashWorkflowEffectApprovalRecord(decisionApproval),
      approvalDecisionHash: hashWorkflowEffectApprovalDecision(decisionApproval, humanDecision),
      humanDecision,
    },
    record.validationContext,
  );
  if (decisionValue.kind !== 'effect_decision_committed') {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Recovered observer prefix changed decision artifact kind.',
    );
  }
  if (approval.revision === 1) return Object.freeze([pendingValue, decisionValue]);
  const auditValue = validateWorkflowEffectControlArtifact(
    {
      ...base,
      kind: 'effect_audit_recorded',
      approval,
      approvalRecordHash: hashWorkflowEffectApprovalRecord(approval),
      approvalDecisionHash: hashWorkflowEffectApprovalDecision(approval, humanDecision),
      humanDecision,
    },
    record.validationContext,
  );
  if (auditValue.kind !== 'effect_audit_recorded') {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Recovered observer prefix changed audit artifact kind.',
    );
  }
  return Object.freeze([pendingValue, decisionValue, auditValue]);
}

/**
 * Rebuilds the exact observer prefix from the current durable D2 authority
 * artifact. It never reads the caller-facing approval store as authority and
 * never changes effect decision or execution state.
 */
export async function recoverWorkflowEffectAuthorityObservationPrefix(
  approvalStoreRoot: string,
  runId: string,
  approvalId: string,
  evaluationIndex: number,
): Promise<readonly WorkflowEffectControlObservation[]> {
  if (
    !SAFE_ID.test(runId) ||
    !SAFE_ID.test(approvalId) ||
    !Number.isSafeInteger(evaluationIndex) ||
    evaluationIndex < 1
  ) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
      'Observer recovery scope is invalid.',
    );
  }
  const root = authorityRoot(approvalStoreRoot)!;
  if (!(await present(root))) {
    if (await approvalEvidenceExists(approvalStoreRoot)) {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Approval evidence exists but its authority lineage is missing.',
      );
    }
    return Object.freeze([]);
  }
  const paths = await preparePaths(approvalStoreRoot, false);
  return withLock(paths, async () => {
    const recovered = await readAuthority(paths, approvalStoreRoot, runId, evaluationIndex);
    const artifact = recovered?.artifact;
    if (!recovered || !artifact || artifact.kind === 'effect_intent') return Object.freeze([]);
    if (artifact.approval.approvalId !== approvalId) {
      return fail(
        'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
        'Observer recovery approval identity changed.',
      );
    }
    return Object.freeze(
      projectAuthorityObservationPrefix(recovered).map((value) =>
        projectWorkflowEffectControlObservation(value, recovered.validationContext),
      ),
    );
  });
}

export interface WorkflowEffectAuthorityObservationFailure {
  readonly recordHash: string;
  readonly code: string;
}

export interface WorkflowEffectAuthorityObservationScan {
  readonly prefixes: readonly WorkflowEffectAuthorityObservationPrefix[];
  readonly failures: readonly WorkflowEffectAuthorityObservationFailure[];
  readonly recordIndex: ReadonlyMap<string, WorkflowEffectAuthorityObservationRecordIdentity>;
}

export interface WorkflowEffectAuthorityObservationRecordIdentity {
  readonly identity: string;
  readonly approvalScope: string | null;
}

function observerFailure(
  recordName: string,
  error: unknown,
): WorkflowEffectAuthorityObservationFailure {
  return Object.freeze({
    recordHash: hashWorkflowEffectControlDomain('observer-record-name', recordName),
    code:
      error instanceof WorkflowEffectAuthorityStoreError
        ? error.code
        : 'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
  });
}

/** A directory identity token lets the non-authorizing worker avoid unchanged full scans. */
export async function workflowEffectAuthorityObservationRevisionToken(
  approvalStoreRoot: string,
): Promise<string> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE',
      'Approval store root is not the authenticated workflow authority root.',
    );
  }
  const records = join(root, 'records');
  const stat = await present(records);
  if (!stat) return 'missing';
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return fail('WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE', 'Authority records directory is unsafe.');
  }
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

export interface WorkflowEffectAuthorityObservationPrefix {
  readonly runId: string;
  readonly approvalId: string;
  readonly observations: readonly WorkflowEffectControlObservation[];
}

/** Rebuilds every observer prefix under one owner-safe authority-store lock. */
export async function recoverAllWorkflowEffectAuthorityObservationPrefixes(
  approvalStoreRoot: string,
): Promise<readonly WorkflowEffectAuthorityObservationPrefix[]> {
  const scan = await scanWorkflowEffectAuthorityObservationPrefixes(approvalStoreRoot);
  if (scan.failures.length > 0) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
      'Authority observer recovery found invalid record evidence.',
    );
  }
  return scan.prefixes;
}

/** Observer-only best-effort scan; it never weakens authoritative reads or writes. */
export async function scanWorkflowEffectAuthorityObservationPrefixes(
  approvalStoreRoot: string,
  priorIndex: ReadonlyMap<string, WorkflowEffectAuthorityObservationRecordIdentity> = new Map(),
): Promise<WorkflowEffectAuthorityObservationScan> {
  const root = authorityRoot(approvalStoreRoot);
  if (!root) {
    return fail(
      'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE',
      'Approval store root is not the authenticated workflow authority root.',
    );
  }
  if (!(await present(root))) {
    if (await approvalEvidenceExists(approvalStoreRoot)) {
      return fail(
        'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
        'Approval evidence exists but its authority lineage is missing.',
      );
    }
    return Object.freeze({
      prefixes: Object.freeze([]),
      failures: Object.freeze([]),
      recordIndex: new Map(),
    });
  }
  const paths = await preparePaths(approvalStoreRoot, false);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireOwnerJournalLock(paths.locks, 'authority', JOURNAL_SECURITY);
    const prefixes: WorkflowEffectAuthorityObservationPrefix[] = [];
    const failures: WorkflowEffectAuthorityObservationFailure[] = [];
    const seenApprovals = new Set<string>();
    const recordIndex = new Map<string, WorkflowEffectAuthorityObservationRecordIdentity>();
    try {
      await recoverAuthorityTemporaries(paths);
    } catch (error) {
      failures.push(observerFailure('temporary-recovery', error));
    }
    const recordEntries = (await readdir(paths.records, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (recordEntries.length > MAX_ENTRIES) {
      failures.push(
        observerFailure(
          'record-capacity',
          new WorkflowEffectAuthorityStoreError(
            'WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED',
            'Authority observer record inventory exceeds its bound.',
          ),
        ),
      );
    }
    for (const entry of recordEntries.slice(0, MAX_ENTRIES)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !AUTHORITY_FILE.test(entry.name)) {
        failures.push(
          observerFailure(
            entry.name,
            new WorkflowEffectAuthorityStoreError(
              'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
              'Authority observer recovery found an unsafe record entry.',
            ),
          ),
        );
        continue;
      }
      try {
        const path = join(paths.records, entry.name);
        const stat = await lstat(path);
        const identity = [
          stat.dev,
          stat.ino,
          stat.size,
          stat.birthtimeMs,
          stat.mtimeMs,
          stat.ctimeMs,
          stat.mode,
        ].join(':');
        const prior = priorIndex.get(entry.name);
        if (prior?.identity === identity) {
          recordIndex.set(entry.name, prior);
          if (prior.approvalScope !== null) {
            if (seenApprovals.has(prior.approvalScope)) {
              failures.push(
                observerFailure(
                  entry.name,
                  new WorkflowEffectAuthorityStoreError(
                    'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
                    'Observer recovery found duplicate approval authority records.',
                  ),
                ),
              );
            }
            seenApprovals.add(prior.approvalScope);
          }
          continue;
        }
        const bytes = await readBounded(path, paths.records, MAX_AUTHORITY_BYTES);
        if (!bytes) {
          recordIndex.set(entry.name, Object.freeze({ identity, approvalScope: null }));
          continue;
        }
        const candidate = parseAuthorityRecord(bytes);
        const recovered = await readAuthority(
          paths,
          approvalStoreRoot,
          candidate.runId,
          candidate.evaluationIndex,
        );
        const artifact = recovered?.artifact;
        if (!recovered || !artifact || artifact.kind === 'effect_intent') {
          recordIndex.set(entry.name, Object.freeze({ identity, approvalScope: null }));
          continue;
        }
        const approvalId = artifact.approval.approvalId;
        const scope = `${recovered.runId}\0${approvalId}`;
        recordIndex.set(entry.name, Object.freeze({ identity, approvalScope: scope }));
        if (seenApprovals.has(scope)) {
          failures.push(
            observerFailure(
              entry.name,
              new WorkflowEffectAuthorityStoreError(
                'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED',
                'Observer recovery found duplicate approval authority records.',
              ),
            ),
          );
          continue;
        }
        seenApprovals.add(scope);
        prefixes.push(
          Object.freeze({
            runId: recovered.runId,
            approvalId,
            observations: Object.freeze(
              projectAuthorityObservationPrefix(recovered).map((value) =>
                projectWorkflowEffectControlObservation(value, recovered.validationContext),
              ),
            ),
          }),
        );
      } catch (error) {
        failures.push(observerFailure(entry.name, error));
        recordIndex.delete(entry.name);
        continue;
      }
    }
    return Object.freeze({
      prefixes: Object.freeze(prefixes),
      failures: Object.freeze(failures),
      recordIndex,
    });
  } finally {
    await release?.();
  }
}
