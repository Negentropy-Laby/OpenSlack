import { describe, it, expect } from 'vitest';
import { proposeWorkspacePR } from '../propose.js';
import type { AgentPermissionSnapshot } from '@openslack/kernel';

function makeSnapshot(actionVerdict: 'allow' | 'ask' | 'deny'): AgentPermissionSnapshot {
  return {
    principal: {
      registry_id: 'test_agent',
      runtime_uid: 'uid-001',
      run_id: 'RUN-001',
      provider: 'cli',
    },
    registry_entry_agent_id: 'test_agent',
    permissions: {
      paths: { allow: ['packages/runtime/**'], deny: [] },
      actions: { 'pr.propose': actionVerdict },
      github: { can_create_pr: true, can_comment: true, can_approve: false, can_merge: false },
      max_risk_zone: 'yellow',
    },
    resolved_at: new Date().toISOString(),
    source: 'registry_v2',
  };
}

describe('proposeWorkspacePR authorization', () => {
  it('blocks when agent authorization requires confirmation', async () => {
    const result = await proposeWorkspacePR({
      agentId: 'test_agent',
      taskId: 'TASK-1',
      runId: 'RUN-001',
      changedPaths: ['packages/runtime/src/tick.ts'],
      snapshot: makeSnapshot('ask'),
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Authorization requires confirmation');
  });

  it('blocks when changed paths exceed the agent risk ceiling', async () => {
    const result = await proposeWorkspacePR({
      agentId: 'test_agent',
      taskId: 'TASK-1',
      runId: 'RUN-001',
      changedPaths: ['packages/kernel/src/index.ts'],
      snapshot: makeSnapshot('allow'),
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Authorization denied');
    expect(result.errors[0]).toContain('red');
  });
});
