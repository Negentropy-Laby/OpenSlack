import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkflowControlObservation } from '../workflow-control-observation.js';
import type { WorkflowControlObservationError } from '../workflow-control-observation.js';
import { hashWorkflowControlValue } from '../workflow-control-contract.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function authorityFixture(manifestHash = 'a'.repeat(64)) {
  const root = resolve(await mkdtemp(join(tmpdir(), 'workflow-observation-')));
  roots.push(root);
  const runId = 'run-observation-test';
  const runRoot = join(root, '.openslack.local', 'workflows', 'runs', runId);
  await mkdir(join(runRoot, 'agents'), { recursive: true });
  await writeFile(
    join(runRoot, 'meta.json'),
    JSON.stringify({
      runId,
      workflowName: 'Contract to Delivery',
      mode: 'execute',
      manifestHash,
      args: { customer: 'not-exported' },
      startedAt: '2026-08-03T00:00:00.000Z',
      budgetPolicy: { tokenBudget: 1000, maxAgents: 2, onExceeded: 'pause' },
    }),
  );
  await writeFile(
    join(runRoot, 'status.json'),
    JSON.stringify({
      runId,
      status: 'paused_waiting_approval',
      currentPhase: 'Review contract',
      updatedAt: '2026-08-03T00:00:02.000Z',
      phases: [
        {
          phase: 'Prepare contract',
          timestamp: '2026-08-03T00:00:01.000Z',
          status: 'completed',
          result: { safeProjectionInput: true },
          cacheKey: 'agent cache 1',
        },
      ],
      budgetWarnings: [
        {
          timestamp: '2026-08-03T00:00:02.000Z',
          kind: 'threshold',
          message: 'not exported',
          tokensUsed: 250,
          tokenBudget: 1000,
          percent: 0.25,
          costUsd: 0.01,
        },
      ],
    }),
  );
  await writeFile(
    join(runRoot, 'pending-approvals.json'),
    JSON.stringify([
      {
        id: 'approval-1',
        operation: 'example',
        detail: 'credential-like prose is counted, never exported',
        timestamp: '2026-08-03T00:00:01.000Z',
        status: 'pending',
      },
    ]),
  );
  await writeFile(
    join(runRoot, 'agents', 'agent-1.json'),
    JSON.stringify({
      data: { output: 'not-exported' },
      tokenUsage: 250,
      workflowEvidence: { tokenUsage: 250, promptSummary: 'not-exported' },
    }),
  );
  return { root, runId, runRoot };
}

describe('Workflow Control GS7-B authoritative observation builder', () => {
  it('derives only hashes, counts, and durable budget evidence', async () => {
    const fixture = await authorityFixture();
    const observation = await buildWorkflowControlObservation({
      rootDir: fixture.root,
      runId: fixture.runId,
    });
    expect(observation).toMatchObject({
      authority: 'typescript',
      runId: fixture.runId,
      workflowName: 'Contract to Delivery',
      status: 'paused_waiting_approval',
      approvals: {
        legacyRunGate: { counts: { pending: 1, approved: 0, rejected: 0 } },
        effectV2: { counts: { pending: 0, approved: 0, rejected: 0 } },
      },
      budget: { configured: true, tokenBudget: 1000, tokensUsed: 250, agentCalls: 1 },
    });
    expect(observation.phases[0]).toEqual({
      phase: 'Prepare contract',
      observedAt: '2026-08-03T00:00:01.000Z',
      status: 'completed',
      resultHash: hashWorkflowControlValue({ safeProjectionInput: true }),
      cacheKeyHash: hashWorkflowControlValue('agent cache 1'),
    });
    const bytes = JSON.stringify(observation);
    expect(bytes).not.toContain('customer');
    expect(bytes).not.toContain('credential-like');
    expect(bytes).not.toContain('promptSummary');
    expect(bytes).not.toContain('not-exported');
  });

  it('diagnoses old 16-hex manifest hashes instead of padding or fabricating them', async () => {
    const fixture = await authorityFixture('0123456789abcdef');
    await expect(
      buildWorkflowControlObservation({ rootDir: fixture.root, runId: fixture.runId }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_CONTROL_OBSERVATION_LEGACY_MANIFEST_HASH',
    } satisfies Partial<WorkflowControlObservationError>);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked authoritative status file',
    async () => {
      const fixture = await authorityFixture();
      const status = join(fixture.runRoot, 'status.json');
      const bytes = await readFile(status);
      const target = join(fixture.root, 'outside-status.json');
      const { rm } = await import('node:fs/promises');
      await writeFile(target, bytes);
      await rm(status);
      await symlink(target, status);
      await expect(
        buildWorkflowControlObservation({ rootDir: fixture.root, runId: fixture.runId }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_CONTROL_OBSERVATION_PATH_UNSAFE' });
    },
  );
});
