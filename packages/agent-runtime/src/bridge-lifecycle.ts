/**
 * Bridge Lifecycle Mapping — maps BridgeContract session events to
 * recorder/transcript state. Bridge session start/complete/fail do not
 * directly call collaboration `recordEvent()` from agent-runtime;
 * lifecycle visibility continues through agent-shim and conversation
 * integrations so every run emits one coherent started/completed/failed
 * sequence.
 *
 * AR-2.5C: Lifecycle Mapping
 */

import type { BridgeSessionSummary } from './types.js';
import type { BridgeErrorKind } from './bridge-contract.js';
import type { RunRecorder } from './recorder.js';

/**
 * Maps bridge session lifecycle events to transcript progress events.
 *
 * The mapper is bridge-agnostic: it receives session state changes and
 * emits `recorder.progress()` calls with bridge_ prefixed events.
 * It never calls collaboration event recording directly — that remains
 * the responsibility of the agent-shim / conversation integration layer.
 */
export class BridgeLifecycleMapper {
  private readonly recorder: RunRecorder | null;
  private readonly runId: string;

  constructor(recorder: RunRecorder | null | undefined, runId: string) {
    this.recorder = recorder ?? null;
    this.runId = runId;
  }

  /**
   * Called when a bridge session opens successfully.
   * Emits: `bridge_session_started` progress event.
   */
  onSessionOpen(sessionId: string, metadata?: Record<string, unknown>): void {
    if (!this.recorder) return;
    this.recorder.progress(this.runId, {
      step: 'bridge_session_started',
      sessionId,
      correlationId: this.runId,
      ...metadata,
    });
  }

  /**
   * Called when a bridge session closes successfully.
   * Emits: `bridge_session_completed` progress event with summary.
   */
  onSessionClose(summary: BridgeSessionSummary): void {
    if (!this.recorder) return;
    this.recorder.progress(this.runId, {
      step: 'bridge_session_completed',
      ...summary,
    });
  }

  /**
   * Called when a bridge session encounters an error.
   * Emits: `bridge_session_failed` progress event with error details.
   */
  onSessionError(
    error: {
      kind: BridgeErrorKind;
      message: string;
      sessionId?: string;
    },
  ): void {
    if (!this.recorder) return;
    this.recorder.progress(this.runId, {
      step: 'bridge_session_failed',
      errorKind: error.kind,
      errorMessage: error.message,
      sessionId: error.sessionId,
      correlationId: this.runId,
    });
  }

  /**
   * Called for intermediate bridge progress (tool calls, reasoning, etc.).
   * Emits: `bridge_progress` progress event.
   */
  onBridgeProgress(step: string, data?: Record<string, unknown>): void {
    if (!this.recorder) return;
    this.recorder.progress(this.runId, {
      step: `bridge_${step}`,
      correlationId: this.runId,
      ...data,
    });
  }

  /**
   * Called when a tool call is reported by the bridge runtime.
   * Emits: `bridge_tool_call` progress event (NOT a transcript tool_call —
   * that is emitted by the ToolGuard after validation).
   */
  onBridgeToolCall(toolName: string, input?: unknown): void {
    if (!this.recorder) return;
    this.recorder.progress(this.runId, {
      step: 'bridge_tool_call',
      toolName,
      input,
      correlationId: this.runId,
    });
  }

  /**
   * Called when a tool result is reported by the bridge runtime.
   * Emits: `bridge_tool_result` progress event.
   */
  onBridgeToolResult(toolName: string, output?: unknown): void {
    if (!this.recorder) return;
    this.recorder.progress(this.runId, {
      step: 'bridge_tool_result',
      toolName,
      output,
      correlationId: this.runId,
    });
  }

  /**
   * Build a BridgeSessionSummary from run state and adapter result.
   */
  static buildSummary(
    runId: string,
    sessionId: string,
    options: {
      tokenUsage?: number;
      toolCalls?: number;
      uniqueTools?: string[];
      lastTool?: string;
      durationMs?: number;
      resultSummary?: Record<string, unknown>;
    } = {},
  ): BridgeSessionSummary {
    return {
      runId,
      sessionId,
      terminalReason: 'completed',
      tokenUsage: options.tokenUsage,
      toolStats:
        options.toolCalls !== undefined
          ? {
              totalCalls: options.toolCalls,
              uniqueTools: options.uniqueTools ?? [],
              lastTool: options.lastTool,
            }
          : undefined,
      durationMs: options.durationMs,
      resultSummary: options.resultSummary,
    };
  }

  /**
   * Build a BridgeSessionSummary for a failed session.
   */
  static buildErrorSummary(
    runId: string,
    sessionId: string,
    error: {
      kind: BridgeErrorKind;
      message: string;
    },
    options: {
      tokenUsage?: number;
      durationMs?: number;
    } = {},
  ): BridgeSessionSummary {
    return {
      runId,
      sessionId,
      terminalReason: error.kind === 'timeout' ? 'timeout' : 'failed',
      errorDetails: {
        kind: error.kind,
        message: error.message,
      },
      tokenUsage: options.tokenUsage,
      durationMs: options.durationMs,
    };
  }
}
