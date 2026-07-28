import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkflowEffectDecisionAuthority,
  LocalWorkflowEffectApprovalStore,
  validateWorkflowEffectApproval,
  workflowEffectApprovalBytes,
} from '../index.js';
import { canonicalWorkflowEffectJson } from '../workflow-effect-json.js';

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
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('LocalWorkflowEffectApprovalStore', () => {
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
    const now = Date.now();
    const storeRoot = await root();
    const decisionAuthority = authority();
    const store = new LocalWorkflowEffectApprovalStore(storeRoot, decisionAuthority, () =>
      new Date(now + 1_000).toISOString(),
    );
    await store.createPending(pending(now));
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
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: 'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH' },
    });
    const final = await store.read('run-001', 'approval-001');
    expect(final?.correlationId).toBe('business-correlation-001');
    expect(final?.revision).toBe(1);
    expect(['approved', 'rejected']).toContain(final?.status);
    expect(final && workflowEffectApprovalBytes(final)).toEqual(
      final && workflowEffectApprovalBytes({ ...final, correlationId: final.correlationId }),
    );
  });

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
