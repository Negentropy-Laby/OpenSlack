import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collaborationCommands } from '../commands/collaboration.js';
import * as workflows from '@openslack/workflows';
import * as pr from '@openslack/pr';
import * as github from '@openslack/github';
import type * as OpenSlackGitHubModule from '@openslack/github';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeReceiptFixture } from '../../../../packages/workflows/src/__tests__/workflow-runner-v2-test-fixture.js';

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
const loaderFixtureRoots: string[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  state.status = 'paused';
  const meta = {
    name: 'resume-test',
    description: 'Resume test',
    phases: [{ title: 'Run', detail: 'Run' }],
  };
  const root = await mkdtemp(join(tmpdir(), 'openslack-cli-loader-source-'));
  loaderFixtureRoots.push(root);
  const path = join(root, 'resume-test.mjs');
  const source = `export const meta = ${JSON.stringify(meta)};\nexport async function run() { return { status: 'completed' }; }\n`;
  await writeFile(path, source, 'utf8');
  const actual = await vi.importActual<typeof workflows>('@openslack/workflows');
  const loaded = await actual.loadWorkflow(path);
  const snapshot = loaded.sourceSnapshot;
  if (!snapshot) throw new Error('The public file loader must own this fixture snapshot.');
  state.bytes = await readFile(path);
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
  state.find.mockResolvedValue({ path, source: 'openslack-project' });
  state.load.mockResolvedValue(loaded);
  state.submit.mockResolvedValue({ status: 'completed', runId: 'run.test' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const root of loaderFixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
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
  it.each(
    ['--proposal-issue', '--review-issue', '--phase-issues', '--governance-issue'].flatMap((flag) =>
      ['9007199254740992', '9007199254740993', '9007199254740995'].map(
        (value) => [flag, value] as const,
      ),
    ),
  )('rejects unsafe %s %s before preview, query, or writes', async (flag, value) => {
    await collaborationCommands().parseAsync(
      ['workflow', 'finalize-pr', '42', flag, flag === '--phase-issues' ? `1,${value}` : value],
      { from: 'user' },
    );
    expect(process.exitCode).toBe(1);
    expect(github.previewWorkflowFinalization).not.toHaveBeenCalled();
    expect(pr.fetchPRDetails).not.toHaveBeenCalled();
    expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
  });
  it.each(['9007199254740992', '9007199254740993', '9007199254740995'])(
    'rejects unsafe PR %s without rounding it into another target',
    async (value) => {
      await collaborationCommands().parseAsync(['workflow', 'finalize-pr', value], {
        from: 'user',
      });
      expect(process.exitCode).toBe(1);
      expect(github.previewWorkflowFinalization).not.toHaveBeenCalled();
      expect(pr.fetchPRDetails).not.toHaveBeenCalled();
      expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
    },
  );
  it.each(['pr', '--proposal-issue', '--review-issue', '--phase-issues', '--governance-issue'])(
    'accepts the exact maximum safe integer for %s into credential-free preview only',
    async (flag) => {
      vi.mocked(github.previewWorkflowFinalization).mockResolvedValueOnce({
        dryRun: true,
        errors: [],
        closedIssues: [],
        commentedIssues: [],
        updatedLabels: [],
      });
      await collaborationCommands().parseAsync(
        [
          'workflow',
          'finalize-pr',
          flag === 'pr' ? '9007199254740991' : '42',
          ...(flag === 'pr' ? [] : [flag, '9007199254740991']),
        ],
        { from: 'user' },
      );
      expect(process.exitCode).toBeUndefined();
      expect(github.previewWorkflowFinalization).toHaveBeenCalledExactlyOnceWith(
        flag === 'pr' ? 9007199254740991 : 42,
      );
      expect(pr.fetchPRDetails).not.toHaveBeenCalled();
      expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'does not auto-select an unbound body issue (explicit=%s)',
    async (explicit) => {
      const coordinate = vi.spyOn(pr, 'finalizeWorkflowLifecycle').mockResolvedValue(
        explicit
          ? { status: 'refused', message: 'Cannot override the verified governance issue.' }
          : {
              status: 'finalized',
              result: { closedIssues: [888], commentedIssues: [], updatedLabels: [], errors: [] },
            },
      );
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
        expect(coordinate).toHaveBeenCalledWith(
          expect.objectContaining({
            prNumber: 42,
            mode: 'explicit-targets',
            governanceIssue: undefined,
            proposalIssue: 888,
          }),
        );
        expect(process.exitCode).toBeUndefined();
      }
    },
  );
  it.each(['headSha', 'baseSha'])('preserves shared refusal without reviewed %s', async () => {
    vi.spyOn(pr, 'finalizeWorkflowLifecycle').mockResolvedValue({
      status: 'refused',
      message: 'Cannot finalize without reviewed repository head and base.',
    });
    await collaborationCommands().parseAsync(
      ['workflow', 'finalize-pr', '42', '--proposal-issue', '888'],
      { from: 'user' },
    );
    expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
describe('Go resume CLI boundary', () => {
  it('revalidates file-backed profile source after admission before any submission', async () => {
    vi.spyOn(github, 'loadProfileSyncConfig').mockReturnValue(
      structuredClone(github.DEFAULT_PROFILE_SYNC_CONFIG),
    );
    const reader = vi.mocked(workflows.readWorkflowRunnerSourceBytes);
    const previous = reader.getMockImplementation()!;
    let reads = 0;
    reader.mockImplementation(async () =>
      ++reads === 1 ? state.bytes : Buffer.from('changed after admission'),
    );
    try {
      await collaborationCommands().parseAsync(['workflow', 'profile-sync', 'run', '--yes'], {
        from: 'user',
      });
      expect(reads).toBe(2);
      expect(process.exitCode).toBe(1);
      expect(state.submit).not.toHaveBeenCalled();
      expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('SOURCE_DRIFT');
    } finally {
      reader.mockImplementation(previous);
    }
  });
  it.each([
    ['workflow', 'run', 'profile-sync', '--yes'],
    ['workflow', 'profile-sync', 'run', '--yes'],
  ])('refuses embedded %j before the legacy admission prompt or submission', async (...args) => {
    const actual = await vi.importActual<typeof workflows>('@openslack/workflows');
    const embedded = await actual.loadWorkflow('openslack:builtin/profile-sync');
    state.find.mockResolvedValue({ path: 'openslack:builtin/profile-sync', source: 'builtin' });
    state.load.mockResolvedValue(embedded);
    const reader = vi.mocked(workflows.readWorkflowRunnerSourceBytes);
    const previous = reader.getMockImplementation()!;
    reader.mockImplementation(actual.readWorkflowRunnerSourceBytes);
    try {
      await collaborationCommands().parseAsync(args, { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(state.submit).not.toHaveBeenCalled();
      expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain(
        'UNATTENDED-ADMISSION',
      );
      expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
        'SOURCE_KIND_UNSUPPORTED',
      );
    } finally {
      reader.mockImplementation(previous);
    }
  });
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
    expect(diagnostics).toContain('source: openslack.workflow-runner.workflow-source.v2');
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
