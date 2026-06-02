import type { AgentRunState, AgentPermissionProfile, ResolvedAgentConfig } from './types.js';
import type { RunRecorder } from './recorder.js';

/**
 * Context passed to an execution adapter. Contains everything the adapter
 * needs to execute an agent run, minus the infrastructure concerns
 * (MCP checks, worktree lifecycle, permission validation) that the launcher
 * handles before delegating.
 */
export interface AdapterExecutionContext {
  /** The prompt to execute. */
  prompt: string;
  /** Unique run identifier (already validated). */
  runId: string;
  /** Resolved agent identity. */
  agentId: string;
  /** Fully resolved agent configuration. */
  resolvedConfig: ResolvedAgentConfig;
  /** Permission profile (already validated — adapter may further restrict). */
  permissionProfile: AgentPermissionProfile;
  /** Path to worktree if isolation is active, undefined otherwise. */
  worktreePath?: string;
  /** Run recorder for emitting transcript events. */
  recorder: RunRecorder;
  /** Current run state (snapshot from recorder.start). */
  runState: AgentRunState;
}

/**
 * Result returned by an execution adapter.
 */
export interface AdapterExecutionResult<T = unknown> {
  /** The structured result produced by the adapter. */
  data: T;
  /** Estimated or actual token usage, if available. */
  tokenUsage?: number;
}

/**
 * Provider-neutral execution adapter interface.
 *
 * The launcher handles infrastructure (MCP checks, worktree lifecycle,
 * permission validation, run recording, transcript) and delegates the
 * actual execution to an adapter implementing this interface.
 *
 * Adapters are responsible for:
 * - Producing a structured result from the prompt
 * - Emitting progress/tool_call/tool_result events via the recorder
 * - Respecting the permission profile's tool allow/deny lists
 * - Operating within the worktree path when provided
 *
 * Adapters must NOT:
 * - Create or clean up worktrees (launcher handles this)
 * - Validate or modify the permission profile
 * - Start/complete/fail the run (launcher handles this)
 * - Access secrets, credentials, or tokens
 */
export interface AgentExecutionAdapter {
  /** Unique identifier for this adapter type (e.g., 'local', 'external-command'). */
  readonly adapterId: string;

  /**
   * Execute an agent run.
   *
   * @param context - Pre-validated execution context.
   * @returns Structured result and optional token usage.
   * @throws PermissionDeniedError if the adapter detects a disallowed action.
   * @throws Error for any execution failure.
   */
  execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>>;
}

// ---------------------------------------------------------------------------
// Local execution adapter (placeholder for Phase AR)
// ---------------------------------------------------------------------------

/**
 * Local adapter: produces a structured result without calling an external LLM.
 *
 * This parses the prompt for known patterns and returns appropriate
 * placeholder data. It's a bridge that makes ctx.agent() runnable
 * while the real LLM integration is being built.
 *
 * TODO(phase-ar-llm): Replace placeholder responses with real LLM calls.
 * Every return statement below uses `as T` to satisfy the generic type.
 * This is safe only because this adapter produces hardcoded mock data.
 * When a real adapter is added, the `as T` casts must be removed and
 * the adapter should produce properly typed results via the schema
 * validation already present in the agent shim.
 */
export class LocalExecutionAdapter implements AgentExecutionAdapter {
  readonly adapterId = 'local';

  async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
    const { prompt, permissionProfile, recorder, runState } = context;

    // Record the execution
    recorder.progress(runState.runId, { step: 'parsing_prompt', promptLength: prompt.length });

    // Simulate tool usage based on permission profile
    const simulatedTools = permissionProfile.allowedTools.slice(0, 3);
    for (const tool of simulatedTools) {
      recorder.toolCall(runState.runId, tool, { query: prompt.slice(0, 50) });
      recorder.toolResult(runState.runId, tool, { found: true, matches: 1 });
    }

    // Parse prompt for structured intent
    const lowerPrompt = prompt.toLowerCase();

    // Review request pattern
    if (lowerPrompt.includes('review') || lowerPrompt.includes('check')) {
      recorder.progress(runState.runId, { step: 'generating_review' });
      return {
        data: {
          review: 'Local adapter review: no issues found in analyzed scope.',
          findings: [],
          approved: true,
        } as T,
        tokenUsage: estimateTokenUsage(prompt, { review: 'placeholder' }),
      };
    }

    // Research request pattern
    if (
      lowerPrompt.includes('research') ||
      lowerPrompt.includes('find') ||
      lowerPrompt.includes('search')
    ) {
      recorder.progress(runState.runId, { step: 'generating_research' });
      return {
        data: {
          summary: 'Local adapter research: analyzed available context.',
          sources: ['local-context'],
          confidence: 'medium',
        } as T,
        tokenUsage: estimateTokenUsage(prompt, { summary: 'placeholder' }),
      };
    }

    // Plan request pattern
    if (lowerPrompt.includes('plan') || lowerPrompt.includes('design')) {
      recorder.progress(runState.runId, { step: 'generating_plan' });
      return {
        data: {
          plan: [
            'Step 1: Analyze requirements',
            'Step 2: Implement changes',
            'Step 3: Validate results',
          ],
          estimatedEffort: 'medium',
        } as T,
        tokenUsage: estimateTokenUsage(prompt, { plan: 'placeholder' }),
      };
    }

    // Default: generic structured response
    recorder.progress(runState.runId, { step: 'generating_response' });
    return {
      data: {
        response: 'Local adapter executed successfully.',
        promptAnalyzed: true,
        toolsUsed: simulatedTools,
      } as T,
      tokenUsage: estimateTokenUsage(prompt, { response: 'placeholder' }),
    };
  }
}

function estimateTokenUsage(prompt: string, result: unknown): number {
  // Rough heuristic: ~4 chars per token
  const promptTokens = Math.ceil(prompt.length / 4);
  const resultTokens = Math.ceil(JSON.stringify(result).length / 4);
  return promptTokens + resultTokens + 50; // overhead
}
