import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunStoreFs } from '../run-store.js';
import {
  validateWorkflowCheckpointShadowObservation,
  workflowCheckpointCanonicalJson,
  workflowCheckpointHash,
  type WorkflowCheckpointExecutionBinding,
  type WorkflowCheckpointShadowEnvelope,
} from '../workflow-checkpoint-shadow-contract.js';
import {
  createWorkflowCheckpointObservationPort,
  createWorkflowCheckpointShadowHttpPublisher,
  type WorkflowCheckpointObservationPort,
} from '../workflow-checkpoint-shadow.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function binding(attempt = 1): WorkflowCheckpointExecutionBinding {
  return {
    workspaceId: 'workspace.test',
    jobId: `job.${attempt}`,
    workflowRunId: 'run.checkpoint.1',
    attemptId: `attempt.${attempt}`,
    leaseId: `lease.${attempt}`,
    fencingToken: attempt,
    correlationId: 'correlation.checkpoint.1',
    runnerBuildHash: 'a'.repeat(64),
    workflowSourceHash: 'b'.repeat(64),
    manifestHash: 'c'.repeat(64),
    inputHash: 'd'.repeat(64),
  };
}

function envelope(sourceSequence = 1): WorkflowCheckpointShadowEnvelope {
  const checkpoint = {
    checkpointId: 'checkpoint.test.1',
    phaseId: 'phase-0',
    phaseIndex: 0,
    commitPoint: 'after_phase_work' as const,
    artifactRef: 'checkpoint-control/artifacts/artifact.json',
    artifactHash: '1'.repeat(64),
    resultHash: null,
    cacheKeyHash: null,
    committedRevision: sourceSequence + 1,
    resumeGeneration: sourceSequence - 1,
    committedAt: '2026-08-12T00:00:00.000Z',
  };
  const observation = {
    schema: 'openslack.workflow_checkpoint_shadow_observation.v1' as const,
    authority: 'typescript' as const,
    goRole: 'observer_only' as const,
    runId: 'run.checkpoint.1',
    revision: sourceSequence + 1,
    resumeGeneration: sourceSequence - 1,
    workflowSourceHash: 'b'.repeat(64),
    manifestHash: 'c'.repeat(64),
    inputHash: 'd'.repeat(64),
    runner: {
      workspaceId: 'workspace.test',
      jobId: `job.${sourceSequence}`,
      attemptId: `attempt.${sourceSequence}`,
      leaseId: `lease.${sourceSequence}`,
      fencingToken: sourceSequence,
      correlationId: 'correlation.checkpoint.1',
      runnerBuildHash: 'a'.repeat(64),
    },
    checkpoint,
    priorCheckpoint: null,
    nextPhaseId: null,
    nextPhaseIndex: null,
  };
  return {
    schema: 'openslack.workflow_checkpoint_shadow_envelope.v1',
    goRole: 'observer_only',
    sourceSequence,
    operation: 'checkpoint_commit',
    observation,
    observationHash: workflowCheckpointHash(observation),
  };
}

function receipt(
  value: WorkflowCheckpointShadowEnvelope,
  status: 'accepted' | 'reconciliation_required',
) {
  return workflowCheckpointCanonicalJson({
    schema: 'openslack.workflow_checkpoint_shadow_receipt.v1',
    status,
    idempotencyKey: `openslack.workflow-checkpoint-shadow.v1.${value.observationHash}`,
    receiptId: `receipt.${value.sourceSequence}`,
    observationId: status === 'accepted' ? `observation.${value.sourceSequence}` : null,
    workspaceId: value.observation.runner.workspaceId,
    runId: value.observation.runId,
    sourceSequence: value.sourceSequence,
    operation: value.operation,
    parity: status === 'accepted' ? 'matched' : 'unknown',
    mismatchCode: null,
    reconciliationToken: status === 'reconciliation_required' ? 'reconciliation.test.1' : null,
    envelopeHash: workflowCheckpointHash(value),
    observationHash: value.observationHash,
    serviceBuildHash: 'e'.repeat(64),
    committedAt: status === 'accepted' ? '2026-08-12T00:00:00.000Z' : null,
  });
}

