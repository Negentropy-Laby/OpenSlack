import { describe, expect, it } from 'vitest';
import {
  compileWorkflowStartPlan,
  createSealedWorkflowPlanResolver,
  rehydrateWorkflowStartPlan,
  resolveSealedWorkflowPlanTarget,
  WORKFLOW_START_EFFECT_SCHEMA,
  WORKFLOW_START_PLAN_SCHEMA,
} from '../index.js';

function resolver() {
  return createSealedWorkflowPlanResolver({
    entries: [
      {
        id: 'delivery.create',
        version: '1.2.3',
        adapterId: 'openslack.github.v1',
        executorId: 'workflow.delivery.create',
        workflowHash: 'a'.repeat(64),
        risk: 'medium',
        capabilityIds: ['github.issues.create', 'github.issues.read'],
        authorityRequirements: [
          {
            provider: 'github',
            objectType: 'repository',
            credentialRequired: true,
          },
        ],
      },
    ],
  });
}

function input() {
  return {
    resolver: resolver(),
    workflowId: 'delivery.create',
    input: {
      objective: 'Create a governed delivery issue.',
      labels: ['delivery', 'review-required'],
    },
    authorityBindings: [
      {
        provider: 'github',
        objectType: 'repository',
        objectId: 'acme/project',
        version: 'head:abc123',
        observedAt: '2026-07-27T00:00:00.000Z',
        credentialBindingId: 'github.app.demo',
      },
    ],
    actorId: 'human-reviewer',
    workspaceId: 'workspace-main',
    correlationId: 'correlation-001',
    createdAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2026-07-27T00:15:00.000Z',
  } as const;
}

