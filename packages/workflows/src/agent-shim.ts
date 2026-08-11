import { createHash } from 'node:crypto';
import {
  AgentBudgetExceededError,
  AgentRunRestartRequestedError,
  generateRunId,
  getAgentRunFailureSummary,
  requestAgentRunCancellation,
  redactSensitiveText,
} from '@openslack/agent-runtime';
import type {
  AgentOptions,
  AgentResult,
  BudgetState,
  ExecutionMode,
  WorkflowBudgetPolicy,
} from './types.js';
import { checkPermission } from './permission-checker.js';
import type { ResolvedAgentConfig } from './agent-resolver.js';
import { isAgentLaunchBlockedByWorkflowControl } from './workflow-runs.js';
import type { AgentReplayInput, RunStore } from './run-store.js';
import {
  estimateWorkflowAgentCost,
  getBudgetWarningThreshold,
  loadWorkflowCostConfig,
  type WorkflowCostConfig,
} from './cost.js';
import { captureFailure, throwWithSuppressed } from './internal/suppressed-errors.js';

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
export interface AgentLauncher<T = unknown> {
  (prompt: string, options: AgentOptions): Promise<AgentResult<T>>;
  /** Fail-closed runtime validation performed before cache lookup. */
  preflight?: (prompt: string, options: AgentOptions) => Promise<void>;
}

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
    resolvedAgentConfig: sanitizeResolvedAgentConfig(
      options.resolvedAgent ?? options.options.resolvedAgentConfig,
    ),
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
    resolvedAgentConfig: sanitizeResolvedAgentConfig(resolvedAgentConfig),
    agentRunId,
    bridgeMode,
  };
}

function sanitizeResolvedAgentConfig(
  config: ResolvedAgentConfig | undefined | null,
): ResolvedAgentConfig | undefined {
  if (!config) return undefined;
  const safe = { ...config };
  delete safe.prompt;
  delete safe.initialPrompt;
  delete safe.criticalSystemReminder;
  return safe;
}

type BudgetPolicyDecision =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'pause' | 'fail';
      readonly error: WorkflowBudgetPausedError | WorkflowBudgetExceededError;
    };

interface AgentCallExecutionConfig {
  runId: string;
  mode: ExecutionMode;
  budget: BudgetState;
  permissions: Set<string>;
  cache: AgentCacheStore;
  launcher: AgentLauncher<unknown>;
  log: (message: string) => void;
  cacheKey: string;
  eventEmitter?: AgentEventEmitter;
  resolvedAgent?: ResolvedAgentConfig | null;
  agentRunId?: string;
  rootDir?: string;
  runStore?: RunStore;
  budgetPolicy?: WorkflowBudgetPolicy;
  onBudgetChange?: (budget: BudgetState) => Promise<void>;
  loadCostConfig?: () => Promise<WorkflowCostConfig | null>;
  signal?: AbortSignal;
}

async function applyCostAndBudgetPolicy(options: {
  runId: string;
  runStore?: RunStore;
  budget: BudgetState;
  budgetPolicy?: WorkflowBudgetPolicy;
  tokensUsedThisCall: number;
  provider?: string;
  model?: string;
  costConfig: WorkflowCostConfig | null;
}): Promise<BudgetPolicyDecision> {
  const costConfig = options.costConfig;
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
  const tokenBudget =
    policy?.tokenBudget ??
    (options.budget.tokensRemaining === null
      ? null
      : options.budget.tokensUsed + options.budget.tokensRemaining);
  if (!tokenBudget || tokenBudget <= 0) return { kind: 'continue' };

  const percent = options.budget.tokensUsed / tokenBudget;
  const threshold = getBudgetWarningThreshold(costConfig);
  const exceeded =
    options.budget.tokensUsed >= tokenBudget ||
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

  if (!exceeded) return { kind: 'continue' };

  if (await hasApprovedBudgetOverride(options.runStore, options.runId)) {
    return { kind: 'continue' };
  }

  const onExceeded = policy?.onExceeded ?? 'fail';
  if (onExceeded === 'pause') {
    const detail = `Token budget exceeded: ${options.budget.tokensUsed}/${tokenBudget} tokens.`;
    return { kind: 'pause', error: new WorkflowBudgetPausedError(options.runId, detail) };
  }

  return {
    kind: 'fail',
    error: new WorkflowBudgetExceededError(
      options.runId,
      `Token budget exceeded: ${options.budget.tokensUsed}/${tokenBudget} tokens.`,
    ),
  };
}

