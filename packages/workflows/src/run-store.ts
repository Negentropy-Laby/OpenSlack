import type {
  ExecutionMode,
  BudgetState,
  PhaseCheckpoint,
  RunStatus,
  RunStatusState,
  PendingApproval,
  WorkflowBudgetPolicy,
  WorkflowRunInfo,
  WorkflowRunControlAction,
  WorkflowRunControlTarget,
} from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  appendFile as fsAppendFile,
  access,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { scanValue } from '@openslack/collaboration';
import {
  atomicWrite,
  acquireOwnerJournalLock,
  isWorkflowControlObservationPort,
  productionJournalSecurity,
  ensureOwnerDirectory,
  readOwnerFile,
  type WorkflowControlObservationPort,
} from './workflow-control-shadow.js';
import { enqueueByKey } from './internal/keyed-serial-queue.js';
import {
  canonicalTimestamp,
  closedDataRecord,
  finiteNumber,
  safeInteger,
} from './internal/strict-data.js';
import { canonicalJsonRoundTrip } from './internal/canonical-json.js';
import {
  WORKFLOW_ARGUMENTS_SCHEMA,
  decodeWorkflowArguments,
  encodeWorkflowArguments,
  inspectWorkflowArgumentsEnvelope,
  validateWorkflowArgumentsEnvelope,
  type WorkflowArgumentsEnvelope,
} from './internal/workflow-arguments.js';
import { WORKFLOW_CONTROL_CONTRACT_LIMITS } from './workflow-control-contract.js';
import {
  WORKFLOW_CHECKPOINT_CONTROL_SCHEMA,
  WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
  validateWorkflowCheckpointControlState,
  validateWorkflowCheckpointExecutionBinding,
  workflowCheckpointCanonicalJson,
  workflowCheckpointBytesHash,
  workflowCheckpointError,
  workflowCheckpointHash,
  type WorkflowCheckpointControlState,
  type WorkflowCheckpointExecutionBinding,
  type WorkflowCheckpointRecord,
  type WorkflowCheckpointShadowObservation,
} from './workflow-checkpoint-shadow-contract.js';
import {
  isWorkflowCheckpointObservationPort,
  type WorkflowCheckpointObservationPort,
} from './workflow-checkpoint-shadow.js';
import {
  isWorkflowRunStoreRecoveryAccess,
  type WorkflowRunStoreRecoveryAccess,
} from './internal/workflow-run-store-recovery-access.js';
import type { WorkflowCheckpointCommitInput, WorkflowCheckpointCommitResult } from './types.js';

// ── Directory layout ──────────────────────────────────────────────────────────
//
// .openslack.local/workflows/
//   runs/
//     <runId>/
//       meta.json            # Run metadata
//       status.json          # Current status, phase index
//       phases/
//         <phaseName>.json   # Phase result and checkpoint
//       agents/
//         <cacheKey>.json    # Agent call result cache
//       pipeline/
//         <phaseName>/
//           <index>.json     # Pipeline item checkpoint
//       log.jsonl            # Structured log entries
//       output.json          # Final workflow output (on completion)

/**
 * Valid run statuses and their allowed transitions.
 *
 *   running -> paused    (interrupted, resumable)
 *   running -> completed (successful finish)
 *   running -> failed    (unrecoverable error)
 *   paused  -> running   (resumed)
 */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  created: new Set(['previewed', 'confirmed', 'running']),
  previewed: new Set(['confirmed', 'running']),
  confirmed: new Set(['running']),
  running: new Set([
    'paused',
    'paused_waiting_approval',
    'resuming',
    'completed',
    'failed',
    'cancelled',
  ]),
  paused: new Set(['running']),
  paused_waiting_approval: new Set(['resuming', 'cancelled']),
  resuming: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/**
 * Return whether the Go-authority recovery projection accepts an edge.
 *
 * This narrow predicate lets the frozen Workflow Control contract prove parity
 * against runtime behavior without exporting the mutable transition sets.
 */
export function isRunStatusTransitionAllowed(from: RunStatusState, to: RunStatusState): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Run metadata persisted to meta.json.
 */
export interface RunMeta {
  runId: string;
  workflowName: string;
  mode: ExecutionMode;
  manifestHash: string;
  argsEncoding?: typeof WORKFLOW_ARGUMENTS_SCHEMA;
  args: Record<string, unknown> | WorkflowArgumentsEnvelope;
  startedAt: string;
  budget?: { tokens: number; costUsd?: number };
  budgetPolicy?: WorkflowBudgetPolicy;
}

export const WORKFLOW_BUDGET_SNAPSHOT_SCHEMA = 'openslack.workflow_budget_snapshot.v1' as const;

/**
 * Closed, cumulative budget evidence for a workflow run.
 *
 * `budget` is immutable. `usage` is monotonic and survives pause/resume so a
 * caller cannot obtain a fresh allowance by submitting a second runner job.
 */
export interface WorkflowBudgetSnapshot {
  schema: typeof WORKFLOW_BUDGET_SNAPSHOT_SCHEMA;
  runId: string;
  budget: { tokens: number; costUsd: number };
  revision: number;
  usage: BudgetState;
  updatedAt: string;
}

export const WORKFLOW_AUDIT_RECORD_SCHEMA = 'openslack.workflow_audit_record.v1' as const;
export const WORKFLOW_AUDIT_MAX_BYTES = 2 * 1024 * 1024;
export const WORKFLOW_CHECKPOINT_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
export const WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES = 8 * 1024 * 1024;

export function parseWorkflowCheckpointReservation(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as { schema?: unknown; bindingId?: unknown };
    if (
      Object.keys(value).sort().join(',') !== 'bindingId,schema' ||
      value.schema !== 'openslack.workflow_checkpoint_reservation.v1' ||
      (value.bindingId !== null &&
        (typeof value.bindingId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value.bindingId))) ||
      workflowCheckpointCanonicalJson(value) !== raw
    )
      throw new Error();
    return value.bindingId as string | null;
  } catch {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT',
      'Checkpoint reservation is corrupt; explicit repair is required.',
    );
  }
}
const WORKFLOW_CHECKPOINT_ARTIFACT_FILE_MAX_BYTES = 6 * 1024 * 1024;
const WORKFLOW_CHECKPOINT_HASH = /^[0-9a-f]{64}$/u;
const WORKFLOW_RUN_LIST_CONCURRENCY = 4;

function checkpointBinding(value: unknown): WorkflowCheckpointExecutionBinding {
  try {
    return validateWorkflowCheckpointExecutionBinding(value);
  } catch (error) {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_BINDING_INVALID',
      'Workflow checkpoint execution binding is invalid.',
      error,
    );
  }
}

/** Hash-only local audit evidence. Raw effect details are never persisted. */
export interface WorkflowAuditRecord {
  schema: typeof WORKFLOW_AUDIT_RECORD_SCHEMA;
  runId: string;
  sequence: number;
  operation: string;
  detailHash: string;
  recordedAt: string;
}

export interface AppendWorkflowAuditResult {
  readonly record: WorkflowAuditRecord;
  readonly duplicate: boolean;
}

/**
 * Run status persisted to status.json.
 */
export interface RunStatusFile {
  runId: string;
  status: RunStatus['status'];
  currentPhase?: string;
  updatedAt: string;
  phases: PhaseCheckpoint[];
  budgetWarnings?: BudgetWarning[];
  controlEvents?: WorkflowRunControlRecord[];
  pendingAgentControls?: WorkflowRunControlRecord[];
}

export interface WorkflowRunControlRecord {
  action: WorkflowRunControlAction;
  timestamp: string;
  target?: WorkflowRunControlTarget;
  status: 'applied' | 'recorded' | 'rejected';
  message: string;
}

/**
 * A single JSONL log line.
 */
export interface LogEntry {
  ts: string;
  phase?: string;
  message: string;
  runId: string;
}

export interface BudgetWarning {
  timestamp: string;
  kind: 'threshold' | 'exceeded';
  message: string;
  tokensUsed: number;
  tokenBudget: number;
  percent: number;
  costUsd?: number;
}

export interface AgentReplayInput {
  schema: 'openslack.workflow_agent_replay_input.v1';
  workflowRunId: string;
  agentRunId: string;
  prompt: string;
  options: Record<string, unknown>;
  resolvedAgentConfig?: unknown;
  phase: string;
  label: string;
  cacheKey: string;
  attempt: number;
  createdAt: string;
}

export type AgentReplayInputLoadResult =
  | { available: true; input: AgentReplayInput }
  | { available: false; reason: string };

export interface AgentReplayInputPersistenceResult {
  available: boolean;
  reason?: string;
  path: string;
}

/**
 * Abstraction over the filesystem operations the run store needs.
 * Tests inject an in-memory implementation; production uses real fs.
 */
export interface RunStoreFs {
  /** Ensure a directory exists (recursive mkdir). */
  mkdir(dir: string): Promise<void>;
  /** Write a file with UTF-8 text content. */
  writeFile(path: string, content: string): Promise<void>;
  /** Read a file as UTF-8 text. Returns null if file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Hardened owner-only/no-follow bounded read for checkpoint authority files. */
  readOwnerOnlyFile?(path: string, maxBytes: number): Promise<string | null>;
  /** Append a line to a file (creates if missing). */
  appendFile(path: string, line: string): Promise<void>;
  /** Check if a path exists. */
  exists(path: string): Promise<boolean>;
  /** Stable file identity used only for per-run validated read caches. */
  fileIdentity?(path: string): Promise<RunStoreFileIdentity | null>;
  /** Production cross-process exclusion for checkpoint head CAS. */
  withExclusiveLock?<T>(path: string, action: () => Promise<T>): Promise<T>;
  /** Owner-only temp+fsync+rename replacement for authoritative checkpoint heads. */
  writeOwnerOnlyAtomic?(path: string, content: string): Promise<void>;
  ensureOwnerOnlyDirectory?(path: string): Promise<void>;
}

export interface RunStoreFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface BudgetSession {
  readonly identity: RunStoreFileIdentity;
  readonly snapshot: WorkflowBudgetSnapshot;
}

interface AuditSession {
  readonly identity: RunStoreFileIdentity | null;
  readonly records: readonly WorkflowAuditRecord[];
  readonly dedup: ReadonlyMap<string, WorkflowAuditRecord>;
  readonly bytes: number;
}

/**
 * Options for creating a RunStore.
 */
