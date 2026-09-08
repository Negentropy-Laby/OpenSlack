import { existsSync, lstatSync, opendirSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  locateWorkflowRunProjection,
  type WorkflowRunProjectionLocation,
  WorkflowRunReadContext,
  withWorkflowRunRead,
  retryWorkflowRunRead,
} from './workflow-run-projection.js';
import {
  WorkflowRunReadError,
  asWorkflowRunReadError,
  type WorkflowRunReadDiagnostic,
  renderWorkflowRunReadDiagnostic,
  workflowRunReadDiagnostic,
} from './workflow-run-read-errors.js';
import {
  readWorkflowEvidenceText,
  WORKFLOW_LOCAL_EVIDENCE_MAX_BYTES,
} from './internal/workflow-evidence-file.js';
import {
  readRunStateSnapshot,
  type AgentRunEvent,
  type AgentRunState,
} from '@openslack/agent-runtime';
import { redactString } from './redact.js';
import {
  estimateWorkflowAgentCost,
  getBudgetWarningThreshold,
  parseWorkflowCostConfig,
  type WorkflowCostConfig,
} from './cost.js';
import type { BudgetWarning } from './run-store.js';
import {
  WORKFLOW_ARGUMENTS_SCHEMA,
  encodeWorkflowArguments,
  validateWorkflowArgumentsEnvelope,
  type WorkflowArgumentsEnvelope,
} from './internal/workflow-arguments.js';
import type {
  AgentResult,
  ExecutionMode,
  PendingApproval,
  PhaseCheckpoint,
  RunStatusState,
  WorkflowAgentProgress,
  WorkflowBudgetUsage,
  WorkflowMeta,
  WorkflowPhaseProgress,
  WorkflowRunProgress,
  WorkflowToolEvidence,
} from './types.js';

interface ProgressLogEntry {
  ts: string;
  phase?: string;
  message: string;
  runId: string;
}

interface RunMetaFile {
  runId: string;
  workflowName: string;
  mode: ExecutionMode;
  manifestHash: string;
  argsEncoding?: typeof WORKFLOW_ARGUMENTS_SCHEMA;
  args: Record<string, unknown> | WorkflowArgumentsEnvelope;
  startedAt: string;
}

interface RunStatusFileLike {
  runId?: string;
  status?: RunStatusState;
  currentPhase?: string;
  updatedAt?: string;
  phases?: PhaseCheckpoint[];
  controlEvents?: Array<{ action?: string; timestamp?: string }>;
  budgetWarnings?: BudgetWarning[];
}

interface ReadResult<T> {
  value: T | null;
  present: boolean;
  warning?: string;
  failure?: WorkflowRunReadError;
}

export interface GetWorkflowRunProgressOptions {
  rootDir?: string;
  loadWorkflowManifest?: boolean;
  loadCostConfig?: boolean;
  strictRead?: boolean;
  /** @internal Reuse the location already verified by this read query. */
  readContext?: WorkflowRunReadContext;
}

