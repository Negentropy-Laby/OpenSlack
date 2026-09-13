import {
  bindGoWorkflowResumeIdentity,
  validateGoWorkflowResumeContext,
  checkResumeEligibility,
} from '../resume.js';
import {
  createWorkflowSourceSnapshot,
  workflowSourceSnapshotBytes,
  verifyWorkflowSourceSnapshot,
} from '../internal/workflow-source-snapshot.js';
import { resolveWorkflowIdentityHash } from '../internal/workflow-identity.js';
import { validateWorkflowRunRouteReceipt } from '../workflow-run-routing.js';
import type { WorkflowModule } from '../types.js';
import { describe, it, expect } from 'vitest';
import { checkResumable, prepareResume, replayCachedPhases } from '../resume.js';
import type { ResumeState, WorkflowResumeIdentity } from '../resume.js';
import { RunStore } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from '../internal/workflow-run-store-recovery-access.js';
import type { RunStoreFs, RunMeta } from '../run-store.js';
import type { PhaseCheckpoint, WorkflowMeta, ExecutionMode } from '../types.js';

// ── In-memory filesystem ────────────────────────────────────────────────────

function createMemFs(): RunStoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async mkdir(dir: string) {
      files.set(dir.endsWith('/') ? dir : `${dir}/`, '');
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async appendFile(path: string, line: string) {
      const existing = files.get(path) ?? '';
      files.set(path, existing + line);
    },
    async exists(path: string) {
      return files.has(path) || files.has(`${path}/`);
    },
  };
}

function makeStore(): { store: RunStore; fs: ReturnType<typeof createMemFs> } {
  const fs = createMemFs();
  const store = new RunStore({
    access: createWorkflowRunStoreRecoveryAccess(),
    baseDir: '/test/workflows',
    fs,
  });
  return { store, fs };
}

const TEST_MANIFEST: WorkflowMeta = {
  name: 'test-scan',
  description: 'Test workflow for resume tests',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
    { title: 'Report', detail: 'Report phase' },
  ],
};

const TEST_HASH = 'a'.repeat(64);

function identity(
  manifest: WorkflowMeta = TEST_MANIFEST,
  hash: string = TEST_HASH,
): WorkflowResumeIdentity {
  return {
    meta: manifest,
    format: 'openslack-native',
    hash,
    run: async () => ({ status: 'completed' }),
  };
}

function makeMeta(manifest: WorkflowMeta, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: 'run-001',
    workflowName: manifest.name,
    mode: 'execute' as ExecutionMode,
    manifestHash: TEST_HASH,
    args: {},
    startedAt: '2026-05-28T12:00:00.000Z',
    ...overrides,
  };
}

async function initPausedRun(
  store: RunStore,
  manifest: WorkflowMeta,
  completedPhaseNames: string[] = [],
): Promise<string> {
  const runId = 'run-001';
  const meta = makeMeta(manifest);
  await store.initRun(runId, meta);

  // Save checkpoints for completed phases
  for (const name of completedPhaseNames) {
    const cp: PhaseCheckpoint = {
      phase: name,
      timestamp: new Date().toISOString(),
      status: 'completed',
    };
    await store.savePhaseCheckpoint(runId, cp);
  }

  // Transition to paused
  await store.transitionStatus(runId, 'paused');
  return runId;
}