async function hasApprovedBudgetOverride(
  runStore: RunStore | undefined,
  runId: string,
): Promise<boolean> {
  if (!runStore) return false;
  const approvals = await runStore.loadPendingApprovals(runId).catch(() => []);
  return approvals.some(
    (approval) =>
      approval.operation === 'workflow.budget.exceeded' && approval.status === 'approved',
  );
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
  config: Omit<AgentCallExecutionConfig, 'launcher'> & { launcher: AgentLauncher<T> },
): Promise<T> {
  const throwIfAborted = (): void => {
    if (!config.signal?.aborted) return;
    throw config.signal.reason instanceof Error
      ? config.signal.reason
      : new Error('Workflow agent call cancelled.');
  };
  throwIfAborted();
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

  // 3. Budget check. An independently approved pause override permits a new
  // attempt to overdraw the original limit; an unapproved exhausted run still
  // fails before provider preflight or cache lookup.
  const approvedBudgetOverride =
    config.budget.tokensRemaining !== null && config.budget.tokensRemaining <= 0
      ? await hasApprovedBudgetOverride(config.runStore, config.runId)
      : false;
  if (
    config.budget.tokensRemaining !== null &&
    config.budget.tokensRemaining <= 0 &&
    !approvedBudgetOverride
  ) {
    throw new AgentBudgetExceededError();
  }

  // 4. Provider preflight. Production launchers validate before cache lookup so
  // stale fixture/cache data cannot make an unconfigured runtime look ready.
  const providerPrompt = redactSensitiveText(prompt).value;
  let agentRunId = config.agentRunId ?? generateRunId();
  let launchOptions: AgentOptions = {
    ...options,
    budget: resolveLaunchBudget(
      options.budget,
      config.budget.tokensRemaining,
      approvedBudgetOverride,
    ),
    agentRunId,
  };
  const agentId = config.resolvedAgent?.agentId ?? options.agentType ?? options.label;
  const shouldEmit = config.mode === 'execute' && config.eventEmitter;
  try {
    await config.launcher.preflight?.(providerPrompt, launchOptions);
  } catch (error) {
    if (shouldEmit) {
      config.eventEmitter!({
        type: 'agent.conversation.failed',
        agentId,
        label: options.label,
        phase: options.phase,
        runId: config.runId,
        agentRunId,
        resolvedAgentId: config.resolvedAgent?.agentId,
        error: getAgentRunFailureSummary(error),
      });
    }
    throw error;
  }

  // 5. Cache lookup
  const cached = await config.cache.load(config.runId, config.cacheKey);
  if (cached !== null) {
    if (options.schema) {
      const violations = validateAgainstSchema(cached.data, options.schema);
      if (violations.length > 0) {
        config.log(`Cached schema validation failed for ${options.label}`);
        throw new SchemaValidationError(options.label, violations);
      }
    }
    return cached.data as T;
  }

  // 6. Execute agent call (with optional event emission for execute mode)
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
  let launchPrompt = providerPrompt;

  while (true) {
    throwIfAborted();
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
      const cancelActiveAgent = () => {
        requestAgentRunCancellation(agentRunId, 'workflow runner requested cancellation');
      };
      config.signal?.addEventListener('abort', cancelActiveAgent, { once: true });
      try {
        result = await config.launcher(launchPrompt, launchOptions);
      } finally {
        config.signal?.removeEventListener('abort', cancelActiveAgent);
      }
      throwIfAborted();
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
      const failedUsage = chargeFailedAgentUsage(config.budget, err);
      if (shouldEmit) {
        config.eventEmitter!({
          type: 'agent.conversation.failed',
          agentId,
          label: options.label,
          phase: options.phase,
          runId: config.runId,
          agentRunId,
          resolvedAgentId: config.resolvedAgent?.agentId,
          error: getAgentRunFailureSummary(err),
        });
      }
      await settleAgentCall({
        config,
        options,
        tokensUsedThisCall: failedUsage,
        primary: err,
      });
      throw err;
    }
  }

  if (!result) {
    throw new Error('Agent launcher did not produce a result.');
  }

  // Every real provider response consumes the cumulative budget, even when
  // its payload subsequently fails schema validation. Cache hits returned
  // above never enter this accounting path.
  const usage = result.tokenUsage ?? 0;
  config.budget.tokensUsed += usage;
  if (config.budget.tokensRemaining !== null) {
    config.budget.tokensRemaining -= usage;
  }
  config.budget.agentCalls += 1;

  // 6. Schema validation
  if (options.schema) {
    const violations = validateAgainstSchema(result.data, options.schema);
    if (violations.length > 0) {
      config.log(`Schema validation failed for ${options.label}`);
      const error = new SchemaValidationError(options.label, violations);
      if (shouldEmit) {
        config.eventEmitter!({
          type: 'agent.conversation.failed',
          agentId,
          label: options.label,
          phase: options.phase,
          runId: config.runId,
          agentRunId: result.runId ?? agentRunId,
          resolvedAgentId: config.resolvedAgent?.agentId,
          error: getAgentRunFailureSummary(error),
        });
      }
      await settleAgentCall({
        config,
        options,
        tokensUsedThisCall: usage,
        primary: error,
      });
      throw error;
    }
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

  // 7. Update budget and persist result evidence
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
      promptSummary: summarizePrompt(providerPrompt),
      promptHash: hashPrompt(providerPrompt),
      startedAt,
      completedAt: new Date().toISOString(),
      tokenUsage: usage,
      replayAvailable,
      replayUnavailableReason,
    },
  };

  // Persist cumulative usage before making the result cache-visible. If the
  // budget write fails, a later resume may re-run and over-count this call,
  // but it can never use a cached result whose usage was not durably charged.
  await settleAgentCall({
    config,
    options,
    tokensUsedThisCall: usage,
    cacheResult: evidenceResult as AgentResult,
  });

  return result.data as T;
}

