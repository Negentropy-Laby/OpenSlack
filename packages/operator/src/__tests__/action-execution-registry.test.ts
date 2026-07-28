import { describe, expect, it, vi } from 'vitest';
import {
  createGovernedActionExecutionRegistry,
  type GovernedActionExecutorDefinition,
} from '../action-execution-registry.js';

function definition(
  execute: GovernedActionExecutorDefinition['execute'] = async () => ({
    status: 'succeeded',
    summary: 'Created',
    data: { id: 'instance-1' },
    evidenceRefs: ['repo:scenarios/software-delivery/scenario.yaml'],
  }),
): GovernedActionExecutorDefinition {
  return {
    actionId: 'scenario.instantiate',
    version: '1.0.0',
    bindingId: 'scenario-runtime.instantiate.v1',
    description: 'Instantiate a locked scenario',
    execute,
  };
}

const context = {
  planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
  executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
  actorId: 'qoder.local',
  workspaceId: 'workspace.demo',
  correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
  actionIndex: 0,
};

describe('governed action execution registry', () => {
  it('is sealed, deterministic, and exposes metadata without executor functions', () => {
    const registry = createGovernedActionExecutionRegistry([definition()]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(registry.list()).toEqual([
      {
        actionId: 'scenario.instantiate',
        version: '1.0.0',
        bindingId: 'scenario-runtime.instantiate.v1',
        description: 'Instantiate a locked scenario',
      },
    ]);
    expect(registry.actionCatalogHash).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.executorBindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Reflect.set(registry, 'has', () => true)).toBe(false);

    const changedExecutor = createGovernedActionExecutionRegistry([
      { ...definition(), bindingId: 'scenario-runtime.instantiate.v2' },
    ]);
    expect(changedExecutor.actionCatalogHash).toBe(registry.actionCatalogHash);
    expect(changedExecutor.executorBindingHash).not.toBe(registry.executorBindingHash);
  });

  it('passes only deeply frozen canonical input/context and freezes output', async () => {
    const execute = vi.fn(async (input, executionContext) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(executionContext)).toBe(true);
      return {
        status: 'succeeded' as const,
        summary: 'Created',
        data: { nested: [{ ok: true }] },
      };
    });
    const registry = createGovernedActionExecutionRegistry([definition(execute)]);

    const outcome = await registry.execute(
      { actionId: 'scenario.instantiate', input: { name: 'demo' } },
      context,
    );

    expect(outcome.status).toBe('succeeded');
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.data)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects proxy definitions and malicious results without invoking traps/getters', async () => {
    let touched = 0;
    const proxy = new Proxy(definition(), {
      ownKeys: () => {
        touched += 1;
        return [];
      },
    });
    expect(() => createGovernedActionExecutionRegistry([proxy])).toThrow('Proxy');

    const registry = createGovernedActionExecutionRegistry([
      definition(async () =>
        Object.defineProperty(
          {
            status: 'succeeded' as const,
            summary: 'Created',
          },
          'data',
          {
            enumerable: true,
            get: () => {
              touched += 1;
              return {};
            },
          },
        ),
      ),
    ]);
    await expect(
      registry.execute({ actionId: 'scenario.instantiate', input: {} }, context),
    ).rejects.toThrow('own data');
    expect(touched).toBe(0);
  });

  it('rejects unregistered actions and duplicate registry bindings', async () => {
    const registry = createGovernedActionExecutionRegistry([definition()]);
    await expect(
      registry.execute({ actionId: 'shell.run', input: { command: 'anything' } }, context),
    ).rejects.toThrow('not registered');
    expect(() => createGovernedActionExecutionRegistry([definition(), definition()])).toThrow(
      'Duplicate',
    );
  });
});
