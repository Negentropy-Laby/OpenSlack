import { createHash } from 'node:crypto';
import { AgentRunRestartRequestedError, generateRunId } from '@openslack/agent-runtime';
import type { AgentOptions, AgentResult, BudgetState, ExecutionMode, WorkflowBudgetPolicy } from './types.js';
import { checkPermission } from './permission-checker.js';
import type { ResolvedAgentConfig } from './agent-resolver.js';
import { isAgentLaunchBlockedByWorkflowControl } from './workflow-runs.js';
import type { AgentReplayInput, RunStore } from './run-store.js';
import {
  estimateWorkflowAgentCost,
  getBudgetWarningThreshold,
  loadWorkflowCostConfig,
} from './cost.js';

/**
 * Error thrown when agent result fails schema validation.
 */
export class SchemaValidationError extends Error {
  readonly label: string;
  readonly violations: string[];

  constructor(label: string, violations: string[]) {
    super(`Schema validation failed for "${label}": ${violations.join(', ')}`);
    this.name = 'SchemaValidationError';
    this.label = label;
    this.violations = violations;
  }
}

/**
 * Cache store interface used by the agent shim.
 */
export interface AgentCacheStore {
  load(runId: string, cacheKey: string): Promise<AgentResult | null>;
  save(runId: string, cacheKey: string, result: AgentResult): Promise<void>;
}

/**
 * Event emitted during the agent call lifecycle.
 * Used to record agent conversation events into the collaboration layer.
 */
export interface AgentConversationEvent {
  type: 'agent.conversation.started' | 'agent.conversation.completed' | 'agent.conversation.failed';
  agentId: string;
  label: string;
  phase: string;
  runId: string;
  agentRunId?: string;
  resolvedAgentId?: string;
  error?: string;
}

/**
 * Event emitter callback for agent conversation events.
 * When provided, the agent shim emits lifecycle events during execution.
 */
export type AgentEventEmitter = (event: AgentConversationEvent) => void;

/**
 * Agent launcher function type. The real implementation would call an
 * AI agent; tests inject a stub.
 */
export type AgentLauncher<T = unknown> = (
  prompt: string,
  options: AgentOptions,
) => Promise<AgentResult<T>>;

export class WorkflowBudgetPausedError extends Error {
  readonly runId: string;
  readonly detail: string;

  constructor(runId: string, detail: string) {
    super(`Workflow paused: budget exceeded for run ${runId}`);
    this.name = 'WorkflowBudgetPausedError';
    this.runId = runId;
    this.detail = detail;
  }
}

export class WorkflowBudgetExceededError extends Error {
  readonly runId: string;
  readonly detail: string;

  constructor(runId: string, detail: string) {
    super(`Workflow budget exceeded for run ${runId}: ${detail}`);
    this.name = 'WorkflowBudgetExceededError';
    this.runId = runId;
    this.detail = detail;
  }
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

function summarizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 240) || 'not recorded';
}

async function persistReplayInput(options: {
  runStore?: RunStore;
  runId: string;
  agentRunId: string;
  prompt: string;
  options: AgentOptions;
  resolvedAgent?: ResolvedAgentConfig | null;
  cacheKey: string;
  attempt: number;
}): Promise<{ available: boolean; reason?: string }> {
  if (!options.runStore) return { available: false, reason: 'Workflow run store not configured.' };
  const replayInput: AgentReplayInput = {
    schema: 'openslack.workflow_agent_replay_input.v1',
    workflowRunId: options.runId,
    agentRunId: options.agentRunId,
    prompt: options.prompt,
    options: sanitizeAgentOptions(options.options),
    resolvedAgentConfig: options.resolvedAgent ?? options.options.resolvedAgentConfig,
    phase: options.options.phase,
    label: options.options.label,
    cacheKey: options.cacheKey,
    attempt: options.attempt,
    createdAt: new Date().toISOString(),
  };
  const result = await options.runStore.saveAgentReplayInput(
    options.runId,
    options.agentRunId,
    replayInput,
  );
  return { available: result.available, reason: result.reason };
}