const MAX_JSON_BYTES = WORKFLOW_LOCAL_EVIDENCE_MAX_BYTES;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_JSONL_LINES = 10_000;
const MAX_AGENT_RESULT_FILES = 256;
const MAX_PROGRESS_ITEMS = 1_000;
const EXECUTION_MODES = new Set<ExecutionMode>(['validate', 'preview', 'dry-run', 'execute']);
const RUN_STATUS_STATES = new Set<RunStatusState>([
  'created',
  'previewed',
  'confirmed',
  'running',
  'paused',
  'paused_waiting_approval',
  'resuming',
  'completed',
  'failed',
  'cancelled',
]);
const PHASE_STATUS_STATES = new Set<PhaseCheckpoint['status']>(['completed', 'failed', 'skipped']);
const APPROVAL_STATUS_STATES = new Set<PendingApproval['status']>([
  'pending',
  'approved',
  'rejected',
]);
const AGENT_RUN_STATUS_STATES = new Set<AgentRunState['status']>([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
const AGENT_EVENT_TYPES = new Set<AgentRunEvent['type']>([
  'start',
  'progress',
  'tool_call',
  'tool_result',
  'complete',
  'fail',
  'cancel',
]);
const AGENT_FAILURE_CODES = new Set([
  'RUNTIME_NOT_CONFIGURED',
  'RUNTIME_MISCONFIGURED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_INVALID_RESPONSE',
  'TOOL_ARGUMENT_INVALID',
  'TOOL_DENIED',
  'BUDGET_EXCEEDED',
  'LIMIT_EXCEEDED',
  'EXECUTION_FAILED',
]);
const AGENT_BRIDGE_MODES = new Set(['local', 'external-command', 'process', 'fake']);
const AGENT_ISOLATION_MODES = new Set(['none', 'worktree']);

type ReadContext = Omit<WorkflowRunReadDiagnostic, 'code'>;

function invalidLocalEvidence(context: ReadContext): never {
  throw new WorkflowRunReadError([
    { ...context, code: 'WORKFLOW_PROGRESS_LOCAL_EVIDENCE_INVALID' },
  ]);
}

function recordReadFailure(
  error: unknown,
  context: ReadContext,
  strictRead: boolean,
  diagnostics: WorkflowRunReadDiagnostic[],
): void {
  const failure = asWorkflowRunReadError(error, context);
  if (strictRead) throw failure;
  diagnostics.push(...failure.diagnostics);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 10_000;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function validateRunMeta(value: unknown, runId: string): value is RunMetaFile {
  if (!isRecord(value)) return false;
  const argsValid = (() => {
    try {
      if (value.argsEncoding === WORKFLOW_ARGUMENTS_SCHEMA) {
        validateWorkflowArgumentsEnvelope(value.args);
        return true;
      }
      if (value.argsEncoding !== undefined || !isRecord(value.args)) return false;
      encodeWorkflowArguments(value.args);
      return true;
    } catch {
      return false;
    }
  })();
  return (
    value.runId === runId &&
    isNonEmptyString(value.workflowName) &&
    EXECUTION_MODES.has(value.mode as ExecutionMode) &&
    isNonEmptyString(value.manifestHash) &&
    argsValid &&
    isTimestamp(value.startedAt)
  );
}

function validatePhaseCheckpoint(value: unknown): value is PhaseCheckpoint {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.phase) &&
    isTimestamp(value.timestamp) &&
    PHASE_STATUS_STATES.has(value.status as PhaseCheckpoint['status']) &&
    isOptionalString(value.cacheKey)
  );
}

function validateBudgetWarning(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isTimestamp(value.timestamp) &&
    (value.kind === 'threshold' || value.kind === 'exceeded') &&
    isNonEmptyString(value.message) &&
    isNonNegativeNumber(value.tokensUsed) &&
    isNonNegativeNumber(value.tokenBudget) &&
    isNonNegativeNumber(value.percent) &&
    isOptionalNonNegativeNumber(value.costUsd)
  );
}

function validateRunStatus(value: unknown, runId: string): value is RunStatusFileLike {
  if (!isRecord(value)) return false;
  return (
    value.runId === runId &&
    RUN_STATUS_STATES.has(value.status as RunStatusState) &&
    isTimestamp(value.updatedAt) &&
    isOptionalString(value.currentPhase) &&
    Array.isArray(value.phases) &&
    value.phases.length <= MAX_PROGRESS_ITEMS &&
    value.phases.every(validatePhaseCheckpoint) &&
    (value.controlEvents === undefined ||
      (Array.isArray(value.controlEvents) &&
        value.controlEvents.length <= MAX_PROGRESS_ITEMS &&
        value.controlEvents.every(isRecord))) &&
    (value.budgetWarnings === undefined ||
      (Array.isArray(value.budgetWarnings) &&
        value.budgetWarnings.length <= MAX_PROGRESS_ITEMS &&
        value.budgetWarnings.every(validateBudgetWarning)))
  );
}

function validatePendingApproval(value: unknown): value is PendingApproval {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.operation) &&
    isNonEmptyString(value.detail) &&
    isTimestamp(value.timestamp) &&
    APPROVAL_STATUS_STATES.has(value.status as PendingApproval['status'])
  );
}

function validateLogEntry(value: unknown, runId: string): value is ProgressLogEntry {
  if (!isRecord(value)) return false;
  return (
    value.runId === runId &&
    isTimestamp(value.ts) &&
    isOptionalString(value.phase) &&
    isNonEmptyString(value.message)
  );
}

function validateWorkflowEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.label) &&
    isNonEmptyString(value.phase) &&
    isOptionalString(value.agentRunId) &&
    isOptionalString(value.model) &&
    (value.isolation === undefined || AGENT_ISOLATION_MODES.has(String(value.isolation))) &&
    isOptionalString(value.agentType) &&
    (value.bridgeMode === undefined || AGENT_BRIDGE_MODES.has(String(value.bridgeMode))) &&
    isNonEmptyString(value.promptSummary) &&
    isNonEmptyString(value.promptHash) &&
    isTimestamp(value.startedAt) &&
    (value.completedAt === undefined || isTimestamp(value.completedAt)) &&
    isOptionalNonNegativeNumber(value.tokenUsage) &&
    (value.replayAvailable === undefined || typeof value.replayAvailable === 'boolean') &&
    isOptionalString(value.replayUnavailableReason)
  );
}

function validateAgentResult(value: unknown): value is AgentResult {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'data')) return false;
  return (
    isOptionalNonNegativeNumber(value.tokenUsage) &&
    isOptionalString(value.schemaVersion) &&
    isOptionalString(value.runId) &&
    (value.workflowEvidence === undefined || validateWorkflowEvidence(value.workflowEvidence))
  );
}

