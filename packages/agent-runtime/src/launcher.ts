import type { AgentRunRequest } from './types.js';
import { PermissionDeniedError, AgentUnavailableError } from './types.js';
import {
  AgentRunCancelledError,
  AgentRunRestartRequestedError,
  registerActiveAgentRunControl,
} from './control.js';
import { buildPermissionProfile, validatePermissionProfile } from './permissions.js';
import { createRunRecorder } from './recorder.js';
import type { AgentRunStore } from './run-store.js';
import { generateRunId } from './run-store.js';
import type { AgentExecutionAdapter } from './adapter.js';
import { LocalExecutionAdapter, ToolGuard } from './adapter.js';
import type { BridgeMode } from './bridge-factory.js';
import { createBridgeAdapter } from './bridge-factory.js';
import type { BridgeRuntimeResolver } from './bridge-runtime-resolver.js';
import {
  BridgeRuntimeConfigError,
  createBridgeRuntimeResolver,
  isAbyRuntime,
} from './bridge-runtime-resolver.js';

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
  /**
   * Bridge mode for adapter selection. Only used when adapter is not explicitly provided.
   * @see createBridgeAdapter
   */
  bridgeMode?: BridgeMode;
  /**
   * Resolves provider-specific process bridge configuration. Defaults to the
   * OpenSlack local resolver, which uses OPENSLACK_ABY_ROOT or
   * .openslack.local/agent-runtime.json for Aby runtimes.
   */
  bridgeRuntimeResolver?: BridgeRuntimeResolver;
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
    bridgeMode,
  } = options;
  const bridgeRuntimeResolver =
    options.bridgeRuntimeResolver ??
    createBridgeRuntimeResolver({ rootDir });

  // Select default adapter: explicit adapter > global bridgeMode > local default.
  // Per-run bridgeMode from resolvedConfig is handled inside launchAgent so
  // that a single launcher can serve mixed local/bridge agent calls.
  const defaultAdapter: AgentExecutionAdapter =
    options.adapter ??
    (bridgeMode
      ? createBridgeAdapter({ bridgeMode, availableMcpServers })
      : new LocalExecutionAdapter());

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
      correlationId?: string;
      threadId?: string;
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

    // Build permission profile before worktree selection so Aby bridge runs
    // with write-capable tools are isolated even when the registry did not
    // explicitly request a worktree.
    const permissionProfile = buildPermissionProfile(resolvedConfig);

    // Validate profile
    const { valid: profileValid, violations } = validatePermissionProfile(permissionProfile);
    if (!profileValid) {
      throw new PermissionDeniedError('profile.validation', violations.join('; '));
    }

    // Enforce worktree isolation for implementer agents and write-capable
    // Aby bridge agents.
    let worktreePath: string | undefined;
    let worktreeBranchName: string | undefined;
    const isImplementer =
      resolvedConfig.agentId?.toLowerCase().includes('implement') ||
      resolvedConfig.prompt?.toLowerCase().includes('implement');
    const isAbyBridgeRun =
      resolvedConfig.bridgeMode === 'process' && isAbyRuntime(resolvedConfig);
    const isWriteCapable =
      permissionProfile.permissionMode !== 'plan' ||
      permissionProfile.allowedTools.some((tool) => ['Edit', 'Write', 'Bash'].includes(tool));
    const needsWorktree =
      resolvedConfig.isolation === 'worktree' ||
      isImplementer ||
      (isAbyBridgeRun && isWriteCapable);

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
      worktreeBranchName = wtResult.branchName;
    }

    // Build run request
    const request: AgentRunRequest = {
      runId,
      agentId: resolvedConfig.agentId,
      prompt,
      resolvedConfig,
      permissionProfile,
      budget: agentOptions.budget,
      correlationId: agentOptions.correlationId,
      threadId: agentOptions.threadId,
      worktreePath,
    };

    // Start run
    const state = recorder.start(request);
    const abortController = new AbortController();
    const unregisterControl = registerActiveAgentRunControl({
      runId,
      abortController,
      recorder,
      startedAt: state.startedAt,
    });

    // Select adapter for this run: per-run bridgeMode > global default
    const runBridgeMode = resolvedConfig.bridgeMode;
    const runtimeOptions =
      runBridgeMode === 'process'
        ? bridgeRuntimeResolver.resolve(resolvedConfig)
        : null;
    if (runBridgeMode === 'process' && !runtimeOptions?.command) {
      throw new BridgeRuntimeConfigError(
        `Process bridge requested for agent "${resolvedConfig.agentId}" but no bridge command was resolved.`,
      );
    }
    const runAdapter: AgentExecutionAdapter =
      (runBridgeMode && runBridgeMode !== bridgeMode)
        ? createBridgeAdapter({
            bridgeMode: runBridgeMode,
            availableMcpServers,
            ...(runtimeOptions ?? {}),
          })
        : defaultAdapter;

    try {
      // Delegate execution to the adapter
      const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
      const adapterResult = await runAdapter.execute<T>({
        prompt,
        runId,
        agentId: resolvedConfig.agentId,
        resolvedConfig,
        permissionProfile,
        worktreePath,
        correlationId: agentOptions.correlationId,
        threadId: agentOptions.threadId,
        recorder,
        runState: state,
        toolGuard,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        throw abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new AgentRunCancelledError(runId, 'agent run aborted');
      }

      // Complete run with adapter-provided token usage
      recorder.complete(runId, adapterResult.data, adapterResult.tokenUsage);

      // Record bridge lifecycle marker only when the adapter is actually a bridge
      if (runAdapter.bridgeContract) {
        recorder.progress(runId, {
          step: 'bridge_lifecycle_complete',
          runId,
          status: 'completed',
        });
      }

      return {
        data: adapterResult.data,
        tokenUsage: adapterResult.tokenUsage,
        runId,
      };
    } catch (err) {
      if (err instanceof AgentRunRestartRequestedError) {
        recorder.progress(runId, {
          step: 'agent_restart_handoff',
          reason: err.reason,
        });
        recorder.cancel(runId);
        if (runAdapter.bridgeContract) {
          recorder.progress(runId, {
            step: 'bridge_lifecycle_complete',
            runId,
            status: 'cancelled',
            reason: err.reason,
          });
        }
        throw err;
      }
      if (abortController.signal.aborted || err instanceof AgentRunCancelledError) {
        const reason = err instanceof AgentRunCancelledError
          ? err.reason
          : err instanceof Error
            ? err.message
            : 'agent run cancelled';
        recorder.cancel(runId);
        if (runAdapter.bridgeContract) {
          recorder.progress(runId, {
            step: 'bridge_lifecycle_complete',
            runId,
            status: 'cancelled',
            reason,
          });
        }
        throw err instanceof AgentRunCancelledError
          ? err
          : new AgentRunCancelledError(runId, reason);
      }
      recorder.fail(runId, err instanceof Error ? err : new Error(String(err)));
      if (runAdapter.bridgeContract) {
        recorder.progress(runId, {
          step: 'bridge_lifecycle_complete',
          runId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      unregisterControl();
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
            const branchName = worktreeBranchName ?? `agent/${resolvedConfig.agentId}/run-${runId}/${runId}`;
            recorder.progress(runId, {
              step: 'worktree_dirty_preserved',
              worktreePath,
              branchName,
              reason: dirtyResult.reason ?? 'Uncommitted changes detected',
            });

            // Record the handoff in run state so it can be recovered.
            const handoff: import('./types.js').WorktreeHandoff = {
              worktreePath,
              branchName,
              reason: dirtyResult.reason ?? 'Uncommitted changes detected',
              preservedAt: new Date().toISOString(),
            };
            runStore.updateRun(runId, { worktreeHandoff: handoff });
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
