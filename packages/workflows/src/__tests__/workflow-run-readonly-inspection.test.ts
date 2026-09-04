import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from '../run-store.js';
import {
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
} from '../workflow-control-authority-client.js';
import { createWorkflowRunProjectionStore } from '../workflow-run-projection.js';
import { inspectWorkflowRunReadOnly } from '../workflow-run-readonly-inspection.js';
import { WorkflowRunRouteJournal, WorkflowRunRouter } from '../workflow-run-routing.js';

const roots: string[] = [];
const NOW = '2026-09-04T00:00:00.000Z';
const HASH = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'openslack-readonly-inspection-'));
  roots.push(value);
  return value;
}

describe('GS9-H workflow run read-only inspection', () => {
  it('labels an unrouted TypeScript record as historical evidence', async () => {
    const workspaceRoot = await root();
    const store = new RunStore({
      baseDir: join(workspaceRoot, '.openslack.local', 'workflows'),
    });
    await store.initRun('run.legacy', {
      runId: 'run.legacy',
      workflowName: 'workflow.legacy',
      mode: 'execute',
      manifestHash: HASH,
      args: {},
      startedAt: NOW,
    });

    await expect(
      inspectWorkflowRunReadOnly('run.legacy', { rootDir: workspaceRoot }),
    ).resolves.toMatchObject({
      ownership: 'typescript-historical',
      disposition: 'evidence-only',
      authorityHead: null,
      localEvidence: { runId: 'run.legacy', status: 'running' },
      diagnostics: ['UNROUTED_TYPESCRIPT_HISTORICAL_EVIDENCE'],
    });
  });

  it('uses the durable Go head as authority and reports local projection drift', async () => {
    const workspaceRoot = await root();
    const runId = 'run.go';
    const journal = new WorkflowRunRouteJournal(
      join(workspaceRoot, '.openslack.local', 'workflows', 'routes'),
    );
    const router = new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: 'workspace.test',
      backend: 'go',
      routingEpoch: 21,
      authorityBuildHash: HASH,
      qualificationEnvironmentId: 'gs9h.test',
      workflowAllowlist: ['workflow.go'],
      runAllowlist: [],
      expiresAt: '2026-09-05T00:00:00.000Z',
    });
    const receipt = await journal.commit(
      router.select({
        workspaceId: 'workspace.test',
        runId,
        workflowId: 'workflow.go',
        workflowVersion: '1.0.0',
        workflowSourceHash: HASH,
        manifestHash: HASH,
        inputHash: HASH,
        correlationId: 'correlation.go',
        selectedAt: NOW,
      }),
    );
    await createWorkflowRunProjectionStore(workspaceRoot, 'go').initRun(runId, {
      runId,
      workflowName: 'workflow.go',
      mode: 'execute',
      manifestHash: HASH,
      args: {},
      startedAt: NOW,
    });
    const record = {
      ...workflowControlAuthorityInitialRecord(receipt),
      state: 'paused' as const,
      revision: 2,
      currentPhaseId: 'phase-1',
      currentPhaseIndex: 0,
    };
    const readIfExists = vi.fn(async () => ({
      ...record,
      schema: 'openslack.workflow_control_authority_read.v2' as const,
      recordHash: HASH,
      record,
      updatedAt: NOW,
    }));
    const authority = { readIfExists } as unknown as WorkflowControlAuthorityPort;

    await expect(
      inspectWorkflowRunReadOnly(runId, { rootDir: workspaceRoot, journal, authority }),
    ).resolves.toMatchObject({
      ownership: 'go-workflow-control',
      disposition: 'authoritative-head',
      authorityHead: { state: 'paused', revision: 2 },
      localEvidence: { status: 'running' },
      diagnostics: ['GO_LOCAL_RECOVERY_PROJECTION_STATE_DRIFT'],
    });
    expect(readIfExists).toHaveBeenCalledWith(runId, receipt.route);
  });

  it('does not treat a local Go projection as authority when credentials are absent', async () => {
    const workspaceRoot = await root();
    const runId = 'run.go.authority-required';
    const journal = new WorkflowRunRouteJournal(
      join(workspaceRoot, '.openslack.local', 'workflows', 'routes'),
    );
    const router = new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: 'workspace.test',
      backend: 'go',
      routingEpoch: 21,
      authorityBuildHash: HASH,
      qualificationEnvironmentId: 'gs9h.test',
      workflowAllowlist: ['workflow.go'],
      runAllowlist: [],
      expiresAt: '2026-09-05T00:00:00.000Z',
    });
    await journal.commit(
      router.select({
        workspaceId: 'workspace.test',
        runId,
        workflowId: 'workflow.go',
        workflowVersion: '1.0.0',
        workflowSourceHash: HASH,
        manifestHash: HASH,
        inputHash: HASH,
        correlationId: 'correlation.go',
        selectedAt: NOW,
      }),
    );

    await expect(
      inspectWorkflowRunReadOnly(runId, { rootDir: workspaceRoot, journal }),
    ).resolves.toMatchObject({
      ownership: 'go-workflow-control',
      disposition: 'authority-required',
      authorityHead: null,
      diagnostics: ['GO_AUTHORITY_HEAD_REQUIRED'],
    });
  });
});
