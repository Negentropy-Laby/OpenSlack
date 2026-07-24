import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { parseTaskLinkMetadata, proposeWorkspacePR, renderTaskLinkMetadata } from '../propose.js';
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
  it('round-trips the structured task-link marker', () => {
    const body = renderTaskLinkMetadata({
      schema: 'openslack.task_link.v1',
      issue_number: 42,
      agent_id: 'test-agent',
      task_id: 'TASK-42',
      run_id: 'RUN-42',
      claim_ref: 'refs/heads/openslack/claims/issue-42',
    });
    expect(parseTaskLinkMetadata(body)).toEqual({
      schema: 'openslack.task_link.v1',
      issue_number: 42,
      agent_id: 'test-agent',
      task_id: 'TASK-42',
      run_id: 'RUN-42',
      claim_ref: 'refs/heads/openslack/claims/issue-42',
    });
  });

  it('rejects malformed task-link metadata', () => {
    expect(
      parseTaskLinkMetadata(
        '<!-- openslack-task-link {"schema":"openslack.task_link.v1","issue_number":"42"} -->',
      ),
    ).toBeNull();
    expect(
      parseTaskLinkMetadata(
        renderTaskLinkMetadata({
          schema: 'openslack.task_link.v1',
          issue_number: 42,
          agent_id: 'test-agent',
          task_id: 'TASK-42',
          run_id: 'RUN-42',
          claim_ref: 'refs/heads/openslack/claims/issue-99',
        }),
      ),
    ).toBeNull();
  });

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

  it('blocks a non-main base before delivery or workspace mutation', async () => {
    const publish = vi.fn();
    const result = await proposeWorkspacePR({
      agentId: 'test_agent',
      taskId: 'TASK-1',
      runId: 'RUN-001',
      changedPaths: ['docs/readme.md'],
      baseBranch: 'release/0.3',
      deliveryService: { publish },
    });

    expect(result).toMatchObject({
      success: false,
      riskZone: 'unknown',
      errors: [expect.stringContaining('DELIVERY_BASE_FORBIDDEN')],
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('commits locally and delegates publication to GitHubDeliveryService', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-propose-delivery-'));
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: root });
      writeFileSync(
        join(root, 'openslack.yaml'),
        'canonical_remote:\n  owner: acme\n  repo: project\n',
        'utf-8',
      );
      writeFileSync(join(root, 'work.txt'), 'before\n', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'test: seed workspace'], { cwd: root });
      writeFileSync(join(root, 'work.txt'), 'after\n', 'utf-8');
      const publish = vi.fn(async () => ({
        state: 'AWAITING_GATES' as const,
        history: [
          'PREPARED',
          'PUSHED',
          'PR_CREATED',
          'HEAD_SYNCHRONIZED',
          'AWAITING_GATES',
        ] as const,
        action: 'created' as const,
        prNumber: 7,
        prUrl: 'https://github.com/acme/project/pull/7',
        branchSha: 'a'.repeat(40),
        prHeadSha: 'a'.repeat(40),
        checks: [],
        checksStatus: 'empty' as const,
        permissions: [],
        evidenceTimestamp: '2026-07-11T00:00:00.000Z',
      }));
      const result = await proposeWorkspacePR({
        agentId: 'test-agent',
        taskId: 'TASK-7',
        runId: 'RUN-7',
        issueNumber: 42,
        changedPaths: ['work.txt'],
        rootDir: root,
        deliveryService: { publish },
      });
      expect(result).toMatchObject({
        success: true,
        prUrl: 'https://github.com/acme/project/pull/7',
        delivery: { state: 'AWAITING_GATES' },
      });
      expect(result.prBody).toContain('<!-- openslack-task-link');
      expect(parseTaskLinkMetadata(result.prBody)).toMatchObject({
        issue_number: 42,
        agent_id: 'test-agent',
        claim_ref: 'refs/heads/openslack/claims/issue-42',
      });
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ rootDir: root, owner: 'acme', repo: 'project' }),
      );
      expect(
        execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf-8' }).trim(),
      ).toBe('runtime: deliver TASK-7 workspace changes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to include paths that were already staged by another operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-propose-staged-'));
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: root });
      writeFileSync(
        join(root, 'openslack.yaml'),
        'canonical_remote:\n  owner: acme\n  repo: project\n',
        'utf-8',
      );
      writeFileSync(join(root, 'work.txt'), 'before\n', 'utf-8');
      writeFileSync(join(root, 'unexpected.txt'), 'before\n', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'test: seed workspace'], { cwd: root });
      writeFileSync(join(root, 'work.txt'), 'after\n', 'utf-8');
      writeFileSync(join(root, 'unexpected.txt'), 'staged elsewhere\n', 'utf-8');
      execFileSync('git', ['add', 'unexpected.txt'], { cwd: root });
      const publish = vi.fn();

      const result = await proposeWorkspacePR({
        agentId: 'test-agent',
        taskId: 'TASK-8',
        runId: 'RUN-8',
        changedPaths: ['work.txt'],
        rootDir: root,
        deliveryService: { publish },
      });

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('already contains staged paths');
      expect(publish).not.toHaveBeenCalled();
      expect(
        execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf-8' }).trim(),
      ).toBe('test: seed workspace');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