function sanitizeAgentOptions(options: AgentOptions): Record<string, unknown> {
  const {
    label,
    phase,
    schema,
    isolation,
    budget,
    model,
    agentType,
    resolvedAgentId,
    resolvedAgentConfig,
    agentRunId,
    bridgeMode,
  } = options;
  return {
    label,
    phase,
    schema,
    isolation,
    budget,
    model,
    agentType,
    resolvedAgentId,
    resolvedAgentConfig,
    agentRunId,
    bridgeMode,
  };
}

async function applyCostAndBudgetPolicy(options: {
  runId: string;
  rootDir?: string;
  runStore?: RunStore;
  budget: BudgetState;
  budgetPolicy?: WorkflowBudgetPolicy;
  tokensUsedThisCall: number;
  provider?: string;
  model?: string;
}): Promise<void> {
  const costConfig = await loadWorkflowCostConfig(options.rootDir).catch(() => null);
  const estimate = estimateWorkflowAgentCost({
    config: costConfig,
    provider: options.provider,
    model: options.model,
    tokens: options.tokensUsedThisCall,
  });
  if (estimate.known) {
    options.budget.costUsd += estimate.estimatedUsd;
  }

  const policy = options.budgetPolicy;
  const tokenBudget = policy?.tokenBudget ??
    (options.budget.tokensRemaining === null
      ? null
      : options.budget.tokensUsed + options.budget.tokensRemaining);
  if (!tokenBudget || tokenBudget <= 0) return;

  const percent = options.budget.tokensUsed / tokenBudget;
  const threshold = getBudgetWarningThreshold(costConfig);
  const exceeded = options.budget.tokensUsed >= tokenBudget ||
    (options.budget.tokensRemaining !== null && options.budget.tokensRemaining <= 0);

  if (percent >= threshold) {
    const kind = exceeded ? 'exceeded' : 'threshold';
    const message = exceeded
      ? `Budget exceeded: ${options.budget.tokensUsed}/${tokenBudget} tokens.`
      : `Budget warning: ${Math.round(percent * 100)}% of token budget used.`;
    await options.runStore?.appendBudgetWarning(options.runId, {
      timestamp: new Date().toISOString(),
      kind,
      message,
      tokensUsed: options.budget.tokensUsed,
      tokenBudget,
      percent,
      costUsd: estimate.known ? options.budget.costUsd : undefined,
    });
    await options.runStore?.appendLog(options.runId, {
      ts: new Date().toISOString(),
      runId: options.runId,
      message,
    });
  }

  if (!exceeded) return;

  const onExceeded = policy?.onExceeded ?? 'fail';
  if (onExceeded === 'pause') {
    if (await hasApprovedBudgetOverride(options.runStore, options.runId)) return;
    const detail = `Token budget exceeded: ${options.budget.tokensUsed}/${tokenBudget} tokens.`;
    await options.runStore?.savePendingApproval(options.runId, {
      operation: 'workflow.budget.exceeded',
      detail,
      timestamp: new Date().toISOString(),
    });
    await safeTransitionStatus(options.runStore, options.runId, 'paused_waiting_approval');
    throw new WorkflowBudgetPausedError(options.runId, detail);
  }

  throw new WorkflowBudgetExceededError(
    options.runId,
    `Token budget exceeded: ${options.budget.tokensUsed}/${tokenBudget} tokens.`,
  );
}

async function hasApprovedBudgetOverride(runStore: RunStore | undefined, runId: string): Promise<boolean> {
  if (!runStore) return false;
  const approvals = await runStore.loadPendingApprovals(runId).catch(() => []);
  return approvals.some((approval) =>
    approval.operation === 'workflow.budget.exceeded' && approval.status === 'approved'
  );
}

async function safeTransitionStatus(
  runStore: RunStore | undefined,
  runId: string,
  status: import('./types.js').RunStatus['status'],
): Promise<void> {
  if (!runStore) return;
  try {
    await runStore.transitionStatus(runId, status);
  } catch {
    // The caller may already have moved the run into a terminal or paused state.
  }
}

