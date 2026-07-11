import type { AgentRunRequest, ResolvedAgentConfig, WorktreeHandoff } from './types.js';
import {
  PermissionDeniedError,
  AgentUnavailableError,
  RuntimeMisconfiguredError,
  RuntimeNotConfiguredError,
} from './types.js';
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
import { ToolGuard } from './adapter.js';
import type { BridgeMode } from './bridge-factory.js';
import { createBridgeAdapter } from './bridge-factory.js';
import type { BridgeRuntimeResolver } from './bridge-runtime-resolver.js';
import {
  BridgeRuntimeConfigError,
  createBridgeRuntimeResolver,
} from './bridge-runtime-resolver.js';
import type { ProviderResolution, ProviderTransport } from './provider-registry.js';
import { ProviderRegistry } from './provider-registry.js';

export interface LauncherOptions {
  runStore: AgentRunStore;
  model?: string;
  rootDir?: string;
  /** List of available MCP server names. Agents requiring unavailable servers will be rejected. */
  availableMcpServers?: string[];
  /**
   * Explicit execution adapter injection. Intended for tests and runtime hosts
   * that construct a governed adapter directly. There is no production default.
   */
  adapter?: AgentExecutionAdapter;
  /**
   * Legacy transport metadata for an explicitly injected adapter. This value
   * never selects or constructs an adapter.
   */
  bridgeMode?: BridgeMode;
  /** Instance-scoped provider registry. Defaults to an opt-in Aby registration. */
  providerRegistry?: ProviderRegistry;
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
 * A launcher without an explicit adapter or registered provider fails closed
 * with {@link RuntimeNotConfiguredError}; it never returns fixture output.
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

  // Fixtures are available only through explicit adapter injection. bridgeMode
  // describes transport and never constructs a production execution backend.
  const explicitlyConfiguredAdapter = options.adapter;
  const providerRegistry =
    options.providerRegistry ??
    createDefaultProviderRegistry(bridgeRuntimeResolver, availableMcpServers);

  const recorder = createRunRecorder(runStore, rootDir);

  function resolveProvider(resolvedConfig: ResolvedAgentConfig): ProviderResolution {
    return explicitlyConfiguredAdapter
      ? {
          providerId:
            resolvedConfig.runtimeProvider?.trim().toLowerCase() ||
            `injected:${explicitlyConfiguredAdapter.adapterId}`,
          transport: transportForExplicitAdapter(bridgeMode),
          adapter: explicitlyConfiguredAdapter,
        }
      : providerRegistry.resolve(resolvedConfig);
  }

  function validatePrerequisites(resolvedConfig: ResolvedAgentConfig) {
    if (resolvedConfig.requiredMcpServers && resolvedConfig.requiredMcpServers.length > 0) {
      const missing = resolvedConfig.requiredMcpServers.filter(
        (name) => !availableMcpServers.includes(name),
      );
      if (missing.length > 0) throw new AgentUnavailableError(missing);
    }

    const permissionProfile = buildPermissionProfile(resolvedConfig);
    const { valid, violations } = validatePermissionProfile(permissionProfile);
    if (!valid) {
      throw new PermissionDeniedError('profile.validation', violations.join('; '));
    }
    return permissionProfile;
  }

