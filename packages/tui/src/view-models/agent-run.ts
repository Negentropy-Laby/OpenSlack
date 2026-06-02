import type { AgentRunState, AgentRunEvent } from '@openslack/agent-runtime';
import { readTranscript } from '@openslack/agent-runtime';

export interface AgentRunViewModel {
  runId: string;
  status: string;
  agentName: string;
  model?: string;
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

export function mapAgentRunToViewModel(state: AgentRunState): AgentRunViewModel {
  const transcript = readTranscript(state.runId);
  const startEvent = transcript.find((e) => e.type === 'start');
  const completeEvent = transcript.find((e) => e.type === 'complete');

  return {
    runId: state.runId,
    status: state.status,
    agentName: state.agentId,
    model: state.model,
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
