import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  WORKFLOW_CONTROL_APPROVAL_STATES,
  WORKFLOW_CONTROL_AUTHORITY,
  WORKFLOW_CONTROL_CONTRACT_LIMITS,
  WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
  WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
  WORKFLOW_CONTROL_RUN_STATES,
  hashWorkflowControlValue,
  validateWorkflowControlObservation,
  type WorkflowControlApprovalCounts,
  type WorkflowControlObservation,
} from './workflow-control-contract.js';
import { parseWorkflowEffectJson } from './workflow-effect-json.js';
import {
  validateWorkflowEffectApproval,
  type WorkflowEffectApprovalRecord,
} from './workflow-effect-approval.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const LEGACY_MANIFEST_HASH = /^[0-9a-f]{16}$/u;
const JSON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json$/u;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_AGENT_FILES = 4_096;
const MAX_EFFECT_FILES = 4_096;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);

type JsonRecord = Readonly<Record<string, unknown>>;

export const WORKFLOW_CONTROL_OBSERVATION_ERROR_CODES = Object.freeze([
  'WORKFLOW_CONTROL_OBSERVATION_INVALID',
  'WORKFLOW_CONTROL_OBSERVATION_NOT_FOUND',
  'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE',
  'WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED',
  'WORKFLOW_CONTROL_OBSERVATION_LEGACY_MANIFEST_HASH',
] as const);
export type WorkflowControlObservationErrorCode =
  (typeof WORKFLOW_CONTROL_OBSERVATION_ERROR_CODES)[number];

export class WorkflowControlObservationError extends Error {
  constructor(
    readonly code: WorkflowControlObservationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowControlObservationError';
  }
}

export interface BuildWorkflowControlObservationOptions {
  /** Workspace root containing .openslack.local/workflows. */
  readonly rootDir: string;
  readonly runId: string;
  /** Defaults to .openslack.local/workflows/effect-approvals. */
  readonly effectApprovalRoot?: string;
}

function fail(code: WorkflowControlObservationErrorCode, message: string): never {
  throw new WorkflowControlObservationError(code, message);
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function record(value: unknown, label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', `${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Authoritative evidence has unknown fields.');
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', `${label} is invalid.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', `${label} is invalid.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', `${label} is not canonical RFC3339.`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', `${label} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', `${label} must be a safe integer.`);
  }
  return number;
}

async function assertDirectory(path: string, parent?: string): Promise<string> {
  const before = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return fail('WORKFLOW_CONTROL_OBSERVATION_NOT_FOUND', 'Authoritative directory is missing.');
    }
    throw error;
  });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE', 'Authoritative path is unsafe.');
  }
  const canonical = await realpath(path);
  if (
    resolve(canonical) !== resolve(path) ||
    (parent !== undefined && !contained(parent, canonical))
  ) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE', 'Authoritative path escapes its root.');
  }
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(before, after)) {
    return fail(
      'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE',
      'Authoritative path changed during read.',
    );
  }
  return canonical;
}

async function readJsonFile(
  path: string,
  root: string,
  maximum = MAX_FILE_BYTES,
): Promise<unknown> {
  if (!contained(root, path)) {
    return fail('WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE', 'Authoritative file escapes its root.');
  }
  const before = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return fail('WORKFLOW_CONTROL_OBSERVATION_NOT_FOUND', 'Authoritative evidence is missing.');
    }
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) {
    return fail(
      before.size > BigInt(maximum)
        ? 'WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED'
        : 'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE',
      'Authoritative evidence is unsafe or exceeds its byte limit.',
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      return fail(
        'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE',
        'Authoritative file identity changed.',
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length > maximum) {
      return fail(
        'WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED',
        'Evidence exceeds its byte limit.',
      );
    }
    const after = await handle.stat({ bigint: true });
    const repeated = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(after, repeated)) {
      return fail(
        'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE',
        'Authoritative file changed during read.',
      );
    }
    return parseWorkflowEffectJson(bytes, {
      maxDepth: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxJsonDepth,
      maxNodes: WORKFLOW_CONTROL_CONTRACT_LIMITS.maxJsonNodes,
      maxStringLength: MAX_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof WorkflowControlObservationError) throw error;
    return fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Authoritative evidence is invalid JSON.');
  } finally {
    await handle.close();
  }
}