async function root(): Promise<string> {
  // WSL can inherit a Windows TMPDIR mounted through DrvFS. That filesystem
  // reports permissive synthetic modes and cannot exercise the POSIX
  // owner-only journal boundary. Keep native Windows on its ACL path and use
  // the real POSIX temporary filesystem everywhere else.
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const value = await mkdtemp(join(temporaryRoot, 'openslack-checkpoint-shadow-'));
  roots.push(value);
  return value;
}

function memoryStore(
  options: {
    observer?: WorkflowCheckpointObservationPort;
    failWrite?: (path: string, writeNumber: number) => boolean;
  } = {},
) {
  const files = new Map<string, string>();
  const writes = new Map<string, number>();
  const fs: RunStoreFs = {
    async mkdir(path) {
      files.set(`${path}/`, '');
    },
    async writeFile(path, content) {
      const writeNumber = (writes.get(path) ?? 0) + 1;
      writes.set(path, writeNumber);
      if (options.failWrite?.(path, writeNumber)) throw new Error('injected checkpoint write loss');
      files.set(path, content);
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async appendFile(path, line) {
      files.set(path, (files.get(path) ?? '') + line);
    },
    async exists(path) {
      return files.has(path) || files.has(`${path}/`);
    },
  };
  return {
    store: new RunStore({
      baseDir: '/memory/workflows',
      fs,
      checkpointObservationPort: options.observer,
    }),
    files,
    fs,
  };
}

describe('GS9-C TS checkpoint authority and credential-free observation', () => {
  it('rejects a multiword display title as a wire phase ID', async () => {
    const { store } = memoryStore();
    await store.initializeCheckpointControl('run.checkpoint.1', binding());
    await expect(
      store.commitWorkflowCheckpoint(
        'run.checkpoint.1',
        binding(),
        'Prepare Release Candidate',
        0,
        { artifact: Buffer.from('bounded-artifact') },
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_COMMIT_INVALID' });
    await expect(
      store.commitWorkflowCheckpoint('run.checkpoint.1', binding(), 'phase-0', 0, {
        artifact: Buffer.from('bounded-artifact'),
      }),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('fails closed on stale generations, identity drift, artifact loss, and corrupt control', async () => {
    const first = memoryStore();
    await first.store.initializeCheckpointControl('run.checkpoint.1', binding());
    await first.store.commitWorkflowCheckpoint('run.checkpoint.1', binding(), 'phase-0', 0, {
      artifact: Buffer.from('artifact-one'),
    });
    await first.store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(2), 'phase-1', 1);
    await expect(
      first.store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(3), 'phase-1', 1),
    ).resolves.toMatchObject({ revision: 4, resumeGeneration: 2 });
    await expect(
      first.store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(), 'phase-1', 1),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_BINDING_STALE' });
    await expect(
      first.store.beginCheckpointResumeGeneration(
        'run.checkpoint.1',
        { ...binding(4), manifestHash: 'f'.repeat(64) },
        'phase-1',
        1,
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_RESUME_INVALID' });
    await expect(
      first.store.beginCheckpointResumeGeneration(
        'run.checkpoint.1',
        { ...binding(4), inputHash: 'e'.repeat(64) },
        'phase-1',
        1,
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_RESUME_INVALID' });
    await expect(
      first.store.beginCheckpointResumeGeneration(
        'run.checkpoint.1',
        { ...binding(4), workflowSourceHash: 'e'.repeat(64) },
        'phase-1',
        1,
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_RESUME_INVALID' });

    const checkpoint = (await first.store.loadCheckpointControl('run.checkpoint.1'))!
      .checkpoints[0]!;
    first.files.delete(
      first.store.checkpointArtifactPath('run.checkpoint.1', checkpoint.artifactHash),
    );
    await expect(
      first.store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(4), 'phase-1', 1),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_ARTIFACT_MISSING' });

    const second = memoryStore();
    await second.store.initializeCheckpointControl('run.checkpoint.1', binding());
    await second.store.commitWorkflowCheckpoint('run.checkpoint.1', binding(), 'phase-0', 0, {
      artifact: Buffer.from('artifact-two'),
    });
    const secondCheckpoint = (await second.store.loadCheckpointControl('run.checkpoint.1'))!
      .checkpoints[0]!;
    second.files.set(
      second.store.checkpointArtifactPath('run.checkpoint.1', secondCheckpoint.artifactHash),
      '{}',
    );
    await expect(
      second.store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(2), 'phase-1', 1),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED' });

    second.files.set(second.store.checkpointControlPath('run.checkpoint.1'), '{}');
    await expect(second.store.loadCheckpointControl('run.checkpoint.1')).rejects.toMatchObject({
      code: 'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT',
    });
  });

  it('keeps the observer completely absent from a large default-off checkpoint run', async () => {
    const { store } = memoryStore();
    await store.initializeCheckpointControl('run.checkpoint.1', binding());
    for (let phaseIndex = 0; phaseIndex < 64; phaseIndex += 1) {
      await store.commitWorkflowCheckpoint(
        'run.checkpoint.1',
        binding(),
        `phase-${phaseIndex}`,
        phaseIndex,
        { artifact: Buffer.from(`artifact-${phaseIndex}`) },
      );
    }
    expect(await store.loadCheckpointControl('run.checkpoint.1')).toMatchObject({
      revision: 65,
      sourceSequence: 0,
      shadowEnabled: false,
      shadowOverflowed: false,
      pendingObservations: [],
    });
  });

  it('commits ordered hash-only checkpoints and advances each runner generation once', async () => {
    const workspace = await root();
    const baseDir = join(workspace, 'workflows');
    await mkdir(join(baseDir, 'runs', 'run.checkpoint.1'), { recursive: true });
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      const envelope = JSON.parse(body) as {
        observationHash: string;
        sourceSequence: number;
        operation: 'checkpoint_commit' | 'resume_advance';
        observation: { runId: string; runner: { workspaceId: string } };
      };
      return new Response(
        workflowCheckpointCanonicalJson({
          schema: 'openslack.workflow_checkpoint_shadow_receipt.v1',
          status: 'accepted',
          idempotencyKey: `openslack.workflow-checkpoint-shadow.v1.${envelope.observationHash}`,
          receiptId: `receipt.${envelope.sourceSequence}`,
          observationId: `observation.${envelope.sourceSequence}`,
          workspaceId: envelope.observation.runner.workspaceId,
          runId: envelope.observation.runId,
          sourceSequence: envelope.sourceSequence,
          operation: envelope.operation,
          parity: 'matched',
          mismatchCode: null,
          reconciliationToken: null,
          envelopeHash: workflowCheckpointHash(envelope),
          observationHash: envelope.observationHash,
          serviceBuildHash: 'e'.repeat(64),
          committedAt: '2026-08-12T00:00:00.000Z',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    const publisher = createWorkflowCheckpointShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8082',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetch: fetcher as typeof globalThis.fetch,
    });
    const observer = await createWorkflowCheckpointObservationPort({
      enabled: true,
      journalRoot: join(workspace, 'journal'),
      publisher,
    });
    const store = new RunStore({ baseDir, checkpointObservationPort: observer });

    expect((await store.initializeCheckpointControl('run.checkpoint.1', binding())).revision).toBe(
      1,
    );
    const first = await store.commitWorkflowCheckpoint(
      'run.checkpoint.1',
      binding(),
      'phase-0',
      0,
      {
        artifact: Buffer.from('SECRET-ARTIFACT-BYTES'),
        resultHash: '2'.repeat(64),
        cacheKeyHash: '3'.repeat(64),
      },
    );
    expect(first).toMatchObject({ revision: 2, resumeGeneration: 0, duplicate: false });
    await expect(
      store.commitWorkflowCheckpoint('run.checkpoint.1', binding(), 'phase-0', 0, {
        artifact: Buffer.from('SECRET-ARTIFACT-BYTES'),
        resultHash: '2'.repeat(64),
        cacheKeyHash: '3'.repeat(64),
      }),
    ).resolves.toMatchObject({ revision: 2, duplicate: true });

    expect(
      (await store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(2), 'phase-1', 1))
        .resumeGeneration,
    ).toBe(1);
    expect(
      (await store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(2), 'phase-1', 1))
        .revision,
    ).toBe(3);
    await expect(
      store.beginCheckpointResumeGeneration('run.checkpoint.1', binding(), 'phase-1', 1),
    ).rejects.toThrow('stale');
    await store.commitWorkflowCheckpoint('run.checkpoint.1', binding(2), 'phase-1', 1, {
      artifact: Buffer.from('SECOND-SECRET'),
    });
    await observer.flush();

    const state = await store.loadCheckpointControl('run.checkpoint.1');
    expect(state).toMatchObject({ revision: 4, resumeGeneration: 1 });
    expect(state?.checkpoints).toHaveLength(2);
    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => JSON.parse(body).sourceSequence)).toEqual([1, 2, 3]);
    expect(bodies.join('\n')).not.toContain('SECRET');
    expect(bodies.join('\n')).not.toContain('raw-key');
    expect(await readdir(join(workspace, 'journal', 'entries'))).toEqual([]);
  }, 30_000);

  it('keeps the TS commit durable when the post-commit publisher fails', async () => {
    const workspace = await root();
    const baseDir = join(workspace, 'workflows');
    await mkdir(join(baseDir, 'runs', 'run.checkpoint.1'), { recursive: true });
    const publisher = createWorkflowCheckpointShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8082',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
      }) as typeof globalThis.fetch,
    });
    const observer = await createWorkflowCheckpointObservationPort({
      enabled: true,
      journalRoot: join(workspace, 'journal'),
      publisher,
    });
    const store = new RunStore({ baseDir, checkpointObservationPort: observer });
    await store.initializeCheckpointControl('run.checkpoint.1', binding());

    await expect(
      store.commitWorkflowCheckpoint('run.checkpoint.1', binding(), 'phase-0', 0, {
        artifact: Buffer.from('raw-never-observed'),
      }),
    ).resolves.toMatchObject({ revision: 2, duplicate: false });
    await expect(observer.flush()).resolves.toBeUndefined();
    expect((await store.loadCheckpointControl('run.checkpoint.1'))?.checkpoints).toHaveLength(1);
    const entries = await readdir(join(workspace, 'journal', 'entries'));
    expect(entries).toHaveLength(1);
    expect(
      await readFile(join(workspace, 'journal', 'entries', entries[0]!), 'utf8'),
    ).not.toContain('raw-never-observed');
  }, 30_000);

  it('replays both head-to-journal and journal-to-ack crash windows', async () => {
    const workspace = await root();
    const journalRoot = join(workspace, 'journal');
    const publisher = createWorkflowCheckpointShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8082',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetch: vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const value = JSON.parse(String(init?.body)) as WorkflowCheckpointShadowEnvelope;
        return new Response(receipt(value, 'accepted'), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });
    const observer = await createWorkflowCheckpointObservationPort({
      enabled: true,
      journalRoot,
      publisher,
    });
    let failAcknowledgement = false;
    const memory = memoryStore({
      observer,
      failWrite: (path, writeNumber) =>
        failAcknowledgement && path.endsWith('/head.v1.json') && writeNumber === 7,
    });
    await memory.store.initializeCheckpointControl('run.checkpoint.1', binding());

    const invalidEntry = join(journalRoot, 'entries', 'not-an-envelope');
    await writeFile(invalidEntry, 'invalid');
    await expect(
      memory.store.commitWorkflowCheckpoint('run.checkpoint.1', binding(), 'phase-0', 0, {
        artifact: Buffer.from('artifact-one'),
      }),
    ).resolves.toMatchObject({ revision: 2 });
    expect(
      (await memory.store.loadCheckpointControl('run.checkpoint.1'))?.pendingObservations,
    ).toHaveLength(1);

    await unlink(invalidEntry);
    const restarted = new RunStore({
      baseDir: '/memory/workflows',
      fs: memory.fs,
      checkpointObservationPort: observer,
    });
    await restarted.initializeCheckpointControl('run.checkpoint.1', binding());
    expect(
      (await restarted.loadCheckpointControl('run.checkpoint.1'))?.pendingObservations,
    ).toEqual([]);

    await restarted.beginCheckpointResumeGeneration('run.checkpoint.1', binding(2), 'phase-1', 1);
    failAcknowledgement = true;
    await restarted.commitWorkflowCheckpoint('run.checkpoint.1', binding(2), 'phase-1', 1, {
      artifact: Buffer.from('artifact-two'),
    });
    expect(
      (await restarted.loadCheckpointControl('run.checkpoint.1'))?.pendingObservations,
    ).toHaveLength(1);

    failAcknowledgement = false;
    const secondRestart = new RunStore({
      baseDir: '/memory/workflows',
      fs: memory.fs,
      checkpointObservationPort: observer,
    });
    await secondRestart.initializeCheckpointControl('run.checkpoint.1', binding(2));
    await observer.flush();
    expect(
      (await secondRestart.loadCheckpointControl('run.checkpoint.1'))?.pendingObservations,
    ).toEqual([]);
  }, 30_000);

  it.each(['accepted', 'reconciliation_required'] as const)(
    'recovers a %s receipt after transport response loss without changing request bytes',
    async (status) => {
      const value = envelope();
      const requestBodies: string[] = [];
      let call = 0;
      const publisher = createWorkflowCheckpointShadowHttpPublisher({
        endpoint: 'http://127.0.0.1:8082',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
        fetch: vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          requestBodies.push(String(init?.body));
          call += 1;
          if (call === 1) throw new Error('response lost after commit');
          return new Response(receipt(value, status), {
            status: status === 'accepted' ? 200 : 202,
            headers: {
              'content-type': 'application/json',
              ...(status === 'accepted' ? { 'idempotency-replayed': 'true' } : {}),
            },
          });
        }) as typeof globalThis.fetch,
      });

      await expect(publisher.publish(value)).rejects.toMatchObject({
        code: 'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
      });
      await expect(publisher.publish(value)).resolves.toMatchObject({ status });
      expect(requestBodies).toEqual([
        workflowCheckpointCanonicalJson(value),
        workflowCheckpointCanonicalJson(value),
      ]);
    },
  );

  it('fails closed on a tampered journal entry without exposing its bytes', async () => {
    const workspace = await root();
    const journalRoot = join(workspace, 'journal');
    const never = new Promise<Response>(() => undefined);
    const blockedPublisher = createWorkflowCheckpointShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8082',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetch: vi.fn(async () => never) as typeof globalThis.fetch,
    });
    const first = await createWorkflowCheckpointObservationPort({
      enabled: true,
      journalRoot,
      publisher: blockedPublisher,
    });
    const value = envelope();
    await first.journalObservation(value.sourceSequence, value.operation, value.observation);
    const entryName = (await readdir(join(journalRoot, 'entries')))[0]!;
    await writeFile(join(journalRoot, 'entries', entryName), '{"rawSecret":"must-not-escape"}');

    const diagnostics: Array<{ code?: string; observationHash: string }> = [];
    const second = await createWorkflowCheckpointObservationPort({
      enabled: true,
      journalRoot,
      publisher: blockedPublisher,
      diagnosticSink: (item) => {
        diagnostics.push(item);
      },
    });
    await second.replay();

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
        observationHash: value.observationHash,
      }),
    );
    expect(JSON.stringify(diagnostics)).not.toContain('must-not-escape');
  }, 30_000);

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked journal entry through the no-follow reader',
    async () => {
      const workspace = await root();
      const journalRoot = join(workspace, 'journal');
      const blockedPublisher = createWorkflowCheckpointShadowHttpPublisher({
        endpoint: 'http://127.0.0.1:8082',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
        fetch: vi.fn(async () => new Promise<Response>(() => undefined)) as typeof globalThis.fetch,
      });
      const first = await createWorkflowCheckpointObservationPort({
        enabled: true,
        journalRoot,
        publisher: blockedPublisher,
      });
      const value = envelope();
      await first.journalObservation(value.sourceSequence, value.operation, value.observation);
      const entryName = (await readdir(join(journalRoot, 'entries')))[0]!;
      const entryPath = join(journalRoot, 'entries', entryName);
      const target = join(workspace, 'outside-envelope.json');
      await writeFile(target, workflowCheckpointCanonicalJson(value), { mode: 0o600 });
      await unlink(entryPath);
      await symlink(target, entryPath);

      const diagnostics: Array<{ code?: string }> = [];
      const second = await createWorkflowCheckpointObservationPort({
        enabled: true,
        journalRoot,
        publisher: blockedPublisher,
        diagnosticSink: (item) => {
          diagnostics.push(item);
        },
      });
      await second.replay();
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ code: 'WORKFLOW_CHECKPOINT_JOURNAL_INVALID' }),
      );
    },
    30_000,
  );

  it.runIf(process.platform !== 'win32')(
    'does not await a large offline backlog during observer startup',
    async () => {
      const workspace = await root();
      const journalRoot = join(workspace, 'journal');
      const bootstrapPublisher = createWorkflowCheckpointShadowHttpPublisher({
        endpoint: 'http://127.0.0.1:8082',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
        fetch: vi.fn(async () => {
          throw new Error('bootstrap publisher must not be called');
        }) as typeof globalThis.fetch,
      });
      const bootstrap = await createWorkflowCheckpointObservationPort({
        enabled: true,
        journalRoot,
        publisher: bootstrapPublisher,
      });
      await bootstrap.replay();

      for (let sourceSequence = 1; sourceSequence <= 64; sourceSequence += 1) {
        const value = envelope(sourceSequence);
        await writeFile(
          join(
            journalRoot,
            'entries',
            `${String(sourceSequence).padStart(16, '0')}-${value.observationHash}.json`,
          ),
          workflowCheckpointCanonicalJson(value),
          { mode: 0o600 },
        );
      }
      let fetchCalls = 0;
      const offlinePublisher = createWorkflowCheckpointShadowHttpPublisher({
        endpoint: 'http://127.0.0.1:8082',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
        timeoutMs: 30_000,
        fetch: vi.fn(async () => {
          fetchCalls += 1;
          return new Promise<Response>(() => undefined);
        }) as typeof globalThis.fetch,
      });

      await expect(
        Promise.race([
          createWorkflowCheckpointObservationPort({
            enabled: true,
            journalRoot,
            publisher: offlinePublisher,
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('observer startup waited for remote backlog')),
              20_000,
            ),
          ),
        ]),
      ).resolves.toBeDefined();
      expect(fetchCalls).toBeLessThanOrEqual(1);
    },
    30_000,
  );

  it('rejects journal capacity exhaustion before accepting another observation', async () => {
    const workspace = await root();
    const journalRoot = join(workspace, 'journal');
    const publisher = createWorkflowCheckpointShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8082',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetch: vi.fn(async () => {
        throw new Error('capacity rejection must happen before delivery');
      }) as typeof globalThis.fetch,
    });
    const observer = await createWorkflowCheckpointObservationPort({
      enabled: true,
      journalRoot,
      publisher,
    });
    await observer.replay();
    const first = envelope();
    await observer.journalObservation(first.sourceSequence, first.operation, first.observation);
    await observer.flush();
    const occupied = join(
      journalRoot,
      'entries',
      (await readdir(join(journalRoot, 'entries')))[0]!,
    );
    await truncate(occupied, 512 * 1024 * 1024);
    const value = envelope(2);

    await expect(
      observer.journalObservation(value.sourceSequence, value.operation, value.observation),
    ).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_JOURNAL_CAPACITY' });
  }, 30_000);

  it('rejects authority claims and raw unknown fields in the closed observation', () => {
    expect(() =>
      validateWorkflowCheckpointShadowObservation({
        schema: 'openslack.workflow_checkpoint_shadow_observation.v1',
        authority: 'typescript',
        goRole: 'authority',
        rawResult: 'forbidden',
      }),
    ).toThrow('missing or unknown fields');
  });
});
