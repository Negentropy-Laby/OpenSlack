import type { PermissionMode } from '@openslack/kernel';

export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  isolation?: string;
  prompt?: string;
  effort?: 'low' | 'medium' | 'high';
  hooks?: { before?: string; after?: string };
  initialPrompt?: string;
  background?: boolean;
  requiredMcpServers?: string[];
  criticalSystemReminder?: string;
  remote?: boolean;
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
  error?: string;
  worktreePath?: string;
  transcriptPath: string;
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
