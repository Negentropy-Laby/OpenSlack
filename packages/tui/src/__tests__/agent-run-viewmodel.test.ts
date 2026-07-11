import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTranscriptEvent, type AgentRunState } from '@openslack/agent-runtime';
import { mapAgentRunToViewModel } from '../view-models/agent-run.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-run-viewmodel-test-'));
}

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('mapAgentRunToViewModel', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('derives bridge observability fields from transcript events', () => {
    const runId = 'RUN-20260603-ABCDEFGH';
    appendTranscriptEvent(
      runId,
      {
        timestamp: '2026-06-03T00:00:00.000Z',
        type: 'start',
        data: {
          agentId: 'anthropic_architect_aby',
          runtime: 'aby_assistant',
          provider: 'aby',
          bridgeMode: 'process',
          permissionMode: 'plan',
          allowedTools: ['Read'],
          requiredMcpServers: ['github'],
        },
      },
      root,
    );
    appendTranscriptEvent(
      runId,
      {
        timestamp: '2026-06-03T00:00:01.000Z',
        type: 'progress',
        data: {
          step: 'bridge_session_started',
          sessionId: 'bridge-RUN-20260603-ABCDEFGH',
        },
      },
      root,
    );
    appendTranscriptEvent(
      runId,
      {
        timestamp: '2026-06-03T00:00:02.000Z',
        type: 'progress',
        data: {
          step: 'bridge_mcp_availability',
          required: ['github'],
          available: ['github', 'filesystem'],
        },
      },
      root,
    );
    appendTranscriptEvent(
      runId,
      {
        timestamp: '2026-06-03T00:00:03.000Z',
        type: 'progress',
        data: {
          step: 'tool_denied',
          toolName: 'github.pr.merge',
        },
      },
      root,
    );
    appendTranscriptEvent(
      runId,
      {
        timestamp: '2026-06-03T00:00:04.000Z',
        type: 'progress',
        data: {
          step: 'bridge_session_completed',
          sessionId: 'bridge-RUN-20260603-ABCDEFGH',
          terminalReason: 'completed',
        },
      },
      root,
    );

    const state: AgentRunState = {
      runId,
      status: 'completed',
      agentId: 'anthropic_architect_aby',
      startedAt: '2026-06-03T00:00:00.000Z',
      completedAt: '2026-06-03T00:00:05.000Z',
      tokensUsed: 7,
      tokensRemaining: null,
      toolCalls: 1,
      lastTool: 'Read',
      transcriptPath: join(root, '.openslack.local', 'agents', 'runs', runId, 'transcript.jsonl'),
      worktreePath: join(root, 'wt'),
      worktreeHandoff: {
        worktreePath: join(root, 'wt'),
        branchName: 'agent/anthropic_architect_aby/run',
        reason: 'Uncommitted changes detected',
        preservedAt: '2026-06-03T00:00:05.000Z',
      },
    };

    const model = mapAgentRunToViewModel(state, { rootDir: root });

    expect(model.runtimeProvider).toBe('aby / aby_assistant / process');
    expect(model.bridgeSessionId).toBe('bridge-RUN-20260603-ABCDEFGH');
    expect(model.terminalReason).toBe('completed');
    expect(model.mcpRequired).toEqual(['github']);
    expect(model.mcpAvailable).toEqual(['github', 'filesystem']);
    expect(model.permissionDenies).toBe(1);
    expect(model.worktreeHandoffStatus).toContain('preserved');
  });

  it('resolves relative transcript paths from the current working directory when rootDir is omitted', () => {
    const runId = 'RUN-20260603-RELATIVE';
    appendTranscriptEvent(
      runId,
      {
        timestamp: '2026-06-03T00:00:00.000Z',
        type: 'start',
        data: {
          agentId: 'anthropic_architect_aby',
          runtime: 'aby_assistant',
          provider: 'aby',
          bridgeMode: 'process',
        },
      },
      root,
    );

    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const state: AgentRunState = {
        runId,
        status: 'running',
        agentId: 'anthropic_architect_aby',
        startedAt: '2026-06-03T00:00:00.000Z',
        tokensUsed: 0,
        tokensRemaining: null,
        toolCalls: 0,
        transcriptPath: join('.openslack.local', 'agents', 'runs', runId, 'transcript.jsonl'),
      };

      const model = mapAgentRunToViewModel(state);

      expect(model.events).toHaveLength(1);
      expect(model.runtimeProvider).toBe('aby / aby_assistant / process');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('surfaces a fail-closed runtime code when no bridge session was started', () => {
    const runId = 'RUN-20260603-NOCONFIG';
    const state: AgentRunState = {
      runId,
      status: 'failed',
      agentId: 'unconfigured-agent',
      startedAt: '2026-06-03T00:00:00.000Z',
      completedAt: '2026-06-03T00:00:00.000Z',
      failureCode: 'RUNTIME_NOT_CONFIGURED',
      errorSummary: 'Agent runtime is not configured.',
      tokensUsed: 0,
      tokensRemaining: null,
      toolCalls: 0,
      transcriptPath: join(root, '.openslack.local', 'agents', 'runs', runId, 'transcript.jsonl'),
    };

    const model = mapAgentRunToViewModel(state, { rootDir: root });

    expect(model.runtimeProvider).toBe('not recorded');
    expect(model.bridgeSessionId).toBe('not recorded');
    expect(model.terminalReason).toBe('RUNTIME_NOT_CONFIGURED');
  });
});
