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
import { resolve } from 'node:path';
import { scanValue } from '@openslack/collaboration';
import {
  isWorkflowControlObservationPort,
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
 * Return whether the authoritative RunStore transition method accepts an edge.
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
  /** Append a line to a file (creates if missing). */
  appendFile(path: string, line: string): Promise<void>;
  /** Check if a path exists. */
  exists(path: string): Promise<boolean>;
  /** Stable file identity used only for per-run validated read caches. */
  fileIdentity?(path: string): Promise<RunStoreFileIdentity | null>;
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
  /** Filesystem abstraction. Defaults to Node.js fs if not provided. */
  fs?: RunStoreFs;
  /** Optional, default-off GS7-B fail-open shadow observation seam. */
  observationPort?: WorkflowControlObservationPort;
}

/**
 * Run store manages the on-disk state for a single workflow run.
 *
 * All paths are derived from `baseDir/runs/<runId>/`.
 */
export class RunStore {
  private readonly baseDir: string;
  private readonly fs: RunStoreFs;
  private readonly observationPort: WorkflowControlObservationPort | undefined;
  private readonly budgetQueues = new Map<string, Promise<unknown>>();
  private readonly auditQueues = new Map<string, Promise<unknown>>();
  private readonly statusQueues = new Map<string, Promise<unknown>>();
  private readonly budgetSessions = new Map<string, BudgetSession>();
  private readonly auditSessions = new Map<string, AuditSession>();

  constructor(options: RunStoreOptions) {
    this.baseDir = options.baseDir;
    this.fs = options.fs ?? createNodeFs();
    if (
      options.observationPort !== undefined &&
      !isWorkflowControlObservationPort(options.observationPort)
    ) {
      throw new TypeError('RunStore observationPort must be a host-created Workflow Control port.');
    }
    this.observationPort = options.observationPort;
  }

  private observeRun(runId: string): void {
    try {
      this.observationPort?.observeRun(runId);
    } catch {
      // The Go shadow can never affect the TypeScript RunStore authority.
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

  // ── Agent result cache ────────────────────────────────────────────────────

  /**
   * Save an agent call result to the cache.
   */
  async saveAgentResult(runId: string, cacheKey: string, result: unknown): Promise<void> {
    await this.fs.writeFile(this.agentPath(runId, cacheKey), JSON.stringify(result, null, 2));
    this.observeRun(runId);
  }

  async saveAgentReplayInput(
    runId: string,
    agentRunId: string,
    input: AgentReplayInput,
  ): Promise<AgentReplayInputPersistenceResult> {
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
    await this.fs.appendFile(this.logPath(runId), JSON.stringify(entry) + '\n');
  }

  async appendBudgetWarning(runId: string, warning: BudgetWarning): Promise<void> {
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

    const results: WorkflowRunInfo[] = [];
    for (const runId of runIds) {
      const meta = await this.loadMeta(runId);
      const st = await this.loadStatus(runId);
      if (meta && st && st.status === status) {
        results.push({
          runId: meta.runId,
          workflowName: meta.workflowName,
          mode: meta.mode,
          status: st.status as RunStatusState,
          startedAt: meta.startedAt,
          updatedAt: st.updatedAt,
        });
      }
    }
    return results;
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

function parseBoundedJson(raw: string, label: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxObservationBytes) {
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