export interface RunStoreOptions {
  /** Root directory for all runs, e.g. `.openslack.local/workflows` */
  baseDir: string;
  /**
   * Read-only access is the only ordinary construction mode. The recovery
   * projection mode is internal to the sealed Go-authority worker and may
   * never be selected from CLI, MCP, Qoder, or environment composition.
   */
  access: 'read-only' | WorkflowRunStoreRecoveryAccess;
  /** Filesystem abstraction. Defaults to Node.js fs if not provided. */
  fs?: RunStoreFs;
  /** Optional, default-off GS7-B fail-open shadow observation seam. */
  observationPort?: WorkflowControlObservationPort;
  /** Optional, default-off GS9-C post-commit checkpoint observer. */
  checkpointObservationPort?: WorkflowCheckpointObservationPort;
}

export class WorkflowTypeScriptMutationRetiredError extends Error {
  readonly code = 'WORKFLOW_TYPESCRIPT_MUTATION_RETIRED' as const;

  constructor() {
    super('TypeScript workflow mutation is retired; Go Workflow Control authority is required.');
    this.name = 'WorkflowTypeScriptMutationRetiredError';
  }
}

/**
 * Run store manages the on-disk state for a single workflow run.
 *
 * All paths are derived from `baseDir/runs/<runId>/`.
 */
export class RunStore {
  private readonly baseDir: string;
  protected readonly fs: RunStoreFs;
  private readonly mutationAccess: boolean;
  private readonly observationPort: WorkflowControlObservationPort | undefined;
  private readonly checkpointObservationPort: WorkflowCheckpointObservationPort | undefined;
  private readonly budgetQueues = new Map<string, Promise<unknown>>();
  private readonly auditQueues = new Map<string, Promise<unknown>>();
  private readonly statusQueues = new Map<string, Promise<unknown>>();
  private readonly checkpointQueues = new Map<string, Promise<unknown>>();
  private readonly budgetSessions = new Map<string, BudgetSession>();
  private readonly auditSessions = new Map<string, AuditSession>();

