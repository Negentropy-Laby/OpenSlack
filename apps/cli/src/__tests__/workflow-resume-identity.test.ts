import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collaborationCommands } from '../commands/collaboration.js';
import * as workflows from '@openslack/workflows';

const state = vi.hoisted(() => ({
  bytes: new Uint8Array(),
  route: {} as unknown,
  meta: {} as unknown,
  status: 'paused',
  submit: vi.fn(),
  find: vi.fn(),
  load: vi.fn(),
}));
vi.mock('@openslack/workflows', async () => {
  const actual =
    await vi.importActual<typeof import('@openslack/workflows')>('@openslack/workflows');
  return {
    ...actual,
    readWorkflowPolicy: vi.fn(() => ({ enabled: true })),
    loadWorkflowRunnerControlConfig: vi.fn(() => ({ workspaceId: 'workspace.test' })),
    loadWorkflowRunRoutingConfig: vi.fn(() => ({})),
    createWorkflowRunRoutingExecutionContext: vi.fn(() => ({
      routing: {},
      journal: { locateReadOnly: async () => ({ receipt: state.route, state: 'active' }) },
    })),
    openWorkflowRunReadOnly: vi.fn(() => ({
      runExists: async () => true,
      getRunStatus: async () => ({ status: state.status }),
      loadMeta: async () => state.meta,
      loadPhaseCheckpoint: async () => null,
    })),
    findWorkflow: state.find,
    loadWorkflow: state.load,
    readWorkflowRunnerSourceBytes: vi.fn(async () => state.bytes),
    executeWorkflowThroughRunner: state.submit,
  };
});
vi.mock('@openslack/github', async () => ({
  ...(await vi.importActual<typeof import('@openslack/github')>('@openslack/github')),
  publishWorkflowRunAudit: vi.fn(async () => ({
    issueNumber: 1,
    url: 'https://example.test/audit',
  })),
}));
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
  state.status = 'paused';
  state.bytes = Buffer.from('unchanged source');
  const meta = {
    name: 'resume-test',
    description: 'Resume test',
    phases: [{ title: 'Run', detail: 'Run' }],
  };
  const snapshot = workflows.createWorkflowSourceSnapshot(state.bytes, meta);
  state.meta = {
    runId: 'run.test',
    workflowName: meta.name,
    mode: 'execute',
    manifestHash: snapshot.rawHash,
    args: {},
    startedAt: '2020-01-01T00:00:00.000Z',
  };
  state.route = workflows.validateWorkflowRunRouteReceipt({
    schema: 'openslack.workflow_run_route_receipt.v1',
    workspaceId: 'workspace.test',
    runId: 'run.test',
    workflowId: meta.name,
    workflowVersion: '0.0.0',
    workflowSourceHash: snapshot.workflowSourceHash,
    manifestHash: snapshot.manifestHash,
    inputHash: 'a'.repeat(64),
    route: {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 1,
      authorityBuildHash: 'b'.repeat(64),
    },
    policyHash: 'c'.repeat(64),
    correlationId: 'correlation.test',
    qualificationEnvironmentId: 'test',
    selectedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-02T00:00:00.000Z',
  });
  state.find.mockResolvedValue({ path: 'resume-test.mjs', source: 'openslack-project' });
  state.load.mockResolvedValue({
    meta,
    format: 'openslack-native',
    hash: snapshot.rawHash,
    sourceSnapshot: snapshot,
    run: async () => ({ status: 'completed' }),
  });
  state.submit.mockResolvedValue({ status: 'completed', runId: 'run.test' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});
const resume = () =>
  collaborationCommands().parseAsync(['workflow', 'resume', 'run.test', '--yes'], { from: 'user' });
describe('Go resume CLI boundary', () => {
  it('submits verified historical identity using the final source snapshot', async () => {
    await resume();
    expect(state.submit).toHaveBeenCalledOnce();
    expect(state.submit.mock.calls[0][0]).toMatchObject({
      workflowSourceBytes: state.bytes,
      sourceSnapshot: expect.objectContaining({
        workflowSourceHash: (state.route as workflows.WorkflowRunRouteReceipt).workflowSourceHash,
      }),
    });
    expect(process.exitCode).toBeUndefined();
  });
  it('rejects confirmation-time drift before runner submission', async () => {
    vi.mocked(console.log).mockImplementation((message) => {
      if (String(message).includes('[UNATTENDED-ADMISSION]'))
        state.bytes = Buffer.from('changed during confirmation');
    });
    await resume();
    expect(state.submit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('SOURCE_DRIFT');
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'runs inspect run.test',
    );
  });
  it('reports terminal state before importing a changed workflow', async () => {
    state.status = 'completed';
    state.load.mockRejectedValue(new Error('unreachable drift'));
    await resume();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.submit).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('STATUS_NOT_RESUMABLE');
  });
  it('reports missing execution function without an extra source read', async () => {
    const loaded = await state.load();
    state.load.mockResolvedValue({ ...loaded, run: undefined });
    await resume();
    expect(workflows.readWorkflowRunnerSourceBytes).not.toHaveBeenCalled();
    expect(state.submit).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('no run function');
  });
  it('reports route drift with typed diagnostics and does not submit', async () => {
    state.route = { ...(state.route as object), manifestHash: 'f'.repeat(64) };
    await resume();
    expect(state.submit).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('MANIFEST_DRIFT');
  });
  it('publishes the submitted v2 source identity in audit evidence', async () => {
    const { publishWorkflowRunAudit } = await import('@openslack/github');
    await collaborationCommands().parseAsync(
      ['workflow', 'run', 'resume-test', '--yes', '--audit-issue'],
      { from: 'user' },
    );
    expect(publishWorkflowRunAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowHash: state.submit.mock.calls[0][0].sourceSnapshot.workflowSourceHash,
      }),
      { createIssue: true },
    );
  });
});
