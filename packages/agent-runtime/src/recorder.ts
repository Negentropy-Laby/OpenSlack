import type { AgentRunFailureCode, AgentRunState, AgentRunRequest } from './types.js';
import { getAgentRunFailureCode, getAgentRunFailureSummary } from './types.js';
import { appendTranscriptEvent } from './transcript.js';
import type { AgentRunStore } from './run-store.js';

export interface RunRecorder {
  start(request: AgentRunRequest): AgentRunState;
  reject(request: AgentRunRequest, error: Error, failureCode?: AgentRunFailureCode): AgentRunState;
  progress(runId: string, data: Record<string, unknown>): void;
  toolCall(runId: string, toolName: string, input?: unknown): void;
  toolResult(runId: string, toolName: string, output?: unknown): void;
  complete(runId: string, result: unknown, tokenUsage?: number): AgentRunState;
  fail(runId: string, error: Error, failureCode?: AgentRunFailureCode): AgentRunState;
  cancel(runId: string): AgentRunState;
}

export function createRunRecorder(store: AgentRunStore, rootDir?: string): RunRecorder {
  return {
    start(request: AgentRunRequest): AgentRunState {
      const state = store.createRun(request);
      const updated = store.updateRun(state.runId, { status: 'running' });

      appendTranscriptEvent(
        state.runId,
        {
          timestamp: new Date().toISOString(),
          type: 'start',
          data: {
            agentId: request.agentId,
            model: request.resolvedConfig.model,
            runtime: request.resolvedConfig.runtime,
            runtimeProvider: request.resolvedConfig.runtimeProvider,
            provider: request.resolvedConfig.provider,
            bridgeMode: request.resolvedConfig.bridgeMode,
            permissionMode: request.permissionProfile.permissionMode,
            allowedTools: request.permissionProfile.allowedTools,
            requiredMcpServers: request.resolvedConfig.requiredMcpServers,
            mcpServers: request.resolvedConfig.mcpServers,
          },
        },
        rootDir,
      );

      return updated;
    },

    reject(
      request: AgentRunRequest,
      error: Error,
      failureCode?: AgentRunFailureCode,
    ): AgentRunState {
      const code = failureCode ?? getAgentRunFailureCode(error);
      const errorSummary = getAgentRunFailureSummary(error, code);
      appendTranscriptEvent(
        request.runId,
        {
          timestamp: new Date().toISOString(),
          type: 'fail',
          data: { failureCode: code, errorSummary },
        },
        rootDir,
      );
      return store.createFailedRun(request, { failureCode: code, errorSummary });
    },

    progress(runId: string, data: Record<string, unknown>): void {
      appendTranscriptEvent(
        runId,
        {
          timestamp: new Date().toISOString(),
          type: 'progress',
          data,
        },
        rootDir,
      );
    },

    toolCall(runId: string, toolName: string, input?: unknown): void {
      appendTranscriptEvent(
        runId,
        {
          timestamp: new Date().toISOString(),
          type: 'tool_call',
          data: { toolName, input },
        },
        rootDir,
      );

      const state = store.getRun(runId);
      if (state) {
        store.updateRun(runId, {
          toolCalls: state.toolCalls + 1,
          lastTool: toolName,
        });
      }
    },

    toolResult(runId: string, toolName: string, output?: unknown): void {
      appendTranscriptEvent(
        runId,
        {
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          data: { toolName, output },
        },
        rootDir,
      );
    },

    complete(runId: string, result: unknown, tokenUsage?: number): AgentRunState {
      appendTranscriptEvent(
        runId,
        {
          timestamp: new Date().toISOString(),
          type: 'complete',
          data: { result, tokenUsage },
        },
        rootDir,
      );

      const state = store.getRun(runId);
      const patch: Partial<AgentRunState> = {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
      if (tokenUsage !== undefined && state) {
        patch.tokensUsed = state.tokensUsed + tokenUsage;
        if (state.tokensRemaining !== null) {
          patch.tokensRemaining = state.tokensRemaining - tokenUsage;
        }
      }

      return store.updateRun(runId, patch);
    },

    fail(runId: string, error: Error, failureCode?: AgentRunFailureCode): AgentRunState {
      return recordFailure(runId, error, failureCode);
    },

    cancel(runId: string): AgentRunState {
      appendTranscriptEvent(
        runId,
        {
          timestamp: new Date().toISOString(),
          type: 'cancel',
          data: {},
        },
        rootDir,
      );

      return store.updateRun(runId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
    },
  };

  function recordFailure(
    runId: string,
    error: Error,
    failureCode: AgentRunFailureCode = getAgentRunFailureCode(error),
  ): AgentRunState {
    const errorSummary = getAgentRunFailureSummary(error, failureCode);
    appendTranscriptEvent(
      runId,
      {
        timestamp: new Date().toISOString(),
        type: 'fail',
        data: { failureCode, errorSummary },
      },
      rootDir,
    );

    return store.updateRun(runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      failureCode,
      errorSummary,
      error: errorSummary,
    });
  }
}