function validateAgentRunState(value: unknown, runId: string): value is AgentRunState {
  if (!isRecord(value)) return false;
  const handoff = value.worktreeHandoff;
  return (
    value.runId === runId &&
    AGENT_RUN_STATUS_STATES.has(value.status as AgentRunState['status']) &&
    isNonEmptyString(value.agentId) &&
    isOptionalString(value.model) &&
    isTimestamp(value.startedAt) &&
    (value.completedAt === undefined || isTimestamp(value.completedAt)) &&
    isNonNegativeNumber(value.tokensUsed) &&
    (value.tokensRemaining === null ||
      (typeof value.tokensRemaining === 'number' &&
        Number.isFinite(value.tokensRemaining) &&
        Number.isInteger(value.tokensRemaining))) &&
    isNonNegativeNumber(value.toolCalls) &&
    isOptionalString(value.lastTool) &&
    (value.failureCode === undefined || AGENT_FAILURE_CODES.has(String(value.failureCode))) &&
    isOptionalString(value.errorSummary) &&
    isOptionalString(value.error) &&
    isOptionalString(value.worktreePath) &&
    isNonEmptyString(value.transcriptPath) &&
    (handoff === undefined ||
      (isRecord(handoff) &&
        isNonEmptyString(handoff.worktreePath) &&
        isNonEmptyString(handoff.branchName) &&
        isNonEmptyString(handoff.reason) &&
        isTimestamp(handoff.preservedAt)))
  );
}

function validateAgentRunEvent(value: unknown): value is AgentRunEvent {
  if (!isRecord(value)) return false;
  return (
    isTimestamp(value.timestamp) &&
    AGENT_EVENT_TYPES.has(value.type as AgentRunEvent['type']) &&
    isRecord(value.data)
  );
}

async function readJson<T>(
  path: string,
  label: string,
  context: Omit<WorkflowRunReadDiagnostic, 'code'> = { scope: 'workspace' },
): Promise<ReadResult<T>> {
  try {
    return {
      value: JSON.parse(await readWorkflowEvidenceText(path, MAX_JSON_BYTES, context)) as T | null,
      present: true,
    };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOENT') {
      return { value: null, present: false, warning: `${label} not recorded` };
    }
    return {
      value: null,
      present: true,
      warning: `${label} could not be parsed`,
      failure: asWorkflowRunReadError(err, context),
    };
  }
}

async function readJsonl<T>(
  path: string,
  label: string,
  context: ReadContext,
): Promise<{ values: T[]; warning?: string; failure?: WorkflowRunReadError }> {
  try {
    const raw = await readWorkflowEvidenceText(path, MAX_JSON_BYTES, context);
    const values: T[] = [];
    const lines = raw.split('\n');
    if (lines.length > MAX_JSONL_LINES) {
      return {
        values: [],
        warning: `${label} exceeds the line bound`,
        failure: new WorkflowRunReadError([
          { ...context, code: 'WORKFLOW_PROGRESS_LOCAL_EVIDENCE_INVALID' },
        ]),
      };
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line) as T);
      } catch (cause) {
        return {
          values,
          warning: `${label} contains a malformed JSONL line`,
          failure: new WorkflowRunReadError(
            [{ ...context, code: 'WORKFLOW_PROGRESS_LOCAL_EVIDENCE_INVALID' }],
            { cause },
          ),
        };
      }
    }
    return { values };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOENT') return { values: [], warning: `${label} not recorded` };
    return {
      values: [],
      warning: `${label} could not be read`,
      failure: asWorkflowRunReadError(err, context),
    };
  }
}

function summarize(value: unknown, fallback = 'not recorded'): string {
  if (value === undefined || value === null) return fallback;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return redactString(raw.replace(/\s+/g, ' ').trim()).slice(0, 280) || fallback;
}

