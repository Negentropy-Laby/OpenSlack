import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowControlObservationError } from '../workflow-control-observation.js';
import {
  WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
  acquireOwnerJournalLock,
  createWorkflowControlObservationPort,
  createWorkflowControlObservationPortForTest,
  createWorkflowControlShadowPublisherPort,
  prepareWorkflowControlShadowRequest,
  type WorkflowControlShadowJournalSecurityDependencies,
  type WorkflowControlShadowDiagnostic,
} from '../workflow-control-shadow.js';
import {
  canonicalWorkflowControlJson,
  hashWorkflowControlValue,
} from '../workflow-control-contract.js';
import { shadowObservation } from './workflow-control-shadow-fixtures.js';

const roots: string[] = [];
const WINDOWS_OWNER_SID = 'S-1-5-21-1000-1001-1002-1003';
const WINDOWS_SYSTEM_SID = 'S-1-5-18';
// Hosted windows-2022 runs have reached 17.8s and each ACL subprocess remains bounded at 20s.
const DURABLE_JOURNAL_TIMEOUT_MS = process.platform === 'win32' ? 45_000 : 5_000;

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function journalRoot(name: string) {
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const parent = await realpath(resolve(await mkdtemp(join(temporaryRoot, `${name}-`))));
  roots.push(parent);
  await chmod(parent, 0o700);
  return join(parent, 'journal');
}

function safeWindowsAcl() {
  return {
    owner: WINDOWS_OWNER_SID,
    protected: true,
    reparse: false,
    rules: [
      { sid: WINDOWS_OWNER_SID, type: 'Allow' },
      { sid: WINDOWS_SYSTEM_SID, type: 'Allow' },
    ],
  } as const;
}

function windowsSecurity(
  options: Partial<WorkflowControlShadowJournalSecurityDependencies> = {},
): WorkflowControlShadowJournalSecurityDependencies {
  return Object.freeze({
    platform: 'win32' as const,
    currentWindowsSid: () => WINDOWS_OWNER_SID,
    readWindowsPathSecurity:
      options.readWindowsPathSecurity ?? (() => JSON.stringify(safeWindowsAcl())),
    hardenPath: options.hardenPath ?? (() => undefined),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.processId ? { processId: options.processId } : {}),
    ...(options.processSessionId ? { processSessionId: options.processSessionId } : {}),
    ...(options.probeProcess ? { probeProcess: options.probeProcess } : {}),
  });
}

function receiptFor(
  envelope: Parameters<ReturnType<typeof createWorkflowControlShadowPublisherPort>['publish']>[0],
) {
  const request = prepareWorkflowControlShadowRequest(envelope);
  return {
    schema: WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest',
    status: 'accepted',
    parity: 'matched',
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    workspaceId: envelope.source.workspaceId,
    runId: envelope.source.runId,
    sourceSequence: envelope.source.sourceSequence,
    observationDigest: createHash('sha256').update(request.body).digest('hex'),
    observationHash: envelope.projection.observationHash,
    committedAt: '2026-08-03T00:00:03.000Z',
  } as const;
}