describe('governed workflow plan compiler', () => {
  it('binds the sorted sealed resolver to a deterministic immutable integrity hash', () => {
    const first = resolver();
    const second = resolver();
    const empty = createSealedWorkflowPlanResolver({ entries: [] });

    expect(first.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.integrityHash).toBe(first.integrityHash);
    expect(empty.integrityHash).not.toBe(first.integrityHash);
    expect(first.list()).toEqual([first.resolve('delivery.create')]);
    expect(Object.isFrozen(first.list())).toBe(true);
  });

  it('compiles one deterministic immutable canonical effect without executing it', () => {
    const first = compileWorkflowStartPlan(input());
    const secondInput = input();
    const second = compileWorkflowStartPlan({
      ...secondInput,
      input: {
        labels: ['delivery', 'review-required'],
        objective: 'Create a governed delivery issue.',
      },
    });

    expect(first.schema).toBe(WORKFLOW_START_PLAN_SCHEMA);
    expect(first.effect.schema).toBe(WORKFLOW_START_EFFECT_SCHEMA);
    expect(first.effect.kind).toBe('workflow.start');
    expect(first.effect.executorId).toBe('workflow.delivery.create');
    expect(first.effect.authorityBindings[0]).toMatchObject({
      provider: 'github',
      objectType: 'repository',
      objectId: 'acme/project',
      credentialBindingId: 'github.app.demo',
    });
    expect(first.requiresConfirmation).toBe(true);
    expect(first.planId).toBe(`workflow-plan:sha256:${first.planHash}`);
    expect(first.planHash).toBe(second.planHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.effect)).toBe(true);
    expect(first).not.toHaveProperty('run');
    expect(first.effect).not.toHaveProperty('command');
    expect(first.effect).not.toHaveProperty('module');
  });

  it('requires a nominal host-sealed resolver and rejects unknown workflow IDs', () => {
    expect(() =>
      compileWorkflowStartPlan({
        ...input(),
        resolver: {
          resolve: () => resolveSealedWorkflowPlanTarget(resolver(), 'delivery.create'),
        } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PLAN_RESOLVER_SEALED_REQUIRED' }));
    expect(() =>
      compileWorkflowStartPlan({ ...input(), workflowId: 'delivery.missing' }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PLAN_TARGET_MISSING' }));
  });

  it('strictly rehydrates persisted plans against current host-owned bindings', () => {
    const originalInput = input();
    const original = compileWorkflowStartPlan(originalInput);
    const persisted = JSON.parse(JSON.stringify(original));
    const restored = rehydrateWorkflowStartPlan(persisted, {
      resolver: originalInput.resolver,
      planHash: original.planHash,
      actorId: original.actorId,
      workspaceId: original.workspaceId,
      correlationId: original.correlationId,
      workflowHash: original.workflow.workflowHash,
      now: original.createdAt,
    });
    expect(restored).toEqual(original);
    expect(Object.isFrozen(restored)).toBe(true);

    persisted.effect.workflowHash = 'b'.repeat(64);
    expect(() =>
      rehydrateWorkflowStartPlan(persisted, {
        resolver: originalInput.resolver,
        planHash: original.planHash,
        actorId: original.actorId,
        workspaceId: original.workspaceId,
        correlationId: original.correlationId,
        workflowHash: original.workflow.workflowHash,
        now: original.createdAt,
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PERSISTED_PLAN_INVALID' }));
  });

  it('rejects stale resolver, actor, workflow, and expiry bindings during rehydration', () => {
    const originalInput = input();
    const original = compileWorkflowStartPlan(originalInput);
    const persisted = JSON.parse(JSON.stringify(original));
    const baseBinding = {
      resolver: originalInput.resolver,
      planHash: original.planHash,
      actorId: original.actorId,
      workspaceId: original.workspaceId,
      correlationId: original.correlationId,
      workflowHash: original.workflow.workflowHash,
      now: original.createdAt,
    };
    expect(() =>
      rehydrateWorkflowStartPlan(persisted, {
        ...baseBinding,
        actorId: 'different-actor',
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PERSISTED_PLAN_BINDING_MISMATCH' }));
    expect(() =>
      rehydrateWorkflowStartPlan(persisted, {
        ...baseBinding,
        workflowHash: 'b'.repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PERSISTED_PLAN_BINDING_MISMATCH' }));
    expect(() =>
      rehydrateWorkflowStartPlan(persisted, {
        ...baseBinding,
        now: original.expiresAt,
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PLAN_EXPIRED' }));
    expect(() =>
      rehydrateWorkflowStartPlan(persisted, {
        ...baseBinding,
        resolver: createSealedWorkflowPlanResolver({
          entries: [
            {
              ...original.workflow,
              workflowHash: 'b'.repeat(64),
            },
          ],
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PERSISTED_PLAN_INVALID' }));
  });

  it.each([
    { allowUnattended: true },
    { confirmStep: true },
    { targetPath: './dynamic/workflow.mjs' },
    { modulePath: './workflow.mjs' },
    { repository: 'acme/other' },
    { githubToken: 'not-a-real-token' },
    { nested: { shellCommand: 'openslack workflow run' } },
  ])('rejects user-controlled execution, path, repository, or auth fields', (unsafe) => {
    expect(() => compileWorkflowStartPlan({ ...input(), input: unsafe })).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_PLAN_INPUT_INVALID' }),
    );
  });

  it('rejects top-level control fields even when the caller casts around TypeScript', () => {
    expect(() => compileWorkflowStartPlan({ ...input(), confirmStep: true } as never)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_PLAN_INPUT_INVALID' }),
    );
  });

  it('requires exact GitHub repository and credential bindings', () => {
    expect(() => compileWorkflowStartPlan({ ...input(), authorityBindings: [] })).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_PLAN_AUTHORITY_INVALID' }),
    );
    expect(() =>
      compileWorkflowStartPlan({
        ...input(),
        authorityBindings: [
          {
            ...input().authorityBindings[0],
            credentialBindingId: null,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PLAN_AUTHORITY_INVALID' }));
    expect(() =>
      compileWorkflowStartPlan({
        ...input(),
        authorityBindings: [
          {
            ...input().authorityBindings[0],
            objectId: '../other',
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PLAN_AUTHORITY_INVALID' }));
  });

  it.each(['github.pr.merge', 'github.pr.approve', 'shell.run'])(
    'refuses to seal a resolver with direct %s authority',
    (capability) => {
      expect(() =>
        createSealedWorkflowPlanResolver({
          entries: [
            {
              id: 'unsafe.workflow',
              version: '1.0.0',
              adapterId: 'unsafe.adapter',
              executorId: 'unsafe.executor',
              workflowHash: 'b'.repeat(64),
              risk: 'high',
              capabilityIds: [capability],
              authorityRequirements: [],
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PLAN_RESOLVER_INVALID' }));
    },
  );

  it('rejects proxy inputs and resolver data before invoking any traps', () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
        ownKeys() {
          traps += 1;
          return [];
        },
      },
    );
    expect(() => createSealedWorkflowPlanResolver(proxy as never)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_PLAN_RESOLVER_INVALID' }),
    );
    expect(() => compileWorkflowStartPlan({ ...input(), input: proxy })).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_PLAN_INPUT_INVALID' }),
    );
    expect(() => createSealedWorkflowPlanResolver({ entries: [proxy as never] })).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_PLAN_RESOLVER_INVALID' }),
    );
    expect(() =>
      compileWorkflowStartPlan({ ...input(), authorityBindings: [proxy as never] }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_PLAN_AUTHORITY_INVALID' }));
    expect(traps).toBe(0);
  });
});