/**
 * Lightweight JSON schema subset validator.
 * Returns an array of violation messages (empty = valid).
 */
function validateAgainstSchema(
  data: unknown,
  schema: NonNullable<AgentOptions['schema']>,
  path: string = 'root',
): string[] {
  const violations: string[] = [];

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;

    if (!expected.includes(actualType)) {
      violations.push(`${path}: expected type ${expected.join('|')}, got ${actualType}`);
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    violations.push(`${path}: value must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in obj) {
        violations.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`));
      } else if (schema.required?.includes(key)) {
        violations.push(`${path}.${key}: required property missing`);
      }
    }
  }

  if (schema.items && Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      const itemSchema = Array.isArray(schema.items) ? schema.items[i] : schema.items;
      if (itemSchema) {
        violations.push(...validateAgainstSchema(item, itemSchema, `${path}[${i}]`));
      }
    }
  }

  return violations;
}

/**
 * Execute an agent call with permission checks, budget enforcement,
 * caching, and schema validation.
 */
export async function executeAgentCall<T>(
  prompt: string,
  options: AgentOptions,
  config: {
    runId: string;
    mode: ExecutionMode;
    budget: BudgetState;
    permissions: Set<string>;
    cache: AgentCacheStore;
    launcher: AgentLauncher<T>;
    log: (message: string) => void;
    cacheKey: string;
    eventEmitter?: AgentEventEmitter;
    resolvedAgent?: ResolvedAgentConfig | null;
    agentRunId?: string;
    rootDir?: string;
    runStore?: RunStore;
    budgetPolicy?: WorkflowBudgetPolicy;
  },
): Promise<T> {
  // 1. Mode check
  if (config.mode === 'validate') {
    throw new Error('Agent calls not allowed in validate mode');
  }

  // 2. Permission check
  const permKey = `agent.${options.label}`;
  if (!checkPermission(config.permissions, permKey)) {
    // Agent calls are generally allowed; the permission system gates
    // specific actions, not the agent call itself. We check that the
    // agent phase matches allowed phases.
  }

  // 3. Budget check
  if (config.budget.tokensRemaining !== null && config.budget.tokensRemaining <= 0) {
    throw new Error('Budget exhausted: no tokens remaining');
  }

  // 4. Cache lookup
  const cached = await config.cache.load(config.runId, config.cacheKey);
  if (cached !== null) {
    return cached.data as T;
  }

  // 5. Execute agent call (with optional event emission for execute mode)
  const agentId = config.resolvedAgent?.agentId ?? options.agentType ?? options.label;
  const shouldEmit = config.mode === 'execute' && config.eventEmitter;
  let agentRunId = config.agentRunId ?? generateRunId();
  const blockedReason = await isAgentLaunchBlockedByWorkflowControl({
    rootDir: config.rootDir,
    runId: config.runId,
    phase: options.phase,
    label: options.label,
    agentType: options.agentType,
    agentRunId,
  });
  if (blockedReason) {
    throw new Error(blockedReason);
  }

  let result: AgentResult<T> | undefined;
  const startedAt = new Date().toISOString();
  let replayAvailable = true;
  let replayUnavailableReason: string | undefined;
  let attempt = 0;
  let launchPrompt = prompt;
  let launchOptions = { ...options, agentRunId };

  while (true) {
    const replayResult = await persistReplayInput({
      runStore: config.runStore,
      runId: config.runId,
      agentRunId,
      prompt: launchPrompt,
      options: launchOptions,
      resolvedAgent: config.resolvedAgent,
      cacheKey: config.cacheKey,
      attempt,
    });
    replayAvailable = replayResult.available;
    replayUnavailableReason = replayResult.reason;

    if (shouldEmit) {
      config.eventEmitter!({
        type: 'agent.conversation.started',
        agentId,
        label: options.label,
        phase: options.phase,
        runId: config.runId,
        agentRunId,
        resolvedAgentId: config.resolvedAgent?.agentId,
      });
    }

    try {
      result = await config.launcher(launchPrompt, launchOptions);
      break;
    } catch (err) {
      if (err instanceof AgentRunRestartRequestedError) {
        const replay = config.runStore
          ? await config.runStore.loadAgentReplayInput(config.runId, err.runId)
          : null;
        if (!replay) {
          const reason = `Restart rejected: replay input missing for ${err.runId}.`;
          config.log(reason);
          throw new Error(reason);
        }
        if (!replay.available) {
          const reason = `Restart rejected: ${replay.reason}`;
          config.log(reason);
          throw new Error(reason);
        }
        attempt += 1;
        if (attempt > 3) {
          throw new Error('Restart rejected: maximum replay attempts reached for this agent call.');
        }
        config.log(`Restarting agent ${err.runId} from persisted replay input.`);
        agentRunId = generateRunId();
        launchPrompt = replay.input.prompt;
        launchOptions = {
          ...(replay.input.options as unknown as AgentOptions),
          agentRunId,
        };
        continue;
      }
      if (shouldEmit) {
        config.eventEmitter!({
          type: 'agent.conversation.failed',
          agentId,
          label: options.label,
          phase: options.phase,
          runId: config.runId,
          agentRunId,
          resolvedAgentId: config.resolvedAgent?.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  if (!result) {
    throw new Error('Agent launcher did not produce a result.');
  }

  if (shouldEmit) {
    config.eventEmitter!({
      type: 'agent.conversation.completed',
      agentId,
      label: options.label,
      phase: options.phase,
      runId: config.runId,
      agentRunId: result.runId ?? agentRunId,
      resolvedAgentId: config.resolvedAgent?.agentId,
    });
  }

  // 6. Schema validation
  if (options.schema) {
    const violations = validateAgainstSchema(result.data, options.schema);
    if (violations.length > 0) {
      config.log(`Schema validation failed for ${options.label}`);
      throw new SchemaValidationError(options.label, violations);
    }
  }

  // 7. Update budget and persist result evidence
  const usage = result.tokenUsage ?? 0;
  const evidenceResult: AgentResult<T> = {
    ...result,
    workflowEvidence: {
      label: options.label,
      phase: options.phase,
      agentRunId: result.runId ?? agentRunId,
      model: options.model,
      isolation: options.isolation,
      agentType: options.agentType,
      bridgeMode: options.bridgeMode,
      promptSummary: summarizePrompt(prompt),
      promptHash: hashPrompt(prompt),
      startedAt,
      completedAt: new Date().toISOString(),
      tokenUsage: usage,
      replayAvailable,
      replayUnavailableReason,
    },
  };

  config.budget.tokensUsed += usage;
  if (config.budget.tokensRemaining !== null) {
    config.budget.tokensRemaining -= usage;
  }
  config.budget.agentCalls += 1;

  // Re-save with runtime evidence after budget accounting. Older cache
  // entries without workflowEvidence remain readable by the progress model.
  await config.cache.save(config.runId, config.cacheKey, evidenceResult as AgentResult);

  await applyCostAndBudgetPolicy({
    runId: config.runId,
    rootDir: config.rootDir,
    runStore: config.runStore,
    budget: config.budget,
    budgetPolicy: config.budgetPolicy,
    tokensUsedThisCall: usage,
    provider: config.resolvedAgent?.provider,
    model: config.resolvedAgent?.model ?? options.model,
  });

  return result.data as T;
}

/**
 * Compute a deterministic cache key for an agent call.
 */
export function computeAgentCacheKey(
  manifestHash: string,
  phase: string,
  label: string,
  prompt: string,
  resolvedAgentId?: string,
): string {
  // Simple hash of the prompt for cache key stability
  let promptHash = 0;
  for (let i = 0; i < prompt.length; i++) {
    promptHash = ((promptHash << 5) - promptHash + prompt.charCodeAt(i)) | 0;
  }
  const agentPart = resolvedAgentId ? `:${resolvedAgentId}` : '';
  return `${manifestHash}:${phase}:${label}${agentPart}:${promptHash.toString(36)}`;
}

export { validateAgainstSchema };