  constructor(options: RunStoreOptions) {
    if (options.access !== 'read-only' && !isWorkflowRunStoreRecoveryAccess(options.access)) {
      throw new WorkflowTypeScriptMutationRetiredError();
    }
    this.baseDir = options.baseDir;
    this.mutationAccess = isWorkflowRunStoreRecoveryAccess(options.access);
    const fs = options.fs ?? createNodeFs();
    this.fs = options.access === 'read-only' ? createReadOnlyRunStoreFs(fs) : fs;
    if (
      options.access === 'read-only' &&
      (options.observationPort !== undefined || options.checkpointObservationPort !== undefined)
    ) {
      throw new TypeError('Read-only workflow run access cannot receive mutation observers.');
    }
    if (
      options.observationPort !== undefined &&
      !isWorkflowControlObservationPort(options.observationPort)
    ) {
      throw new TypeError('RunStore observationPort must be a host-created Workflow Control port.');
    }
    this.observationPort = options.observationPort;
    if (
      options.checkpointObservationPort !== undefined &&
      !isWorkflowCheckpointObservationPort(options.checkpointObservationPort)
    ) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_OBSERVER_CONFIG_INVALID',
        'RunStore checkpointObservationPort must be a host-created checkpoint shadow port.',
      );
    }
    this.checkpointObservationPort = options.checkpointObservationPort;
  }

  private assertMutationAccess(): void {
    if (!this.mutationAccess) throw new WorkflowTypeScriptMutationRetiredError();
  }

  private observeRun(runId: string): void {
    try {
      this.observationPort?.observeRun(runId);
    } catch {
      // Projection observation cannot affect the Go Workflow Control authority.
    }
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  /** Path to the run directory. */
  runDir(runId: string): string {
    return `${this.baseDir}/runs/${runId}`;
  }

  /** Path to meta.json. */
  metaPath(runId: string): string {
    return `${this.runDir(runId)}/meta.json`;
  }

  /** Path to status.json. */
  statusPath(runId: string): string {
    return `${this.runDir(runId)}/status.json`;
  }

  /** Path to the phases directory. */
  phasesDir(runId: string): string {
    return `${this.runDir(runId)}/phases`;
  }

  /** Path to a specific phase file. */
  phasePath(runId: string, phaseName: string): string {
    return `${this.phasesDir(runId)}/${phaseName}.json`;
  }

  /** TS-authoritative, canonical checkpoint head; deliberately separate from legacy status.json. */
  checkpointControlDir(runId: string): string {
    return `${this.runDir(runId)}/checkpoint-control`;
  }

  checkpointControlPath(runId: string): string {
    return `${this.checkpointControlDir(runId)}/head.v1.json`;
  }

  checkpointArtifactsDir(runId: string): string {
    return `${this.checkpointControlDir(runId)}/artifacts`;
  }

  checkpointArtifactPath(runId: string, artifactHash: string): string {
    return `${this.checkpointArtifactsDir(runId)}/${artifactHash}.json`;
  }

  /** Path to the agents directory. */
  agentsDir(runId: string): string {
    return `${this.runDir(runId)}/agents`;
  }

  /** Path to an agent cache file. */
  agentPath(runId: string, cacheKey: string): string {
    return `${this.agentsDir(runId)}/${safeFileName(cacheKey)}.json`;
  }

  /** Path to the replay input directory. */
  replayDir(runId: string): string {
    return `${this.runDir(runId)}/replay/agents`;
  }

  /** Path to a replay input file. */
  replayInputPath(runId: string, agentRunId: string): string {
    return `${this.replayDir(runId)}/${safeFileName(agentRunId)}.json`;
  }

  /** Path to a replay-unavailable marker. */
  replayUnavailablePath(runId: string, agentRunId: string): string {
    return `${this.replayDir(runId)}/${safeFileName(agentRunId)}.unavailable.json`;
  }

  /** Path to the pipeline directory. */
  pipelineDir(runId: string, phaseName: string): string {
    return `${this.runDir(runId)}/pipeline/${phaseName}`;
  }

  /** Path to a pipeline item file. */
  pipelineItemPath(runId: string, phaseName: string, index: number): string {
    return `${this.pipelineDir(runId, phaseName)}/${index}.json`;
  }

  /** Path to log.jsonl. */
  logPath(runId: string): string {
    return `${this.runDir(runId)}/log.jsonl`;
  }

  /** Path to output.json. */
  outputPath(runId: string): string {
    return `${this.runDir(runId)}/output.json`;
  }

  /** Path to pending-approvals.json. */
  pendingApprovalsPath(runId: string): string {
    return `${this.runDir(runId)}/pending-approvals.json`;
  }

  /** Path to the cumulative budget snapshot. */
  budgetSnapshotPath(runId: string): string {
    return `${this.runDir(runId)}/budget.json`;
  }

  /** Path to hash-only audit records. */
  auditPath(runId: string): string {
    return `${this.runDir(runId)}/audit.jsonl`;
  }

  // ── Initialization ────────────────────────────────────────────────────────

  /**
   * Initialize a new run: create directory structure and write meta + status.
   */
  async initRun(runId: string, meta: RunMeta): Promise<void> {
    this.assertMutationAccess();
    const encodedArgs =
      meta.argsEncoding === WORKFLOW_ARGUMENTS_SCHEMA
        ? inspectWorkflowArgumentsEnvelope(meta.args)
        : encodeWorkflowArguments(meta.args as Record<string, unknown>);
    const normalizedMeta = validateRunMeta(
      {
        ...meta,
        argsEncoding: WORKFLOW_ARGUMENTS_SCHEMA,
        args: encodedArgs.envelope,
      },
      runId,
    );
    if (!/^[0-9a-f]{64}$/u.test(normalizedMeta.manifestHash)) {
      throw new Error('New workflow runs require a full SHA-256 workflow identity.');
    }
    const normalizedBudget =
      normalizedMeta.budget === undefined
        ? undefined
        : validateBudgetLimit(normalizedMeta.budget, 'meta.budget');
    const dir = this.runDir(runId);
    await this.fs.mkdir(dir);
    await this.fs.mkdir(this.phasesDir(runId));
    await this.fs.mkdir(this.agentsDir(runId));
    await this.fs.mkdir(this.replayDir(runId));

    // Write meta.json
    await this.fs.writeFile(this.metaPath(runId), JSON.stringify(normalizedMeta, null, 2));

    // Write initial status.json
    const status: RunStatusFile = {
      runId,
      status: 'running',
      updatedAt: normalizedMeta.startedAt,
      phases: [],
    };
    await this.fs.writeFile(
      this.statusPath(runId),
      JSON.stringify(validateRunStatus(status, runId), null, 2),
    );
    if (normalizedBudget !== undefined) {
      const snapshot = createBudgetSnapshot({
        runId,
        budget: normalizedBudget,
        revision: 0,
        usage: {
          tokensUsed: 0,
          tokensRemaining: normalizedBudget.tokens,
          costUsd: normalizedBudget.costUsd,
          agentCalls: 0,
        },
        updatedAt: normalizedMeta.startedAt,
      });
      await this.fs.writeFile(this.budgetSnapshotPath(runId), JSON.stringify(snapshot, null, 2));
    }
    // The empty file is authoritative evidence that the legacy run-gate plane
    // was observed and currently has no approvals. Absence is not equivalent
    // to an observed zero count for the Workflow Control shadow.
    await this.fs.writeFile(this.pendingApprovalsPath(runId), JSON.stringify([], null, 2));
    this.observeRun(runId);
  }

  // ── Cumulative budget ────────────────────────────────────────────────────

  /** Load and strictly validate a cumulative budget snapshot. */
  async loadBudgetSnapshot(runId: string): Promise<WorkflowBudgetSnapshot | null> {
    const raw = await this.fs.readFile(this.budgetSnapshotPath(runId));
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Workflow budget snapshot for ${runId} is not valid JSON.`, {
        cause: error,
      });
    }
    if (raw !== JSON.stringify(value, null, 2)) {
      throw new Error(`Workflow budget snapshot for ${runId} is not canonical JSON.`);
    }
    return validateBudgetSnapshot(value, runId);
  }

  /**
   * Persist a monotonic usage update under a per-run serial queue.
   *
   * The queue prevents parallel agent completions from reading and replacing
   * the same revision. Callers pass the full in-memory cumulative state; a
   * regressing or internally inconsistent update fails closed.
   */
  async persistBudgetState(runId: string, usage: BudgetState): Promise<WorkflowBudgetSnapshot> {
    this.assertMutationAccess();
    const candidate = cloneBudgetState(usage);
    return enqueueByKey(this.budgetQueues, runId, async () => {
      const current = await this.loadBudgetSnapshotForUpdate(runId);
      if (current === null) {
        throw new Error(`Workflow budget snapshot for ${runId} is missing.`);
      }
      validateBudgetUsage(candidate, current.budget, 'budget usage');
      if (
        candidate.tokensUsed < current.usage.tokensUsed ||
        candidate.agentCalls < current.usage.agentCalls ||
        candidate.costUsd < current.usage.costUsd ||
        (current.usage.tokensRemaining !== null &&
          (candidate.tokensRemaining === null ||
            candidate.tokensRemaining > current.usage.tokensRemaining))
      ) {
        throw new Error(`Workflow budget snapshot for ${runId} cannot move backwards.`);
      }
      const next = createBudgetSnapshot({
        runId,
        budget: current.budget,
        revision: current.revision + 1,
        usage: candidate,
        updatedAt: new Date().toISOString(),
      });
      await this.fs.writeFile(this.budgetSnapshotPath(runId), JSON.stringify(next, null, 2));
      await this.rememberBudgetSession(runId, next);
      this.observeRun(runId);
      return next;
    });
  }

  // ── Strict local audit ───────────────────────────────────────────────────

  /**
   * Append a serial, hash-only audit record.
   *
   * Re-entered workflows deduplicate the durable record by operation and
   * detail hash. A caller that needs two intentional occurrences must include
   * a unique `occurrenceId` in its canonical details. Effect intent, approval,
   * and outcome remain per-attempt concerns outside this store.
   */
  async appendAuditRecord(
    runId: string,
    operation: string,
    detail: string,
  ): Promise<AppendWorkflowAuditResult> {
    this.assertMutationAccess();
    if (!operation || operation.length > 256 || /[\r\n]/u.test(operation)) {
      throw new Error('Workflow audit operation is invalid.');
    }
    return enqueueByKey(this.auditQueues, runId, async () => {
      if (!(await this.runExists(runId))) {
        throw new Error(`Workflow run ${runId} does not exist for audit persistence.`);
      }
      const session = await this.loadAuditSession(runId);
      const records = session.records;
      const detailHash = createHash('sha256').update(detail, 'utf8').digest('hex');
      const duplicate = session.dedup.get(auditDedupKey(operation, detailHash));
      if (duplicate) return { record: { ...duplicate }, duplicate: true };
      const record: WorkflowAuditRecord = {
        schema: WORKFLOW_AUDIT_RECORD_SCHEMA,
        runId,
        sequence: records.length + 1,
        operation,
        detailHash,
        recordedAt: new Date().toISOString(),
      };
      validateAuditRecord(record, runId, records.length + 1);
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (session.bytes + lineBytes > WORKFLOW_AUDIT_MAX_BYTES) {
        throw new Error(`Workflow audit records for ${runId} exceed their byte limit.`);
      }
      await this.fs.appendFile(this.auditPath(runId), line);
      await this.rememberAuditSession(runId, [...records, record], session.bytes + lineBytes);
      this.observeRun(runId);
      return { record, duplicate: false };
    });
  }

  /** Read and strictly validate the complete audit chain. */
  async readAuditRecords(runId: string): Promise<WorkflowAuditRecord[]> {
    return [...(await this.readAuditState(runId)).records];
  }

  private async readAuditState(
    runId: string,
  ): Promise<{ records: WorkflowAuditRecord[]; bytes: number }> {
    const raw = await this.fs.readFile(this.auditPath(runId));
    if (raw === null || raw === '') return { records: [], bytes: 0 };
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > WORKFLOW_AUDIT_MAX_BYTES) {
      throw new Error(`Workflow audit records for ${runId} exceed their byte limit.`);
    }
    if (!raw.endsWith('\n') || raw.includes('\r')) {
      throw new Error(`Workflow audit records for ${runId} do not use canonical JSONL framing.`);
    }
    const lines = raw.slice(0, -1).split('\n');
    if (lines.some((line) => line.length === 0)) {
      throw new Error(`Workflow audit records for ${runId} contain an empty record.`);
    }
    const records = lines.map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Workflow audit record ${index + 1} for ${runId} is not valid JSON.`, {
          cause: error,
        });
      }
      const record = validateAuditRecord(value, runId, index + 1);
      if (line !== JSON.stringify(record)) {
        throw new Error(`Workflow audit record ${index + 1} for ${runId} is not canonical JSON.`);
      }
      return record;
    });
    return { records, bytes };
  }

  // ── Status management ─────────────────────────────────────────────────────

  /**
   * Load the current run status. Returns null if run does not exist.
   */
  async loadStatus(runId: string): Promise<RunStatusFile | null> {
    return enqueueByKey(this.statusQueues, runId, () => this.readStatus(runId));
  }

  private async readStatus(runId: string): Promise<RunStatusFile | null> {
    const raw = await this.fs.readFile(this.statusPath(runId));
    if (raw === null) return null;
    return validateRunStatus(parseBoundedJson(raw, `Workflow run status for ${runId}`), runId);
  }

  /** Persist a complete status record after closed validation. */
  async saveStatus(runId: string, status: RunStatusFile): Promise<void> {
    this.assertMutationAccess();
    const validated = validateRunStatus(status, runId);
    await enqueueByKey(this.statusQueues, runId, async () => {
      await this.fs.writeFile(this.statusPath(runId), JSON.stringify(validated, null, 2));
      if (['completed', 'failed', 'cancelled'].includes(validated.status))
        this.clearSessions(runId);
      this.observeRun(runId);
    });
  }

  /**
   * Transition run status. Throws if the transition is invalid.
   */
  async transitionStatus(runId: string, newStatus: RunStatus['status']): Promise<void> {
    this.assertMutationAccess();
    await enqueueByKey(this.statusQueues, runId, async () => {
      const current = await this.readStatus(runId);
      if (current === null) {
        throw new Error(`Run ${runId} not found`);
      }

      if (!isRunStatusTransitionAllowed(current.status, newStatus)) {
        throw new Error(`Invalid status transition: ${current.status} -> ${newStatus}`);
      }

      current.status = newStatus;
      current.updatedAt = new Date().toISOString();
      await this.fs.writeFile(this.statusPath(runId), JSON.stringify(current, null, 2));
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) this.clearSessions(runId);
      this.observeRun(runId);
    });
  }

  /**
   * Update the current phase name in the status file.
   */
  async setCurrentPhase(runId: string, phase: string): Promise<void> {
    this.assertMutationAccess();
    await enqueueByKey(this.statusQueues, runId, async () => {
      const current = await this.readStatus(runId);
      if (current === null) {
        throw new Error(`Run ${runId} not found`);
      }
      current.currentPhase = phase;
      current.updatedAt = new Date().toISOString();
      await this.fs.writeFile(this.statusPath(runId), JSON.stringify(current, null, 2));
      this.observeRun(runId);
    });
  }

  // ── Phase checkpoints ─────────────────────────────────────────────────────

  /**
   * Save a phase checkpoint to the phases directory.
   */
  async savePhaseCheckpoint(runId: string, checkpoint: PhaseCheckpoint): Promise<void> {
    this.assertMutationAccess();
    await this.fs.writeFile(
      this.phasePath(runId, checkpoint.phase),
      JSON.stringify(checkpoint, null, 2),
    );

    // Also update the phases array in status.json
    await enqueueByKey(this.statusQueues, runId, async () => {
      const status = await this.readStatus(runId);
      if (status !== null) {
        const idx = status.phases.findIndex((p) => p.phase === checkpoint.phase);
        if (idx >= 0) {
          status.phases[idx] = checkpoint;
        } else {
          status.phases.push(checkpoint);
        }
        status.updatedAt = new Date().toISOString();
        await this.fs.writeFile(this.statusPath(runId), JSON.stringify(status, null, 2));
      }
      this.observeRun(runId);
    });
  }

  /**
   * Load a phase checkpoint. Returns null if not found.
   */
  async loadPhaseCheckpoint(runId: string, phaseName: string): Promise<PhaseCheckpoint | null> {
    const raw = await this.fs.readFile(this.phasePath(runId, phaseName));
    if (raw === null) return null;
    return JSON.parse(raw) as PhaseCheckpoint;
  }

  // ── GS9-C authoritative checkpoint control ──────────────────────────────

  /** Initialize the separate canonical checkpoint head for a newly accepted runner binding. */
  async initializeCheckpointControl(
    runId: string,
    bindingValue: WorkflowCheckpointExecutionBinding,
  ): Promise<WorkflowCheckpointControlState> {
    this.assertMutationAccess();
    if (this.fs.ensureOwnerOnlyDirectory) {
      await this.fs.ensureOwnerOnlyDirectory(this.checkpointControlDir(runId));
    } else {
      await this.fs.mkdir(this.checkpointControlDir(runId));
    }
    const state = await this.withCheckpointMutation(runId, async () => {
      const binding = checkpointBinding(bindingValue);
      if (binding.workflowRunId !== runId) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_BINDING_INVALID',
          'Workflow checkpoint binding run is mismatched.',
        );
      }
      const existing = await this.loadCheckpointControl(runId);
      if (existing !== null) {
        if (
          workflowCheckpointCanonicalJson(existing.activeBinding) ===
          workflowCheckpointCanonicalJson(binding)
        ) {
          return existing;
        }
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_BINDING_STALE',
          'Workflow checkpoint control is already bound to another attempt.',
        );
      }
      const now = new Date().toISOString();
      const state = validateWorkflowCheckpointControlState(
        {
          schema: WORKFLOW_CHECKPOINT_CONTROL_SCHEMA,
          runId,
          revision: 1,
          resumeGeneration: 0,
          sourceSequence: 0,
          shadowEnabled: Boolean(this.checkpointObservationPort),
          shadowOverflowed: false,
          activeBinding: binding,
          seenBindingHashes: [workflowCheckpointHash(binding)],
          checkpoints: [],
          pendingObservations: [],
          updatedAt: now,
        },
        runId,
      );
      await this.writeCheckpointControl(runId, state);
      return state;
    });
    await this.drainPendingCheckpointObservations(runId);
    return state;
  }

  /**
   * Advance resume generation once for a new accepted runner binding.
   * Retrying the exact binding is idempotent; reusing an older binding is stale.
   */
  async beginCheckpointResumeGeneration(
    runId: string,
    bindingValue: WorkflowCheckpointExecutionBinding,
    nextPhaseId: string,
    nextPhaseIndex: number,
  ): Promise<WorkflowCheckpointControlState> {
    return this.advanceCheckpointResumeGeneration(runId, bindingValue, nextPhaseId, nextPhaseIndex);
  }

  /** Internal Go source: validate and commit its staged authority before updating the cache. */
  protected async advanceCheckpointResumeGeneration(
    runId: string,
    bindingValue: WorkflowCheckpointExecutionBinding,
    nextPhaseId: string,
    nextPhaseIndex: number,
    authority?: {
      expectedGeneration: number;
      reservationId: string;
      prepare(
        prior: WorkflowCheckpointControlState,
        next: WorkflowCheckpointControlState,
      ): Promise<WorkflowCheckpointControlState | void>;
      commit(): Promise<void>;
    },
  ): Promise<WorkflowCheckpointControlState> {
    this.assertMutationAccess();
    let reservedPrior: WorkflowCheckpointControlState | undefined;
    const next = await this.withCheckpointMutation(
      runId,
      async () => {
        const binding = checkpointBinding(bindingValue);
        if (binding.workflowRunId !== runId) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_BINDING_INVALID',
            'Workflow checkpoint binding run is mismatched.',
          );
        }
        const state = await this.requireCheckpointControl(runId);
        const bindingHash = workflowCheckpointHash(binding);
        if (
          authority &&
          state.resumeGeneration !== authority.expectedGeneration &&
          !(
            state.resumeGeneration === authority.expectedGeneration + 1 &&
            bindingHash === state.seenBindingHashes.at(-1)
          )
        ) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_BINDING_STALE',
            'Go resume generation is stale.',
          );
        }
        if (state.seenBindingHashes.includes(bindingHash)) {
          if (
            bindingHash === state.seenBindingHashes.at(-1) &&
            nextPhaseId === `phase-${nextPhaseIndex}` &&
            nextPhaseIndex === state.checkpoints.length
          ) {
            return state;
          }
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_BINDING_STALE',
            'Workflow checkpoint binding is stale.',
          );
        }
        const priorCheckpoint = state.checkpoints.at(-1) ?? null;
        const initialPhaseReentry =
          priorCheckpoint === null &&
          state.checkpoints.length === 0 &&
          nextPhaseIndex === 0 &&
          nextPhaseId === 'phase-0';
        if (
          (!initialPhaseReentry &&
            (priorCheckpoint === null || nextPhaseIndex !== priorCheckpoint.phaseIndex + 1)) ||
          nextPhaseId !== `phase-${nextPhaseIndex}` ||
          binding.attemptId === state.activeBinding.attemptId ||
          binding.leaseId === state.activeBinding.leaseId ||
          ((binding.jobId === state.activeBinding.jobId || !authority) &&
            binding.fencingToken <= state.activeBinding.fencingToken) ||
          binding.workspaceId !== state.activeBinding.workspaceId ||
          binding.workflowRunId !== state.activeBinding.workflowRunId ||
          binding.correlationId !== state.activeBinding.correlationId ||
          binding.runnerBuildHash !== state.activeBinding.runnerBuildHash ||
          binding.workflowSourceHash !== state.activeBinding.workflowSourceHash ||
          binding.manifestHash !== state.activeBinding.manifestHash ||
          binding.inputHash !== state.activeBinding.inputHash
        ) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_RESUME_INVALID',
            'Workflow checkpoint resume binding or next phase is invalid.',
          );
        }
        if (priorCheckpoint) await this.verifyCheckpointArtifact(runId, priorCheckpoint);
        const revision = state.revision + 1;
        const resumeGeneration = state.resumeGeneration + 1;
        const queueObservation = Boolean(
          state.shadowEnabled &&
          this.checkpointObservationPort &&
          !state.shadowOverflowed &&
          state.pendingObservations.length < 1024,
        );
        const sourceSequence = state.sourceSequence + (queueObservation ? 1 : 0);
        const observation: WorkflowCheckpointShadowObservation = {
          schema: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
          authority: 'typescript',
          goRole: 'observer_only',
          runId,
          revision,
          resumeGeneration,
          workflowSourceHash: binding.workflowSourceHash,
          manifestHash: binding.manifestHash,
          inputHash: binding.inputHash,
          runner: this.checkpointRunner(binding),
          checkpoint: null,
          priorCheckpoint,
          nextPhaseId,
          nextPhaseIndex,
        };
        let next = validateWorkflowCheckpointControlState(
          {
            ...state,
            revision,
            resumeGeneration,
            sourceSequence,
            shadowOverflowed:
              state.shadowOverflowed || Boolean(state.shadowEnabled && !queueObservation),
            activeBinding: binding,
            seenBindingHashes: [...state.seenBindingHashes, bindingHash],
            pendingObservations: queueObservation
              ? [
                  ...state.pendingObservations,
                  { sourceSequence, operation: 'resume_advance', observation },
                ]
              : state.pendingObservations,
            updatedAt: new Date().toISOString(),
          },
          runId,
        );
        if (authority) {
          next = (await authority.prepare(state, next)) ?? next;
          await this.writeCheckpointReservation(runId, authority.reservationId);
          reservedPrior = state;
        } else {
          await this.writeCheckpointControl(runId, next);
        }
        return next;
      },
      authority?.reservationId,
    );
    if (authority && reservedPrior) {
      await authority.commit();
      await this.finalizeCheckpointResume(runId, authority.reservationId, reservedPrior, next);
    }
    await this.drainPendingCheckpointObservations(runId);
    return next;
  }

  /** Commit one after-phase checkpoint, then notify the fail-open observer. */
  async commitWorkflowCheckpoint(
    runId: string,
    bindingValue: WorkflowCheckpointExecutionBinding,
    phaseId: string,
    phaseIndex: number,
    input: WorkflowCheckpointCommitInput,
  ): Promise<WorkflowCheckpointCommitResult> {
    this.assertMutationAccess();
    const result = await this.withCheckpointMutation(runId, async () => {
      const binding = checkpointBinding(bindingValue);
      const state = await this.requireCheckpointControl(runId);
      if (
        workflowCheckpointCanonicalJson(state.activeBinding) !==
        workflowCheckpointCanonicalJson(binding)
      ) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_BINDING_STALE',
          'Workflow checkpoint commit binding is stale or mismatched.',
        );
      }
      if (phaseId !== `phase-${phaseIndex}`) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_COMMIT_INVALID',
          'Workflow checkpoint phase identity is invalid.',
        );
      }
      if (
        !(input.artifact instanceof Uint8Array) ||
        input.artifact.byteLength === 0 ||
        input.artifact.byteLength > WORKFLOW_CHECKPOINT_ARTIFACT_MAX_BYTES
      ) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_ARTIFACT_INVALID',
          'Workflow checkpoint artifact bytes are invalid or out of bounds.',
        );
      }
      const artifactHash = workflowCheckpointBytesHash(input.artifact);
      const artifactRef = `checkpoint-control/artifacts/${artifactHash}.json`;
      const resultHash = input.resultHash ?? null;
      const cacheKeyHash = input.cacheKeyHash ?? null;
      if (
        (resultHash !== null && !WORKFLOW_CHECKPOINT_HASH.test(resultHash)) ||
        (cacheKeyHash !== null && !WORKFLOW_CHECKPOINT_HASH.test(cacheKeyHash))
      ) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_COMMIT_INVALID',
          'Workflow checkpoint result or cache hash is invalid.',
        );
      }
      const prior = state.checkpoints[phaseIndex];
      if (prior) {
        if (
          prior.phaseId !== phaseId ||
          prior.artifactRef !== artifactRef ||
          prior.artifactHash !== artifactHash ||
          prior.resultHash !== resultHash ||
          prior.cacheKeyHash !== cacheKeyHash
        ) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_COMMIT_INVALID',
            'Workflow checkpoint replay conflicts with the committed phase.',
          );
        }
        await this.verifyCheckpointArtifact(runId, prior);
        return Object.freeze({
          checkpointId: prior.checkpointId,
          revision: prior.committedRevision,
          resumeGeneration: prior.resumeGeneration,
          duplicate: true,
        });
      }
      if (phaseIndex !== state.checkpoints.length) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_COMMIT_INVALID',
          'Workflow checkpoint phases must commit in declared order.',
        );
      }
      await this.persistCheckpointArtifact(runId, artifactHash, input.artifact);
      const committedRevision = state.revision + 1;
      const queueObservation = Boolean(
        state.shadowEnabled &&
        this.checkpointObservationPort &&
        !state.shadowOverflowed &&
        state.pendingObservations.length < 1024,
      );
      const sourceSequence = state.sourceSequence + (queueObservation ? 1 : 0);
      const committedAt = new Date().toISOString();
      const checkpointSeed = {
        runId,
        phaseId,
        phaseIndex,
        artifactRef,
        artifactHash,
        resultHash,
        cacheKeyHash,
      };
      const checkpoint: WorkflowCheckpointRecord = {
        checkpointId: `checkpoint-${workflowCheckpointHash(checkpointSeed)}`,
        phaseId,
        phaseIndex,
        commitPoint: 'after_phase_work',
        artifactRef,
        artifactHash,
        resultHash,
        cacheKeyHash,
        committedRevision,
        resumeGeneration: state.resumeGeneration,
        committedAt,
      };
      const observation: WorkflowCheckpointShadowObservation = {
        schema: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
        authority: 'typescript',
        goRole: 'observer_only',
        runId,
        revision: committedRevision,
        resumeGeneration: state.resumeGeneration,
        workflowSourceHash: binding.workflowSourceHash,
        manifestHash: binding.manifestHash,
        inputHash: binding.inputHash,
        runner: this.checkpointRunner(binding),
        checkpoint,
        priorCheckpoint: null,
        nextPhaseId: null,
        nextPhaseIndex: null,
      };
      const next = validateWorkflowCheckpointControlState(
        {
          ...state,
          revision: committedRevision,
          sourceSequence,
          shadowOverflowed:
            state.shadowOverflowed || Boolean(state.shadowEnabled && !queueObservation),
          checkpoints: [...state.checkpoints, checkpoint],
          pendingObservations: queueObservation
            ? [
                ...state.pendingObservations,
                { sourceSequence, operation: 'checkpoint_commit', observation },
              ]
            : state.pendingObservations,
          updatedAt: committedAt,
        },
        runId,
      );
      await this.writeCheckpointControl(runId, next);
      return Object.freeze({
        checkpointId: checkpoint.checkpointId,
        revision: committedRevision,
        resumeGeneration: checkpoint.resumeGeneration,
        duplicate: false,
      });
    });
    await this.drainPendingCheckpointObservations(runId);
    return result;
  }

  async loadCheckpointControl(runId: string): Promise<WorkflowCheckpointControlState | null> {
    try {
      const raw = this.fs.readOwnerOnlyFile
        ? await this.fs.readOwnerOnlyFile(
            this.checkpointControlPath(runId),
            WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES,
          )
        : await this.fs.readFile(this.checkpointControlPath(runId));
      if (raw === null) return null;
      const state = validateWorkflowCheckpointControlState(
        parseBoundedJson(
          raw,
          `Workflow checkpoint control for ${runId}`,
          WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES,
        ),
        runId,
      );
      if (workflowCheckpointCanonicalJson(state) !== raw) {
        throw new Error('Workflow checkpoint control bytes are not canonical.');
      }
      return state;
    } catch (error) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT',
        'Workflow checkpoint control is corrupt.',
        error,
      );
    }
  }

  private async requireCheckpointControl(runId: string): Promise<WorkflowCheckpointControlState> {
    const state = await this.loadCheckpointControl(runId);
    if (state === null) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_CONTROL_MISSING',
        `Workflow checkpoint control for ${runId} is missing.`,
      );
    }
    return state;
  }

  protected async writeCheckpointControl(
    runId: string,
    state: WorkflowCheckpointControlState,
  ): Promise<void> {
    const path = this.checkpointControlPath(runId);
    const body = workflowCheckpointCanonicalJson(state);
    try {
      if (this.fs.writeOwnerOnlyAtomic) await this.fs.writeOwnerOnlyAtomic(path, body);
      else await this.fs.writeFile(path, body);
      const readback = this.fs.readOwnerOnlyFile
        ? await this.fs.readOwnerOnlyFile(path, WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES)
        : await this.fs.readFile(path);
      if (readback === body) return;
      throw new Error('Workflow checkpoint control readback is mismatched.');
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: unknown }).code === 'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT'
      ) {
        throw error;
      }
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT',
        'Workflow checkpoint control persistence failed.',
        error,
      );
    }
  }

  private checkpointRunner(binding: WorkflowCheckpointExecutionBinding) {
    return Object.freeze({
      workspaceId: binding.workspaceId,
      jobId: binding.jobId,
      attemptId: binding.attemptId,
      leaseId: binding.leaseId,
      fencingToken: binding.fencingToken,
      correlationId: binding.correlationId,
      runnerBuildHash: binding.runnerBuildHash,
    });
  }

  private async persistCheckpointArtifact(
    runId: string,
    artifactHash: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (this.fs.ensureOwnerOnlyDirectory) {
      await this.fs.ensureOwnerOnlyDirectory(this.checkpointArtifactsDir(runId));
    } else {
      await this.fs.mkdir(this.checkpointArtifactsDir(runId));
    }
    const body = workflowCheckpointCanonicalJson({
      schema: 'openslack.workflow_checkpoint_artifact.v1',
      artifactHash,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });
    const path = this.checkpointArtifactPath(runId, artifactHash);
    let existing: string | null;
    try {
      existing = this.fs.readOwnerOnlyFile
        ? await this.fs.readOwnerOnlyFile(path, WORKFLOW_CHECKPOINT_ARTIFACT_FILE_MAX_BYTES)
        : await this.fs.readFile(path);
      if (existing === null) {
        if (this.fs.writeOwnerOnlyAtomic) await this.fs.writeOwnerOnlyAtomic(path, body);
        else await this.fs.writeFile(path, body);
        return;
      }
    } catch (error) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_INVALID',
        'Workflow checkpoint artifact persistence failed.',
        error,
      );
    }
    if (existing !== body) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED',
        'Workflow checkpoint artifact is mismatched.',
      );
    }
  }

  private async verifyCheckpointArtifact(
    runId: string,
    checkpoint: WorkflowCheckpointRecord,
  ): Promise<void> {
    if (checkpoint.artifactRef !== `checkpoint-control/artifacts/${checkpoint.artifactHash}.json`) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED',
        'Workflow checkpoint artifact reference is invalid.',
      );
    }
    const path = this.checkpointArtifactPath(runId, checkpoint.artifactHash);
    let raw: string | null;
    try {
      raw = this.fs.readOwnerOnlyFile
        ? await this.fs.readOwnerOnlyFile(path, WORKFLOW_CHECKPOINT_ARTIFACT_FILE_MAX_BYTES)
        : await this.fs.readFile(path);
    } catch (error) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED',
        'Workflow checkpoint artifact could not be read safely.',
        error,
      );
    }
    if (raw === null) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_MISSING',
        'Workflow checkpoint artifact is missing.',
      );
    }
    if (Buffer.byteLength(raw, 'utf8') > WORKFLOW_CHECKPOINT_ARTIFACT_FILE_MAX_BYTES) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_INVALID',
        'Workflow checkpoint artifact exceeds its byte limit.',
      );
    }
    const value = parseBoundedJson(
      raw,
      `Workflow checkpoint artifact for ${runId}`,
      WORKFLOW_CHECKPOINT_ARTIFACT_FILE_MAX_BYTES,
    );
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).sort().join(',') !== 'artifactHash,bytesBase64,schema'
    ) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED',
        'Workflow checkpoint artifact framing is invalid.',
      );
    }
    const artifact = value as Record<string, unknown>;
    if (
      artifact.schema !== 'openslack.workflow_checkpoint_artifact.v1' ||
      artifact.artifactHash !== checkpoint.artifactHash ||
      typeof artifact.bytesBase64 !== 'string' ||
      workflowCheckpointCanonicalJson(artifact) !== raw
    ) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED',
        'Workflow checkpoint artifact framing is invalid.',
      );
    }
    const bytes = Buffer.from(artifact.bytesBase64, 'base64');
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > WORKFLOW_CHECKPOINT_ARTIFACT_MAX_BYTES ||
      bytes.toString('base64') !== artifact.bytesBase64 ||
      workflowCheckpointBytesHash(bytes) !== checkpoint.artifactHash
    ) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED',
        'Workflow checkpoint artifact digest is invalid.',
      );
    }
  }

  protected async withCheckpointMutation<T>(
    runId: string,
    action: () => Promise<T>,
    reservationId?: string,
  ): Promise<T> {
    const guarded = async () => {
      const path = `${this.checkpointControlPath(runId)}.intent`;
      const raw = this.fs.readOwnerOnlyFile
        ? await this.fs.readOwnerOnlyFile(path, WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES)
        : await this.fs.readFile(path);
      if (raw !== null) {
        const pending = parseWorkflowCheckpointReservation(raw);
        if (pending !== null && pending !== reservationId)
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_RECONCILIATION_REQUIRED',
            'An unfinished resume intent reserves this checkpoint cache.',
          );
      }
      return action();
    };
    return enqueueByKey(this.checkpointQueues, runId, async () => {
      if (this.fs.withExclusiveLock) {
        return this.fs.withExclusiveLock(`${this.checkpointControlPath(runId)}.lock`, guarded);
      }
      return guarded();
    });
  }

  private async writeCheckpointReservation(runId: string, bindingId: string | null): Promise<void> {
    const path = `${this.checkpointControlPath(runId)}.intent`;
    const body = workflowCheckpointCanonicalJson({
      schema: 'openslack.workflow_checkpoint_reservation.v1',
      bindingId,
    });
    if (this.fs.writeOwnerOnlyAtomic) await this.fs.writeOwnerOnlyAtomic(path, body);
    else await this.fs.writeFile(path, body);
  }

  /** Finish a proven CAS after a lost response/cache write; never rewind newer state. */
  protected async finalizeCheckpointResume(
    runId: string,
    reservationId: string,
    prior: WorkflowCheckpointControlState,
    next: WorkflowCheckpointControlState,
  ): Promise<void> {
    this.assertMutationAccess();
    await this.withCheckpointMutation(
      runId,
      async () => {
        const current = await this.requireCheckpointControl(runId);
        if (
          current.resumeGeneration > next.resumeGeneration ||
          (current.resumeGeneration === next.resumeGeneration && current.revision > next.revision)
        )
          return;
        if (workflowCheckpointHash(current) !== workflowCheckpointHash(next)) {
          if (workflowCheckpointHash(current) !== workflowCheckpointHash(prior))
            throw workflowCheckpointError(
              'WORKFLOW_CHECKPOINT_RECONCILIATION_REQUIRED',
              'Checkpoint cache changed after its resume intent.',
            );
          await this.writeCheckpointControl(runId, next);
        }
        await this.writeCheckpointReservation(runId, null);
      },
      reservationId,
    );
  }

  private async drainPendingCheckpointObservations(runId: string): Promise<void> {
    if (!this.checkpointObservationPort) return;
    while (true) {
      const pending = await this.withCheckpointMutation(runId, async () => {
        const state = await this.requireCheckpointControl(runId);
        return [...state.pendingObservations];
      });
      if (pending.length === 0) return;
      let acknowledged = 0;
      for (const observation of pending) {
        try {
          await this.checkpointObservationPort.journalObservation(
            observation.sourceSequence,
            observation.operation,
            observation.observation,
          );
          acknowledged += 1;
        } catch {
          break;
        }
      }
      if (acknowledged === 0) return;
      try {
        await this.withCheckpointMutation(runId, async () => {
          const state = await this.requireCheckpointControl(runId);
          const exactPrefix = pending.slice(0, acknowledged).every((expected, index) => {
            const current = state.pendingObservations[index];
            return (
              current?.sourceSequence === expected.sourceSequence &&
              current.operation === expected.operation &&
              workflowCheckpointHash(current.observation) ===
                workflowCheckpointHash(expected.observation)
            );
          });
          if (!exactPrefix) return;
          await this.writeCheckpointControl(
            runId,
            validateWorkflowCheckpointControlState(
              { ...state, pendingObservations: state.pendingObservations.slice(acknowledged) },
              runId,
            ),
          );
        });
      } catch {
        // The journal is already durable. Acknowledgement cleanup is shadow-only.
        return;
      }
      if (acknowledged < pending.length) return;
    }
  }

  // ── Agent result cache ────────────────────────────────────────────────────

  /**
   * Save an agent call result to the cache.
   */
  async saveAgentResult(runId: string, cacheKey: string, result: unknown): Promise<void> {
    this.assertMutationAccess();
    await this.fs.writeFile(this.agentPath(runId, cacheKey), JSON.stringify(result, null, 2));
    this.observeRun(runId);
  }

  async saveAgentReplayInput(
    runId: string,
    agentRunId: string,
    input: AgentReplayInput,
  ): Promise<AgentReplayInputPersistenceResult> {
    this.assertMutationAccess();
    await this.fs.mkdir(this.replayDir(runId));
    const targetPath = this.replayInputPath(runId, agentRunId);
    const scan = scanValue(input, 'replayInput');
    if (scan.found) {
      const reason = `Replay input contains ${scan.name} at ${scan.path}. Restart unavailable.`;
      await this.markAgentReplayUnavailable(runId, agentRunId, reason);
      return { available: false, reason, path: this.replayUnavailablePath(runId, agentRunId) };
    }
    await this.fs.writeFile(targetPath, JSON.stringify(input, null, 2));
    return { available: true, path: targetPath };
  }

  async markAgentReplayUnavailable(
    runId: string,
    agentRunId: string,
    reason: string,
  ): Promise<void> {
    this.assertMutationAccess();
    await this.fs.mkdir(this.replayDir(runId));
    await this.fs.writeFile(
      this.replayUnavailablePath(runId, agentRunId),
      JSON.stringify(
        { agentRunId, available: false, reason, timestamp: new Date().toISOString() },
        null,
        2,
      ),
    );
  }

  async loadAgentReplayInput(
    runId: string,
    agentRunId: string,
  ): Promise<AgentReplayInputLoadResult | null> {
    const unavailable = await this.fs.readFile(this.replayUnavailablePath(runId, agentRunId));
    if (unavailable !== null) {
      try {
        const parsed = JSON.parse(unavailable) as { reason?: string };
        return { available: false, reason: parsed.reason ?? 'Replay input is unavailable.' };
      } catch {
        return {
          available: false,
          reason: 'Replay input availability marker could not be parsed.',
        };
      }
    }
    const raw = await this.fs.readFile(this.replayInputPath(runId, agentRunId));
    if (raw === null) return null;
    return { available: true, input: JSON.parse(raw) as AgentReplayInput };
  }

  /**
   * Load a cached agent result. Returns null if not found.
   */
  async loadAgentResult(runId: string, cacheKey: string): Promise<unknown | null> {
    const raw = await this.fs.readFile(this.agentPath(runId, cacheKey));
    if (raw === null) return null;
    return JSON.parse(raw);
  }

  // ── Pipeline item cache ───────────────────────────────────────────────────

  /**
   * Save a pipeline item result.
   */
  async savePipelineItem(
    runId: string,
    phase: string,
    index: number,
    result: unknown,
  ): Promise<void> {
    this.assertMutationAccess();
    await this.fs.mkdir(this.pipelineDir(runId, phase));
    await this.fs.writeFile(
      this.pipelineItemPath(runId, phase, index),
      JSON.stringify(result, null, 2),
    );
  }

  /**
   * Load a pipeline item result. Returns null if not found.
   */
  async loadPipelineItem(runId: string, phase: string, index: number): Promise<unknown | null> {
    const raw = await this.fs.readFile(this.pipelineItemPath(runId, phase, index));
    if (raw === null) return null;
    return JSON.parse(raw);
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  /**
   * Append a structured log entry to log.jsonl.
   */
  async appendLog(runId: string, entry: LogEntry): Promise<void> {
    this.assertMutationAccess();
    await this.fs.appendFile(this.logPath(runId), JSON.stringify(entry) + '\n');
  }

  async appendBudgetWarning(runId: string, warning: BudgetWarning): Promise<void> {
    this.assertMutationAccess();
    await enqueueByKey(this.statusQueues, runId, async () => {
      const status = await this.readStatus(runId);
      if (status === null) return;
      status.budgetWarnings = [...(status.budgetWarnings ?? []), warning];
      status.updatedAt = new Date().toISOString();
      await this.fs.writeFile(this.statusPath(runId), JSON.stringify(status, null, 2));
      this.observeRun(runId);
    });
  }

  /**
   * Read all log entries for a run.
   */
  async readLog(runId: string): Promise<LogEntry[]> {
    const raw = await this.fs.readFile(this.logPath(runId));
    if (raw === null) return [];
    return raw
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogEntry);
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /**
   * Save the final workflow output.
   */
  async saveOutput(runId: string, output: unknown): Promise<void> {
    this.assertMutationAccess();
    await this.fs.writeFile(this.outputPath(runId), JSON.stringify(output, null, 2));
  }

  /**
   * Load the final workflow output. Returns null if not found.
   */
  async loadOutput(runId: string): Promise<unknown | null> {
    const raw = await this.fs.readFile(this.outputPath(runId));
    if (raw === null) return null;
    return JSON.parse(raw);
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  /**
   * Load run metadata. Returns null if not found.
   */
  async loadMeta(runId: string): Promise<RunMeta | null> {
    const raw = await this.fs.readFile(this.metaPath(runId));
    if (raw === null) return null;
    return validateRunMeta(parseBoundedJson(raw, `Workflow run metadata for ${runId}`), runId);
  }

  /**
   * Check if a run directory exists.
   */
  async runExists(runId: string): Promise<boolean> {
    return this.fs.exists(this.runDir(runId));
  }

  /**
   * Build a full RunStatus object for external consumers.
   */
  async getRunStatus(runId: string): Promise<RunStatus | null> {
    const meta = await this.loadMeta(runId);
    const status = await this.loadStatus(runId);
    if (meta === null || status === null) return null;

    return {
      runId: meta.runId,
      workflowName: meta.workflowName,
      mode: meta.mode,
      status: status.status,
      startedAt: meta.startedAt,
      updatedAt: status.updatedAt,
      currentPhase: status.currentPhase,
      phases: status.phases,
      argsEncoding: WORKFLOW_ARGUMENTS_SCHEMA,
      args: encodeRunMetaArguments(meta).envelope,
    };
  }

  private async loadBudgetSnapshotForUpdate(runId: string): Promise<WorkflowBudgetSnapshot | null> {
    if (!this.fs.fileIdentity) return this.loadBudgetSnapshot(runId);
    const identity = await this.fs.fileIdentity(this.budgetSnapshotPath(runId));
    const cached = this.budgetSessions.get(runId);
    if (identity !== null && cached && sameFileIdentity(identity, cached.identity)) {
      return cached.snapshot;
    }
    const snapshot = await this.loadBudgetSnapshot(runId);
    if (snapshot !== null) await this.rememberBudgetSession(runId, snapshot);
    return snapshot;
  }

  private async rememberBudgetSession(
    runId: string,
    snapshot: WorkflowBudgetSnapshot,
  ): Promise<void> {
    if (!this.fs.fileIdentity) return;
    const identity = await this.fs.fileIdentity(this.budgetSnapshotPath(runId));
    if (identity === null) this.budgetSessions.delete(runId);
    else this.budgetSessions.set(runId, { identity, snapshot: cloneBudgetSnapshot(snapshot) });
  }

  private async loadAuditSession(runId: string): Promise<AuditSession> {
    if (this.fs.fileIdentity) {
      const identity = await this.fs.fileIdentity(this.auditPath(runId));
      const cached = this.auditSessions.get(runId);
      if (
        identity !== null &&
        cached !== undefined &&
        cached.identity !== null &&
        sameFileIdentity(identity, cached.identity)
      ) {
        return cached;
      }
    }
    const state = await this.readAuditState(runId);
    const identity = this.fs.fileIdentity
      ? await this.fs.fileIdentity(this.auditPath(runId))
      : null;
    return createAuditSession(identity, state.records, state.bytes);
  }

  private async rememberAuditSession(
    runId: string,
    records: readonly WorkflowAuditRecord[],
    bytes: number,
  ): Promise<void> {
    if (!this.fs.fileIdentity) return;
    const identity = await this.fs.fileIdentity(this.auditPath(runId));
    if (identity === null) this.auditSessions.delete(runId);
    else this.auditSessions.set(runId, createAuditSession(identity, records, bytes));
  }

  private clearSessions(runId: string): void {
    this.budgetSessions.delete(runId);
    this.auditSessions.delete(runId);
  }

  // ── Pending Approvals ─────────────────────────────────────────────────────

  /**
   * Save a pending approval to the run's pending-approvals.json.
   */
  async savePendingApproval(
    runId: string,
    approval: Omit<PendingApproval, 'id' | 'status'>,
  ): Promise<void> {
    this.assertMutationAccess();
    const approvals = await this.loadPendingApprovals(runId);
    approvals.push({
      id: randomUUID(),
      status: 'pending',
      ...approval,
    });
    await this.fs.writeFile(this.pendingApprovalsPath(runId), JSON.stringify(approvals, null, 2));
    this.observeRun(runId);
  }

  /**
   * Load all pending approvals for a run.
   */
  async loadPendingApprovals(runId: string): Promise<PendingApproval[]> {
    const raw = await this.fs.readFile(this.pendingApprovalsPath(runId));
    if (raw === null) return [];
    return JSON.parse(raw) as PendingApproval[];
  }

  /**
   * Resolve a pending approval by id.
   */
  async resolvePendingApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    this.assertMutationAccess();
    const approvals = await this.loadPendingApprovals(runId);
    const idx = approvals.findIndex((a) => a.id === approvalId);
    if (idx < 0) {
      throw new Error(`Approval ${approvalId} not found for run ${runId}`);
    }
    approvals[idx].status = decision;
    await this.fs.writeFile(this.pendingApprovalsPath(runId), JSON.stringify(approvals, null, 2));
    this.observeRun(runId);
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  /**
   * List all runs with a specific status.
   */
  async listRunsByStatus(status: RunStatusState): Promise<WorkflowRunInfo[]> {
    const runsDir = `${this.baseDir}/runs`;
    let runIds: string[];
    try {
      // List run directories
      const entries = await this.fs.readFile(`${runsDir}/.index`);
      if (entries) {
        runIds = entries.trim().split('\n').filter(Boolean);
      } else {
        // Fallback: scan directories if no index file
        const { readdir } = await import('node:fs/promises');
        runIds = await readdir(runsDir).catch(() => []);
      }
    } catch {
      return [];
    }

    const results = new Array<WorkflowRunInfo | null>(runIds.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= runIds.length) return;
        const runId = runIds[index]!;
        const [meta, st] = await Promise.all([this.loadMeta(runId), this.loadStatus(runId)]);
        if (meta && st && st.status === status) {
          results[index] = {
            runId: meta.runId,
            workflowName: meta.workflowName,
            mode: meta.mode,
            status: st.status as RunStatusState,
            startedAt: meta.startedAt,
            updatedAt: st.updatedAt,
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WORKFLOW_RUN_LIST_CONCURRENCY, runIds.length) }, worker),
    );
    return results.filter((item): item is WorkflowRunInfo => item !== null);
  }
}

