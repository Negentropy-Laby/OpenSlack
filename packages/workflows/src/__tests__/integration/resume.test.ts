import { describe, it, expect } from 'vitest';
import { RunStore } from '../../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from '../../internal/workflow-run-store-recovery-access.js';
import type { RunStoreFs, RunMeta } from '../../run-store.js';
import { checkResumable, prepareResume, replayCachedPhases } from '../../resume.js';
import type { WorkflowMeta, PhaseCheckpoint, ExecutionMode } from '../../types.js';

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
  name: 'test-resume-workflow',
  description: 'Test resume workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
    { title: 'Report', detail: 'Report phase' },
  ],
  permissions: { github: ['issues:read'] },
  risk: 'low',
};

const TEST_HASH = 'a'.repeat(64);
const identity = (manifest: WorkflowMeta = TEST_MANIFEST, hash = TEST_HASH) => ({
  meta: manifest,
  format: 'openslack-native' as const,
  hash,
  run: async () => ({ status: 'completed' }),
});

function makeMeta(manifest: WorkflowMeta, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: 'run-resume-001',
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
  runId: string = 'run-resume-001',
): Promise<string> {
  const meta = makeMeta(manifest, { runId });
  await store.initRun(runId, meta);

  for (const name of completedPhaseNames) {
    const cp: PhaseCheckpoint = {
      phase: name,
      timestamp: new Date().toISOString(),
      status: 'completed',
    };
    await store.savePhaseCheckpoint(runId, cp);
  }

  await store.transitionStatus(runId, 'paused');
  return runId;
}

describe('resume with run store integration', () => {
  it('checkResumable works with in-memory store', async () => {
    const { store } = makeStore();
    await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const result = await checkResumable(store, 'run-resume-001', identity());
    expect(result.canResume).toBe(true);
    expect(result.manifestMatch).toBe(true);
  });

  it('prepareResume returns correct state after partial completion', async () => {
    const { store } = makeStore();
    await initPausedRun(store, TEST_MANIFEST, ['Scan', 'Verify']);

    const state = await prepareResume(store, 'run-resume-001', identity());
    expect(state.completedPhases).toHaveLength(2);
    expect(state.completedPhases[0].phase).toBe('Scan');
    expect(state.completedPhases[1].phase).toBe('Verify');
    expect(state.nextPhaseIndex).toBe(2);
  });

  it('replayCachedPhases validates checkpoint order for resume', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
    ];
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints);
    expect(result).toHaveLength(1);
    expect(result[0].phase).toBe('Scan');
  });

  it('detects mismatched manifest during resume check', async () => {
    const { store } = makeStore();
    await initPausedRun(store, TEST_MANIFEST, ['Scan']);

    const modifiedManifest: WorkflowMeta = {
      ...TEST_MANIFEST,
      description: 'Modified description',
    };

    const result = await checkResumable(
      store,
      'run-resume-001',
      identity(modifiedManifest, 'b'.repeat(64)),
    );
    expect(result.canResume).toBe(false);
    expect(result.reason).toContain('Manifest hash mismatch');
  });
});
