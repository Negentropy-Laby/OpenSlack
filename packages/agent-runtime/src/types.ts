import type { PermissionMode } from '@openslack/kernel';

export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunFailureCode =
  | 'RUNTIME_NOT_CONFIGURED'
  | 'RUNTIME_MISCONFIGURED'
  | 'PROVIDER_UNAVAILABLE'
  | 'EXECUTION_FAILED';

export interface AgentPermissionProfile {
  allowedTools: string[];
  deniedTools: string[];
  permissionMode: PermissionMode;
  canApprovePR: false;
  canMerge: false;
  canReadSecrets: false;
  canBypassRulesets: false;
  acceptEdits: boolean;
  isReadOnly: boolean;
}

export interface ResolvedAgentConfig {
  agentId: string;
  source: string;
  runtime?: string;
  /** Execution provider owned by the runtime host (distinct from model vendor). */
  runtimeProvider?: string;
  /** Model/API vendor metadata; not used to select an execution transport. */
  provider?: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  isolation?: string;
  prompt?: string;
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high';
  hooks?: { before?: string; after?: string };
  initialPrompt?: string;
  background?: boolean;
  mcpServers?: string[];
  requiredMcpServers?: string[];
  criticalSystemReminder?: string;
  remote?: boolean;
  /** Bridge mode hint for adapter selection. */
  bridgeMode?: 'local' | 'external-command' | 'process' | 'fake';
}

export interface AgentRunRequest {
  runId: string;
  agentId: string;
  prompt: string;
  resolvedConfig: ResolvedAgentConfig;
  permissionProfile: AgentPermissionProfile;
  budget?: { tokens: number; costUsd: number };
  correlationId?: string;
  threadId?: string;
  worktreePath?: string;
}

/**
 * Records a preserved dirty worktree that was not cleaned up after a run.
 * This binds the run to a recoverable worktree with uncommitted changes.
 */
export interface WorktreeHandoff {
  /** Filesystem path to the preserved worktree. */
  worktreePath: string;
  /** Git branch name of the worktree. */
  branchName: string;
  /** Why the worktree was preserved (e.g., 'Uncommitted changes detected'). */
  reason: string;
  /** ISO timestamp when the handoff was recorded. */
  preservedAt: string;
}

export interface AgentRunState {
  runId: string;
  status: AgentRunStatus;
  agentId: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
  tokensUsed: number;
  tokensRemaining: number | null;
  toolCalls: number;
  lastTool?: string;
  failureCode?: AgentRunFailureCode;
  errorSummary?: string;
  /** @deprecated Use errorSummary for operator-safe failure rendering. */
  error?: string;
  worktreePath?: string;
  transcriptPath: string;
  /**
   * Set when the worktree was preserved (not cleaned up) because it
   * contained uncommitted changes. Null or undefined when the worktree
   * was cleaned up normally or no worktree was used.
   */
  worktreeHandoff?: WorktreeHandoff;
}

export interface AgentRunEvent {
  timestamp: string;
  type: 'start' | 'progress' | 'tool_call' | 'tool_result' | 'complete' | 'fail' | 'cancel';
  data: Record<string, unknown>;
}

export interface AgentRunResult {
  data: unknown;
  runState: AgentRunState;
  transcript: AgentRunEvent[];
}

// ---------------------------------------------------------------------------
// Bridge types (AR-2.5A) — re-exported from bridge-contract.ts (canonical source)
// ---------------------------------------------------------------------------

export type { BridgeSessionState, BridgeErrorKind, BridgeCapabilityDescriptor } from './bridge-contract.js';

export class AgentUnavailableError extends Error {
  readonly missingMcpServers: string[];

  constructor(missingMcpServers: string[]) {
    super(`Agent unavailable: missing required MCP servers: ${missingMcpServers.join(', ')}`);
    this.name = 'AgentUnavailableError';
    this.missingMcpServers = missingMcpServers;
  }
}

export class PermissionDeniedError extends Error {
  readonly action: string;
  readonly reason: string;

  constructor(action: string, reason: string) {
    super(`Permission denied for "${action}": ${reason}`);
    this.name = 'PermissionDeniedError';
    this.action = action;
    this.reason = reason;
  }
}

export class RuntimeNotConfiguredError extends Error {
  readonly code = 'RUNTIME_NOT_CONFIGURED' as const;
  runId?: string;

  constructor(
    message = 'Agent runtime is not configured. Configure a provider before starting agent work.',
  ) {
    super(message);
    this.name = 'RuntimeNotConfiguredError';
  }
}

export class RuntimeMisconfiguredError extends Error {
  readonly code = 'RUNTIME_MISCONFIGURED' as const;
  runId?: string;

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeMisconfiguredError';
  }
}

export function getAgentRunFailureCode(error: unknown): AgentRunFailureCode {
  if (error instanceof RuntimeNotConfiguredError) return error.code;
  if (error instanceof RuntimeMisconfiguredError) return error.code;
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (
      code === 'RUNTIME_NOT_CONFIGURED' ||
      code === 'RUNTIME_MISCONFIGURED' ||
      code === 'PROVIDER_UNAVAILABLE' ||
      code === 'EXECUTION_FAILED'
    ) {
      return code;
    }
  }
  return 'EXECUTION_FAILED';
}

/** Operator-safe, allowlisted failure text. Raw provider errors are never persisted. */
export function getAgentRunFailureSummary(
  error: unknown,
  failureCode: AgentRunFailureCode = getAgentRunFailureCode(error),
): string {
  switch (failureCode) {
    case 'RUNTIME_NOT_CONFIGURED':
      return 'Agent runtime is not configured. Configure an execution provider before retrying.';
    case 'RUNTIME_MISCONFIGURED':
      return 'Agent runtime configuration is invalid. Run openslack agent-runtime doctor for details.';
    case 'PROVIDER_UNAVAILABLE':
      return 'Agent execution provider is unavailable. Check runtime diagnostics and retry.';
    case 'EXECUTION_FAILED':
      return 'Agent execution failed. Inspect runtime diagnostics for details.';
  }
}

// ---------------------------------------------------------------------------
// Bridge session summary (AR-2.5C)
// ---------------------------------------------------------------------------

export interface BridgeSessionSummary {
  runId: string;
  sessionId: string;
  terminalReason?: 'completed' | 'failed' | 'cancelled' | 'timeout';
  resultSummary?: Record<string, unknown>;
  errorDetails?: {
    kind: string;
    message: string;
  };
  tokenUsage?: number;
  toolStats?: {
    totalCalls: number;
    uniqueTools: string[];
    lastTool?: string;
  };
  durationMs?: number;
}