// ── Node.js fs adapter ─────────────────────────────────────────────────────

function createNodeFs(): RunStoreFs {
  return {
    async mkdir(dir: string) {
      await mkdir(dir, { recursive: true });
    },
    async writeFile(path: string, content: string) {
      const target = resolve(path);
      const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fsWriteFile(temporary, content, 'utf-8');
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
    async readFile(path: string) {
      try {
        return await fsReadFile(resolve(path), 'utf-8');
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          return null;
        }
        throw err;
      }
    },
    async readOwnerOnlyFile(path: string, maxBytes: number) {
      try {
        return await readOwnerFile(resolve(path), productionJournalSecurity(), maxBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async appendFile(path: string, line: string) {
      await fsAppendFile(resolve(path), line, 'utf-8');
    },
    async exists(path: string) {
      try {
        await access(resolve(path));
        return true;
      } catch {
        return false;
      }
    },
    async withExclusiveLock<T>(path: string, action: () => Promise<T>) {
      const target = resolve(path);
      let release: () => Promise<void>;
      try {
        release = await acquireOwnerJournalLock(
          dirname(target),
          basename(target, '.lock'),
          productionJournalSecurity(),
        );
      } catch (error) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT',
          'Workflow checkpoint control lock could not be acquired.',
          error,
        );
      }
      try {
        return await action();
      } finally {
        await release();
      }
    },
    async writeOwnerOnlyAtomic(path: string, content: string) {
      await atomicWrite(resolve(path), content, productionJournalSecurity());
    },
    async ensureOwnerOnlyDirectory(path: string) {
      await ensureOwnerDirectory(resolve(path), productionJournalSecurity());
    },
    async fileIdentity(path: string) {
      try {
        const value = await stat(resolve(path), { bigint: true });
        if (!value.isFile()) return null;
        return {
          dev: value.dev.toString(),
          ino: value.ino.toString(),
          size: value.size.toString(),
          mtimeNs: value.mtimeNs.toString(),
          ctimeNs: value.ctimeNs.toString(),
        };
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          return null;
        }
        throw error;
      }
    },
  };
}