function elapsedMs(startedAt?: string, updatedAt?: string): number | undefined {
  if (!startedAt || !updatedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function getPhaseName(checkpoint: PhaseCheckpoint): string {
  return checkpoint.phase;
}

function normalizePhaseStatus(status?: PhaseCheckpoint['status']): WorkflowPhaseProgress['status'] {
  if (status === 'completed' || status === 'failed' || status === 'skipped') return status;
  return 'unknown';
}

function readEvidence(
  result: AgentResult | Record<string, unknown>,
  filename: string,
): WorkflowAgentProgress {
  const agentResult = result as AgentResult;
  const evidence = agentResult.workflowEvidence;
  const tokenUsage =
    typeof agentResult.tokenUsage === 'number'
      ? agentResult.tokenUsage
      : typeof evidence?.tokenUsage === 'number'
        ? evidence.tokenUsage
        : 0;
  const agentRunId =
    typeof agentResult.runId === 'string' ? agentResult.runId : evidence?.agentRunId;
  return {
    id: filename.replace(/\.(json|txt)$/, ''),
    label: evidence?.label ?? 'agent',
    phase: evidence?.phase ?? 'unknown',
    status: 'cached',
    cached: true,
    agentRunId,
    model: evidence?.model,
    bridgeMode: evidence?.bridgeMode,
    isolation: evidence?.isolation,
    promptSummary: redactString(evidence?.promptSummary ?? 'not recorded'),
    resultSummary: summarize(agentResult.data),
    replayAvailable: evidence?.replayAvailable,
    replayUnavailableReason: evidence?.replayUnavailableReason,
    tokensUsed: tokenUsage,
    tokensRemaining: null,
    recentTools: [],
    warnings: evidence ? [] : ['agent workflow evidence not recorded; showing cached result only'],
  };
}

function toolEvidenceFromTranscript(events: AgentRunEvent[]): WorkflowToolEvidence[] {
  return events
    .filter(
      (event) =>
        event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'progress',
    )
    .slice(-8)
    .map((event) => {
      const data = event.data as Record<string, unknown>;
      const name = String(data.tool ?? data.name ?? data.step ?? event.type);
      return {
        type: event.type === 'tool_call' || event.type === 'tool_result' ? event.type : 'progress',
        name,
        timestamp: event.timestamp,
        summary: summarize(data, name),
      };
    });
}

async function readAgentTranscript(
  state: AgentRunState | null,
  agentRunId: string,
  rootDir: string,
  warnings: string[],
  strictRead: boolean,
  context: ReadContext,
  readDiagnostics: WorkflowRunReadDiagnostic[],
): Promise<AgentRunEvent[]> {
  if (!state) return [];
  const transcriptPath = resolve(
    rootDir,
    '.openslack.local',
    'agents',
    'runs',
    agentRunId,
    'transcript.jsonl',
  );
  let raw: string;
  try {
    raw = await readWorkflowEvidenceText(transcriptPath, MAX_TRANSCRIPT_BYTES, context);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordReadFailure(error, context, strictRead, readDiagnostics);
      warnings.push(`agent transcript ${agentRunId} could not be read safely`);
    }
    return [];
  }
  const events: AgentRunEvent[] = [];
  const lines = raw.split('\n');
  if (lines.length > MAX_JSONL_LINES) {
    warnings.push(`agent transcript ${agentRunId} exceeds the line bound`);
    return [];
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as AgentRunEvent;
      if (strictRead && !validateAgentRunEvent(event)) invalidLocalEvidence(context);
      events.push(event);
    } catch {
      if (strictRead) invalidLocalEvidence(context);
      warnings.push(`agent transcript ${agentRunId} contains a malformed JSONL line`);
      return [];
    }
  }
  return events;
}

async function enrichAgent(
  agent: WorkflowAgentProgress,
  rootDir: string,
  warnings: string[],
  strictRead: boolean,
  context: ReadContext,
  readDiagnostics: WorkflowRunReadDiagnostic[],
): Promise<WorkflowAgentProgress> {
  if (!agent.agentRunId) return agent;
  let state: AgentRunState | null = null;
  try {
    state = readRunStateSnapshot(agent.agentRunId, rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordReadFailure(error, context, strictRead, readDiagnostics);
      warnings.push(`agent run state ${agent.agentRunId} could not be read safely`);
    }
    state = null;
  }
  if (!state) return agent;
  if (strictRead && !validateAgentRunState(state, agent.agentRunId)) invalidLocalEvidence(context);
  const transcript = await readAgentTranscript(
    state,
    agent.agentRunId,
    rootDir,
    warnings,
    strictRead,
    context,
    readDiagnostics,
  );
  const complete = [...transcript].reverse().find((event) => event.type === 'complete');
  const fail = [...transcript].reverse().find((event) => event.type === 'fail');
  const cancel = [...transcript].reverse().find((event) => event.type === 'cancel');
  return {
    ...agent,
    status: state.status,
    model: state.model ?? agent.model,
    runtimeProvider: (transcript.find((event) => event.type === 'start')?.data?.runtimeProvider ??
      transcript.find((event) => event.type === 'start')?.data?.provider) as string | undefined,
    worktreePath: state.worktreePath,
    transcriptPath: state.transcriptPath,
    resultSummary: complete
      ? summarize(complete.data?.result, agent.resultSummary)
      : agent.resultSummary,
    terminalReason: String(
      complete?.data?.terminalReason ??
        fail?.data?.failureCode ??
        fail?.data?.errorKind ??
        (cancel ? 'cancelled' : (agent.terminalReason ?? 'not recorded')),
    ),
    tokensUsed: state.tokensUsed || agent.tokensUsed,
    tokensRemaining: state.tokensRemaining,
    recentTools: toolEvidenceFromTranscript(transcript),
    warnings: agent.warnings,
  };
}

