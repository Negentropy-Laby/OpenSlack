import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collaborationCommands } from '../commands/collaboration.js';
import * as workflows from '@openslack/workflows';
import * as pr from '@openslack/pr';
import * as github from '@openslack/github';
import {
  createWorkflowEvidence,
  evaluateWorkflowGate as evaluateRealWorkflowGate,
} from '../../../../packages/pr/src/workflow-gate.js';
import type * as OpenSlackGitHubModule from '@openslack/github';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeReceiptFixture } from '../../../../packages/workflows/src/__tests__/workflow-runner-v2-test-fixture.js';
// CLI consumes the built package: its internal fixture must share that ownership registry.
import { createWorkflowSourceSnapshot } from '../../../../packages/workflows/dist/internal/workflow-source-snapshot.js';

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
  const actual = await vi.importActual<typeof workflows>('@openslack/workflows');
  return {
    ...actual,
    createWorkflowRunRouteJournal: vi.fn(() => ({})),
    inspectWorkflowRunReadOnly: vi.fn(async () => ({
      ownership: 'typescript-historical',
      disposition: 'evidence-only',
    })),
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
  ...(await vi.importActual<typeof OpenSlackGitHubModule>('@openslack/github')),
  publishWorkflowRunAudit: vi.fn(async () => ({
    issueNumber: 1,
    url: 'https://example.test/audit',
  })),
  finalizeWorkflowPR: vi.fn(async () => ({
    closedIssues: [],
    commentedIssues: [],
    updatedLabels: [],
    errors: [],
  })),
  previewWorkflowFinalization: vi.fn(async () => undefined),
}));
vi.mock('@openslack/pr', async () => ({
  ...(await vi.importActual<typeof pr>('@openslack/pr')),
  fetchPRDetails: vi.fn(),
  loadPRCodeownerEvidence: vi.fn(async () => ({ owners: [] })),
  evaluateWorkflowGate: vi.fn(),
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
  const snapshot = createWorkflowSourceSnapshot(state.bytes, meta);
  state.meta = {
    runId: 'run.test',
    workflowName: meta.name,
    mode: 'execute',
    manifestHash: snapshot.rawHash,
    args: {},
    startedAt: '2020-01-01T00:00:00.000Z',
  };
  state.route = routeReceiptFixture({
    runId: 'run.test',
    workflowId: meta.name,
    workflowSourceHash: snapshot.workflowSourceHash,
    manifestHash: snapshot.manifestHash,
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
describe('workflow finalize CLI binding', () => {
  it('runs a real frontend preview without live gate or publisher calls', async () => {
    vi.mocked(github.previewWorkflowFinalization).mockResolvedValueOnce({
      dryRun: true,
      errors: [],
      closedIssues: [],
      commentedIssues: [],
      updatedLabels: [],
    });
    await collaborationCommands().parseAsync(['workflow', 'finalize-pr', '42'], { from: 'user' });
    expect(pr.fetchPRDetails).not.toHaveBeenCalled();
    expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('preview only'));
  });

  it.each(['0x2a', '4e1', '0', '-1', '42x', ' 42', '9007199254740992'])(
    'rejects noncanonical Governance Issue %s before any repository query',
    async (value) => {
      await collaborationCommands().parseAsync(
        ['workflow', 'finalize-pr', '42', '--governance-issue', value],
        { from: 'user' },
      );
      expect(process.exitCode).toBe(1);
      expect(github.previewWorkflowFinalization).not.toHaveBeenCalled();
      expect(pr.fetchPRDetails).not.toHaveBeenCalled();
      expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'does not auto-select an unbound body issue (explicit=%s)',
    async (explicit) => {
      const path = '.openslack/workflows/existing.mjs';
      const report = {
        workflowEvidence: createWorkflowEvidence({
          baseSha: 'base',
          headSha: 'head',
          baseTree: [{ path, sha: 'old', mode: '100644', type: 'blob' }],
          headTree: [{ path, sha: 'new', mode: '100644', type: 'blob' }],
        }),
        changedFiles: [path],
        body: 'Historical discussion: Workflow governance #999',
        author: 'author',
        baseSha: 'base',
        headSha: 'head',
        reviews: [
          {
            user: 'human-reviewer',
            state: 'APPROVED',
            commitOid: 'head',
            body: 'Workflow-Trust: trusted',
          },
        ],
      };
      const gate = evaluateRealWorkflowGate(report);
      expect(gate.overall).toBe('PASS');
      vi.mocked(pr.fetchPRDetails).mockResolvedValue(report as never);
      vi.mocked(pr.evaluateWorkflowGate).mockReturnValue(gate);
      await collaborationCommands().parseAsync(
        [
          'workflow',
          'finalize-pr',
          '42',
          '--proposal-issue',
          '888',
          ...(explicit ? ['--governance-issue', '999'] : []),
        ],
        { from: 'user' },
      );
      if (explicit) {
        expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      } else {
        expect(github.finalizeWorkflowPR).toHaveBeenCalledWith(
          42,
          expect.objectContaining({
            governanceIssue: undefined,
            proposalIssue: 888,
            expectedHeadSha: 'head',
            expectedBaseSha: 'base',
          }),
        );
      }
    },
  );
  it.each(['headSha', 'baseSha'])('refuses writes without reviewed %s', async (missing) => {
    vi.mocked(pr.fetchPRDetails).mockResolvedValue({
      headSha: 'head',
      baseSha: 'base',
      [missing]: undefined,
    } as never);
    await collaborationCommands().parseAsync(
      ['workflow', 'finalize-pr', '42', '--proposal-issue', '888'],
      { from: 'user' },
    );
    expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
describe('Go resume CLI boundary', () => {
  it.each(['modified', 'deleted', 'unloadable'])(
    'historical audit identity survives a %s current source file',
    async (scenario) => {
      const { publishWorkflowRunAudit } = await import('@openslack/github');
      const directory = await mkdtemp(join(tmpdir(), 'openslack-audit-history-'));
      const sourcePath = join(directory, 'current.mjs');
      const metaPath = join(directory, 'meta.json');
      try {
        await writeFile(sourcePath, 'export const version = 1;');
        const originalMeta = JSON.stringify(state.meta, null, 3);
        await writeFile(metaPath, originalMeta);
        const historicalStore = {
          loadMeta: async () => JSON.parse(await readFile(metaPath, 'utf8')),
          getRunStatus: async () => ({ status: 'completed' }),
        } as never;
        vi.mocked(workflows.openWorkflowRunReadOnly)
          .mockReturnValueOnce(historicalStore)
          .mockReturnValueOnce(historicalStore);
        state.find.mockResolvedValue({ path: sourcePath, source: 'openslack-project' });
        state.load.mockImplementation(async () => {
          throw new Error('historical audit must not import today’s source');
        });
        const audit = () =>
          collaborationCommands().parseAsync(
            ['workflow', 'audit-run', 'run.test', '--create-issue'],
            { from: 'user' },
          );
        await audit();
        if (scenario === 'deleted') await rm(sourcePath);
        else
          await writeFile(
            sourcePath,
            scenario === 'modified' ? 'export const version = 2;' : 'invalid module syntax !!!',
          );
        await audit();
        expect(publishWorkflowRunAudit).toHaveBeenCalledTimes(2);
        const calls = vi.mocked(publishWorkflowRunAudit).mock.calls;
        expect(calls[1]![0].workflowIdentity).toEqual(calls[0]![0].workflowIdentity);
        expect(await readFile(metaPath, 'utf8')).toBe(originalMeta);
        expect(state.find).not.toHaveBeenCalled();
        expect(state.load).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('historical audit never consults or imports current source', async () => {
    const { publishWorkflowRunAudit } = await import('@openslack/github');
    state.find.mockRejectedValue(new Error('current file must not be consulted'));
    state.load.mockRejectedValue(new Error('current module must not be imported'));
    await collaborationCommands().parseAsync(
      ['workflow', 'audit-run', 'run.test', '--create-issue'],
      { from: 'user' },
    );
    expect(state.find).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(publishWorkflowRunAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowIdentity: {
          digest: (state.meta as { manifestHash: string }).manifestHash,
          domain: 'unknown',
          provenance: 'unknown',
        },
      }),
      { issueNumber: undefined, createIssue: true },
    );
  });
  it('rejects absent loader evidence before runner submission or audit publication', async () => {
    const loaded = await state.load();
    state.load.mockResolvedValue({ ...loaded, sourceSnapshot: undefined });
    const { publishWorkflowRunAudit } = await import('@openslack/github');
    await resume();
    expect(state.submit).not.toHaveBeenCalled();
    expect(publishWorkflowRunAudit).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'SOURCE_EVIDENCE_MISSING',
    );
  });
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
  it('passes the confirmation reread to the client and renders its typed drift rejection', async () => {
    // Real client zero-write rejection is covered by its integration-style suite.
    state.submit.mockImplementationOnce(async (input) => {
      try {
        workflows.verifyWorkflowSourceSnapshot(
          input.sourceSnapshot,
          input.workflowSourceBytes,
          input.manifest,
        );
      } catch (cause) {
        throw new workflows.WorkflowResumeRecoveryRequiredError(
          'run.test',
          'source changed',
          { cause },
          'SOURCE_DRIFT',
          (cause as workflows.WorkflowSourceEvidenceError).identities,
        );
      }
    });
    vi.mocked(console.log).mockImplementation((message) => {
      if (String(message).includes('[UNATTENDED-ADMISSION]'))
        state.bytes = Buffer.from('changed during confirmation');
    });
    await resume();
    expect(state.submit).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('SOURCE_DRIFT');
    const diagnostics = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(diagnostics).toContain('runner-v2-source');
    expect(diagnostics).toContain(
      (state.route as workflows.WorkflowRunRouteReceipt).workflowSourceHash,
    );
    expect(diagnostics).toContain(
      createHash('sha256')
        .update('openslack.workflow-runner.workflow-source.v2\0')
        .update('changed during confirmation')
        .digest('hex'),
    );
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
        workflowIdentity: {
          digest: state.submit.mock.calls[0][0].sourceSnapshot.workflowSourceHash,
          domain: 'openslack.workflow-runner.workflow-source.v2',
          provenance: 'inferred',
        },
      }),
      { createIssue: true },
    );
  });
});
