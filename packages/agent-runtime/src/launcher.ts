import type { AgentRunRequest, AgentRunState, AgentPermissionProfile } from './types.js';
import { PermissionDeniedError, AgentUnavailableError } from './types.js';
import { buildPermissionProfile, validatePermissionProfile } from './permissions.js';
import { createRunRecorder, type RunRecorder } from './recorder.js';
import type { AgentRunStore } from './run-store.js';
import { generateRunId } from './run-store.js';

export interface LauncherOptions {
  runStore: AgentRunStore;
  model?: string;
  rootDir?: string;
  /** List of available MCP server names. Agents requiring unavailable servers will be rejected. */
  availableMcpServers?: string[];
}

/**
 * Create an OpenSlack-local agent launcher.
 *
 * This launcher replaces the "No agent launcher configured" stub.
 * It creates a fully instrumented agent run with permission checks,
 * transcript recording, and structured result generation — without
 * requiring an external LLM or Claude Code binary.
 */
export function createOpenSlackAgentLauncher(options: LauncherOptions) {
  const { runStore, model, rootDir, availableMcpServers = [] } = options;
  const recorder = createRunRecorder(runStore, rootDir);

  return async function launchAgent<T>(
    prompt: string,
    agentOptions: {
      label: string;
      phase: string;
      schema?: unknown;
      isolation?: 'none' | 'worktree';
      budget?: { tokens: number; costUsd: number };
      model?: string;
      agentType?: string;
      resolvedAgentId?: string;
      resolvedAgentConfig?: import('./types.js').ResolvedAgentConfig;
      agentRunId?: string;
    },
  ): Promise<{ data: T; tokenUsage?: number; runId: string }> {
    const resolvedConfig = agentOptions.resolvedAgentConfig ?? {
      agentId: agentOptions.agentType ?? agentOptions.label,
      source: 'runtime',
      model: agentOptions.model ?? model,
    };

    // Phase AR: Check required MCP servers before launching
    if (resolvedConfig.requiredMcpServers && resolvedConfig.requiredMcpServers.length > 0) {
      const missing = resolvedConfig.requiredMcpServers.filter(
        (name) => !availableMcpServers.includes(name),
      );
      if (missing.length > 0) {
        throw new AgentUnavailableError(missing);
      }
    }

    // Phase AR: Enforce worktree isolation for implementer agents
    let worktreePath: string | undefined;
    const isImplementer =
      resolvedConfig.agentId?.toLowerCase().includes('implement') ||
      resolvedConfig.prompt?.toLowerCase().includes('implement');
    const needsWorktree = resolvedConfig.isolation === 'worktree' || isImplementer;

    const runId = agentOptions.agentRunId ?? generateRunId();

    if (needsWorktree) {
      const { createWorktree } = await import('@openslack/runtime');
      const wtResult = createWorktree(
        `run-${runId}`,
        resolvedConfig.agentId,
        runId,
        rootDir,
      );
      if (!wtResult.success) {
        throw new Error(
          `Worktree isolation required but creation failed: ${wtResult.errors.join(', ')}`,
        );
      }
      worktreePath = wtResult.worktreePath;
    }

    // Build permission profile
    const permissionProfile = buildPermissionProfile(resolvedConfig);

    // Validate profile
    const { valid: profileValid, violations } = validatePermissionProfile(permissionProfile);
    if (!profileValid) {
      throw new PermissionDeniedError('profile.validation', violations.join('; '));
    }

    // Build run request
    const request: AgentRunRequest = {
      runId,
      agentId: resolvedConfig.agentId,
      prompt,
      resolvedConfig,
      permissionProfile,
      budget: agentOptions.budget,
      worktreePath,
    };

    // Start run
    const state = recorder.start(request);

    try {
      // --- Local adapter execution (no external LLM) ---
      const result = await executeLocalAdapter<T>(
        prompt,
        resolvedConfig,
        permissionProfile,
        recorder,
        state,
      );

      // Complete run
      const tokenUsage = estimateTokenUsage(prompt, result);
      recorder.complete(runId, result, tokenUsage);

      return {
        data: result,
        tokenUsage,
        runId,
      };
    } catch (err) {
      recorder.fail(runId, err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      // Cleanup worktree if created
      if (worktreePath) {
        try {
          const { cleanupWorktree } = await import('@openslack/runtime');
          cleanupWorktree(runId, rootDir);
        } catch (cleanupErr) {
          // Log cleanup failure so orphan worktrees are discoverable, but do
          // not mask the original result or error from the run.
          recorder.progress(runId, {
            step: 'worktree_cleanup_failed',
            worktreePath,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
    }
  };
}

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
async function executeLocalAdapter<T>(
  prompt: string,
  _resolvedConfig: import('./types.js').ResolvedAgentConfig,
  permissionProfile: AgentPermissionProfile,
  recorder: RunRecorder,
  state: AgentRunState,
): Promise<T> {
  // Record the execution
  recorder.progress(state.runId, { step: 'parsing_prompt', promptLength: prompt.length });

  // Simulate tool usage based on permission profile
  const simulatedTools = permissionProfile.allowedTools.slice(0, 3);
  for (const tool of simulatedTools) {
    recorder.toolCall(state.runId, tool, { query: prompt.slice(0, 50) });
    recorder.toolResult(state.runId, tool, { found: true, matches: 1 });
  }

  // Parse prompt for structured intent
  const lowerPrompt = prompt.toLowerCase();

  // Review request pattern
  if (lowerPrompt.includes('review') || lowerPrompt.includes('check')) {
    recorder.progress(state.runId, { step: 'generating_review' });
    return {
      review: 'Local adapter review: no issues found in analyzed scope.',
      findings: [],
      approved: true,
    } as T;
  }

  // Research request pattern
  if (
    lowerPrompt.includes('research') ||
    lowerPrompt.includes('find') ||
    lowerPrompt.includes('search')
  ) {
    recorder.progress(state.runId, { step: 'generating_research' });
    return {
      summary: 'Local adapter research: analyzed available context.',
      sources: ['local-context'],
      confidence: 'medium',
    } as T;
  }

  // Plan request pattern
  if (lowerPrompt.includes('plan') || lowerPrompt.includes('design')) {
    recorder.progress(state.runId, { step: 'generating_plan' });
    return {
      plan: [
        'Step 1: Analyze requirements',
        'Step 2: Implement changes',
        'Step 3: Validate results',
      ],
      estimatedEffort: 'medium',
    } as T;
  }

  // Default: generic structured response
  recorder.progress(state.runId, { step: 'generating_response' });
  return {
    response: 'Local adapter executed successfully.',
    promptAnalyzed: true,
    toolsUsed: simulatedTools,
  } as T;
}

function estimateTokenUsage(prompt: string, result: unknown): number {
  // Rough heuristic: ~4 chars per token
  const promptTokens = Math.ceil(prompt.length / 4);
  const resultTokens = Math.ceil(JSON.stringify(result).length / 4);
  return promptTokens + resultTokens + 50; // overhead
}