async function readAgentResults(
  runDir: string,
  rootDir: string,
  warnings: string[],
  strictRead: boolean,
  context: ReadContext,
  readDiagnostics: WorkflowRunReadDiagnostic[],
): Promise<WorkflowAgentProgress[]> {
  const agentDir = join(runDir, 'agents');
  let before: BigIntStats;
  try {
    before = lstatSync(agentDir, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordReadFailure(error, context, strictRead, readDiagnostics);
      warnings.push('agent result directory could not be read safely');
    }
    return [];
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    recordReadFailure(
      new WorkflowRunReadError([{ ...context, code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' }]),
      context,
      strictRead,
      readDiagnostics,
    );
    warnings.push('agent result directory is not a regular directory');
    return [];
  }
  let handle: ReturnType<typeof opendirSync> | undefined;
  const agents: WorkflowAgentProgress[] = [];
  let seen = 0;
  try {
    handle = opendirSync(agentDir);
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      seen += 1;
      if (seen > MAX_AGENT_RESULT_FILES) {
        warnings.push(`agent result directory exceeds the ${MAX_AGENT_RESULT_FILES} item bound`);
        return [];
      }
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        recordReadFailure(
          new WorkflowRunReadError([{ ...context, code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' }]),
          context,
          strictRead,
          readDiagnostics,
        );
        warnings.push(`agent result ${entry.name} is not a regular file`);
        return [];
      }
      const read = await readJson<AgentResult | Record<string, unknown>>(
        join(agentDir, entry.name),
        `agent result ${entry.name}`,
        context,
      );
      if (read.failure) {
        if (strictRead) throw read.failure;
        readDiagnostics.push(...read.failure.diagnostics);
      }
      if (read.warning) warnings.push(read.warning);
      if (strictRead && read.present && !validateAgentResult(read.value))
        invalidLocalEvidence(context);
      if (!read.value) continue;
      agents.push(
        await enrichAgent(
          readEvidence(read.value, entry.name),
          rootDir,
          warnings,
          strictRead,
          context,
          readDiagnostics,
        ),
      );
    }
  } catch (error) {
    recordReadFailure(error, context, strictRead, readDiagnostics);
    warnings.push('agent results could not be read safely');
    return [];
  } finally {
    handle?.closeSync();
  }
  const after = lstatSync(agentDir, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    recordReadFailure(
      new WorkflowRunReadError([{ ...context, code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED' }]),
      context,
      strictRead,
      readDiagnostics,
    );
    warnings.push('agent result directory changed during read');
    return [];
  }
  return agents;
}

function budgetState(
  tokenBudget: number | null,
  tokensUsed: number,
  threshold: number,
): WorkflowBudgetUsage['status'] {
  if (tokenBudget === null || tokenBudget <= 0) return 'unknown';
  const percent = tokensUsed / tokenBudget;
  if (tokensUsed >= tokenBudget) return 'exceeded';
  if (percent >= threshold) return 'warning';
  return 'ok';
}

function buildCostSummary(
  agents: WorkflowAgentProgress[],
  costConfig: WorkflowCostConfig | null,
): { costEstimateUsd?: number; costSource: WorkflowBudgetUsage['costSource']; warnings: string[] } {
  if (agents.length === 0) {
    return { costSource: 'not-recorded', warnings: [] };
  }
  let total = 0;
  const warnings: string[] = [];
  let knownCount = 0;
  for (const agent of agents) {
    const estimate = estimateWorkflowAgentCost({
      config: costConfig,
      provider: agent.runtimeProvider,
      model: agent.model,
      tokens: agent.tokensUsed,
    });
    if (estimate.known) {
      knownCount += 1;
      total += estimate.estimatedUsd;
    } else {
      warnings.push(estimate.reason);
    }
  }
  if (knownCount === agents.length) {
    return { costEstimateUsd: total, costSource: 'config', warnings };
  }
  return {
    costEstimateUsd: knownCount > 0 ? total : undefined,
    costSource: 'unknown',
    warnings,
  };
}

function buildBudget(
  meta: WorkflowMeta | null,
  agents: WorkflowAgentProgress[],
  status: RunStatusFileLike | null,
  costConfig: WorkflowCostConfig | null,
): WorkflowBudgetUsage {
  const policy = meta?.budgetPolicy;
  const tokensUsed = agents.reduce((sum, agent) => sum + agent.tokensUsed, 0);
  const tokenBudget = policy?.tokenBudget ?? null;
  const threshold = getBudgetWarningThreshold(costConfig);
  const percent = tokenBudget && tokenBudget > 0 ? tokensUsed / tokenBudget : undefined;
  const cost = buildCostSummary(agents, costConfig);
  const warningMessages = [
    ...cost.warnings,
    ...(status?.budgetWarnings ?? []).map((warning) => warning.message),
  ];
  return {
    tokenBudget,
    tokensUsed,
    tokensRemaining: tokenBudget === null ? null : Math.max(0, tokenBudget - tokensUsed),
    costUsd: cost.costEstimateUsd,
    costEstimateUsd: cost.costEstimateUsd,
    costSource: cost.costSource,
    tokenBudgetPercent: percent,
    warningThreshold: threshold,
    status: budgetState(tokenBudget, tokensUsed, threshold),
    warnings: warningMessages,
    agentCalls: agents.length,
    maxAgents: policy?.maxAgents,
    maxConcurrency: policy?.maxConcurrency,
    onExceeded: policy?.onExceeded,
    source: policy ? 'manifest' : agents.length > 0 ? 'agent-results' : 'not-recorded',
  };
}

function groupPhases(
  status: RunStatusFileLike | null,
  meta: WorkflowMeta | null,
  agents: WorkflowAgentProgress[],
): WorkflowPhaseProgress[] {
  const phaseNames = new Set<string>();
  for (const phase of meta?.phases ?? []) phaseNames.add(phase.title);
  for (const checkpoint of status?.phases ?? []) phaseNames.add(getPhaseName(checkpoint));
  for (const agent of agents) phaseNames.add(agent.phase);
  if (phaseNames.size === 0) phaseNames.add(status?.currentPhase ?? 'not recorded');

  return [...phaseNames].map((phase) => {
    const checkpoint = status?.phases?.find((item) => item.phase === phase);
    const phaseAgents = agents.filter((agent) => agent.phase === phase);
    const failedCount = phaseAgents.filter((agent) => agent.status === 'failed').length;
    return {
      phase,
      status: checkpoint
        ? normalizePhaseStatus(checkpoint.status)
        : status?.currentPhase === phase
          ? 'running'
          : 'not-started',
      timestamp: checkpoint?.timestamp,
      agentCount: phaseAgents.length,
      tokenTotal: phaseAgents.reduce((sum, agent) => sum + agent.tokensUsed, 0),
      cachedCount: phaseAgents.filter((agent) => agent.cached).length,
      liveCount: phaseAgents.filter((agent) => agent.status === 'running').length,
      failedCount,
      agents: phaseAgents,
      resultSummary: summarize(checkpoint?.result, undefined),
      warnings: [],
    };
  });
}

export async function loadWorkflowReadModule(rootDir: string, workflowName: string) {
  const { findWorkflow, loadWorkflow } = await import('./loader.js');
  const found = await findWorkflow(workflowName, rootDir);
  if (!found) return null;
  if (!found.path.startsWith('builtin:'))
    await readWorkflowEvidenceText(found.path, MAX_JSON_BYTES);
  return { found, module: await loadWorkflow(found.path) };
}

async function loadWorkflowMeta(
  rootDir: string,
  workflowName?: string,
  context?: WorkflowRunReadContext,
): Promise<WorkflowMeta | null> {
  if (!workflowName) return null;
  try {
    const load = () => loadWorkflowReadModule(rootDir, workflowName);
    return (
      (await (context ? context.memo(`workflow:${workflowName}`, load) : load()))?.module.meta ??
      null
    );
  } catch {
    return null;
  }
}

export async function getWorkflowRunProgress(
  runId: string,
  options: GetWorkflowRunProgressOptions = {},
): Promise<WorkflowRunProgress | null> {
  const rootDir = options.rootDir ?? process.cwd();
  const readContext = options.readContext ?? new WorkflowRunReadContext(rootDir);
  return retryWorkflowRunRead(() =>
    getWorkflowRunProgressOnce(runId, { ...options, rootDir, readContext }),
  );
}

async function getWorkflowRunProgressOnce(
  runId: string,
  options: GetWorkflowRunProgressOptions = {},
): Promise<WorkflowRunProgress | null> {
  const rootDir = options.rootDir ?? process.cwd();
  const readContext = options.readContext ?? new WorkflowRunReadContext(rootDir);
  const location = await locateWorkflowRunProjection(rootDir, runId, {
    readContext,
  });
  if (location.state === 'missing') return null;
  if (location.state !== 'found')
    throw new WorkflowRunReadError(location.diagnostics, { primaryCode: location.primaryCode });
  try {
    return await withWorkflowRunRead(
      runId,
      location,
      () => readLocatedProgress(runId, rootDir, location, { ...options, readContext }),
      readContext,
    );
  } catch (error) {
    throw asWorkflowRunReadError(error, { scope: 'run', runId, backend: location.backend });
  }
}

async function readLocatedProgress(
  runId: string,
  rootDir: string,
  location: Extract<WorkflowRunProjectionLocation, { state: 'found' }>,
  options: GetWorkflowRunProgressOptions,
): Promise<WorkflowRunProgress | null> {
  const { runDir, backend } = location;
  const warnings: string[] = [];
  const context = { scope: 'run' as const, runId, backend };
  const readDiagnostics = [...location.diagnostics];
  const metaRead = await readJson<RunMetaFile>(join(runDir, 'meta.json'), 'run meta', context);
  const statusRead = await readJson<RunStatusFileLike>(
    join(runDir, 'status.json'),
    'run status',
    context,
  );
  if (metaRead.warning) warnings.push(metaRead.warning);
  if (statusRead.warning) warnings.push(statusRead.warning);
  if (!metaRead.present && !statusRead.present) return null;
  for (const value of [metaRead.value, statusRead.value]) {
    if (isRecord(value) && Object.hasOwn(value, 'runId') && value.runId !== runId)
      throw new WorkflowRunReadError([{ ...context, code: 'WORKFLOW_RUN_EVIDENCE_INVALID' }]);
  }
  const failures = [metaRead.failure, statusRead.failure].filter(
    (error): error is WorkflowRunReadError => Boolean(error),
  );
  readDiagnostics.push(...failures.flatMap((error) => error.diagnostics));
  if (failures.length && (options.strictRead || (!metaRead.value && !statusRead.value)))
    throw new WorkflowRunReadError(readDiagnostics, { cause: failures[0] });
  if (
    options.strictRead &&
    (!validateRunMeta(metaRead.value, runId) || !validateRunStatus(statusRead.value, runId))
  ) {
    invalidLocalEvidence(context);
  }
  if (!metaRead.value && !statusRead.value)
    throw new WorkflowRunReadError([
      {
        scope: 'run',
        runId,
        backend,
        code: 'WORKFLOW_RUN_EVIDENCE_INVALID',
      },
    ]);

  const pendingRead = await readJson<PendingApproval[]>(
    join(runDir, 'pending-approvals.json'),
    'pending approvals',
    context,
  );
  if (pendingRead.failure) {
    if (options.strictRead) throw pendingRead.failure;
    readDiagnostics.push(...pendingRead.failure.diagnostics);
  }
  if (pendingRead.warning && pendingRead.warning !== 'pending approvals not recorded')
    warnings.push(pendingRead.warning);
  if (
    pendingRead.value &&
    (!Array.isArray(pendingRead.value) || pendingRead.value.length > MAX_PROGRESS_ITEMS)
  ) {
    pendingRead.value = null;
    warnings.push('pending approvals exceed the safe item bound');
  }
  if (
    options.strictRead &&
    pendingRead.present &&
    (!Array.isArray(pendingRead.value) || !pendingRead.value.every(validatePendingApproval))
  ) {
    invalidLocalEvidence(context);
  }
  const logRead = await readJsonl<ProgressLogEntry>(
    join(runDir, 'log.jsonl'),
    'workflow log',
    context,
  );
  if (logRead.failure) {
    if (options.strictRead) throw logRead.failure;
    readDiagnostics.push(...logRead.failure.diagnostics);
  }
  if (logRead.warning && logRead.warning !== 'workflow log not recorded')
    warnings.push(logRead.warning);
  if (options.strictRead && !logRead.values.every((entry) => validateLogEntry(entry, runId))) {
    invalidLocalEvidence(context);
  }
  const outputRead = await readJson<unknown>(
    join(runDir, 'output.json'),
    'workflow output',
    context,
  );
  if (outputRead.failure) {
    if (options.strictRead) throw outputRead.failure;
    readDiagnostics.push(...outputRead.failure.diagnostics);
  }
  if (outputRead.warning && outputRead.warning !== 'workflow output not recorded')
    warnings.push(outputRead.warning);
  if (
    statusRead.value?.phases &&
    (!Array.isArray(statusRead.value.phases) || statusRead.value.phases.length > MAX_PROGRESS_ITEMS)
  ) {
    statusRead.value.phases = [];
    warnings.push('workflow phases exceed the safe item bound');
  }
  if (
    statusRead.value?.budgetWarnings &&
    (!Array.isArray(statusRead.value.budgetWarnings) ||
      statusRead.value.budgetWarnings.length > MAX_PROGRESS_ITEMS)
  ) {
    statusRead.value.budgetWarnings = [];
    warnings.push('workflow budget warnings exceed the safe item bound');
  }

  const workflowName = metaRead.value?.workflowName ?? 'not recorded';
  const workflowMeta =
    options.loadWorkflowManifest === false
      ? null
      : await loadWorkflowMeta(rootDir, metaRead.value?.workflowName, options.readContext);
  const agents = await readAgentResults(
    runDir,
    rootDir,
    warnings,
    options.strictRead === true,
    context,
    readDiagnostics,
  );
  const phases = groupPhases(statusRead.value, workflowMeta, agents);
  const costPath = resolve(rootDir, '.openslack', 'workflows', 'cost.yaml');
  const costConfig =
    options.loadCostConfig === false
      ? null
      : await options
          .readContext!.memo('cost-config', async () => {
            if (!existsSync(costPath)) return null;
            const raw = await readWorkflowEvidenceText(costPath, MAX_JSON_BYTES);
            return parseWorkflowCostConfig(raw);
          })
          .catch(() => {
            warnings.push('workflow cost config could not be loaded safely');
            return null;
          });
  const budget = buildBudget(workflowMeta, agents, statusRead.value, costConfig);
  let externalArgs = encodeWorkflowArguments({}).envelope;
  if (metaRead.value) {
    try {
      externalArgs =
        metaRead.value.argsEncoding === WORKFLOW_ARGUMENTS_SCHEMA
          ? validateWorkflowArgumentsEnvelope(metaRead.value.args)
          : encodeWorkflowArguments(metaRead.value.args as Record<string, unknown>).envelope;
    } catch {
      warnings.push('workflow arguments could not be normalized');
    }
  }
  if (options.strictRead && warnings.length > 0) {
    invalidLocalEvidence(context);
  }
  warnings.push(...location.diagnostics.map(renderWorkflowRunReadDiagnostic));
  if (backend === 'go') {
    warnings.push(
      'Go recovery projection: local snapshot only; inspect Workflow Control for the authoritative head.',
    );
  }

  const startedAt = metaRead.value?.startedAt;
  const updatedAt = statusRead.value?.updatedAt;
  return {
    runId,
    workflowName,
    provenance: location.provenance,
    degraded: location.degraded || warnings.length > 0,
    readDiagnostics,
    mode: metaRead.value?.mode ?? 'not-recorded',
    status: statusRead.value?.status ?? 'not-recorded',
    startedAt,
    updatedAt,
    elapsedMs: elapsedMs(startedAt, updatedAt),
    currentPhase: statusRead.value?.currentPhase,
    argsEncoding: WORKFLOW_ARGUMENTS_SCHEMA,
    args: externalArgs,
    phaseCount: phases.length,
    agentCount: agents.length,
    pendingApprovalCount: (pendingRead.value ?? []).filter(
      (approval) => approval.status === 'pending',
    ).length,
    budget,
    phases,
    outputSummary: outputRead.value === null ? undefined : summarize(outputRead.value),
    logTail: logRead.values
      .slice(-8)
      .map(
        (entry) =>
          `${entry.ts} ${entry.phase ? `[${entry.phase}] ` : ''}${redactString(entry.message)}`,
      ),
    warnings,
  };
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return 'not recorded';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds % 60}s`;
}

export function renderWorkflowRunProgress(progress: WorkflowRunProgress): string {
  const lines: string[] = [];
  lines.push(`Run: ${progress.runId}`);
  lines.push(`Workflow: ${progress.workflowName}`);
  lines.push(`Status: ${progress.status}`);
  lines.push(`Mode: ${progress.mode}`);
  lines.push(`Current phase: ${progress.currentPhase ?? 'not recorded'}`);
  lines.push(`Elapsed: ${formatDuration(progress.elapsedMs)}`);
  lines.push(`Agents: ${progress.agentCount}`);
  lines.push(`Pending approvals: ${progress.pendingApprovalCount}`);
  const budgetPercent =
    progress.budget.tokenBudgetPercent === undefined
      ? 'n/a'
      : `${Math.round(progress.budget.tokenBudgetPercent * 100)}%`;
  const cost =
    progress.budget.costEstimateUsd === undefined
      ? 'unknown'
      : `$${progress.budget.costEstimateUsd.toFixed(6)}`;
  lines.push(
    `Budget: ${progress.budget.tokensUsed}/${progress.budget.tokenBudget ?? 'unlimited'} tokens, remaining ${progress.budget.tokensRemaining ?? 'unlimited'}, ${budgetPercent}, ${progress.budget.status}, cost ${cost} (${progress.budget.costSource})`,
  );
  for (const warning of progress.budget.warnings.slice(-3))
    lines.push(`  budget warning: ${warning}`);
  lines.push('');
  lines.push('Phases:');
  for (const phase of progress.phases) {
    lines.push(
      `  - ${phase.phase}: ${phase.status}, agents ${phase.agentCount}, tokens ${phase.tokenTotal}`,
    );
    for (const agent of phase.agents) {
      lines.push(
        `      ${agent.label}: ${agent.status}, model ${agent.model ?? 'not recorded'}, isolation ${agent.isolation ?? 'not recorded'}, tokens ${agent.tokensUsed}`,
      );
      lines.push(`        prompt: ${agent.promptSummary}`);
      if (agent.transcriptPath) lines.push(`        transcript: ${agent.transcriptPath}`);
      if (agent.resultSummary) lines.push(`        result: ${agent.resultSummary}`);
      for (const tool of agent.recentTools.slice(-3))
        lines.push(`        tool: ${tool.name} (${tool.type}) ${tool.summary}`);
    }
  }
  if (progress.outputSummary) {
    lines.push('');
    lines.push(`Output: ${progress.outputSummary}`);
  }
  if (progress.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of progress.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join('\n');
}