function createReadOnlyRunStoreFs(delegate: RunStoreFs): RunStoreFs {
  const retired = async (): Promise<never> => {
    throw new WorkflowTypeScriptMutationRetiredError();
  };
  return {
    mkdir: retired,
    writeFile: retired,
    readFile: (path) => delegate.readFile(path),
    readOwnerOnlyFile: delegate.readOwnerOnlyFile
      ? (path, maxBytes) => delegate.readOwnerOnlyFile!(path, maxBytes)
      : undefined,
    appendFile: retired,
    exists: (path) => delegate.exists(path),
    fileIdentity: delegate.fileIdentity ? (path) => delegate.fileIdentity!(path) : undefined,
  };
}

function safeFileName(value: string): string {
  // The returned value is used only as a single path segment. encodeURIComponent
  // escapes path separators and traversal dots, and the explicit '*' escape keeps
  // the segment stable across filesystems that treat glob characters specially.
  return encodeURIComponent(value).replace(/\*/g, '%2A');
}

function validateBudgetLimit(value: unknown, name: string): { tokens: number; costUsd: number } {
  const hasCostUsd = typeof value === 'object' && value !== null && Object.hasOwn(value, 'costUsd');
  const raw = closedDataRecord(value, hasCostUsd ? ['tokens', 'costUsd'] : ['tokens'], name);
  return {
    tokens: safeInteger(raw.tokens, `${name}.tokens`, 1),
    costUsd: finiteNumber(raw.costUsd ?? 0, `${name}.costUsd`),
  };
}