describe('checkResumable', () => {
  it('returns false for non-existent run', async () => {
    const { store } = makeStore();
    const result = await checkResumable(store, 'nope', TEST_MANIFEST);
    expect(result.canResume).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('returns false for running status', async () => {
    const { store } = makeStore();
    const meta = makeMeta(TEST_MANIFEST);
    await store.initRun('run-001', meta);
    // Run is in "running" state by default

    const result = await checkResumable(store, 'run-001', identity());
    expect(result.canResume).toBe(false);
    expect(result.reason).toContain('running');
  });

  it('returns false for completed status', async () => {
    const { store } = makeStore();
    const meta = makeMeta(TEST_MANIFEST);
    await store.initRun('run-001', meta);
    await store.transitionStatus('run-001', 'completed');

    const result = await checkResumable(store, 'run-001', TEST_MANIFEST);
    expect(result.canResume).toBe(false);
    expect(result.reason).toContain('completed');
  });

  it('returns true for paused run with matching manifest', async () => {
    const { store } = makeStore();
    await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const result = await checkResumable(store, 'run-001', identity());
    expect(result.canResume).toBe(true);
    expect(result.manifestMatch).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('keeps the manifest-only compatibility entrypoint fail-closed', async () => {
    const { store } = makeStore();
    await initPausedRun(store, TEST_MANIFEST);

    const result = await checkResumable(store, 'run-001', TEST_MANIFEST);
    expect(result.canResume).toBe(false);
    expect(result.reason).toContain('full executable SHA-256 identity');
    await expect(prepareResume(store, 'run-001', TEST_MANIFEST)).rejects.toMatchObject({
      code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED',
    });
  });

  it('returns false for paused run with mismatched manifest hash', async () => {
    const { store } = makeStore();
    await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const modifiedManifest: WorkflowMeta = {
      ...TEST_MANIFEST,
      description: 'Modified description',
    };

    const result = await checkResumable(
      store,
      'run-001',
      identity(modifiedManifest, 'b'.repeat(64)),
    );
    expect(result.canResume).toBe(false);
    expect(result.manifestMatch).toBe(false);
    expect(result.reason).toContain('Manifest hash mismatch');
    expect(result.storedManifestHash).toBeDefined();
    expect(result.currentManifestHash).toBeDefined();
    expect(result.storedManifestHash).not.toBe(result.currentManifestHash);
  });

  it('includes status in result', async () => {
    const { store } = makeStore();
    await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const result = await checkResumable(store, 'run-001', identity());
    expect(result.status).not.toBeNull();
    expect(result.status!.status).toBe('paused');
  });
});

describe('prepareResume', () => {
  it('returns resume state with completed phases', async () => {
    const { store } = makeStore();
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const state = await prepareResume(store, runId, identity());
    expect(state.runId).toBe('run-001');
    expect(state.completedPhases).toHaveLength(1);
    expect(state.completedPhases[0].phase).toBe('Scan');
    expect(state.nextPhaseIndex).toBe(1); // Resume from Verify
  });

  it('returns nextPhaseIndex 0 when no phases completed', async () => {
    const { store } = makeStore();
    const runId = await initPausedRun(store, TEST_MANIFEST, []);

    const state = await prepareResume(store, runId, identity());
    expect(state.completedPhases).toHaveLength(0);
    expect(state.nextPhaseIndex).toBe(0);
  });

  it('returns correct nextPhaseIndex when all phases completed', async () => {
    const { store } = makeStore();
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan', 'Verify', 'Report']);

    const state = await prepareResume(store, runId, identity());
    expect(state.completedPhases).toHaveLength(3);
    expect(state.nextPhaseIndex).toBe(3);
  });

  it('stops at first non-completed phase', async () => {
    const { store } = makeStore();
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan']);
    // Manually save a "failed" Verify checkpoint
    await store.savePhaseCheckpoint(runId, {
      phase: 'Verify',
      timestamp: new Date().toISOString(),
      status: 'failed',
    });

    const state = await prepareResume(store, runId, identity());
    // Only Scan is completed; Verify is failed so we stop there
    expect(state.completedPhases).toHaveLength(1);
    expect(state.nextPhaseIndex).toBe(1);
  });

  it('throws for non-existent run', async () => {
    const { store } = makeStore();
    await expect(prepareResume(store, 'nope', TEST_MANIFEST)).rejects.toThrow('not found');
  });

  it('throws for running status', async () => {
    const { store } = makeStore();
    await store.initRun('run-001', makeMeta(TEST_MANIFEST));
    await expect(prepareResume(store, 'run-001', TEST_MANIFEST)).rejects.toThrow();
  });

  it('throws for manifest hash mismatch', async () => {
    const { store } = makeStore();
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const modifiedManifest: WorkflowMeta = {
      ...TEST_MANIFEST,
      description: 'Changed!',
    };
    await expect(
      prepareResume(store, runId, identity(modifiedManifest, 'b'.repeat(64))),
    ).rejects.toThrow('Manifest hash mismatch');
  });

  it('includes meta in resume state', async () => {
    const { store } = makeStore();
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const state = await prepareResume(store, runId, identity());
    expect(state.meta.runId).toBe('run-001');
    expect(state.meta.workflowName).toBe('test-scan');
    expect(state.meta.manifestHash).toBe(TEST_HASH);
  });
});

describe('replayCachedPhases', () => {
  it('returns checkpoints that match manifest phases', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
      { phase: 'Verify', timestamp: '2026-01-01', status: 'completed' },
    ];
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints);
    expect(result).toHaveLength(2);
    expect(result[0].phase).toBe('Scan');
    expect(result[1].phase).toBe('Verify');
  });

  it('stops at first missing checkpoint', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
    ];
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for no checkpoints', () => {
    const result = replayCachedPhases(TEST_MANIFEST, []);
    expect(result).toEqual([]);
  });

  it('throws on phase name mismatch', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'WrongPhase', timestamp: '2026-01-01', status: 'completed' },
    ];
    expect(() => replayCachedPhases(TEST_MANIFEST, checkpoints)).toThrow(
      'Phase mismatch at index 0',
    );
  });

  it('throws on non-completed phase status', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'failed' },
    ];
    expect(() => replayCachedPhases(TEST_MANIFEST, checkpoints)).toThrow('has status "failed"');
  });

  it('handles all phases completed', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
      { phase: 'Verify', timestamp: '2026-01-01', status: 'completed' },
      { phase: 'Report', timestamp: '2026-01-01', status: 'completed' },
    ];
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints);
    expect(result).toHaveLength(3);
  });
});

