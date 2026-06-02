import type { AgentRunRequest } from './types.js';
import { PermissionDeniedError, AgentUnavailableError } from './types.js';
import { buildPermissionProfile, validatePermissionProfile } from './permissions.js';
import { createRunRecorder } from './recorder.js';
import type { AgentRunStore } from './run-store.js';
import { generateRunId } from './run-store.js';
import type { AgentExecutionAdapter } from './adapter.js';
import { LocalExecutionAdapter } from './adapter.js';

export interface LauncherOptions {
  runStore: AgentRunStore;
  model?: string;
  rootDir?: string;
  /** List of available MCP server names. Agents requiring unavailable servers will be rejected. */
  availableMcpServers?: string[];
  /**
   * Execution adapter to use for agent runs. Defaults to LocalExecutionAdapter.
   * Override to provide external command, Claude Code, or other adapters.
   */
  adapter?: AgentExecutionAdapter;
}

/**
 * Create an OpenSlack agent launcher.
 *
 * The launcher handles infrastructure concerns (MCP checks, worktree lifecycle,
 * permission validation, run recording, transcript) and delegates actual
 * execution to an {@link AgentExecutionAdapter}.
 *
 * By default, uses the {@link LocalExecutionAdapter} which produces placeholder
 * responses without invoking an external LLM. Pass a custom adapter to connect
 * real execution backends.
 */
export function createOpenSlackAgentLauncher(options: LauncherOptions) {
  const {
    runStore,
    model,
    rootDir,
    availableMcpServers = [],
    adapter = new LocalExecutionAdapter(),
  } = options;
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

    // Check required MCP servers before launching
    if (resolvedConfig.requiredMcpServers && resolvedConfig.requiredMcpServers.length > 0) {
      const missing = resolvedConfig.requiredMcpServers.filter(
        (name) => !availableMcpServers.includes(name),
      );
      if (missing.length > 0) {
        throw new AgentUnavailableError(missing);
      }
    }

    // Enforce worktree isolation for implementer agents
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
      // Delegate execution to the adapter
      const adapterResult = await adapter.execute<T>({
        prompt,
        runId,
        agentId: resolvedConfig.agentId,
        resolvedConfig,
        permissionProfile,
        worktreePath,
        recorder,
        runState: state,
      });

      // Complete run with adapter-provided token usage
      recorder.complete(runId, adapterResult.data, adapterResult.tokenUsage);

      return {
        data: adapterResult.data,
        tokenUsage: adapterResult.tokenUsage,
        runId,
      };
    } catch (err) {
      recorder.fail(runId, err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      // Dirty-state-aware worktree cleanup: preserve worktrees with
      // uncommitted changes so real work is never destroyed by an
      // automatic cleanup sweep.
      if (worktreePath) {
        try {
          const { checkDirty, cleanupWorktree } = await import('@openslack/runtime');
          const dirtyResult = checkDirty(worktreePath);

          if (dirtyResult.status === 'dirty') {
            // Preserve worktree — it contains uncommitted changes that
            // should be reviewed or committed before removal.
            recorder.progress(runId, {
              step: 'worktree_dirty_preserved',
              worktreePath,
              branchName: `agent/${resolvedConfig.agentId}/run-${runId}/${runId}`,
              reason: dirtyResult.reason ?? 'Uncommitted changes detected',
            });
          } else if (dirtyResult.status === 'error') {
            // Fail-closed: if we cannot determine dirty state, attempt
            // cleanup rather than leaking an unmanaged worktree.
            recorder.progress(runId, {
              step: 'worktree_dirty_check_failed',
              worktreePath,
              reason: dirtyResult.reason ?? 'Unknown dirty-check error',
            });
            cleanupWorktree(runId, rootDir);
          } else {
            // Clean — safe to remove.
            cleanupWorktree(runId, rootDir);
          }
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