function cloneBudgetState(value: BudgetState): BudgetState {
  return {
    tokensUsed: value.tokensUsed,
    tokensRemaining: value.tokensRemaining,
    costUsd: value.costUsd,
    agentCalls: value.agentCalls,
  };
}

function cloneBudgetSnapshot(value: WorkflowBudgetSnapshot): WorkflowBudgetSnapshot {
  return {
    schema: WORKFLOW_BUDGET_SNAPSHOT_SCHEMA,
    runId: value.runId,
    budget: { ...value.budget },
    revision: value.revision,
    usage: cloneBudgetState(value.usage),
    updatedAt: value.updatedAt,
  };
}

function validateBudgetUsage(
  value: unknown,
  budget: { tokens: number; costUsd: number },
  name: string,
): BudgetState {
  const record = closedDataRecord(
    value,
    ['tokensUsed', 'tokensRemaining', 'costUsd', 'agentCalls'],
    name,
  );
  const tokensUsed = safeInteger(record.tokensUsed, `${name}.tokensUsed`);
  const tokensRemaining = record.tokensRemaining;
  if (!Number.isSafeInteger(tokensRemaining)) {
    throw new Error(`${name}.tokensRemaining must be a safe integer.`);
  }
  if (tokensRemaining !== budget.tokens - tokensUsed) {
    throw new Error(`${name} is inconsistent with the original token limit.`);
  }
  return {
    tokensUsed,
    tokensRemaining: tokensRemaining as number,
    costUsd: finiteNumber(record.costUsd, `${name}.costUsd`),
    agentCalls: safeInteger(record.agentCalls, `${name}.agentCalls`),
  };
}