describe('Workflow Control GS7-B durable observation journal', () => {
  it('is default-off and requires no journal, network, or authority dependencies', async () => {
    const port = await createWorkflowControlObservationPort();
    expect(() => port.observeRun('run-disabled')).not.toThrow();
    await expect(port.flush()).resolves.toBeUndefined();
  });

  it(
    'coalesces identical snapshots and allocates monotonic sequence per workspace/run',
    async () => {
      const published: number[] = [];
      const publisher = createWorkflowControlShadowPublisherPort(async (envelope) => {
        published.push(envelope.source.sourceSequence);
        return receiptFor(envelope);
      });
      let observation = shadowObservation();
      const root = await journalRoot('workflow-shadow-coalesce');
      const port = await createWorkflowControlObservationPort({
        enabled: true,
        workspaceId: 'workspace.test',
        journalRoot: root,
        publisher,
        buildObservation: async () => observation,
      });
      port.observeRun(observation.runId);
      port.observeRun(observation.runId);
      await port.flush();
      observation = shadowObservation({ updatedAt: '2026-08-03T00:00:02.000Z' });
      port.observeRun(observation.runId);
      await port.flush();
      expect(published).toEqual([1, 2]);
      expect(await readdir(join(root, 'entries'))).toEqual([]);
      const [stateName] = await readdir(join(root, 'states'));
      const state = JSON.parse(await readFile(join(root, 'states', stateName!), 'utf8')) as {
        lastSequence: number;
        ackedSequence: number;
        lastObservationHash: string;
      };
      expect(state).toMatchObject({ lastSequence: 2, ackedSequence: 2 });
      expect(state.lastObservationHash).toBe(hashWorkflowControlValue(observation));
    },
    DURABLE_JOURNAL_TIMEOUT_MS,
  );

  it(
    'persists before publish and replays the exact entry after an unavailable publisher',
    async () => {
      const root = await journalRoot('workflow-shadow-replay');
      const unavailable = createWorkflowControlShadowPublisherPort(async () => {
        throw new Error('offline');
      });
      const observation = shadowObservation();
      const first = await createWorkflowControlObservationPort({
        enabled: true,
        workspaceId: 'workspace.test',
        journalRoot: root,
        publisher: unavailable,
        buildObservation: async () => observation,
      });
      first.observeRun(observation.runId);
      await first.flush();
      expect(await readdir(join(root, 'entries'))).toHaveLength(1);

      const sequences: number[] = [];
      const available = createWorkflowControlShadowPublisherPort(async (envelope) => {
        sequences.push(envelope.source.sourceSequence);
        return receiptFor(envelope);
      });
      const second = await createWorkflowControlObservationPort({
        enabled: true,
        workspaceId: 'workspace.test',
        journalRoot: root,
        publisher: available,
        buildObservation: async () => observation,
      });
      await second.flush();
      expect(sequences).toEqual([1]);
      expect(await readdir(join(root, 'entries'))).toEqual([]);
    },
    DURABLE_JOURNAL_TIMEOUT_MS,
  );

  it(
    'recovers an entry orphaned between durable entry and state publication',
    async () => {
      const root = await journalRoot('workflow-shadow-orphan');
      const observation = shadowObservation();
      const first = await createWorkflowControlObservationPort({
        enabled: true,
        workspaceId: 'workspace.test',
        journalRoot: root,
        publisher: createWorkflowControlShadowPublisherPort(async () => {
          throw new Error('offline');
        }),
        buildObservation: async () => observation,
      });
      first.observeRun(observation.runId);
      await first.flush();
      const [stateName] = await readdir(join(root, 'states'));
      await rm(join(root, 'states', stateName!));

      const sequences: number[] = [];
      const second = await createWorkflowControlObservationPort({
        enabled: true,
        workspaceId: 'workspace.test',
        journalRoot: root,
        publisher: createWorkflowControlShadowPublisherPort(async (envelope) => {
          sequences.push(envelope.source.sourceSequence);
          return receiptFor(envelope);
        }),
        buildObservation: async () => observation,
      });
      await second.flush();
      expect(sequences).toEqual([1]);
      expect(await readdir(join(root, 'entries'))).toEqual([]);
    },
    DURABLE_JOURNAL_TIMEOUT_MS,
  );

  it(
    'treats EPERM as live contention and keeps the observation until the lock is released',
    async () => {
      const root = await journalRoot('workflow-shadow-capacity-lock');
      const published: string[] = [];
      const observation = shadowObservation({ runId: 'run-capacity-lock' });
      const port = await createWorkflowControlObservationPortForTest(
        {
          enabled: true,
          workspaceId: 'workspace.test',
          journalRoot: root,
          publisher: createWorkflowControlShadowPublisherPort(async (envelope) => {
            published.push(envelope.source.runId);
            return receiptFor(envelope);
          }),
          buildObservation: async () => observation,
        },
        windowsSecurity({
          probeProcess: () => {
            throw Object.assign(new Error('foreign live owner'), { code: 'EPERM' });
          },
          sleep: async () => {
            await rm(lockPath, { force: true });
          },
        }),
      );
      const capacityHash = createHash('sha256')
        .update('openslack.workflow-control-shadow.journal-capacity.v1')
        .digest('hex');
      const lockPath = join(root, 'locks', `${capacityHash}.lock`);
      await writeFile(
        lockPath,
        `${canonicalWorkflowControlJson({
          schema: 'openslack.workflow_control_shadow_journal_lock.v1',
          pid: 424_242,
          sessionId: '123e4567-e89b-42d3-a456-426614174003',
          createdAt: '2026-08-03T00:00:00.000Z',
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );

      port.observeRun(observation.runId);
      await port.flush();
      expect(published).toEqual([observation.runId]);
      expect(await readdir(join(root, 'entries'))).toEqual([]);
    },
    DURABLE_JOURNAL_TIMEOUT_MS,
  );

  it('reclaims a reused PID with a different process session without probing it as live', async () => {
    const root = await journalRoot('workflow-shadow-pid-reuse');
    await mkdir(root, { mode: 0o700 });
    const lockHash = 'a'.repeat(64);
    const lockPath = join(root, `${lockHash}.lock`);
    const probeProcess = vi.fn(() => {
      throw new Error('same reused PID must not be probed');
    });
    await writeFile(
      lockPath,
      `${canonicalWorkflowControlJson({
        schema: 'openslack.workflow_control_shadow_journal_lock.v1',
        pid: 7_777,
        sessionId: '123e4567-e89b-42d3-a456-426614174002',
        createdAt: '2026-08-03T00:00:00.000Z',
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    const release = await acquireOwnerJournalLock(
      root,
      lockHash,
      windowsSecurity({
        processId: 7_777,
        processSessionId: '123e4567-e89b-42d3-a456-426614174001',
        probeProcess,
      }),
    );
    expect(probeProcess).not.toHaveBeenCalled();
    await release();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps invalid and legacy observations out of the durable journal with hashed diagnostics', async () => {
    const diagnostics: WorkflowControlShadowDiagnostic[] = [];
    const publisher = createWorkflowControlShadowPublisherPort(
      vi.fn(async (envelope) => receiptFor(envelope)),
    );
    const root = await journalRoot('workflow-shadow-invalid');
    const port = await createWorkflowControlObservationPort({
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot: root,
      publisher,
      buildObservation: async () => {
        throw new WorkflowControlObservationError(
          'WORKFLOW_CONTROL_OBSERVATION_LEGACY_MANIFEST_HASH',
          'legacy hash',
        );
      },
      diagnosticSink: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    port.observeRun('run-shadow-test');
    await port.flush();
    expect(await readdir(join(root, 'entries'))).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        outcome: 'legacy_manifest_skipped',
        workspaceIdHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        runIdHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('workspace.test');
    expect(JSON.stringify(diagnostics)).not.toContain('run-shadow-test');
  });

  it('hardens and proves Windows ACL ownership for every journal directory and new file', async () => {
    const hardened: { path: string; directory: boolean }[] = [];
    const verified: { path: string; cacheable: boolean }[] = [];
    const root = await journalRoot('workflow-shadow-windows-acl');
    const observation = shadowObservation();
    const port = await createWorkflowControlObservationPortForTest(
      {
        enabled: true,
        workspaceId: 'workspace.test',
        journalRoot: root,
        publisher: createWorkflowControlShadowPublisherPort(async (envelope) =>
          receiptFor(envelope),
        ),
        buildObservation: async () => observation,
      },
      windowsSecurity({
        hardenPath: (path, directory) => {
          hardened.push({ path, directory });
        },
        readWindowsPathSecurity: (path, _identity, cacheable) => {
          verified.push({ path, cacheable });
          return JSON.stringify(safeWindowsAcl());
        },
      }),
    );
    port.observeRun(observation.runId);
    await port.flush();

    expect(hardened.filter(({ directory }) => directory).map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        root,
        join(root, 'entries'),
        join(root, 'locks'),
        join(root, 'states'),
      ]),
    );
    const hardenedFiles = hardened.filter(({ directory }) => !directory).map(({ path }) => path);
    expect(hardenedFiles.some((path) => /[\\/]locks[\\/][0-9a-f]{64}\.lock$/u.test(path))).toBe(
      true,
    );
    expect(hardenedFiles.some((path) => /[\\/]entries[\\/].+\.json$/u.test(path))).toBe(true);
    expect(hardenedFiles.some((path) => /[\\/]states[\\/].+\.tmp$/u.test(path))).toBe(true);
    expect(verified.filter(({ cacheable }) => cacheable).map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        root,
        join(root, 'entries'),
        join(root, 'locks'),
        join(root, 'states'),
      ]),
    );
    expect(verified.every(({ cacheable }) => cacheable)).toBe(true);
    expect(
      verified.some(
        ({ path, cacheable }) => cacheable && /[\\/]states[\\/][0-9a-f]{64}\.json$/u.test(path),
      ),
    ).toBe(true);
  });

  it('rejects pre-existing Windows journals with unprotected, foreign, broad, or reparse ACLs', async () => {
    const unsafeAcls = [
      { ...safeWindowsAcl(), protected: false },
      { ...safeWindowsAcl(), owner: 'S-1-5-21-9999' },
      {
        ...safeWindowsAcl(),
        rules: [...safeWindowsAcl().rules, { sid: 'S-1-1-0', type: 'Allow' as const }],
      },
      { ...safeWindowsAcl(), reparse: true },
    ] as const;
    for (const [index, acl] of unsafeAcls.entries()) {
      const root = await journalRoot(`workflow-shadow-windows-unsafe-${index}`);
      await mkdir(root, { mode: 0o700 });
      const hardenPath = vi.fn();
      await expect(
        createWorkflowControlObservationPortForTest(
          {
            enabled: true,
            workspaceId: 'workspace.test',
            journalRoot: root,
            publisher: createWorkflowControlShadowPublisherPort(async (envelope) =>
              receiptFor(envelope),
            ),
            buildObservation: async () => shadowObservation(),
          },
          windowsSecurity({ hardenPath, readWindowsPathSecurity: () => acl }),
        ),
      ).rejects.toThrow(/Windows ACL is not owner-only/u);
      expect(hardenPath).not.toHaveBeenCalled();
    }
  });

  it('fails open without publishing when a newly created Windows journal file has an unsafe ACL', async () => {
    const diagnostics: WorkflowControlShadowDiagnostic[] = [];
    const publish = vi.fn(async (envelope) => receiptFor(envelope));
    const root = await journalRoot('workflow-shadow-windows-file-unsafe');
    const port = await createWorkflowControlObservationPortForTest(
      {
        enabled: true,
        workspaceId: 'workspace.test',
        journalRoot: root,
        publisher: createWorkflowControlShadowPublisherPort(publish),
        buildObservation: async () => shadowObservation(),
        diagnosticSink: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
      windowsSecurity({
        readWindowsPathSecurity: (path) =>
          path.endsWith('.lock')
            ? {
                ...safeWindowsAcl(),
                rules: [...safeWindowsAcl().rules, { sid: 'S-1-1-0', type: 'Allow' as const }],
              }
            : safeWindowsAcl(),
      }),
    );
    port.observeRun('run-shadow-test');
    await port.flush();
    expect(publish).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      expect.objectContaining({ outcome: 'journal_invalid', code: 'append' }),
    ]);
    expect(await readdir(join(root, 'locks'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked journal root before Windows ACL inspection',
    async () => {
      const root = await journalRoot('workflow-shadow-windows-symlink');
      const target = join(resolve(root, '..'), 'journal-target');
      await mkdir(target, { mode: 0o700 });
      await symlink(target, root, 'dir');
      const readWindowsPathSecurity = vi.fn(() => safeWindowsAcl());
      await expect(
        createWorkflowControlObservationPortForTest(
          {
            enabled: true,
            workspaceId: 'workspace.test',
            journalRoot: root,
            publisher: createWorkflowControlShadowPublisherPort(async (envelope) =>
              receiptFor(envelope),
            ),
            buildObservation: async () => shadowObservation(),
          },
          windowsSecurity({ readWindowsPathSecurity }),
        ),
      ).rejects.toThrow(/directory must be owner-only/u);
      expect(readWindowsPathSecurity).not.toHaveBeenCalled();
    },
  );
});