describe('verified Go source identities', () => {
  function fixture() {
    const bytes = Buffer.from('exact workflow source');
    const sourceSnapshot = createWorkflowSourceSnapshot(bytes, TEST_MANIFEST);
    const loaded: WorkflowModule = {
      ...identity(TEST_MANIFEST, sourceSnapshot.rawHash),
      sourceSnapshot,
    } as WorkflowModule;
    const route = validateWorkflowRunRouteReceipt({
      schema: 'openslack.workflow_run_route_receipt.v1',
      workspaceId: 'workspace.test',
      runId: 'run-001',
      workflowId: TEST_MANIFEST.name,
      workflowVersion: '0.0.0',
      workflowSourceHash: sourceSnapshot.workflowSourceHash,
      manifestHash: sourceSnapshot.manifestHash,
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
    return { bytes, loaded, route, sourceSnapshot };
  }
  it.each(['raw', 'v2'] as const)(
    'prepares %s metadata without rewriting historical identity or expiring the original route',
    async (domain) => {
      const { bytes, loaded, route, sourceSnapshot } = fixture();
      const { store, fs } = makeStore();
      const hash = domain === 'raw' ? sourceSnapshot.rawHash : sourceSnapshot.workflowSourceHash;
      await store.initRun('run-001', makeMeta(TEST_MANIFEST, { manifestHash: hash }));
      await store.transitionStatus('run-001', 'paused');
      const before = new Map(fs.files);
      const bound = bindGoWorkflowResumeIdentity(
        validateGoWorkflowResumeContext('run-001', route, 'workspace.test'),
        loaded,
        bytes,
      );
      expect(loaded.hash).toBe(sourceSnapshot.rawHash);
      expect(bound.hash).toBe(sourceSnapshot.rawHash);
      expect(resolveWorkflowIdentityHash(bound)).toBe(route.workflowSourceHash);
      expect(await checkResumable(store, 'run-001', bound)).toMatchObject({
        canResume: true,
        storedIdentity: {
          domain: domain === 'raw' ? 'raw-sha256' : 'openslack.workflow-runner.workflow-source.v2',
        },
      });
      expect(await prepareResume(store, 'run-001', bound)).toMatchObject({
        meta: { manifestHash: hash },
      });
      expect(fs.files).toEqual(before);
    },
  );
  it.each([
    ['runId', 'run.other', 'RUN_MISMATCH'],
    ['workspaceId', 'workspace.other', 'WORKSPACE_MISMATCH'],
    ['workflowId', 'workflow.other', 'WORKFLOW_MISMATCH'],
    ['workflowVersion', '2.0.0', 'VERSION_MISMATCH'],
    ['workflowSourceHash', 'd'.repeat(64), 'SOURCE_DRIFT'],
    ['manifestHash', 'e'.repeat(64), 'MANIFEST_DRIFT'],
  ])('diagnoses only the changed %s binding', (field, value, reasonCode) => {
    const { bytes, loaded, route } = fixture();
    const changed = validateWorkflowRunRouteReceipt({ ...route, [field]: value });
    expect(() =>
      bindGoWorkflowResumeIdentity(
        validateGoWorkflowResumeContext('run-001', changed, 'workspace.test'),
        loaded,
        bytes,
      ),
    ).toThrow(expect.objectContaining({ reasonCode }));
  });
  it('rejects invalid authority pairing and receipt time ordering at the receipt boundary', () => {
    const { route } = fixture();
    for (const changed of [
      { ...route, route: { ...route.route, authority: 'typescript' } },
      { ...route, expiresAt: route.selectedAt },
    ]) {
      expect(() =>
        validateGoWorkflowResumeContext('run-001', changed as typeof route, 'workspace.test'),
      ).toThrow(expect.objectContaining({ reasonCode: 'ROUTE_INVALID' }));
    }
  });
  it('detects loader/source TOCTOU independently of route drift', () => {
    const { bytes, loaded, route } = fixture();
    expect(() =>
      bindGoWorkflowResumeIdentity(
        validateGoWorkflowResumeContext('run-001', route, 'workspace.test'),
        { ...loaded, hash: 'f'.repeat(64) },
        bytes,
      ),
    ).toThrow(expect.objectContaining({ reasonCode: 'LOADER_SOURCE_MISMATCH' }));
    expect(() =>
      bindGoWorkflowResumeIdentity(
        validateGoWorkflowResumeContext('run-001', route, 'workspace.test'),
        loaded,
        Buffer.from('changed'),
      ),
    ).toThrow(expect.objectContaining({ reasonCode: 'LOADER_SOURCE_MISMATCH' }));
  });
  it('owns snapshot bytes and rejects forged or modified snapshots', () => {
    const { bytes, loaded, route, sourceSnapshot } = fixture();
    const mutableRoute = { ...route };
    const context = validateGoWorkflowResumeContext('run-001', mutableRoute, 'workspace.test');
    mutableRoute.workflowSourceHash = 'f'.repeat(64);
    expect(resolveWorkflowIdentityHash(bindGoWorkflowResumeIdentity(context, loaded, bytes))).toBe(
      sourceSnapshot.workflowSourceHash,
    );
    expect(() => bindGoWorkflowResumeIdentity({ ...context }, loaded, bytes)).toThrow(
      expect.objectContaining({ reasonCode: 'ROUTE_INVALID' }),
    );
    const copy = workflowSourceSnapshotBytes(sourceSnapshot);
    copy[0] ^= 1;
    expect(workflowSourceSnapshotBytes(sourceSnapshot)).toEqual(bytes);
    expect(() => verifyWorkflowSourceSnapshot(sourceSnapshot, copy, loaded.meta)).toThrow(
      'changed',
    );
    expect(() => workflowSourceSnapshotBytes({ ...sourceSnapshot })).toThrow('Unrecognized');
    expect(() =>
      resolveWorkflowIdentityHash({
        ...loaded,
        workflowIdentity: {
          domain: 'openslack.workflow-runner.workflow-source.v2',
          digest: sourceSnapshot.workflowSourceHash,
        },
      }),
    ).toThrow('verified source evidence');
  });
  it('rejects an unrelated historical hash without claiming actual source drift', async () => {
    const { bytes, loaded, route } = fixture();
    const { store } = makeStore();
    await store.initRun('run-001', makeMeta(TEST_MANIFEST));
    await store.transitionStatus('run-001', 'paused');
    const bound = bindGoWorkflowResumeIdentity(
      validateGoWorkflowResumeContext('run-001', route, 'workspace.test'),
      loaded,
      bytes,
    );
    expect(await checkResumable(store, 'run-001', bound)).toMatchObject({
      canResume: false,
      reasonCode: 'IDENTITY_UNVERIFIED',
    });
  });
  it('checks missing and terminal state before a workflow is loaded', async () => {
    const { store } = makeStore();
    expect(await checkResumeEligibility(store, 'run-001')).toMatchObject({
      reasonCode: 'RUN_NOT_FOUND',
    });
    await store.initRun('run-001', makeMeta(TEST_MANIFEST));
    await store.transitionStatus('run-001', 'completed');
    expect(await checkResumeEligibility(store, 'run-001')).toMatchObject({
      reasonCode: 'STATUS_NOT_RESUMABLE',
    });
  });
});