function validateBudgetSnapshot(value: unknown, expectedRunId: string): WorkflowBudgetSnapshot {
  const record = closedDataRecord(
    value,
    ['schema', 'runId', 'budget', 'revision', 'usage', 'updatedAt'],
    'workflow budget snapshot',
  );
  if (record.schema !== WORKFLOW_BUDGET_SNAPSHOT_SCHEMA) {
    throw new Error('Workflow budget snapshot schema is invalid.');
  }
  if (record.runId !== expectedRunId) {
    throw new Error('Workflow budget snapshot run ID does not match its path.');
  }
  const budgetRecord = closedDataRecord(
    record.budget,
    ['tokens', 'costUsd'],
    'workflow budget snapshot budget',
  );
  const budget = {
    tokens: safeInteger(budgetRecord.tokens, 'workflow budget snapshot budget.tokens', 1),
    costUsd: finiteNumber(budgetRecord.costUsd, 'workflow budget snapshot budget.costUsd'),
  };
  return {
    schema: WORKFLOW_BUDGET_SNAPSHOT_SCHEMA,
    runId: expectedRunId,
    budget,
    revision: safeInteger(record.revision, 'workflow budget snapshot revision'),
    usage: validateBudgetUsage(record.usage, budget, 'workflow budget snapshot usage'),
    updatedAt: canonicalTimestamp(record.updatedAt, 'workflow budget snapshot updatedAt'),
  };
}

function createBudgetSnapshot(
  input: Omit<WorkflowBudgetSnapshot, 'schema'>,
): WorkflowBudgetSnapshot {
  return {
    schema: WORKFLOW_BUDGET_SNAPSHOT_SCHEMA,
    runId: input.runId,
    budget: { ...input.budget },
    revision: input.revision,
    usage: cloneBudgetState(input.usage),
    updatedAt: input.updatedAt,
  };
}

function validateAuditRecord(
  value: unknown,
  expectedRunId: string,
  expectedSequence: number,
): WorkflowAuditRecord {
  const record = closedDataRecord(
    value,
    ['schema', 'runId', 'sequence', 'operation', 'detailHash', 'recordedAt'],
    'workflow audit record',
  );
  if (record.schema !== WORKFLOW_AUDIT_RECORD_SCHEMA) {
    throw new Error('Workflow audit record schema is invalid.');
  }
  if (record.runId !== expectedRunId) {
    throw new Error('Workflow audit record run ID does not match its path.');
  }
  if (safeInteger(record.sequence, 'workflow audit record sequence', 1) !== expectedSequence) {
    throw new Error('Workflow audit record sequence is invalid.');
  }
  if (
    typeof record.operation !== 'string' ||
    record.operation.length === 0 ||
    record.operation.length > 256 ||
    /[\r\n]/u.test(record.operation)
  ) {
    throw new Error('Workflow audit record operation is invalid.');
  }
  if (typeof record.detailHash !== 'string' || !/^[0-9a-f]{64}$/u.test(record.detailHash)) {
    throw new Error('Workflow audit record detail hash is invalid.');
  }
  return {
    schema: WORKFLOW_AUDIT_RECORD_SCHEMA,
    runId: expectedRunId,
    sequence: expectedSequence,
    operation: record.operation,
    detailHash: record.detailHash,
    recordedAt: canonicalTimestamp(record.recordedAt, 'workflow audit record recordedAt'),
  };
}

export function decodeRunMetaArguments(meta: RunMeta): Record<string, unknown> {
  if (meta.argsEncoding === WORKFLOW_ARGUMENTS_SCHEMA) {
    return decodeWorkflowArguments(meta.args);
  }
  const cloned = canonicalJsonRoundTrip(meta.args);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    throw new TypeError('Legacy workflow run arguments must be an object.');
  }
  return cloned as Record<string, unknown>;
}

export function encodeRunMetaArguments(meta: RunMeta): ReturnType<typeof encodeWorkflowArguments> {
  if (meta.argsEncoding === WORKFLOW_ARGUMENTS_SCHEMA) {
    return inspectWorkflowArgumentsEnvelope(meta.args);
  }
  return encodeWorkflowArguments(decodeRunMetaArguments(meta));
}

