import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowEffectDecisionAuthority,
  LocalWorkflowEffectApprovalStore,
  validateWorkflowEffectApproval,
  workflowEffectApprovalBytes,
} from '../index.js';
import { canonicalWorkflowEffectJson } from '../workflow-effect-json.js';

const lockReadRace = vi.hoisted(() => ({
  lockPath: '',
  recordPath: '',
  onOpen: undefined as (() => Promise<never>) | undefined,
  onRealpath: undefined as (() => Promise<string>) | undefined,
  verificationError: undefined as NodeJS.ErrnoException | undefined,
  beforeRename: undefined as (() => Promise<void>) | undefined,
  readRefusals: 0,
  lockSources: [] as string[],
  replacements: 0,
}));

const scanRace = vi.hoisted(() => ({
  directory: '',
  path: '',
  kind: '',
  code: '',
  ownerCheck: false,
  stats: 0,
  fired: false,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    open: (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === lockReadRace.lockPath && lockReadRace.onOpen) {
        const refuse = lockReadRace.onOpen;
        lockReadRace.onOpen = undefined;
        lockReadRace.readRefusals += 1;
        return refuse();
      }
      return fs.open(...args);
    },
    realpath: (...args: Parameters<typeof fs.realpath>) => {
      if (String(args[0]) === lockReadRace.lockPath && lockReadRace.onRealpath) {
        const observe = lockReadRace.onRealpath;
        lockReadRace.onRealpath = undefined;
        lockReadRace.readRefusals += 1;
        return observe();
      }
      return fs.realpath(...args);
    },
    link: (...args: Parameters<typeof fs.link>) => {
      if (String(args[1]) !== lockReadRace.lockPath) return fs.link(...args);
      return fs.link(...args).then(() => {
        lockReadRace.lockSources.push(String(args[0]));
      });
    },
    rename: (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) !== lockReadRace.recordPath) return fs.rename(...args);
      return (async () => {
        await lockReadRace.beforeRename?.();
        await fs.rename(...args);
        lockReadRace.replacements += 1;
      })();
    },
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await fs.readdir(...args);
      if (String(args[0]) === scanRace.directory && !scanRace.fired) {
        for (const entry of entries) {
          if (typeof entry === 'object' && scanRace.path.endsWith(String(entry.name))) {
            if (scanRace.kind) {
              entry.isSymbolicLink = () => scanRace.kind === 'link';
              entry.isFile = () => false;
            }
          }
        }
        if (!scanRace.ownerCheck && !scanRace.code) {
          await fs.rm(scanRace.path);
          scanRace.fired = true;
        }
      }
      return entries;
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === lockReadRace.lockPath && lockReadRace.verificationError) {
        const error = lockReadRace.verificationError;
        lockReadRace.verificationError = undefined;
        throw error;
      }
      if (String(args[0]) === scanRace.path) {
        scanRace.stats += 1;
        if (scanRace.code && !scanRace.fired) {
          scanRace.fired = true;
          if (scanRace.code === 'ENOENT') {
            await fs.rm(scanRace.path);
            await fs.writeFile(scanRace.path, '{}', { mode: 0o600 });
          }
          throw Object.assign(new Error('controlled metadata failure'), { code: scanRace.code });
        }
        if (scanRace.ownerCheck && scanRace.stats === 2) {
          await fs.rm(scanRace.path);
          scanRace.fired = true;
        }
      }
      return fs.lstat(...args);
    },
  };
});

const temporaryRoots: string[] = [];
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const effectHash = 'a'.repeat(64);
const approvedReasonHash = 'd'.repeat(64);
const rejectedReasonHash = 'e'.repeat(64);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'openslack-workflow-effect-approval-'));
  temporaryRoots.push(value);
  return resolve(value);
}

function authority() {
  return createWorkflowEffectDecisionAuthority({
    workspaceId: 'workspace-main',
    humanPrincipalIds: ['human-reviewer'],
    capabilities: ['workflow.effect.decide'],
    maxBindingTtlMs: 60_000,
  });
}

function pending(now: number) {
  return {
    runId: 'run-001',
    approvalId: 'approval-001',
    correlationId: 'business-correlation-001',
    workflowId: 'delivery.create',
    workflowVersion: '1.2.3',
    workflowHash: 'b'.repeat(64),
    inputHash: 'c'.repeat(64),
    effectId: `workflow-effect:sha256:${effectHash}`,
    effectHash,
    requiredCapability: 'workflow.effect.decide',
    createdAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  } as const;
}

