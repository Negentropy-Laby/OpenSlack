import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRunStore, type AgentRunEvent, type AgentRunState } from '@openslack/agent-runtime';
import { redactString } from './redact.js';
import {
  estimateWorkflowAgentCost,
  getBudgetWarningThreshold,
  loadWorkflowCostConfig,
  type WorkflowCostConfig,
} from './cost.js';
import type { BudgetWarning } from './run-store.js';
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
  manifestHash?: string;
  args?: Record<string, unknown>;
  startedAt?: string;
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
  warning?: string;
}

export interface GetWorkflowRunProgressOptions {
  rootDir?: string;
}

function workflowsRunDir(rootDir: string, runId: string): string {
  return resolve(rootDir, '.openslack.local', 'workflows', 'runs', runId);
}

async function readJson<T>(path: string, label: string): Promise<ReadResult<T>> {
  try {
    return { value: JSON.parse(await readFile(path, 'utf-8')) as T };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOENT') return { value: null, warning: `${label} not recorded` };
    return { value: null, warning: `${label} could not be parsed` };
  }
}

async function readJsonl<T>(
  path: string,
  label: string,
): Promise<{ values: T[]; warning?: string }> {
  try {
    const raw = await readFile(path, 'utf-8');
    const values: T[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line) as T);
      } catch {
        return { values, warning: `${label} contains a malformed JSONL line` };
      }
    }
    return { values };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOENT') return { values: [], warning: `${label} not recorded` };
    return { values: [], warning: `${label} could not be read` };
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

function readAgentTranscript(state: AgentRunState | null): AgentRunEvent[] {
  if (!state?.transcriptPath || !existsSync(state.transcriptPath)) return [];
  const raw = readFileSync(state.transcriptPath, 'utf-8');
  const events: AgentRunEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AgentRunEvent);
    } catch {
      break;
    }
  }
  return events;
}

function enrichAgent(agent: WorkflowAgentProgress, rootDir: string): WorkflowAgentProgress {
  if (!agent.agentRunId) return agent;
  let state: AgentRunState | null = null;
  try {
    state = createRunStore(rootDir).getRun(agent.agentRunId);
  } catch {
    state = null;
  }
  if (!state) return agent;
  const transcript = readAgentTranscript(state);
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
): Promise<WorkflowAgentProgress[]> {
  const agentDir = join(runDir, 'agents');
  let files: string[] = [];
  try {
    files = await readdir(agentDir);
  } catch {
    return [];
  }
  const agents: WorkflowAgentProgress[] = [];
  for (const file of files.filter((entry) => entry.endsWith('.json'))) {
    const read = await readJson<AgentResult | Record<string, unknown>>(
      join(agentDir, file),
      `agent result ${file}`,
    );
    if (read.warning) warnings.push(read.warning);
    if (!read.value) continue;
    agents.push(enrichAgent(readEvidence(read.value, file), rootDir));
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

async function loadWorkflowMeta(
  rootDir: string,
  workflowName?: string,
): Promise<WorkflowMeta | null> {
  if (!workflowName) return null;
  try {
    const { findWorkflow, loadWorkflow } = await import('./loader.js');
    const found = await findWorkflow(workflowName, rootDir);
    if (!found) return null;
    return (await loadWorkflow(found.path)).meta;
  } catch {
    return null;
  }
}

export async function getWorkflowRunProgress(
  runId: string,
  options: GetWorkflowRunProgressOptions = {},
): Promise<WorkflowRunProgress | null> {
  const rootDir = options.rootDir ?? process.cwd();
  const runDir = workflowsRunDir(rootDir, runId);
  const warnings: string[] = [];
  const metaRead = await readJson<RunMetaFile>(join(runDir, 'meta.json'), 'run meta');
  const statusRead = await readJson<RunStatusFileLike>(join(runDir, 'status.json'), 'run status');
  if (metaRead.warning) warnings.push(metaRead.warning);
  if (statusRead.warning) warnings.push(statusRead.warning);
  if (!metaRead.value && !statusRead.value) return null;

  const pendingRead = await readJson<PendingApproval[]>(
    join(runDir, 'pending-approvals.json'),
    'pending approvals',
  );
  if (pendingRead.warning && pendingRead.warning !== 'pending approvals not recorded')
    warnings.push(pendingRead.warning);
  const logRead = await readJsonl<ProgressLogEntry>(join(runDir, 'log.jsonl'), 'workflow log');
  if (logRead.warning && logRead.warning !== 'workflow log not recorded')
    warnings.push(logRead.warning);
  const outputRead = await readJson<unknown>(join(runDir, 'output.json'), 'workflow output');
  if (outputRead.warning && outputRead.warning !== 'workflow output not recorded')
    warnings.push(outputRead.warning);

  const workflowName = metaRead.value?.workflowName ?? 'not recorded';
  const workflowMeta = await loadWorkflowMeta(rootDir, metaRead.value?.workflowName);
  const agents = await readAgentResults(runDir, rootDir, warnings);
  const phases = groupPhases(statusRead.value, workflowMeta, agents);
  const costConfig = await loadWorkflowCostConfig(rootDir).catch((err) => {
    warnings.push(
      `workflow cost config could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  const budget = buildBudget(workflowMeta, agents, statusRead.value, costConfig);

  const startedAt = metaRead.value?.startedAt;
  const updatedAt = statusRead.value?.updatedAt;
  return {
    runId,
    workflowName,
    mode: metaRead.value?.mode ?? 'not-recorded',
    status: statusRead.value?.status ?? 'not-recorded',
    startedAt,
    updatedAt,
    elapsedMs: elapsedMs(startedAt, updatedAt),
    currentPhase: statusRead.value?.currentPhase,
    args: metaRead.value?.args ?? {},
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
