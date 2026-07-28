import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGovernedActionExecutionRegistry,
  type GovernedActionExecutorDefinition,
} from '../action-execution-registry.js';
import { LocalGovernedPlanStore } from '../governed-plan-store.js';
import {
  assertGovernedPlanService,
  createGovernedPlanCompiler,
  createGovernedPlanService,
  isGovernedPlanService,
  type GovernedPlanAuditEvent,
} from '../governed-plan-service.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = join(
    tmpdir(),
    `openslack-governed-service-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

const authority = Object.freeze({
  actorId: 'qoder.local',
  workspaceId: 'workspace.demo',
});

function compiler(decision?: 'approve' | 'reject') {
  return createGovernedPlanCompiler((context) => ({
    kind: decision === undefined ? 'scenario.instantiate' : 'workflow.approval.decide',
    goal: decision === undefined ? 'Instantiate scenario' : 'Decide workflow approval',
    input:
      decision === undefined
        ? { scenarioId: 'software-delivery', correlationId: context.correlationId }
        : { decision, correlationId: context.correlationId },
    actions: [
      {
        actionId: decision === undefined ? 'scenario.instantiate' : 'workflow.approval.decide',
        input: {
          correlationId: context.correlationId,
          expiresAt: context.expiresAt,
          ...(decision === undefined ? {} : { decision }),
        },
      },
    ],
    effects: [
      {
        type: decision === undefined ? 'scenario.instance' : 'workflow.approval',
        summary: decision === undefined ? 'Create scenario instance' : 'Record approval decision',
        risk: 'medium',
        target: context.correlationId,
      },
    ],
  }));
}

function makeHarness(
  execute: GovernedActionExecutorDefinition['execute'] = async () => ({
    status: 'succeeded',
    summary: 'Created',
    evidenceRefs: ['repo:scenarios/software-delivery/scenario.yaml'],
  }),
  options: {
    executionTimeoutMs?: number;
    defaultTtlMs?: number;
    now?: () => Date;
  } = {},
) {
  let sourceVersion = 'source-v1';
  let permissionVersion = 'permission-v1';
  let buildNonce = 'operator-build-nonce-0123456789';
  const events: GovernedPlanAuditEvent[] = [];
  const definitions: GovernedActionExecutorDefinition[] = [
    {
      actionId: 'scenario.instantiate',
      version: '1.0.0',
      bindingId: 'scenario-runtime.instantiate.v1',
      description: 'Instantiate scenario',
      execute,
    },
    {
      actionId: 'workflow.approval.decide',
      version: '1.0.0',
      bindingId: 'workflow-runtime.approval.v1',
      description: 'Decide workflow approval',
      execute,
    },
  ];
  const registry = createGovernedActionExecutionRegistry(definitions);
  const store = new LocalGovernedPlanStore(makeRoot());
  const service = createGovernedPlanService({
    store,
    registry,
    getBindingSnapshot: () => ({
      sourceVersions: { scenario: sourceVersion },
      permissionSnapshot: {
        version: permissionVersion,
        capabilities: definitions.map((item) => item.actionId),
      },
      buildNonce,
    }),
    audit: (event) => {
      events.push(event);
    },
    ...(options.executionTimeoutMs === undefined
      ? {}
      : { executionTimeoutMs: options.executionTimeoutMs }),
    ...(options.defaultTtlMs === undefined ? {} : { defaultTtlMs: options.defaultTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    service,
    store,
    registry,
    events,
    changeSource: () => {
      sourceVersion = 'source-v2';
    },
    changePermission: () => {
      permissionVersion = 'permission-v2';
    },
    changeBuild: () => {
      buildNonce = 'operator-build-nonce-changed-9876543210';
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('governed plan service', () => {
  it('compiles after generating the business correlation and returns the token only once', async () => {
    const { service, store, events } = makeHarness();
    const preview = await service.preview(compiler(), authority);

    expect(preview.confirmationToken).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(preview.record.confirmationTokenHash).not.toContain(preview.confirmationToken);
    expect(preview.record.bindings.correlationId).toBe(preview.correlationId);
    expect(preview.record.canonicalPlan.input).toMatchObject({
      correlationId: preview.correlationId,
    });
    expect((await store.load(preview.record.planId))?.confirmationTokenHash).toBe(
      preview.record.confirmationTokenHash,
    );
    expect(events.map((event) => event.type)).toEqual(['plan.previewed']);
    expect(Object.isFrozen(preview.record)).toBe(true);
  });

  it('passes the exact immutable plan and authority into preview and confirm binding checks', async () => {
    const contexts: unknown[] = [];
    const registry = createGovernedActionExecutionRegistry([
      {
        actionId: 'scenario.instantiate',
        version: '1.0.0',
        bindingId: 'scenario-runtime.instantiate.v1',
        description: 'Instantiate scenario',
        execute: async () => ({ status: 'succeeded', summary: 'Created' }),
      },
    ]);
    const service = createGovernedPlanService({
      store: new LocalGovernedPlanStore(makeRoot()),
      registry,
      getBindingSnapshot: (context) => {
        contexts.push(context);
        return {
          sourceVersions: { scenario: 'source-v1' },
          permissionSnapshot: { actions: ['scenario.instantiate'] },
          buildNonce: 'operator-build-nonce-0123456789',
        };
      },
      audit: () => undefined,
    });
    const preview = await service.preview(compiler(), authority);
    await service.confirm(
      {
        planId: preview.record.planId,
        confirmationToken: preview.confirmationToken,
      },
      authority,
    );

    expect(contexts).toEqual([
      {
        phase: 'preview',
        canonicalPlan: preview.record.canonicalPlan,
        authority,
      },
      {
        phase: 'confirm',
        canonicalPlan: preview.record.canonicalPlan,
        authority,
      },
    ]);
    expect(
      contexts.every(
        (context) =>
          Object.isFrozen(context) &&
          Object.isFrozen((context as { canonicalPlan: object }).canonicalPlan) &&
          Object.isFrozen((context as { authority: object }).authority),
      ),
    ).toBe(true);
  });

  it('accepts only nominal compilers and fails closed on throws/proxy/accessor results', async () => {
    const { service, store } = makeHarness();
    await expect(service.preview({} as never, authority)).rejects.toThrow('not host-created');
    expect(() =>
      createGovernedPlanCompiler(
        new Proxy(() => compiler(), {
          apply: () => compiler(),
        }) as never,
      ),
    ).toThrow('host-owned function');
    await expect(
      service.preview(
        createGovernedPlanCompiler(() => {
          throw new Error('compile failed');
        }),
        authority,
      ),
    ).rejects.toThrow('compile failed');
    let trapInvoked = false;
    await expect(
      service.preview(
        createGovernedPlanCompiler(
          () =>
            new Proxy(
              {},
              {
                ownKeys: () => {
                  trapInvoked = true;
                  return [];
                },
              },
            ) as never,
        ),
        authority,
      ),
    ).rejects.toThrow('Proxy');
    let getterInvoked = false;
    await expect(
      service.preview(
        createGovernedPlanCompiler(
          () =>
            Object.defineProperty({}, 'kind', {
              enumerable: true,
              get: () => {
                getterInvoked = true;
                return 'scenario.instantiate';
              },
            }) as never,
        ),
        authority,
      ),
    ).rejects.toThrow('own data');
    expect(getterInvoked).toBe(false);
    expect(trapInvoked).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it('requires the raw token and host authority, then executes exactly once', async () => {
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: 'Created',
    }));
    const { service, events } = makeHarness(execute);
    const preview = await service.preview(compiler(), authority);

    await expect(
      service.confirm(
        {
          planId: preview.record.planId,
          confirmationToken: 'A'.repeat(43),
        },
        authority,
      ),
    ).rejects.toThrow('does not match');
    expect(execute).not.toHaveBeenCalled();

    const completed = await service.confirm(
      {
        planId: preview.record.planId,
        confirmationToken: preview.confirmationToken,
      },
      authority,
    );
    expect(completed.state).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      'plan.previewed',
      'plan.confirmation_rejected',
      'plan.confirmed',
      'plan.execution_started',
      'plan.execution_completed',
    ]);
    expect(events.find((event) => event.type === 'plan.confirmed')?.details).toMatchObject({
      executionId: completed.execution?.executionId,
    });
  });

  it('runs only one executor under concurrent confirmations', async () => {
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      started();
      await wait;
      return { status: 'succeeded' as const, summary: 'Created' };
    });
    const { service, events } = makeHarness(execute);
    const preview = await service.preview(compiler(), authority);
    const request = {
      planId: preview.record.planId,
      confirmationToken: preview.confirmationToken,
    };
    const first = service.confirm(request, authority);
    await began;
    await expect(service.confirm(request, authority)).rejects.toThrow('already active');
    release();
    await expect(first).resolves.toMatchObject({ state: 'succeeded' });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'plan.confirmed')).toHaveLength(1);
  });

  it('fails closed when source bindings drift before the atomic claim', async () => {
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: 'Created',
    }));
    const { service, changeSource } = makeHarness(execute);
    const preview = await service.preview(compiler(), authority);
    changeSource();

    await expect(
      service.confirm(
        {
          planId: preview.record.planId,
          confirmationToken: preview.confirmationToken,
        },
        authority,
      ),
    ).rejects.toThrow('binding changed');
    expect((await service.get(preview.record.planId))?.state).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when permission or build bindings drift before the atomic claim', async () => {
    const permission = makeHarness();
    const permissionPreview = await permission.service.preview(compiler(), authority);
    permission.changePermission();
    await expect(
      permission.service.confirm(
        {
          planId: permissionPreview.record.planId,
          confirmationToken: permissionPreview.confirmationToken,
        },
        authority,
      ),
    ).rejects.toThrow('binding changed');
    expect((await permission.service.get(permissionPreview.record.planId))?.state).toBe('pending');

    const build = makeHarness();
    const buildPreview = await build.service.preview(compiler(), authority);
    build.changeBuild();
    await expect(
      build.service.confirm(
        {
          planId: buildPreview.record.planId,
          confirmationToken: buildPreview.confirmationToken,
        },
        authority,
      ),
    ).rejects.toThrow('binding changed');
    expect((await build.service.get(buildPreview.record.planId))?.state).toBe('pending');
  });

  it('durably requires reconciliation after an executor throws and never replays', async () => {
    const execute = vi.fn(async () => {
      throw new Error('uncertain adapter failure');
    });
    const { service } = makeHarness(execute);
    const preview = await service.preview(compiler(), authority);
    const request = {
      planId: preview.record.planId,
      confirmationToken: preview.confirmationToken,
    };

    await expect(service.confirm(request, authority)).rejects.toThrow('uncertain');
    expect((await service.get(preview.record.planId))?.state).toBe('reconciliation_required');
    await expect(service.confirm(request, authority)).rejects.toThrow('cannot execute');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('turns a provably dead executing owner into reconciliation without replay', async () => {
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: 'Created',
    }));
    const { service, store } = makeHarness(execute);
    const preview = await service.preview(compiler(), authority);
    await store.claimExecution({
      planId: preview.record.planId,
      expectedRevision: preview.record.revision,
      executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
      ownerPid: 2_147_483_647,
      startedAt: '2026-07-27T00:01:00.000Z',
    });
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 2_147_483_647) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    await expect(
      service.confirm(
        {
          planId: preview.record.planId,
          confirmationToken: preview.confirmationToken,
        },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'reconciliation_required' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('aborts before claim without effects and turns post-claim abort into durable reconciliation', async () => {
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: 'Created',
    }));
    const pre = makeHarness(execute);
    const prePreview = await pre.service.preview(compiler(), authority);
    const preAbort = new AbortController();
    preAbort.abort();
    await expect(
      pre.service.confirm(
        {
          planId: prePreview.record.planId,
          confirmationToken: prePreview.confirmationToken,
        },
        authority,
        { signal: preAbort.signal },
      ),
    ).rejects.toThrow('before its atomic claim');
    expect((await pre.service.get(prePreview.record.planId))?.state).toBe('pending');
    expect(execute).not.toHaveBeenCalled();

    let resolveLate!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const late = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    const lateExecute = vi.fn(async () => {
      started();
      await late;
      return { status: 'succeeded' as const, summary: 'Late success' };
    });
    const post = makeHarness(lateExecute);
    const postPreview = await post.service.preview(compiler(), authority);
    const postAbort = new AbortController();
    const confirmation = post.service.confirm(
      {
        planId: postPreview.record.planId,
        confirmationToken: postPreview.confirmationToken,
      },
      authority,
      { signal: postAbort.signal },
    );
    await began;
    postAbort.abort();
    await expect(confirmation).rejects.toThrow('aborted');
    expect((await post.service.get(postPreview.record.planId))?.state).toBe(
      'reconciliation_required',
    );
    resolveLate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await post.service.get(postPreview.record.planId))?.state).toBe(
      'reconciliation_required',
    );
    expect(lateExecute).toHaveBeenCalledOnce();
  });

  it('turns execution timeout into reconciliation and ignores late completion', async () => {
    let resolveLate!: () => void;
    const late = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    const execute = vi.fn(async () => {
      await late;
      return { status: 'succeeded' as const, summary: 'Late success' };
    });
    const { service } = makeHarness(execute, { executionTimeoutMs: 1_000 });
    const preview = await service.preview(compiler(), authority);

    await expect(
      service.confirm(
        {
          planId: preview.record.planId,
          confirmationToken: preview.confirmationToken,
        },
        authority,
      ),
    ).rejects.toThrow('deadline');
    expect((await service.get(preview.record.planId))?.state).toBe('reconciliation_required');
    resolveLate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await service.get(preview.record.planId))?.state).toBe('reconciliation_required');
  });

  it('cancels pending plans and emits workflow approval audit after governed execution', async () => {
    const { service, events } = makeHarness();
    const pending = await service.preview(compiler(), authority);
    await expect(
      service.cancel(
        {
          planId: pending.record.planId,
          confirmationToken: pending.confirmationToken,
        },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'cancelled' });

    const approval = await service.preview(compiler('approve'), authority);
    await expect(
      service.confirm(
        {
          planId: approval.record.planId,
          confirmationToken: approval.confirmationToken,
        },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'succeeded' });
    expect(events.map((event) => event.type)).toContain('plan.cancelled');
    expect(events.map((event) => event.type)).toContain('workflow.approval_decided');
  });

  it('expires pending plans without executing them', async () => {
    let current = Date.parse('2026-07-27T00:00:00.000Z');
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: 'Created',
    }));
    const { service, events } = makeHarness(execute, {
      defaultTtlMs: 60_000,
      now: () => new Date(current),
    });
    const preview = await service.preview(compiler(), authority);
    current += 60_001;

    await expect(
      service.confirm(
        {
          planId: preview.record.planId,
          confirmationToken: preview.confirmationToken,
        },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'expired' });
    expect(execute).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toContain('plan.expired');
  });

  it('brands only services created by the Operator composition boundary', () => {
    const { service, store, registry } = makeHarness();
    expect(isGovernedPlanService(service)).toBe(true);
    expect(assertGovernedPlanService(service)).toBe(service);
    expect(isGovernedPlanService({ ...service })).toBe(false);
    expect(() => assertGovernedPlanService({ ...service })).toThrow('must be created');

    let getterInvoked = false;
    const options = Object.defineProperty(
      {
        store,
        registry,
        getBindingSnapshot: () => ({
          sourceVersions: {},
          permissionSnapshot: {},
          buildNonce: 'operator-build-nonce-0123456789',
        }),
        audit: () => undefined,
      },
      'now',
      {
        enumerable: true,
        get: () => {
          getterInvoked = true;
          return () => new Date();
        },
      },
    );
    expect(() => createGovernedPlanService(options)).toThrow('inert known fields');
    expect(getterInvoked).toBe(false);
  });
});
