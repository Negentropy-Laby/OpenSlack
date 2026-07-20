import { describe, expect, it } from 'vitest';
import React from 'react';
import { Writable } from 'stream';
import { render } from '@openslack/tui';
import { NavigationProvider } from '../navigation/context.js';
import WorkflowRunsView from '../views/WorkflowRunsView.js';
import { deriveWorkflowRunDecisionSummary } from '../view-models/workflow-runs.js';
import type {
  WorkflowRunProgressItem,
  WorkflowRunProgressViewModel,
} from '../view-models/workflow-runs.js';

function createMockStdout(columns = 100, rows = 50) {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _, cb) {
      chunks.push(String(chunk));
      cb();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { value: false, configurable: true },
  });
  return { stdout, chunks };
}

async function renderRuns(model: WorkflowRunProgressViewModel): Promise<string> {
  const { stdout, chunks } = createMockStdout();
  const instance = await render(
    React.createElement(NavigationProvider, null, React.createElement(WorkflowRunsView, { model })),
    { stdout, patchConsole: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const output = chunks.join('');
  instance.unmount();
  return output;
}

describe('WorkflowRunsView', () => {
  it('shows budget warning, paused approval state, phase agent tree, replay state, and save target', async () => {
    const model: WorkflowRunProgressViewModel = {
      runs: [
        {
          runId: 'run-001',
          workflowName: 'dynamic-audit',
          mode: 'execute',
          status: 'paused_waiting_approval',
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
          elapsedMs: 60_000,
          currentPhase: 'Scan',
          args: {},
          phaseCount: 1,
          agentCount: 1,
          pendingApprovalCount: 1,
          budget: {
            tokenBudget: 100,
            tokensUsed: 90,
            tokensRemaining: 10,
            costEstimateUsd: 0.00018,
            costSource: 'config',
            tokenBudgetPercent: 0.9,
            warningThreshold: 0.8,
            status: 'warning',
            warnings: ['Budget warning: 90% of token budget used.'],
            agentCalls: 1,
            maxAgents: 4,
            maxConcurrency: 2,
            onExceeded: 'pause',
            source: 'manifest',
          },
          phases: [
            {
              phase: 'Scan',
              status: 'running',
              agentCount: 1,
              tokenTotal: 90,
              cachedCount: 0,
              liveCount: 1,
              failedCount: 0,
              warnings: [],
              agents: [
                {
                  id: 'agent-001',
                  label: 'scan-api',
                  phase: 'Scan',
                  status: 'running',
                  cached: false,
                  agentRunId: 'RUN-001',
                  model: 'test-model',
                  runtimeProvider: 'test-provider',
                  isolation: 'none',
                  promptSummary: 'scan all api endpoints',
                  resultSummary: 'still running',
                  replayAvailable: true,
                  tokensUsed: 90,
                  tokensRemaining: 10,
                  recentTools: [],
                  warnings: [],
                },
              ],
            },
          ],
          logTail: [],
          warnings: [],
        },
      ],
      selectedRun: undefined,
      summary: {
        total: 1,
        running: 0,
        paused: 1,
        failed: 0,
        pendingApprovals: 1,
      },
    };

    const output = await renderRuns(model);

    expect(output).toContain('Dynamic Workflows / Runs');
    expect(output).toContain('approvals 1');
    expect(output).toContain('Decision Summary');
    expect(output).toContain('Status: paused_waiting_approval | Owner: human');
    expect(output).toContain('Blocker: 1 pending approval');
    expect(output).toContain('Next action: open approvals');
    expect(output).toContain('Budget 90/100 tokens');
    expect(output).toContain('90%');
    expect(output).toContain('warning');
    expect(output).toContain('cost $0.000180');
    expect(output).toContain('Budget warning: 90% of token budget used.');
    expect(output).toContain('save target Project workflow');
    expect(output).toContain('Save/share workflow source');
    expect(output).toContain('[1] Project workflow - .openslack/workflows');
    expect(output).toContain('[2] Claude project - .claude/workflows');
    expect(output).toContain('[3] User workflow - ~/.claude/workflows');
    expect(output).toContain('[4] Skill package - skills/<name> (CLI only)');
    expect(output).toContain(
      'This saves source only. It does not copy transcripts, secrets, or local evidence.',
    );
    expect(output).toContain('dynamic-audit');
    expect(output).toContain('Scan');
    expect(output).toContain('replay yes');
  });
});

function makeRun(overrides: Partial<WorkflowRunProgressItem> = {}): WorkflowRunProgressItem {
  return {
    runId: 'run-001',
    workflowName: 'dynamic-audit',
    mode: 'execute',
    status: 'running',
    currentPhase: 'Scan',
    args: {},
    phaseCount: 1,
    agentCount: 0,
    pendingApprovalCount: 0,
    budget: {
      tokenBudget: 100,
      tokensUsed: 10,
      tokensRemaining: 90,
      tokenBudgetPercent: 0.1,
      status: 'ok',
      warnings: [],
      agentCalls: 1,
      source: 'manifest',
    },
    phases: [
      {
        phase: 'Scan',
        status: 'running',
        agentCount: 0,
        tokenTotal: 10,
        cachedCount: 0,
        liveCount: 0,
        failedCount: 0,
        agents: [],
        warnings: [],
      },
    ],
    logTail: [],
    warnings: [],
    ...overrides,
  };
}

describe('deriveWorkflowRunDecisionSummary', () => {
  it('maps running runs to workflow ownership', () => {
    expect(deriveWorkflowRunDecisionSummary(makeRun())).toMatchObject({
      status: 'running',
      owner: 'workflow',
      blocker: 'none',
      nextAction: 'watch Scan',
    });
  });

  it('maps paused approvals to human ownership', () => {
    expect(
      deriveWorkflowRunDecisionSummary(
        makeRun({ status: 'paused_waiting_approval', pendingApprovalCount: 2 }),
      ),
    ).toMatchObject({
      owner: 'human',
      blocker: '2 pending approvals',
      nextAction: 'open approvals',
    });
  });

  it('maps budget warning to review budget guidance', () => {
    expect(
      deriveWorkflowRunDecisionSummary(
        makeRun({ budget: { ...makeRun().budget, status: 'warning' } }),
      ),
    ).toMatchObject({
      owner: 'workflow',
      blocker: 'budget warning',
      nextAction: 'review budget / pause / continue',
    });
  });

  it('maps exceeded budget according to policy', () => {
    expect(
      deriveWorkflowRunDecisionSummary(
        makeRun({ budget: { ...makeRun().budget, status: 'exceeded', onExceeded: 'pause' } }),
      ),
    ).toMatchObject({
      owner: 'human',
      blocker: 'budget exceeded',
      nextAction: 'open approvals or increase budget',
    });
    expect(
      deriveWorkflowRunDecisionSummary(
        makeRun({ budget: { ...makeRun().budget, status: 'exceeded', onExceeded: 'fail' } }),
      ),
    ).toMatchObject({
      owner: 'agent/operator',
      blocker: 'budget exceeded',
      nextAction: 'inspect failed budget stop',
    });
  });

  it('maps failed phases to inspection guidance', () => {
    const run = makeRun({
      status: 'running',
      phases: [{ ...makeRun().phases[0]!, phase: 'Verify', status: 'failed' }],
    });
    expect(deriveWorkflowRunDecisionSummary(run)).toMatchObject({
      owner: 'agent/operator',
      blocker: 'failed phase: Verify',
      nextAction: 'inspect failed phase',
    });
  });

  it('maps completed runs to save/share or publish', () => {
    expect(deriveWorkflowRunDecisionSummary(makeRun({ status: 'completed' }))).toMatchObject({
      owner: 'none',
      blocker: 'none',
      nextAction: 'save/share or publish',
    });
  });
});
