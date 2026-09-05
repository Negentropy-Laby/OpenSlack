import { describe, expect, it } from 'vitest';

import { selectWorkflowLifecycleCurrentRun } from '../commands/tui.js';

function run(runId: string, status: string, updatedAt: string) {
  return {
    runId,
    workflowName: 'workflow.test',
    status,
    startedAt: '2026-09-04T00:00:00.000Z',
    updatedAt,
  };
}

describe('workflow lifecycle current-run selection', () => {
  it('prefers a live or paused run over a newer terminal run', () => {
    const selected = selectWorkflowLifecycleCurrentRun(
      [
        run('run.completed', 'completed', '2026-09-04T00:10:00.000Z'),
        run('run.paused', 'paused_waiting_approval', '2026-09-04T00:01:00.000Z'),
        run('run.running', 'running', '2026-09-04T00:00:00.000Z'),
      ],
      'workflow.test',
    );

    expect(selected?.runId).toBe('run.running');
  });

  it('uses the newest update when candidates have the same priority', () => {
    const selected = selectWorkflowLifecycleCurrentRun(
      [
        run('run.running.old', 'running', '2026-09-04T00:01:00.000Z'),
        run('run.running.new', 'running', '2026-09-04T00:02:00.000Z'),
      ],
      'workflow.test',
    );

    expect(selected?.runId).toBe('run.running.new');
  });
});