function parseBoundedJson(
  raw: string,
  label: string,
  maxBytes = WORKFLOW_CONTROL_CONTRACT_LIMITS.maxObservationBytes,
): unknown {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds its byte limit.`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function validateRunMeta(value: unknown, expectedRunId: string): RunMeta {
  const record = closedRecordWithOptional(
    value,
    ['runId', 'workflowName', 'mode', 'manifestHash', 'args', 'startedAt'],
    ['argsEncoding', 'budget', 'budgetPolicy'],
    'workflow run metadata',
  );
  if (record.runId !== expectedRunId) {
    throw new Error('Workflow run metadata ID does not match its path.');
  }
  const workflowName = boundedText(
    record.workflowName,
    'workflow run metadata workflowName',
    WORKFLOW_CONTROL_CONTRACT_LIMITS.maxWorkflowNameBytes,
  );
  if (!['validate', 'preview', 'dry-run', 'execute'].includes(String(record.mode))) {
    throw new Error('Workflow run metadata mode is invalid.');
  }
  const manifestHash = boundedText(
    record.manifestHash,
    'workflow run metadata manifestHash',
    WORKFLOW_CONTROL_CONTRACT_LIMITS.maxWorkflowNameBytes,
  );
  const startedAt = canonicalTimestamp(record.startedAt, 'workflow run metadata startedAt');
  const argsEncoding = record.argsEncoding;
  let args: RunMeta['args'];
  if (argsEncoding === undefined) {
    const legacy = canonicalJsonRoundTrip(record.args);
    if (typeof legacy !== 'object' || legacy === null || Array.isArray(legacy)) {
      throw new Error('Legacy workflow run arguments must be an object.');
    }
    args = legacy as Record<string, unknown>;
  } else if (argsEncoding === WORKFLOW_ARGUMENTS_SCHEMA) {
    args = validateWorkflowArgumentsEnvelope(record.args);
  } else {
    throw new Error('Workflow run argument encoding is unsupported.');
  }

  const budget =
    record.budget === undefined ? undefined : validateBudgetLimit(record.budget, 'meta.budget');
  const budgetPolicy =
    record.budgetPolicy === undefined
      ? undefined
      : validateBudgetPolicy(record.budgetPolicy, 'meta.budgetPolicy');
  return {
    runId: expectedRunId,
    workflowName,
    mode: record.mode as ExecutionMode,
    manifestHash,
    ...(argsEncoding === WORKFLOW_ARGUMENTS_SCHEMA ? { argsEncoding } : {}),
    args,
    startedAt,
    ...(budget === undefined ? {} : { budget }),
    ...(budgetPolicy === undefined ? {} : { budgetPolicy }),
  };
}

function validateRunStatus(value: unknown, expectedRunId: string): RunStatusFile {
  const record = closedRecordWithOptional(
    value,
    ['runId', 'status', 'updatedAt', 'phases'],
    ['currentPhase', 'budgetWarnings', 'controlEvents', 'pendingAgentControls'],
    'workflow run status',
  );
  if (record.runId !== expectedRunId) {
    throw new Error('Workflow run status ID does not match its path.');
  }
  if (!Object.hasOwn(VALID_TRANSITIONS, String(record.status))) {
    throw new Error('Workflow run status state is invalid.');
  }
  if (
    !Array.isArray(record.phases) ||
    record.phases.length > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseCheckpoints
  ) {
    throw new Error('Workflow run status phases are invalid.');
  }
  const phases = record.phases.map((phase, index) => validatePhase(phase, index));
  const currentPhase =
    record.currentPhase === undefined
      ? undefined
      : boundedText(
          record.currentPhase,
          'workflow run status currentPhase',
          WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
        );
  const budgetWarnings =
    record.budgetWarnings === undefined ? undefined : validateBudgetWarnings(record.budgetWarnings);
  const controlEvents =
    record.controlEvents === undefined
      ? undefined
      : validateControlRecords(record.controlEvents, 'workflow run controlEvents', expectedRunId);
  const pendingAgentControls =
    record.pendingAgentControls === undefined
      ? undefined
      : validateControlRecords(
          record.pendingAgentControls,
          'workflow run pendingAgentControls',
          expectedRunId,
        );
  return {
    runId: expectedRunId,
    status: record.status as RunStatusState,
    ...(currentPhase === undefined ? {} : { currentPhase }),
    updatedAt: canonicalTimestamp(record.updatedAt, 'workflow run status updatedAt'),
    phases,
    ...(budgetWarnings === undefined ? {} : { budgetWarnings }),
    ...(controlEvents === undefined ? {} : { controlEvents }),
    ...(pendingAgentControls === undefined ? {} : { pendingAgentControls }),
  };
}

function validatePhase(value: unknown, index: number): PhaseCheckpoint {
  const label = `workflow run phase ${index}`;
  const record = closedRecordWithOptional(
    value,
    ['phase', 'timestamp', 'status'],
    ['result', 'cacheKey'],
    label,
  );
  const status = record.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'skipped') {
    throw new Error(`${label} status is invalid.`);
  }
  const result =
    record.result === undefined
      ? undefined
      : canonicalJsonRoundTrip(record.result, { allowNullPrototype: true });
  const cacheKey =
    record.cacheKey === undefined
      ? undefined
      : boundedText(
          record.cacheKey,
          `${label} cacheKey`,
          WORKFLOW_CONTROL_CONTRACT_LIMITS.maxIdentifierBytes,
        );
  return {
    phase: boundedText(
      record.phase,
      `${label} phase`,
      WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
    ),
    timestamp: canonicalTimestamp(record.timestamp, `${label} timestamp`),
    status,
    ...(result === undefined ? {} : { result }),
    ...(cacheKey === undefined ? {} : { cacheKey }),
  };
}

function validateBudgetWarnings(value: unknown): BudgetWarning[] {
  if (!Array.isArray(value) || value.length > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxBudgetWarnings) {
    throw new Error('Workflow run budget warnings are invalid.');
  }
  return value.map((item, index) => {
    const label = `workflow run budget warning ${index}`;
    const record = closedRecordWithOptional(
      item,
      ['timestamp', 'kind', 'message', 'tokensUsed', 'tokenBudget', 'percent'],
      ['costUsd'],
      label,
    );
    if (record.kind !== 'threshold' && record.kind !== 'exceeded') {
      throw new Error(`${label} kind is invalid.`);
    }
    return {
      timestamp: canonicalTimestamp(record.timestamp, `${label} timestamp`),
      kind: record.kind,
      message: boundedText(
        record.message,
        `${label} message`,
        WORKFLOW_CONTROL_CONTRACT_LIMITS.maxObservationBytes,
      ),
      tokensUsed: safeInteger(record.tokensUsed, `${label} tokensUsed`),
      tokenBudget: safeInteger(record.tokenBudget, `${label} tokenBudget`, 1),
      percent: finiteNumber(record.percent, `${label} percent`),
      ...(record.costUsd === undefined
        ? {}
        : { costUsd: finiteNumber(record.costUsd, `${label} costUsd`) }),
    };
  });
}

function validateControlRecords(
  value: unknown,
  label: string,
  expectedRunId: string,
): WorkflowRunControlRecord[] {
  if (!Array.isArray(value) || value.length > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxJsonNodes) {
    throw new Error(`${label} are invalid.`);
  }
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const record = closedRecordWithOptional(
      item,
      ['action', 'timestamp', 'status', 'message'],
      ['target'],
      itemLabel,
    );
    if (
      !['pause', 'resume', 'stopRun', 'stopAgent', 'restartAgent', 'saveScript'].includes(
        String(record.action),
      )
    ) {
      throw new Error(`${itemLabel}.action is invalid.`);
    }
    if (!['applied', 'recorded', 'rejected'].includes(String(record.status))) {
      throw new Error(`${itemLabel}.status is invalid.`);
    }
    return {
      action: record.action as WorkflowRunControlAction,
      timestamp: canonicalTimestamp(record.timestamp, `${itemLabel}.timestamp`),
      ...(record.target === undefined
        ? {}
        : {
            target: validateControlTarget(record.target, `${itemLabel}.target`, expectedRunId),
          }),
      status: record.status as WorkflowRunControlRecord['status'],
      message: boundedText(
        record.message,
        `${itemLabel}.message`,
        WORKFLOW_CONTROL_CONTRACT_LIMITS.maxObservationBytes,
      ),
    };
  });
}

function validateControlTarget(
  value: unknown,
  label: string,
  expectedRunId: string,
): WorkflowRunControlTarget {
  const record = closedRecordWithOptional(
    value,
    ['runId'],
    ['phase', 'agentRunId', 'agentId'],
    label,
  );
  const optional = (field: 'phase' | 'agentRunId' | 'agentId') =>
    record[field] === undefined
      ? undefined
      : boundedText(
          record[field],
          `${label}.${field}`,
          WORKFLOW_CONTROL_CONTRACT_LIMITS.maxIdentifierBytes,
        );
  const phase = optional('phase');
  const agentRunId = optional('agentRunId');
  const agentId = optional('agentId');
  const runId = boundedText(
    record.runId,
    `${label}.runId`,
    WORKFLOW_CONTROL_CONTRACT_LIMITS.maxIdentifierBytes,
  );
  if (runId !== expectedRunId) throw new Error(`${label}.runId does not match the run path.`);
  return {
    runId,
    ...(phase === undefined ? {} : { phase }),
    ...(agentRunId === undefined ? {} : { agentRunId }),
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function validateBudgetPolicy(value: unknown, label: string): WorkflowBudgetPolicy {
  const record = closedRecordWithOptional(
    value,
    [],
    ['maxAgents', 'maxConcurrency', 'tokenBudget', 'onExceeded'],
    label,
  );
  const maxAgents =
    record.maxAgents === undefined
      ? undefined
      : safeInteger(record.maxAgents, `${label}.maxAgents`, 1);
  const maxConcurrency =
    record.maxConcurrency === undefined
      ? undefined
      : safeInteger(record.maxConcurrency, `${label}.maxConcurrency`, 1);
  const tokenBudget =
    record.tokenBudget === undefined
      ? undefined
      : safeInteger(record.tokenBudget, `${label}.tokenBudget`, 1);
  if (
    record.onExceeded !== undefined &&
    record.onExceeded !== 'pause' &&
    record.onExceeded !== 'fail'
  ) {
    throw new Error(`${label}.onExceeded is invalid.`);
  }
  return {
    ...(maxAgents === undefined ? {} : { maxAgents }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(record.onExceeded === undefined ? {} : { onExceeded: record.onExceeded }),
  };
}

function closedRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} has unexpected or missing fields.`);
  }
  return record;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function auditDedupKey(operation: string, detailHash: string): string {
  return JSON.stringify([operation, detailHash]);
}

function createAuditSession(
  identity: RunStoreFileIdentity | null,
  records: readonly WorkflowAuditRecord[],
  bytes: number,
): AuditSession {
  const copied = records.map((record) => ({ ...record }));
  return {
    identity,
    records: copied,
    bytes,
    dedup: new Map(
      copied.map((record) => [auditDedupKey(record.operation, record.detailHash), record]),
    ),
  };
}

function sameFileIdentity(left: RunStoreFileIdentity, right: RunStoreFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
