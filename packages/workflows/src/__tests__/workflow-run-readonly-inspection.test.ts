import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from '../run-store.js';
import {
  isWorkflowControlAuthorityHeadBoundToRoute,
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
  type WorkflowControlAuthorityRunRead,
} from '../workflow-control-authority-client.js';
import { canonicalWorkflowControlAuthorityJson } from '../workflow-control-authority-contract.js';
import type { WorkflowControlShadowJournalSecurityDependencies } from '../workflow-control-shadow.js';
import { createWorkflowRunProjectionStore } from '../workflow-run-projection.js';
import { inspectWorkflowRunReadOnly } from '../workflow-run-readonly-inspection.js';
import {
  WorkflowRunRouteJournal,
  WorkflowRunRouter,
  WorkflowRunRoutingError,
} from '../workflow-run-routing.js';

const roots: string[] = [];
const NOW = '2026-09-04T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const UNIT_JOURNAL_SECURITY: WorkflowControlShadowJournalSecurityDependencies = Object.freeze({
  platform: 'win32',
  currentWindowsSid: () => 'S-1-5-21-1000',
  readWindowsPathSecurity: () =>
    JSON.stringify({
      owner: 'S-1-5-21-1000',
      protected: true,
      reparse: false,
      rules: [
        { sid: 'S-1-5-21-1000', type: 'Allow' },
        { sid: 'S-1-5-18', type: 'Allow' },
      ],
    }),
  hardenPath: () => undefined,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'openslack-readonly-inspection-'));
  roots.push(value);
  return value;
}

function recordHash(record: WorkflowControlAuthorityRunRead['record']): string {
  return createHash('sha256')
    .update(`${canonicalWorkflowControlAuthorityJson(record)}\n`, 'utf8')
    .digest('hex');
}