async function settleAgentCall(options: {
  readonly config: Omit<AgentCallExecutionConfig, 'launcher'>;
  readonly options: AgentOptions;
  readonly tokensUsedThisCall: number;
  readonly primary?: unknown;
  readonly cacheResult?: AgentResult;
}): Promise<void> {
  const { config } = options;
  let decision: BudgetPolicyDecision | undefined;
  let decisionFailure: unknown;
  try {
    const costConfig = await (config.loadCostConfig?.() ??
      loadWorkflowCostConfig(config.rootDir).catch(() => null));
    decision = await applyCostAndBudgetPolicy({
      runId: config.runId,
      runStore: config.runStore,
      budget: config.budget,
      budgetPolicy: config.budgetPolicy,
      tokensUsedThisCall: options.tokensUsedThisCall,
      provider: config.resolvedAgent?.provider,
      model: config.resolvedAgent?.model ?? options.options.model,
      costConfig,
    });
  } catch (error) {
    decisionFailure = error;
  }

  const persistenceFailure = await captureFailure(async () => {
    if (config.onBudgetChange !== undefined) {
      await config.onBudgetChange(config.budget);
    } else if (config.runStore !== undefined) {
      await config.runStore.persistBudgetState(config.runId, config.budget);
    }
  });
  if (persistenceFailure !== undefined) {
    const conditions = [
      decisionFailure,
      decision === undefined || decision.kind === 'continue' ? undefined : decision.error,
    ];
    if (options.primary !== undefined) {
      throwWithSuppressed(options.primary, [...conditions, persistenceFailure]);
    }
    throwWithSuppressed(persistenceFailure, conditions);
  }
  if (decisionFailure !== undefined) {
    if (options.primary !== undefined) throwWithSuppressed(options.primary, [decisionFailure]);
    throw decisionFailure;
  }
  if (decision === undefined) throw new Error('Workflow budget decision was not produced.');

  if (decision.kind === 'pause') {
    const approvalFailure = await captureFailure(async () => {
      if (config.runStore === undefined) {
        throw new Error('Workflow budget pause requires a durable run store.');
      }
      await config.runStore.savePendingApproval(config.runId, {
        operation: 'workflow.budget.exceeded',
        detail: decision.error.detail,
        timestamp: new Date().toISOString(),
      });
    });
    if (approvalFailure !== undefined) {
      if (options.primary !== undefined) {
        throwWithSuppressed(options.primary, [decision.error, approvalFailure]);
      }
      throwWithSuppressed(approvalFailure, [decision.error]);
    }
  }

  const cacheFailure =
    options.primary === undefined && options.cacheResult !== undefined
      ? await captureFailure(() =>
          config.cache.save(config.runId, config.cacheKey, options.cacheResult!),
        )
      : undefined;

  if (decision.kind !== 'continue') {
    throwWithSuppressed(decision.error, [options.primary, cacheFailure]);
  }
  if (options.primary !== undefined) throwWithSuppressed(options.primary, []);
  if (cacheFailure !== undefined) throw cacheFailure;
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

function resolveLaunchBudget(
  requested: AgentOptions['budget'],
  workflowRemaining: number | null,
  approvedOverdraw = false,
): AgentOptions['budget'] {
  const requestedTokens = requested?.tokens;
  const tokens =
    workflowRemaining === null || approvedOverdraw
      ? requestedTokens
      : requestedTokens === undefined
        ? workflowRemaining
        : Math.min(requestedTokens, workflowRemaining);
  return tokens === undefined ? undefined : { tokens, costUsd: requested?.costUsd };
}

function chargeFailedAgentUsage(budget: BudgetState, error: unknown): number {
  const usage =
    error && typeof error === 'object' && 'tokenUsage' in error
      ? (error as { tokenUsage?: unknown }).tokenUsage
      : undefined;
  if (typeof usage === 'number' && Number.isInteger(usage) && usage > 0) {
    budget.tokensUsed += usage;
    if (budget.tokensRemaining !== null) budget.tokensRemaining -= usage;
  }
  budget.agentCalls += 1;
  return typeof usage === 'number' && Number.isInteger(usage) && usage > 0 ? usage : 0;
}