function binding(
  decisionAuthority: ReturnType<typeof authority>,
  now: number,
  decision: 'approved' | 'rejected',
  reasonHash: string,
) {
  // Issuance and the store's injected decision clock describe the same fixture
  // window, irrespective of time spent awaiting real filesystem operations.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try {
    return decisionAuthority.issueHumanDecisionBinding({
      principalId: 'human-reviewer',
      capability: 'workflow.effect.decide',
      runId: 'run-001',
      approvalId: 'approval-001',
      correlationId: 'business-correlation-001',
      approvalExpiresAt: new Date(now + 60_000).toISOString(),
      decision,
      reasonHash,
      expiresAt: new Date(now + 30_000).toISOString(),
    });
  } finally {
    vi.useRealTimers();
  }
}

function recordName(runId = 'run-001', approvalId = 'approval-001') {
  return `${createHash('sha256').update(`${runId}\0${approvalId}`).digest('hex')}.json`;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const pid = child.pid!;
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', () => resolveExit());
  });
  return pid;
}

afterEach(async () => {
  Object.assign(lockReadRace, {
    lockPath: '',
    recordPath: '',
    onOpen: undefined,
    onRealpath: undefined,
    verificationError: undefined,
    beforeRename: undefined,
    readRefusals: 0,
    lockSources: [],
    replacements: 0,
  });
  Object.assign(scanRace, {
    directory: '',
    path: '',
    kind: '',
    code: '',
    ownerCheck: false,
    stats: 0,
    fired: false,
  });
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('LocalWorkflowEffectApprovalStore', () => {
  it.each([
    'decision.lock',
    '.decision.123.11111111-1111-4111-8111-111111111111.0.22222222-2222-4222-8222-222222222222.tmp',
    `.${'a'.repeat(64)}.123.11111111-1111-4111-8111-111111111111.tmp`,
  ])('allows a known transient %s to disappear after enumeration', async (name) => {
    const storeRoot = await root();
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, authority());
    const created = await store.createPending(pending(Date.now()));
    const directory = join(storeRoot, name.startsWith(`.${'a'.repeat(64)}`) ? 'records' : 'locks');
    const path = join(directory, name);
    await writeFile(path, '{}', { mode: 0o600 });
    Object.assign(scanRace, { directory, path });
    await expect(store.read('run-001', 'approval-001')).resolves.toEqual(created);
    expect(scanRace.fired).toBe(true);
  });

  describe('owner-only inventory', () => {
    let store: LocalWorkflowEffectApprovalStore;
    let created: Awaited<ReturnType<LocalWorkflowEffectApprovalStore['createPending']>>;
    let directory: string;

    beforeEach(async () => {
      // Real Windows ACL provisioning is fixture setup, not the raced read.
      // Keep both the hook budget and the tested operation's timeout unchanged.
      const storeRoot = join(await root(), 'effect-approvals');
      store = new LocalWorkflowEffectApprovalStore(storeRoot, authority());
      created = await store.createPending(pending(Date.now()));
      directory = join(storeRoot, 'locks');
    });

    it('allows transient removal during owner-only validation, not just the first lstat', async () => {
      const path = join(directory, 'decision.lock');
      await writeFile(path, '{}', { mode: 0o600 });
      Object.assign(scanRace, { directory, path, ownerCheck: true });
      await expect(store.read('run-001', 'approval-001')).resolves.toEqual(created);
      expect(scanRace.fired).toBe(true);
    });
  });

  it.each(['link', 'directory', 'unknown', 'record', 'EACCES', 'ENOENT'])(
    'does not hide unsafe or durable metadata failures: %s',
    async (failure) => {
      const storeRoot = await root();
      const store = new LocalWorkflowEffectApprovalStore(storeRoot, authority());
      await store.createPending(pending(Date.now()));
      const directory = join(storeRoot, failure === 'record' ? 'records' : 'locks');
      const path = join(
        directory,
        failure === 'record'
          ? recordName()
          : failure === 'unknown'
            ? 'unknown.tmp'
            : 'decision.lock',
      );
      if (failure !== 'record') await writeFile(path, '{}', { mode: 0o600 });
      Object.assign(scanRace, {
        directory,
        path,
        kind: ['link', 'directory'].includes(failure) ? failure : '',
        code: ['EACCES', 'ENOENT'].includes(failure) ? failure : '',
      });
      await expect(store.read('run-001', 'approval-001')).rejects.toMatchObject({
        code:
          failure === 'record'
            ? 'ENOENT'
            : ['EACCES', 'ENOENT'].includes(failure)
              ? failure
              : 'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
      });
      expect(scanRace.fired).toBe(true);
    },
  );

  it('treats an absent owner-only store as empty but rejects a partial tree', async () => {
    const workspaceRoot = await root();
    const storeRoot = join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals');
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, authority());

    expect(await store.read('run-001', 'approval-001')).toBeUndefined();
    await store.createPending(pending(Date.now()));
    await rm(join(storeRoot, 'records'), { recursive: true, force: true });
    await expect(store.read('run-001', 'approval-001')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
    });
  }, 10_000);

  it('persists canonical v2 records outside the workflow run store', async () => {
    const now = Date.now();
    const storeRoot = await root();
    const decisionAuthority = authority();
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, decisionAuthority, () =>
      new Date(now + 1_000).toISOString(),
    );

    expect(await store.read('run-001', 'approval-001')).toBeUndefined();
    const created = await store.createPending(pending(now));
    expect(await store.read('run-001', 'approval-001')).toEqual(created);
    expect(created.correlationId).toBe('business-correlation-001');
    expect(await readFile(join(storeRoot, 'records', recordName()), 'utf8')).toBe(
      `${canonicalWorkflowEffectJson(created)}\n`,
    );
    expect(await readFile(join(storeRoot, 'records', recordName()), 'utf8')).not.toContain(
      'pending-approvals.json',
    );
  });

  it('uses one atomic CAS winner under concurrent opposite decisions', async () => {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const now = Date.now();
      const storeRoot = await root();
      const decisionAuthority = authority();
      const store = new LocalWorkflowEffectApprovalStore(storeRoot, decisionAuthority, () =>
        new Date(now + 1_000).toISOString(),
      );
      await store.createPending(pending(now));
      lockReadRace.recordPath = join(storeRoot, 'records', recordName());
      lockReadRace.replacements = 0;
      const approvedBinding = binding(decisionAuthority, now, 'approved', approvedReasonHash);
      const rejectedBinding = binding(decisionAuthority, now, 'rejected', rejectedReasonHash);

      const results = await Promise.allSettled([
        store.decide({
          runId: 'run-001',
          approvalId: 'approval-001',
          expectedRevision: 0,
          decision: 'approved',
          reasonHash: approvedReasonHash,
          binding: approvedBinding,
        }),
        store.decide({
          runId: 'run-001',
          approvalId: 'approval-001',
          expectedRevision: 0,
          decision: 'rejected',
          reasonHash: rejectedReasonHash,
          binding: rejectedBinding,
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const winner = results.find((result) => result.status === 'fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('Concurrent decision has no winner.');
      expect(await readFile(lockReadRace.recordPath)).toEqual(
        workflowEffectApprovalBytes(winner.value),
      );
      expect(lockReadRace.replacements).toBe(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        reason: { code: 'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH' },
      });
      const final = await store.read('run-001', 'approval-001');
      expect(final?.correlationId).toBe('business-correlation-001');
      expect(final?.revision).toBe(1);
      expect(['approved', 'rejected']).toContain(final?.status);
      expect(final).toEqual(winner.value);
    }
  }, 30_000);

  it.each([
    { code: 'EPERM', retire: true, phase: 'open', verification: false },
    { code: 'EPERM', retire: false, phase: 'open', verification: false },
    { code: 'EACCES', retire: true, phase: 'open', verification: false },
    { code: 'RESOLVED', retire: true, phase: 'realpath', verification: false },
    { code: 'RESOLVED', retire: false, phase: 'realpath', verification: false },
    { code: 'EACCES', retire: true, phase: 'realpath', verification: true },
  ])(
    'keeps incumbent $phase $code / retirement=$retire / verification=$verification bound to actual lock ownership',
    async ({ code, retire, phase, verification }) => {
      const now = Date.now();
      const storeRoot = await root();
      const decisionAuthority = authority();
      const store = new LocalWorkflowEffectApprovalStore(storeRoot, decisionAuthority, () =>
        new Date(now + 1_000).toISOString(),
      );
      await store.createPending(pending(now));
      const lockPath = join(storeRoot, 'locks', 'decision.lock');
      let atWrite!: () => void;
      let releaseWriter!: () => void;
      let enteredWrite = false;
      const writeEntered = new Promise<void>((resolveWrite) => {
        atWrite = resolveWrite;
      });
      const writeGate = new Promise<void>((resolveWrite) => {
        releaseWriter = resolveWrite;
      });
      Object.assign(lockReadRace, {
        lockPath,
        recordPath: join(storeRoot, 'records', recordName()),
        beforeRename: async () => {
          enteredWrite = true;
          atWrite();
          await writeGate;
        },
      });
      const winner = store.decide({
        runId: 'run-001',
        approvalId: 'approval-001',
        expectedRevision: 0,
        decision: 'approved',
        reasonHash: approvedReasonHash,
        binding: binding(decisionAuthority, now, 'approved', approvedReasonHash),
      });
      let contender: ReturnType<typeof store.decide> | undefined;
      const refusal = Object.assign(new Error('Controlled incumbent open refusal.'), {
        code,
        syscall: 'open',
        path: lockPath,
      });
      try {
        await Promise.race([writeEntered, winner]);
        expect(enteredWrite).toBe(true);
        const incumbent = await lstat(lockPath, { bigint: true });
        const incumbentBytes = await readFile(lockPath);
        const retireWriter = async () => {
          if (!retire) return;
          releaseWriter();
          await winner;
        };
        if (phase === 'open') {
          lockReadRace.onOpen = async () => {
            await retireWriter();
            throw refusal;
          };
        } else {
          lockReadRace.onRealpath = async () => {
            await retireWriter();
            if (verification) lockReadRace.verificationError = refusal;
            return join(storeRoot, 'unverified-incumbent-name');
          };
        }
        contender = store.decide({
          runId: 'run-001',
          approvalId: 'approval-001',
          expectedRevision: 0,
          decision: 'rejected',
          reasonHash: rejectedReasonHash,
          binding: binding(decisionAuthority, now, 'rejected', rejectedReasonHash),
        });
        const [outcome] = await Promise.allSettled([contender]);
        expect(outcome?.status).toBe('rejected');
        const retryRetired =
          retire &&
          !verification &&
          (phase === 'realpath' || (process.platform === 'win32' && code === 'EPERM'));
        if (retryRetired) {
          expect(outcome).toMatchObject({
            reason: { code: 'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH' },
          });
          expect(lockReadRace.lockSources).toHaveLength(2);
          expect(new Set(lockReadRace.lockSources).size).toBe(2);
        } else {
          expect(outcome).toMatchObject({ status: 'rejected' });
          if (code === 'RESOLVED') {
            expect(outcome).toMatchObject({
              reason: { code: 'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE' },
            });
          } else if (outcome?.status === 'rejected') expect(outcome.reason).toBe(refusal);
          expect(lockReadRace.lockSources).toHaveLength(1);
        }
        expect(lockReadRace.readRefusals).toBe(1);
        if (!retire) {
          const retained = await lstat(lockPath, { bigint: true });
          expect([retained.dev, retained.ino]).toEqual([incumbent.dev, incumbent.ino]);
          expect(await readFile(lockPath)).toEqual(incumbentBytes);
          expect(lockReadRace.replacements).toBe(0);
          const pendingRecord = validateWorkflowEffectApproval(
            JSON.parse(await readFile(lockReadRace.recordPath, 'utf8')),
          );
          expect(pendingRecord.revision).toBe(0);
          expect(pendingRecord.status).toBe('pending');
        }
        releaseWriter();
        const committed = await winner;
        const final = await store.read('run-001', 'approval-001');
        expect(final).toEqual(committed);
        expect(final && workflowEffectApprovalBytes(final)).toEqual(
          workflowEffectApprovalBytes(committed),
        );
        expect(final?.revision).toBe(1);
        expect(final?.status).toBe('approved');
        expect(lockReadRace.replacements).toBe(1);
      } finally {
        releaseWriter();
        await Promise.allSettled([winner, ...(contender ? [contender] : [])]);
      }
    },
  );

  it('persists a deterministic pending audit projection and marks only that event recorded', async () => {
    const now = Date.now();
    const storeRoot = await root();
    const decisionAuthority = authority();
    let clockOffset = 1_000;
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, decisionAuthority, () =>
      new Date(now + clockOffset).toISOString(),
    );
    await store.createPending(pending(now));
    const decided = await store.decide({
      runId: 'run-001',
      approvalId: 'approval-001',
      expectedRevision: 0,
      decision: 'approved',
      reasonHash: approvedReasonHash,
      binding: binding(decisionAuthority, now, 'approved', approvedReasonHash),
    });
    expect(decided).toMatchObject({
      revision: 1,
      status: 'approved',
      auditProjection: {
        status: 'pending',
      },
    });
    expect(decided.auditProjection!.eventId).toMatch(/^WFAPPROVAL-AUDIT-[0-9a-f]{64}$/);

    clockOffset = 2_000;
    const recorded = await store.markAuditProjected({
      runId: 'run-001',
      approvalId: 'approval-001',
      expectedRevision: 1,
      eventId: decided.auditProjection!.eventId,
    });
    expect(recorded).toMatchObject({
      revision: 2,
      status: 'approved',
      auditProjection: {
        status: 'recorded',
        eventId: decided.auditProjection!.eventId,
        recordedAt: new Date(now + clockOffset).toISOString(),
      },
    });
    expect(() =>
      validateWorkflowEffectApproval({
        ...recorded,
        auditProjection: {
          ...recorded.auditProjection,
          eventId: `WFAPPROVAL-AUDIT-${'f'.repeat(64)}`,
        },
      }),
    ).toThrow(/deterministic decision event/);
    await expect(
      store.markAuditProjected({
        runId: 'run-001',
        approvalId: 'approval-001',
        expectedRevision: 1,
        eventId: decided.auditProjection!.eventId,
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH',
    });
  });

  it('rejects duplicate creation, repeat decisions, and forged bindings', async () => {
    const now = Date.now();
    const storeRoot = await root();
    const decisionAuthority = authority();
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, decisionAuthority, () =>
      new Date(now + 1_000).toISOString(),
    );
    await store.createPending(pending(now));
    await expect(store.createPending(pending(now))).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_ALREADY_EXISTS',
    });
    await expect(
      store.decide({
        runId: 'run-001',
        approvalId: 'approval-001',
        expectedRevision: 0,
        decision: 'approved',
        reasonHash: approvedReasonHash,
        binding: {},
        correlationId: 'transport-correlation-should-not-override',
      } as never),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
    });
    expect((await store.read('run-001', 'approval-001'))?.correlationId).toBe(
      'business-correlation-001',
    );
    await expect(
      store.decide({
        runId: 'run-001',
        approvalId: 'approval-001',
        expectedRevision: 0,
        decision: 'approved',
        reasonHash: approvedReasonHash,
        binding: {
          principalId: 'human-reviewer',
          workspaceId: 'workspace-main',
          capability: 'workflow.effect.decide',
          runId: 'run-001',
          approvalId: 'approval-001',
          correlationId: 'business-correlation-001',
          approvalExpiresAt: new Date(now + 60_000).toISOString(),
          decision: 'approved',
          reasonHash: approvedReasonHash,
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 30_000).toISOString(),
          nonce: '00000000-0000-4000-8000-000000000003',
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' });

    const humanBinding = binding(decisionAuthority, now, 'approved', approvedReasonHash);
    await store.decide({
      runId: 'run-001',
      approvalId: 'approval-001',
      expectedRevision: 0,
      decision: 'approved',
      reasonHash: approvedReasonHash,
      binding: humanBinding,
    });
    await expect(
      store.decide({
        runId: 'run-001',
        approvalId: 'approval-001',
        expectedRevision: 1,
        decision: 'rejected',
        reasonHash: rejectedReasonHash,
        binding: binding(decisionAuthority, now, 'rejected', rejectedReasonHash),
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED' });
  });

  it('does not create already expired or future-dated approval requests', async () => {
    const now = Date.now();
    const expiredRoot = await root();
    const expiredStore = new LocalWorkflowEffectApprovalStore(expiredRoot, authority(), () =>
      new Date(now + 120_000).toISOString(),
    );
    await expect(expiredStore.createPending(pending(now))).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_EXPIRED',
    });

    const futureRoot = await root();
    const futureStore = new LocalWorkflowEffectApprovalStore(futureRoot, authority(), () =>
      new Date(now - 120_000).toISOString(),
    );
    await expect(futureStore.createPending(pending(now))).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_EXPIRED',
    });
  });

  it('recovers a canonical lock whose owner process is provably dead', async () => {
    const now = Date.now();
    const storeRoot = await root();
    const decisionAuthority = authority();
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, decisionAuthority, () =>
      new Date(now + 1_000).toISOString(),
    );
    await store.createPending(pending(now));
    const owner = {
      schema: 'openslack.workflow_effect_approval_lock.v1',
      pid: await deadPid(),
      sessionId: '00000000-0000-4000-8000-000000000001',
      threadId: 0,
      nonce: '00000000-0000-4000-8000-000000000002',
      createdAt: new Date(now).toISOString(),
    };
    await writeFile(
      join(storeRoot, 'locks', 'decision.lock'),
      `${canonicalWorkflowEffectJson(owner)}\n`,
    );
    expect(await store.read('run-001', 'approval-001')).toMatchObject({ status: 'pending' });
  });

  it('rejects duplicate JSON keys, noncanonical bytes, and unknown store entries', async () => {
    const now = Date.now();
    const storeRoot = await root();
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, authority(), () =>
      new Date(now + 1_000).toISOString(),
    );
    await store.createPending(pending(now));
    const path = join(storeRoot, 'records', recordName());
    const original = await readFile(path, 'utf8');
    await writeFile(
      path,
      original.replace(
        '{"approvalId"',
        '{"schema":"openslack.workflow_effect_approval.v2","approvalId"',
      ),
    );
    await expect(store.read('run-001', 'approval-001')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
    });

    const secondRoot = await root();
    const second = new LocalWorkflowEffectApprovalStore(secondRoot, authority());
    await second.createPending(pending(now));
    const secondPath = join(secondRoot, 'records', recordName());
    const secondRecord = JSON.parse(await readFile(secondPath, 'utf8'));
    await writeFile(secondPath, `${JSON.stringify(secondRecord, null, 2)}\n`);
    await expect(second.read('run-001', 'approval-001')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
    });

    const thirdRoot = await root();
    const third = new LocalWorkflowEffectApprovalStore(thirdRoot, authority());
    await third.createPending(pending(now));
    await writeFile(join(thirdRoot, 'records', recordName()), 'x'.repeat(64 * 1024 + 1));
    await expect(third.read('run-001', 'approval-001')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_LIMIT_EXCEEDED',
    });

    const fourthRoot = await root();
    const fourth = new LocalWorkflowEffectApprovalStore(fourthRoot, authority());
    await fourth.createPending(pending(now));
    await writeFile(join(fourthRoot, 'unexpected.txt'), 'unexpected');
    await expect(fourth.read('run-001', 'approval-001')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
    });

    const fifthRoot = await root();
    const fifth = new LocalWorkflowEffectApprovalStore(fifthRoot, authority());
    await fifth.createPending(pending(now));
    await writeFile(join(fifthRoot, 'locks', 'decision.lock'), '');
    await expect(fifth.read('run-001', 'approval-001')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
    });
  });

  it('rejects non-normalized roots, root reparse points, and decision input proxies', async () => {
    const realRoot = await root();
    const nonNormalizedRoot = `${realRoot}${sep}..${sep}${basename(realRoot)}`;
    expect(() => new LocalWorkflowEffectApprovalStore(nonNormalizedRoot, authority())).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE' }),
    );

    const parent = await root();
    const actual = join(parent, 'actual');
    const linked = join(parent, 'linked');
    await mkdir(actual);
    await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedStore = new LocalWorkflowEffectApprovalStore(resolve(linked), authority());
    await expect(linkedStore.read('run-001', 'approval-001')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
    });

    const store = new LocalWorkflowEffectApprovalStore(realRoot, authority());
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap invoked');
        },
        ownKeys() {
          throw new Error('trap invoked');
        },
      },
    );
    await expect(store.decide(proxy as never)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
    });

    let getters = 0;
    const decision = {
      runId: 'run-001',
      approvalId: 'approval-001',
      expectedRevision: 0,
      decision: 'approved',
      binding: {},
    };
    Object.defineProperty(decision, 'runId', {
      enumerable: true,
      get() {
        getters += 1;
        return 'run-hidden';
      },
    });
    await expect(store.decide(decision as never)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
    });
    expect(getters).toBe(0);
  });

  it('keeps the v2 source isolated from legacy and executable workflow entrypoints', async () => {
    const source = await Promise.all(
      [
        'workflow-effect-approval.ts',
        'workflow-effect-approval-store.ts',
        'workflow-effect-json.ts',
      ].map((name) => readFile(join(sourceRoot, name), 'utf8')),
    ).then((values) => values.join('\n'));
    for (const forbidden of [
      ['resolve', 'Pending', 'Approval'].join(''),
      ['find', 'Workflow'].join(''),
      ['load', 'Workflow'].join(''),
      ['allow', 'Unattended'].join(''),
      ['run', '-', 'store'].join(''),
      ['github', ' review'].join(''),
    ]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(source).toContain('O_EXCL');
    expect(source).toContain('handle.sync()');
    expect(source).toContain('syncDirectory');
    expect(source).toContain('rename(');
    expect(source).toContain('link(');
  });
});