  const launchAgent = async function launchAgent<T>(
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
      resolvedAgentConfig?: ResolvedAgentConfig;
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
    const runId = agentOptions.agentRunId ?? generateRunId();

    // Build the safe request envelope first. Provider resolution intentionally
    // precedes MCP/profile checks so those checks cannot mask a missing runtime.
    const permissionProfile = buildPermissionProfile(resolvedConfig);

    const request: AgentRunRequest = {
      runId,
      agentId: resolvedConfig.agentId,
      prompt,
      resolvedConfig,
      permissionProfile,
      budget: agentOptions.budget,
      correlationId: agentOptions.correlationId,
      threadId: agentOptions.threadId,
    };

    // Resolve and validate the runtime before any worktree or process side
    // effect. Rejections are persisted directly as terminal failed runs.
    let providerResolution: ProviderResolution;
    try {
      providerResolution = resolveProvider(resolvedConfig);
    } catch (error) {
      const runtimeError = normalizeRuntimeResolutionError(error);
      runtimeError.runId = runId;
      recorder.reject(request, runtimeError);
      throw runtimeError;
    }

    validatePrerequisites(resolvedConfig);

    // Enforce worktree isolation for implementer agents and write-capable
    // Aby bridge agents.
    let worktreePath: string | undefined;
    let worktreeBranchName: string | undefined;
    const isImplementer =
      resolvedConfig.agentId?.toLowerCase().includes('implement') ||
      resolvedConfig.prompt?.toLowerCase().includes('implement');
    const isAbyBridgeRun =
      providerResolution.providerId === 'aby' && providerResolution.transport === 'process';
    const isWriteCapable =
      permissionProfile.permissionMode !== 'plan' ||
      permissionProfile.allowedTools.some((tool) => ['Edit', 'Write', 'Bash'].includes(tool));
    const needsWorktree =
      resolvedConfig.isolation === 'worktree' ||
      isImplementer ||
      (isAbyBridgeRun && isWriteCapable);

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
      request.worktreePath = worktreePath;
    }

    // Start run
    const state = recorder.start(request);
    const abortController = new AbortController();
    const unregisterControl = registerActiveAgentRunControl({
      runId,
      abortController,
      recorder,
      startedAt: state.startedAt,
    });

    const runAdapter = providerResolution.adapter;

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
            const handoff: WorktreeHandoff = {
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

  launchAgent.preflight = async (
    prompt: string,
    agentOptions: Parameters<typeof launchAgent>[1],
  ): Promise<void> => {
    const resolvedConfig = agentOptions.resolvedAgentConfig ?? {
      agentId: agentOptions.agentType ?? agentOptions.label,
      source: 'runtime',
      model: agentOptions.model ?? model,
    };
    const runId = agentOptions.agentRunId ?? generateRunId();
    const permissionProfile = buildPermissionProfile(resolvedConfig);
    const request: AgentRunRequest = {
      runId,
      agentId: resolvedConfig.agentId,
      prompt,
      resolvedConfig,
      permissionProfile,
      budget: agentOptions.budget,
      correlationId: agentOptions.correlationId,
      threadId: agentOptions.threadId,
    };

    try {
      resolveProvider(resolvedConfig);
    } catch (error) {
      const runtimeError = normalizeRuntimeResolutionError(error);
      runtimeError.runId = runId;
      recorder.reject(request, runtimeError);
      throw runtimeError;
    }
    validatePrerequisites(resolvedConfig);
  };

  return launchAgent;
}

function createDefaultProviderRegistry(
  bridgeRuntimeResolver: BridgeRuntimeResolver,
  availableMcpServers: string[],
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'aby',
    resolve(config) {
      if (config.bridgeMode && config.bridgeMode !== 'process') {
        throw new RuntimeMisconfiguredError(
          `Aby provider requires process transport, not "${config.bridgeMode}".`,
        );
      }

      let runtimeOptions;
      try {
        runtimeOptions = bridgeRuntimeResolver.resolve(config);
      } catch (error) {
        throw normalizeRuntimeResolutionError(error);
      }
      if (!runtimeOptions?.command) {
        throw new RuntimeMisconfiguredError(
          `Aby provider is configured for agent "${config.agentId}" but no bridge command was resolved.`,
        );
      }

      return {
        providerId: 'aby',
        transport: 'process',
        adapter: createBridgeAdapter({
          bridgeMode: 'process',
          availableMcpServers,
          ...runtimeOptions,
        }),
      };
    },
  });
  return registry;
}

function transportForExplicitAdapter(bridgeMode?: BridgeMode): ProviderTransport {
  if (bridgeMode === 'process') return 'process';
  if (bridgeMode === 'external-command') return 'external-command';
  return 'test-fixture';
}

function normalizeRuntimeResolutionError(
  error: unknown,
): RuntimeNotConfiguredError | RuntimeMisconfiguredError {
  if (error instanceof RuntimeNotConfiguredError || error instanceof RuntimeMisconfiguredError) {
    return error;
  }
  if (error instanceof BridgeRuntimeConfigError) {
    return new RuntimeMisconfiguredError(error.message);
  }
  return new RuntimeMisconfiguredError(
    `Agent runtime configuration could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
  );
}
