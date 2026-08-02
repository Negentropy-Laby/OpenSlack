import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
