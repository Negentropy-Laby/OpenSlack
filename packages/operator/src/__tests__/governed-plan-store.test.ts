import type * as FsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalGovernedJson,
  createCanonicalGovernedPlan,
  hashGovernedValue,
  hashOpaqueValue,
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
} from '../governed-plan.js';
import { LocalGovernedPlanStore, GovernedPlanStoreError } from '../governed-plan-store.js';

const renameFault = vi.hoisted(() => ({
  remaining: 0,
  calls: 0,
  corruptTemporary: false,
  corruptTarget: false,
  removeAfterScan: '',
  releaseAfterCollision: false,
  lockReadFault: '' as '' | 'changed' | 'ENOENT' | 'EPERM' | 'EPERM-present',
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (renameFault.lockReadFault && String(args[0]).endsWith('.lock')) {
        const fault = renameFault.lockReadFault;
        renameFault.lockReadFault = '';
        if (fault === 'changed') {
          await actual.utimes(args[0], new Date(0), new Date(0));
        } else {
          if (fault !== 'EPERM-present') await actual.rm(args[0]);
          throw Object.assign(new Error('Synthetic lock read failure'), {
            code: fault === 'EPERM-present' ? 'EPERM' : fault,
          });
        }
      }
      return actual.realpath(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await actual.readdir(...args);
      if (renameFault.removeAfterScan && String(args[0]) === dirname(renameFault.removeAfterScan)) {
        const path = renameFault.removeAfterScan;
        renameFault.removeAfterScan = '';
        await actual.rm(path);
      }
      return entries;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (renameFault.releaseAfterCollision && String(args[1]).endsWith('.lock')) {
        renameFault.releaseAfterCollision = false;
        await actual.link(...args);
        await actual.rm(args[1]);
        throw Object.assign(new Error('Synthetic released contender'), { code: 'EEXIST' });
      }
      return actual.link(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      renameFault.calls += 1;
      if (renameFault.remaining > 0) {
        renameFault.remaining -= 1;
        if (renameFault.corruptTarget) await actual.writeFile(args[1], 'external-change');
        if (renameFault.corruptTemporary) await actual.writeFile(args[0], 'corrupt');
        throw Object.assign(new Error('Synthetic sharing violation'), { code: 'EPERM' });
      }
      return actual.rename(...args);
    },
  };
});

const roots: string[] = [];

function makeRoot(): string {
  const root = join(
    tmpdir(),
    `openslack-governed-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function makeRecord(): GovernedPlanRecord {
  const plan = createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate scenario',
    input: { scenarioId: 'software-delivery' },
    actions: [{ actionId: 'scenario.instantiate', input: { scenarioId: 'software-delivery' } }],
    effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
  });
  const timestamp = '2026-07-27T00:00:00.000Z';
  return validateGovernedPlanRecord({
    schema: 'openslack.governed_plan.v1',
    revision: 1,
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
    state: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: '2026-07-27T00:15:00.000Z',
    canonicalPlan: plan,
    bindings: {
      actorId: 'qoder.local',
      workspaceId: 'workspace.demo',
      correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
      inputHash: hashGovernedValue(plan.input),
      planHash: hashGovernedValue(plan),
      sourceVersionHash: hashGovernedValue({ github: 'abc' }),
      permissionSnapshotHash: hashGovernedValue({ allowed: true }),
      actionCatalogHash: hashGovernedValue(['scenario.instantiate']),
      executorBindingHash: hashGovernedValue(['scenario.instantiate@v1']),
      buildNonceHash: hashOpaqueValue('build-nonce-0123456789'),
      processNonceHash: hashOpaqueValue('process-nonce-0123456789'),
    },
    confirmationTokenHash: hashOpaqueValue('confirmation-token-0123456789'),
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function paths(root: string, planId: string) {
  const key = hash(planId);
  return {
    record: join(root, 'records', `${key}.json`),
    lock: join(root, 'locks', `${key}.lock`),
  };
}

function lockOwner(pid: number) {
  return {
    schema: 'openslack.governed_plan_lock.v1',
    pid,
    sessionId: '123e4567-e89b-42d3-a456-426614174001',
    threadId: 0,
    nonce: '123e4567-e89b-42d3-a456-426614174002',
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

afterEach(() => {
  renameFault.remaining = 0;
  renameFault.calls = 0;
  renameFault.corruptTemporary = false;
  renameFault.corruptTarget = false;
  renameFault.removeAfterScan = '';
  renameFault.releaseAfterCollision = false;
  renameFault.lockReadFault = '';
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('local governed plan store', () => {
  it('creates exact canonical bytes and CAS-transitions pending plans', async () => {
    const root = makeRoot();
    const store = new LocalGovernedPlanStore(root);
    const created = await store.create(makeRecord());
    const raw = readFileSync(paths(root, created.planId).record, 'utf8');

    expect(raw).toBe(`${canonicalGovernedJson(created)}\n`);
    expect(await store.list()).toEqual([created]);
    const cancelled = await store.cancel({
      planId: created.planId,
      expectedRevision: created.revision,
      updatedAt: '2026-07-27T00:01:00.000Z',
    });
    expect(cancelled).toMatchObject({ state: 'cancelled', revision: 2 });
    await expect(
      store.cancel({
        planId: created.planId,
        expectedRevision: 1,
        updatedAt: '2026-07-27T00:02:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_STORE_CAS_MISMATCH' });
  });

  it('allows exactly one concurrent atomic claim', async () => {
    const store = new LocalGovernedPlanStore(makeRoot());
    const created = await store.create(makeRecord());
    const claim = () =>
      store.claimExecution({
        planId: created.planId,
        expectedRevision: created.revision,
        executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
        ownerPid: process.pid,
        startedAt: '2026-07-27T00:01:00.000Z',
      });

    const results = await Promise.allSettled([claim(), claim()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await store.load(created.planId))?.state).toBe('executing');
  });

  it.each(['transient', 'persistent', 'changed-temporary', 'changed-target'] as const)(
    'preserves atomic replacement through %s sharing faults',
    async (scenario) => {
      const root = makeRoot();
      const store = new LocalGovernedPlanStore(root);
      const created = await store.create(makeRecord());
      const original = readFileSync(paths(root, created.planId).record, 'utf8');
      renameFault.calls = 0;
      renameFault.remaining = scenario === 'persistent' ? 100 : 1;
      renameFault.corruptTemporary = scenario === 'changed-temporary';
      renameFault.corruptTarget = scenario === 'changed-target';
      const result = store.cancel({
        planId: created.planId,
        expectedRevision: 1,
        updatedAt: '2026-07-27T00:01:00.000Z',
      });
      if (process.platform === 'win32' && scenario === 'transient') {
        await expect(result).resolves.toMatchObject({ state: 'cancelled', revision: 2 });
        expect(renameFault.calls).toBe(2);
      } else {
        await expect(result).rejects.toMatchObject({
          code:
            process.platform === 'win32' && scenario.startsWith('changed-')
              ? 'GOVERNED_PLAN_STORE_FILE_CHANGED'
              : 'EPERM',
        });
        expect(readFileSync(paths(root, created.planId).record, 'utf8')).toBe(
          scenario === 'changed-target' ? 'external-change' : original,
        );
        expect(readdirSync(join(root, 'locks'))).toEqual([]);
        expect(readdirSync(join(root, 'records'))).toHaveLength(1);
        expect(renameFault.calls).toBe(
          process.platform === 'win32' && scenario === 'persistent' ? 20 : 1,
        );
        if (scenario === 'persistent') {
          renameFault.remaining = 0;
          await expect(
            store.cancel({
              planId: created.planId,
              expectedRevision: 1,
              updatedAt: '2026-07-27T00:01:00.000Z',
            }),
          ).resolves.toMatchObject({ state: 'cancelled' });
        }
      }
    },
  );

  it('retries a lock released before the first collision read', async () => {
    const store = new LocalGovernedPlanStore(makeRoot());
    const created = await store.create(makeRecord());
    renameFault.releaseAfterCollision = true;
    await expect(
      store.cancel({
        planId: created.planId,
        expectedRevision: 1,
        updatedAt: '2026-07-27T00:01:00.000Z',
      }),
    ).resolves.toMatchObject({ state: 'cancelled' });
    expect(renameFault.releaseAfterCollision).toBe(false);
  });

  it.each(['changed', 'ENOENT', 'EPERM', 'EPERM-present'] as const)(
    'handles %s during incumbent lock verification without deleting a live lock',
    async (fault) => {
      const root = makeRoot();
      const store = new LocalGovernedPlanStore(root);
      const created = await store.create(makeRecord());
      const lockPath = paths(root, created.planId).lock;
      const owner = `${canonicalGovernedJson(lockOwner(process.pid))}\n`;
      writeFileSync(lockPath, owner);
      renameFault.lockReadFault = fault;
      const operation = store.cancel({
        planId: created.planId,
        expectedRevision: 1,
        updatedAt: '2026-07-27T00:01:00.000Z',
      });
      if (fault === 'changed' || fault === 'EPERM-present') {
        await expect(operation).rejects.toMatchObject({
          code: fault === 'changed' ? 'GOVERNED_PLAN_STORE_BUSY' : 'EPERM',
        });
        expect(readFileSync(lockPath, 'utf8')).toBe(owner);
        expect((await store.load(created.planId))?.state).toBe('pending');
      } else if (fault === 'EPERM' && process.platform !== 'win32') {
        await expect(operation).rejects.toMatchObject({ code: 'EPERM' });
      } else {
        await expect(operation).resolves.toMatchObject({ state: 'cancelled' });
      }
    },
  );

  it.each(['record-temp', 'lock-temp', 'lock', 'record', 'unknown', 'symlink'] as const)(
    'handles a disappeared %s directory entry without weakening validation',
    async (kind) => {
      const root = makeRoot();
      const store = new LocalGovernedPlanStore(root);
      const created = await store.create(makeRecord());
      const id = hash(created.planId);
      const uuid = '123e4567-e89b-42d3-a456-426614174000';
      const path =
        kind === 'record'
          ? paths(root, created.planId).record
          : join(
              root,
              kind === 'record-temp' ? 'records' : 'locks',
              kind === 'record-temp'
                ? `.${id}.${uuid}.tmp`
                : kind === 'lock-temp'
                  ? `.lock.${id}.1.${uuid}.0.${uuid}.tmp`
                  : kind === 'lock' || kind === 'symlink'
                    ? `${id}.lock`
                    : 'unknown',
            );
      if (kind === 'symlink') symlinkSync(paths(root, created.planId).record, path, 'file');
      else if (kind !== 'record') writeFileSync(path, 'temporary');
      renameFault.removeAfterScan = path;
      if (['record-temp', 'lock-temp', 'lock'].includes(kind)) {
        await expect(store.load(created.planId)).resolves.toMatchObject({ state: 'pending' });
      } else {
        await expect(store.load(created.planId)).rejects.toMatchObject({
          code:
            kind === 'record'
              ? 'GOVERNED_PLAN_STORE_FILE_CHANGED'
              : 'GOVERNED_PLAN_STORE_FILE_UNSAFE',
        });
      }
      expect(renameFault.removeAfterScan).toBe('');
    },
  );

  it('rejects duplicate-key/noncanonical persisted JSON', async () => {
    const root = makeRoot();
    const store = new LocalGovernedPlanStore(root);
    const created = await store.create(makeRecord());
    const recordPath = paths(root, created.planId).record;
    const raw = readFileSync(recordPath, 'utf8');
    writeFileSync(recordPath, raw.replace('{', '{"schema":"openslack.governed_plan.v1",'), 'utf8');

    await expect(store.load(created.planId)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_STORE_RECORD_INVALID',
    });
  });

  it('rejects malformed UTF-8 before decoding persisted record bytes', async () => {
    const root = makeRoot();
    const store = new LocalGovernedPlanStore(root);
    const created = await store.create(makeRecord());
    const recordPath = paths(root, created.planId).record;
    const raw = readFileSync(recordPath);
    raw[raw.indexOf(Buffer.from('Instantiate scenario'))] = 0xff;
    writeFileSync(recordPath, raw);

    await expect(store.load(created.planId)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_STORE_RECORD_INVALID',
      message: 'Governed plan record is not valid UTF-8.',
    });
  });

  it('recovers only a canonical lock whose owner PID is provably dead', async () => {
    const root = makeRoot();
    const store = new LocalGovernedPlanStore(root);
    const created = await store.create(makeRecord());
    const lockPath = paths(root, created.planId).lock;
    writeFileSync(lockPath, `${canonicalGovernedJson(lockOwner(2_147_483_647))}\n`, 'utf8');
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 2_147_483_647) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    const cancelled = await store.cancel({
      planId: created.planId,
      expectedRevision: created.revision,
      updatedAt: '2026-07-27T00:01:00.000Z',
    });

    expect(cancelled.state).toBe('cancelled');
  });

  it('never breaks a live or forged lock', async () => {
    const liveRoot = makeRoot();
    const liveStore = new LocalGovernedPlanStore(liveRoot);
    const live = await liveStore.create(makeRecord());
    writeFileSync(
      paths(liveRoot, live.planId).lock,
      `${canonicalGovernedJson(lockOwner(process.pid))}\n`,
      'utf8',
    );
    await expect(
      liveStore.cancel({
        planId: live.planId,
        expectedRevision: live.revision,
        updatedAt: '2026-07-27T00:01:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_STORE_BUSY' });

    const forgedRoot = makeRoot();
    const forgedStore = new LocalGovernedPlanStore(forgedRoot);
    const forged = await forgedStore.create(makeRecord());
    writeFileSync(paths(forgedRoot, forged.planId).lock, '{}\n', 'utf8');
    await expect(
      forgedStore.cancel({
        planId: forged.planId,
        expectedRevision: forged.revision,
        updatedAt: '2026-07-27T00:01:00.000Z',
      }),
    ).rejects.toBeInstanceOf(GovernedPlanStoreError);
    await expect(
      forgedStore.cancel({
        planId: forged.planId,
        expectedRevision: forged.revision,
        updatedAt: '2026-07-27T00:01:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_STORE_FILE_UNSAFE' });
  });
});
