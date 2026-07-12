import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentRunState, AgentRunEvent } from '@openslack/agent-runtime';

export interface AgentRunViewModel {
  runId: string;
  status: string;
  agentName: string;
  model?: string;
  runtimeProvider: string;
  bridgeSessionId: string;
  terminalReason: string;
  mcpRequired: string[];
  mcpAvailable: string[];
  permissionDenies: number;
  worktreeHandoffStatus: string;
  tools: string[];
  permissionMode: string;
  worktreePath?: string;
  lastTool?: string;
  tokensUsed: number;
  tokensRemaining: number | null;
  transcriptPath: string;
  result?: string;
  error?: string;
  events: AgentRunEvent[];
}

export function mapAgentRunToViewModel(
  state: AgentRunState,
  options: { rootDir?: string } = {},
): AgentRunViewModel {
  const transcript = readTranscriptFromState(state, options.rootDir);
  const startEvent = transcript.find((e) => e.type === 'start');
  const completeEvent = transcript.find((e) => e.type === 'complete');
  const bridgeStarted = transcript.find(
    (e) => e.type === 'progress' && e.data.step === 'bridge_session_started',
  );
  const bridgeCompleted = [...transcript].reverse().find(
    (e) => e.type === 'progress' && e.data.step === 'bridge_session_completed',
  );
  const bridgeFailed = [...transcript].reverse().find(
    (e) => e.type === 'progress' && e.data.step === 'bridge_session_failed',
  );
  const mcpAvailability = [...transcript].reverse().find(
    (e) => e.type === 'progress' && e.data.step === 'bridge_mcp_availability',
  );
  const permissionDenies = transcript.filter(
    (e) =>
      e.type === 'progress' &&
      (e.data.step === 'tool_denied' ||
        e.data.step === 'bridge_approval_required' ||
        e.data.errorKind === 'permission_denied'),
  ).length;

  return {
    runId: state.runId,
    status: state.status,
    agentName: state.agentId,
    model: state.model,
    runtimeProvider: formatRuntimeProvider(startEvent?.data),
    bridgeSessionId: String(
      bridgeStarted?.data.sessionId ??
        bridgeCompleted?.data.sessionId ??
        bridgeFailed?.data.sessionId ??
        'not recorded',
    ),
    terminalReason: String(
      bridgeCompleted?.data.terminalReason ??
        (bridgeFailed
          ? (bridgeFailed.data.errorKind ?? 'failed')
          : (state.failureCode ?? 'not recorded')),
    ),
    mcpRequired: readStringArray(
      mcpAvailability?.data.required ?? startEvent?.data.requiredMcpServers,
    ),
    mcpAvailable: readStringArray(mcpAvailability?.data.available ?? startEvent?.data.mcpServers),
    permissionDenies,
    worktreeHandoffStatus: state.worktreeHandoff
      ? `preserved: ${state.worktreeHandoff.branchName}`
      : state.worktreePath
        ? 'not recorded'
        : 'none',
    tools: (startEvent?.data.allowedTools as string[]) ?? [],
    permissionMode: (startEvent?.data.permissionMode as string) ?? 'default',
    worktreePath: state.worktreePath,
    lastTool: state.lastTool,
    tokensUsed: state.tokensUsed,
    tokensRemaining: state.tokensRemaining,
    transcriptPath: state.transcriptPath,
    result: completeEvent?.data.result ? JSON.stringify(completeEvent.data.result) : undefined,
    error: state.error,
    events: transcript,
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readTranscriptFromState(state: AgentRunState, rootDir?: string): AgentRunEvent[] {
  const transcriptPath =
    rootDir && !isAbsolute(state.transcriptPath)
      ? resolve(rootDir, state.transcriptPath)
      : state.transcriptPath;

  if (!existsSync(transcriptPath)) return [];

  const raw = readFileSync(transcriptPath, 'utf-8');
  const events: AgentRunEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AgentRunEvent);
    } catch {
      // Keep TUI read-only and tolerant of a partially written transcript.
    }
  }
  return events;
}

function formatRuntimeProvider(data: Record<string, unknown> | undefined): string {
  const runtime = typeof data?.runtime === 'string' ? data.runtime : undefined;
  const runtimeProvider =
    typeof data?.runtimeProvider === 'string' ? data.runtimeProvider : undefined;
  const provider = typeof data?.provider === 'string' ? data.provider : undefined;
  const bridgeMode = typeof data?.bridgeMode === 'string' ? data.bridgeMode : undefined;
  const parts = [runtimeProvider ?? provider, runtime, bridgeMode].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'not recorded';
}