async function readOptionalJsonFile(
  path: string,
  root: string,
  maximum = MAX_FILE_BYTES,
): Promise<unknown | undefined> {
  const present = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return present === undefined ? undefined : readJsonFile(path, root, maximum);
}

async function readBoundedJsonDirectory(
  directory: string,
  root: string,
  maximumEntries: number,
  visitor: (value: unknown) => void,
): Promise<void> {
  let directoryRoot: string;
  try {
    directoryRoot = await assertDirectory(directory, root);
  } catch (error) {
    if (
      error instanceof WorkflowControlObservationError &&
      error.code === 'WORKFLOW_CONTROL_OBSERVATION_NOT_FOUND'
    ) {
      return;
    }
    throw error;
  }
  const before = await lstat(directoryRoot, { bigint: true });
  const handle = await opendir(directoryRoot);
  let count = 0;
  let bytes = 0;
  try {
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      count += 1;
      if (count > maximumEntries || !JSON_NAME.test(entry.name)) {
        return fail(
          count > maximumEntries
            ? 'WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED'
            : 'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE',
          'Authoritative evidence directory is outside its closed bounds.',
        );
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        return fail('WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE', 'Evidence entry is unsafe.');
      }
      const path = join(directoryRoot, entry.name);
      const stat = await lstat(path, { bigint: true });
      bytes += Number(stat.size);
      if (bytes > MAX_DIRECTORY_BYTES) {
        return fail(
          'WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED',
          'Evidence directory exceeds its byte limit.',
        );
      }
      visitor(await readJsonFile(path, directoryRoot));
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(directoryRoot, { bigint: true });
  if (!sameIdentity(before, after)) {
    return fail(
      'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE',
      'Evidence directory changed during read.',
    );
  }
}

function zeroCounts(): WorkflowControlApprovalCounts {
  return { pending: 0, approved: 0, rejected: 0 };
}

function incrementCount(counts: WorkflowControlApprovalCounts, status: unknown): void {
  if (!WORKFLOW_CONTROL_APPROVAL_STATES.includes(status as never)) {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Approval status is invalid.');
  }
  (counts as { pending: number; approved: number; rejected: number })[
    status as keyof WorkflowControlApprovalCounts
  ] += 1;
}

function validateMeta(value: unknown, runId: string): JsonRecord {
  const meta = record(value, 'run meta');
  exactKeys(
    meta,
    ['runId', 'workflowName', 'mode', 'manifestHash', 'args', 'startedAt'],
    ['budget', 'budgetPolicy'],
  );
  if (safeId(meta.runId, 'meta.runId') !== runId) {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Run meta does not match the requested run.');
  }
  boundedText(
    meta.workflowName,
    'meta.workflowName',
    WORKFLOW_CONTROL_CONTRACT_LIMITS.maxWorkflowNameBytes,
  );
  if (!['validate', 'preview', 'dry-run', 'execute'].includes(String(meta.mode))) {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Run mode is invalid.');
  }
  canonicalTimestamp(meta.startedAt, 'meta.startedAt');
  if (typeof meta.manifestHash !== 'string') {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Manifest hash is invalid.');
  }
  if (LEGACY_MANIFEST_HASH.test(meta.manifestHash)) {
    fail(
      'WORKFLOW_CONTROL_OBSERVATION_LEGACY_MANIFEST_HASH',
      'Legacy 16-hex manifest hashes cannot be promoted into a SHA-256 observation.',
    );
  }
  if (!HASH.test(meta.manifestHash)) {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Manifest hash must be a full SHA-256 digest.');
  }
  record(meta.args, 'meta.args');
  return meta;
}

function validateStatus(value: unknown, runId: string): JsonRecord {
  const status = record(value, 'run status');
  exactKeys(
    status,
    ['runId', 'status', 'updatedAt', 'phases'],
    ['currentPhase', 'budgetWarnings', 'controlEvents', 'pendingAgentControls'],
  );
  if (
    safeId(status.runId, 'status.runId') !== runId ||
    !WORKFLOW_CONTROL_RUN_STATES.includes(status.status as never)
  ) {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Run status binding is invalid.');
  }
  canonicalTimestamp(status.updatedAt, 'status.updatedAt');
  if (status.currentPhase !== undefined) {
    boundedText(
      status.currentPhase,
      'status.currentPhase',
      WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
    );
  }
  if (
    !Array.isArray(status.phases) ||
    status.phases.length > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseCheckpoints
  ) {
    fail('WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED', 'Phase checkpoint bound is exceeded.');
  }
  return status;
}

function phaseObservation(value: unknown) {
  const checkpoint = record(value, 'phase checkpoint');
  exactKeys(checkpoint, ['phase', 'timestamp', 'status'], ['result', 'cacheKey']);
  const status = checkpoint.status;
  if (!['completed', 'failed', 'skipped'].includes(String(status))) {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Phase checkpoint status is invalid.');
  }
  return {
    phase: boundedText(
      checkpoint.phase,
      'checkpoint.phase',
      WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
    ),
    observedAt: canonicalTimestamp(checkpoint.timestamp, 'checkpoint.timestamp'),
    status: status as 'completed' | 'failed' | 'skipped',
    resultHash:
      checkpoint.result === undefined ? null : hashWorkflowControlValue(checkpoint.result),
    cacheKeyHash:
      checkpoint.cacheKey === undefined
        ? null
        : hashWorkflowControlValue(boundedText(checkpoint.cacheKey, 'checkpoint.cacheKey', 2_048)),
  };
}

function warningObservation(value: unknown) {
  const warning = record(value, 'budget warning');
  exactKeys(
    warning,
    ['timestamp', 'kind', 'message', 'tokensUsed', 'tokenBudget', 'percent'],
    ['costUsd'],
  );
  if (warning.kind !== 'threshold' && warning.kind !== 'exceeded') {
    fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Budget warning kind is invalid.');
  }
  return {
    observedAt: canonicalTimestamp(warning.timestamp, 'warning.timestamp'),
    kind: warning.kind,
    tokensUsed: nonNegativeInteger(warning.tokensUsed, 'warning.tokensUsed'),
    tokenBudget: nonNegativeInteger(warning.tokenBudget, 'warning.tokenBudget'),
    percent: nonNegativeNumber(warning.percent, 'warning.percent'),
    costUsd:
      warning.costUsd === undefined ? null : nonNegativeNumber(warning.costUsd, 'warning.costUsd'),
  } as const;
}

/**
 * Builds the credential-free GS7 observation from current TypeScript authority bytes.
 * It intentionally rejects legacy short manifest hashes instead of fabricating SHA-256 evidence.
 */
export async function buildWorkflowControlObservation(
  options: BuildWorkflowControlObservationOptions,
): Promise<WorkflowControlObservation> {
  if (
    typeof options.rootDir !== 'string' ||
    !isAbsolute(options.rootDir) ||
    resolve(options.rootDir) !== options.rootDir
  ) {
    fail('WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE', 'rootDir must be normalized and absolute.');
  }
  const runId = safeId(options.runId, 'runId');
  const workspaceRoot = await assertDirectory(options.rootDir);
  const workflowRoot = join(workspaceRoot, '.openslack.local', 'workflows');
  const runsRoot = join(workflowRoot, 'runs');
  await assertDirectory(join(workspaceRoot, '.openslack.local'), workspaceRoot);
  await assertDirectory(workflowRoot, workspaceRoot);
  const canonicalRunsRoot = await assertDirectory(runsRoot, workflowRoot);
  const runRoot = await assertDirectory(join(canonicalRunsRoot, runId), canonicalRunsRoot);

  const meta = validateMeta(await readJsonFile(join(runRoot, 'meta.json'), runRoot), runId);
  const status = validateStatus(await readJsonFile(join(runRoot, 'status.json'), runRoot), runId);

  const legacyCounts = zeroCounts();
  const legacy = await readOptionalJsonFile(join(runRoot, 'pending-approvals.json'), runRoot);
  if (legacy !== undefined) {
    if (!Array.isArray(legacy) || legacy.length > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCount) {
      fail('WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED', 'Legacy approval bound is exceeded.');
    }
    for (const value of legacy) {
      const approval = record(value, 'legacy approval');
      exactKeys(approval, ['id', 'operation', 'detail', 'timestamp', 'status']);
      incrementCount(legacyCounts, approval.status);
    }
  }

  let tokensUsed = 0;
  let agentCalls = 0;
  await readBoundedJsonDirectory(join(runRoot, 'agents'), runRoot, MAX_AGENT_FILES, (value) => {
    const result = record(value, 'agent result');
    if (!Object.hasOwn(result, 'data')) {
      fail('WORKFLOW_CONTROL_OBSERVATION_INVALID', 'Agent result is missing its data field.');
    }
    const evidence =
      result.workflowEvidence === undefined
        ? undefined
        : record(result.workflowEvidence, 'agent workflow evidence');
    const usage =
      result.tokenUsage === undefined
        ? evidence?.tokenUsage === undefined
          ? 0
          : nonNegativeInteger(evidence.tokenUsage, 'workflowEvidence.tokenUsage')
        : nonNegativeInteger(result.tokenUsage, 'agentResult.tokenUsage');
    tokensUsed += usage;
    agentCalls += 1;
    if (
      !Number.isSafeInteger(tokensUsed) ||
      tokensUsed > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens
    ) {
      fail('WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED', 'Token usage bound is exceeded.');
    }
  });

  const effectCounts = zeroCounts();
  const effectRoot = options.effectApprovalRoot ?? join(workflowRoot, 'effect-approvals');
  if (!isAbsolute(effectRoot) || resolve(effectRoot) !== effectRoot) {
    fail('WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE', 'Effect approval root must be absolute.');
  }
  const effectRecords = join(effectRoot, 'records');
  await readBoundedJsonDirectory(effectRecords, effectRoot, MAX_EFFECT_FILES, (value) => {
    const approval = validateWorkflowEffectApproval(value) as WorkflowEffectApprovalRecord;
    if (approval.runId === runId) incrementCount(effectCounts, approval.status);
  });

  const phases = (status.phases as readonly unknown[]).map(phaseObservation);
  const warningsValue = status.budgetWarnings ?? [];
  if (
    !Array.isArray(warningsValue) ||
    warningsValue.length > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxBudgetWarnings
  ) {
    fail('WORKFLOW_CONTROL_OBSERVATION_LIMIT_EXCEEDED', 'Budget warning bound is exceeded.');
  }
  const warnings = warningsValue.map(warningObservation);
  const budgetPolicy =
    meta.budgetPolicy === undefined ? undefined : record(meta.budgetPolicy, 'budget policy');
  const legacyBudget = meta.budget === undefined ? undefined : record(meta.budget, 'run budget');
  const tokenBudgetValue = budgetPolicy?.tokenBudget ?? legacyBudget?.tokens;
  const tokenBudget =
    tokenBudgetValue === undefined
      ? null
      : nonNegativeInteger(tokenBudgetValue, 'budget.tokenBudget');
  const configured = budgetPolicy !== undefined || legacyBudget !== undefined;
  const latestCost = [...warnings].reverse().find((warning) => warning.costUsd !== null)?.costUsd;

  return validateWorkflowControlObservation({
    schema: WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
    authority: WORKFLOW_CONTROL_AUTHORITY,
    runId,
    workflowName: meta.workflowName,
    mode: meta.mode,
    status: status.status,
    startedAt: meta.startedAt,
    updatedAt: status.updatedAt,
    manifestHash: meta.manifestHash,
    currentPhase: status.currentPhase ?? null,
    phases,
    approvals: {
      legacyRunGate: {
        plane: 'legacy-run-gate',
        semantics: 'run-gate-only',
        counts: legacyCounts,
      },
      effectV2: {
        plane: 'workflow-effect-v2',
        semantics: 'effect-decision-only',
        schema: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
        counts: effectCounts,
      },
    },
    budget: {
      configured,
      policyHash: budgetPolicy === undefined ? null : hashWorkflowControlValue(budgetPolicy),
      tokenBudget,
      tokensUsed,
      costUsd: latestCost ?? null,
      agentCalls,
      warnings,
    },
  });
}