describe('GS9-H workflow run read-only inspection', () => {
  it('checks every receipt/envelope identity field through the shared authority verifier', () => {
    const receipt = new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: 'workspace.test',
      backend: 'go',
      routingEpoch: 21,
      authorityBuildHash: HASH,
      qualificationEnvironmentId: 'gs9h.test',
      workflowAllowlist: ['workflow.go'],
      runAllowlist: [],
      expiresAt: '2026-09-05T00:00:00.000Z',
    }).select({
      workspaceId: 'workspace.test',
      runId: 'run.shared-verifier',
      workflowId: 'workflow.go',
      workflowVersion: '1.0.0',
      workflowSourceHash: HASH,
      manifestHash: HASH,
      inputHash: HASH,
      correlationId: 'correlation.shared-verifier',
      selectedAt: NOW,
    });
    const record = workflowControlAuthorityInitialRecord(receipt);
    const head: WorkflowControlAuthorityRunRead = {
      ...record,
      schema: 'openslack.workflow_control_authority_read.v2',
      recordHash: recordHash(record),
      record,
      updatedAt: NOW,
    };
    const drifts: WorkflowControlAuthorityRunRead[] = [
      { ...head, workspaceId: 'workspace.other' },
      { ...head, runId: 'run.other' },
      { ...head, workflowId: 'workflow.other' },
      { ...head, workflowVersion: '2.0.0' },
      { ...head, workflowSourceHash: 'b'.repeat(64) },
      { ...head, manifestHash: 'c'.repeat(64) },
      { ...head, inputHash: 'd'.repeat(64) },
      { ...head, route: { ...head.route, backend: 'ts-local' } },
      { ...head, route: { ...head.route, authority: 'typescript' } },
      { ...head, route: { ...head.route, routingEpoch: 22 } },
      { ...head, route: { ...head.route, authorityBuildHash: 'e'.repeat(64) } },
    ];

    expect(isWorkflowControlAuthorityHeadBoundToRoute(receipt, head)).toBe(true);
    for (const drift of drifts) {
      expect(isWorkflowControlAuthorityHeadBoundToRoute(receipt, drift)).toBe(false);
    }
  });

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
      localEvidence: {
        typescriptHistorical: { runId: 'run.legacy', status: 'running' },
        goRecovery: null,
      },
      diagnostics: ['UNROUTED_TYPESCRIPT_HISTORICAL_EVIDENCE'],
    });
  });

  it('uses the durable Go head as authority and reports local projection drift', async () => {
    const workspaceRoot = await root();
    const runId = 'run.go';
    const journal = new WorkflowRunRouteJournal(
      join(workspaceRoot, '.openslack.local', 'workflows', 'routes'),
      UNIT_JOURNAL_SECURITY,
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
      recordHash: recordHash(record),
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
      localEvidence: {
        typescriptHistorical: null,
        goRecovery: { status: 'running' },
      },
      diagnostics: ['GO_LOCAL_RECOVERY_PROJECTION_STATE_DRIFT'],
    });
    expect(readIfExists).toHaveBeenCalledWith(runId, receipt.route);
  });

  it('does not treat a local Go projection as authority when credentials are absent', async () => {
    const workspaceRoot = await root();
    const runId = 'run.go.authority-required';
    const journal = new WorkflowRunRouteJournal(
      join(workspaceRoot, '.openslack.local', 'workflows', 'routes'),
      UNIT_JOURNAL_SECURITY,
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

  it('returns reconciliation evidence for read-only route failures instead of throwing', async () => {
    const workspaceRoot = await root();
    const journal = {
      async locateReadOnly() {
        throw new WorkflowRunRoutingError(
          'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
          'unsafe route fixture',
        );
      },
    };

    const inspection = await inspectWorkflowRunReadOnly('run.route-error', {
      rootDir: workspaceRoot,
      journal,
    });

    expect(inspection).toMatchObject({
      ownership: 'unresolved-route',
      disposition: 'reconciliation-required',
      route: null,
      diagnostics: ['WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED'],
    });
  });

  it('reports both unrouted projections as ambiguous reconciliation evidence', async () => {
    const workspaceRoot = await root();
    const runId = 'run.dual';
    for (const backend of ['ts-local', 'go'] as const) {
      await createWorkflowRunProjectionStore(workspaceRoot, backend).initRun(runId, {
        runId,
        workflowName: 'workflow.dual',
        mode: 'execute',
        manifestHash: HASH,
        args: {},
        startedAt: NOW,
      });
    }

    await expect(
      inspectWorkflowRunReadOnly(runId, { rootDir: workspaceRoot }),
    ).resolves.toMatchObject({
      ownership: 'unresolved-route',
      disposition: 'reconciliation-required',
      localEvidence: {
        typescriptHistorical: { runId },
        goRecovery: { runId },
      },
      diagnostics: expect.arrayContaining(['AMBIGUOUS_UNROUTED_LOCAL_PROJECTIONS']),
    });
  });

  it('keeps an authenticated Go head authoritative when local recovery JSON is unreadable', async () => {
    const workspaceRoot = await root();
    const runId = 'run.go.corrupt-local';
    const journal = new WorkflowRunRouteJournal(
      join(workspaceRoot, '.openslack.local', 'workflows', 'routes'),
      UNIT_JOURNAL_SECURITY,
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
    const record = workflowControlAuthorityInitialRecord(receipt);
    const head: WorkflowControlAuthorityRunRead = {
      ...record,
      schema: 'openslack.workflow_control_authority_read.v2',
      recordHash: recordHash(record),
      record,
      updatedAt: NOW,
    };
    const statusDir = join(
      workspaceRoot,
      '.openslack.local',
      'workflows',
      'go-recovery-projections',
      'runs',
      runId,
    );
    await mkdir(statusDir, { recursive: true });
    await writeFile(join(statusDir, 'status.json'), '{', 'utf8');
    const authority = {
      async readIfExists() {
        return head;
      },
    } as unknown as WorkflowControlAuthorityPort;

    const inspection = await inspectWorkflowRunReadOnly(runId, {
      rootDir: workspaceRoot,
      journal,
      authority,
    });
    expect(inspection).toMatchObject({
      disposition: 'authoritative-head',
      diagnostics: ['GO_RECOVERY_PROJECTION_UNREADABLE'],
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection?.authorityHead)).toBe(true);
    expect(Object.isFrozen(inspection?.localEvidence)).toBe(true);
    expect(Object.isFrozen(inspection?.diagnostics)).toBe(true);
  });

  it.each([
    ['workspaceId', 'workspace.other'],
    ['runId', 'run.other'],
    ['revision', 2],
    ['state', 'running'],
  ] as const)('rejects record/envelope drift in %s', async (field, value) => {
    const workspaceRoot = await root();
    const runId = `run.drift.${field}`;
    const journal = new WorkflowRunRouteJournal(
      join(workspaceRoot, '.openslack.local', 'workflows', 'routes'),
      UNIT_JOURNAL_SECURITY,
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
        correlationId: `correlation.${field}`,
        selectedAt: NOW,
      }),
    );
    const baseRecord = workflowControlAuthorityInitialRecord(receipt);
    const record = { ...baseRecord, [field]: value } as typeof baseRecord;
    const head: WorkflowControlAuthorityRunRead = {
      ...baseRecord,
      schema: 'openslack.workflow_control_authority_read.v2',
      recordHash: recordHash(record),
      record,
      updatedAt: NOW,
    };
    const authority = {
      async readIfExists() {
        return head;
      },
    } as unknown as WorkflowControlAuthorityPort;

    await expect(
      inspectWorkflowRunReadOnly(runId, { rootDir: workspaceRoot, journal, authority }),
    ).resolves.toMatchObject({
      disposition: 'reconciliation-required',
      diagnostics: ['GO_AUTHORITY_HEAD_ROUTE_RECEIPT_DRIFT'],
    });
  });
});
