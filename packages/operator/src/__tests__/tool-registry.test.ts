import { describe, it, expect } from 'vitest';
import {
  BUILTIN_ACTION_REGISTRY,
  REGISTERED_ACTIONS,
  REGISTERED_ACTION_IDS,
  buildActionPlanFromRegisteredActions,
  createActionRegistry,
  createRegisteredStep,
  isRegisteredStep,
  isPluginActionId,
  listRegisteredActions,
  LLM_PLANNER_MAX_TOOL_STEPS,
  type PluginActionId,
  type RegisteredAction,
  type RegisteredActionId,
} from '../index.js';

function pluginStatusAction(id: PluginActionId): RegisteredAction<PluginActionId> {
  return {
    id,
    description: 'Plugin status alias',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, stepId) => ({
      id: stepId,
      actionId: id,
      input,
      tool: 'openslack-cli',
      command: 'status',
      args: [],
      description: 'Plugin status alias',
      confirmationRequired: false,
    }),
    match: (step) => step.command === 'status' && step.args.length === 0,
  };
}

describe('tool registry', () => {
  it('preserves the closed 30-action built-in order and frozen definitions', () => {
    expect(REGISTERED_ACTION_IDS).toEqual([
      'status.show',
      'workspace.status',
      'github.metrics',
      'workspace.index',
      'doctor.run',
      'workspace.validate',
      'self.eval.golden',
      'self.observe',
      'governance.audit',
      'pr.status',
      'pr.doctor',
      'pr.review',
      'pr.queue',
      'pr.watch',
      'pr.merge',
      'task.create.preview',
      'self.triage.create_issues',
      'agent.claim_task',
      'task.checkout',
      'task.sync',
      'github.issue_done',
      'github.repair.labels.preview',
      'github.repair.claims.preview',
      'task.repair.worktrees.preview',
      'conversation.start',
      'conversation.list',
      'conversation.show',
      'conversation.send',
      'conversation.summarize',
      'conversation.archive',
    ]);
    expect(listRegisteredActions().map((action) => action.id)).toEqual(REGISTERED_ACTION_IDS);
    expect(BUILTIN_ACTION_REGISTRY.list()).toHaveLength(30);
    expect(Object.isFrozen(BUILTIN_ACTION_REGISTRY)).toBe(true);
    expect(Reflect.set(BUILTIN_ACTION_REGISTRY, 'get', () => undefined)).toBe(false);
    expect(Object.isFrozen(REGISTERED_ACTIONS)).toBe(true);
    expect(Object.isFrozen(REGISTERED_ACTIONS['pr.merge'])).toBe(true);
    expect(Object.isFrozen(REGISTERED_ACTIONS['pr.merge'].inputSchema)).toBe(true);
  });

  it('keeps plugin action ids namespaced without widening RegisteredActionId', () => {
    const pluginId: PluginActionId = 'plugin:reader:status';
    // @ts-expect-error Plugin ids must not widen the closed built-in action union.
    const builtInId: RegisteredActionId = pluginId;

    expect(isPluginActionId(pluginId)).toBe(true);
    expect(isPluginActionId('plugin:reader:status:extra')).toBe(false);
    expect(isPluginActionId('plugin:openslack:status')).toBe(false);
    expect(isPluginActionId('plugin:read\ner:status')).toBe(false);
    expect(isPluginActionId('plugin:reader:sta\rtus')).toBe(false);
    expect(builtInId).toBe(pluginId);
  });

  it('isolates plugin actions between immutable registry instances', () => {
    const pluginId: PluginActionId = 'plugin:reader:status';
    const registryA = createActionRegistry([
      ...listRegisteredActions(),
      pluginStatusAction(pluginId),
    ]);
    const registryB = createActionRegistry(listRegisteredActions());
    const step = registryA.createStep(pluginId, {}, 'plugin-step');

    expect(registryA.get(pluginId)?.id).toBe(pluginId);
    expect(registryA.revalidateStep(step).valid).toBe(true);
    expect(registryB.get(pluginId)).toBeUndefined();
    expect(registryB.revalidateStep(step).valid).toBe(false);
    expect(BUILTIN_ACTION_REGISTRY.get(pluginId)).toBeUndefined();
  });

  it('rejects duplicate and non-namespaced extension definitions atomically', () => {
    const pluginId: PluginActionId = 'plugin:reader:status';
    const plugin = pluginStatusAction(pluginId);
    expect(() => createActionRegistry([plugin, plugin])).toThrow('Duplicate');
    expect(() =>
      createActionRegistry([{ ...plugin, id: 'reader.status' as PluginActionId }]),
    ).toThrow('plugin-namespaced');
  });

  it('accepts the bounded plugin-api field-name grammar for adapted action schemas', () => {
    const pluginId: PluginActionId = 'plugin:reader:filtered-status';
    const registry = createActionRegistry([
      {
        ...pluginStatusAction(pluginId),
        inputSchema: {
          'filter.label': { type: 'string' },
          'pr-number': { type: 'number' },
        },
      },
    ]);

    expect(
      registry.createStep(
        pluginId,
        {
          'filter.label': 'bug',
          'pr-number': 198,
        },
        's1',
      ).input,
    ).toEqual({
      'filter.label': 'bug',
      'pr-number': 198,
    });
  });

  it('canonical-rebuilds generated steps and rejects every authority-field mutation', () => {
    const canonical = createRegisteredStep('pr.merge', { prNumber: 198 }, 's1');
    const mutations = [
      { ...canonical, actionId: 'pr.status' },
      { ...canonical, input: { prNumber: 999 } },
      { ...canonical, tool: 'package-api' as const },
      { ...canonical, command: 'status' },
      { ...canonical, args: [...canonical.args, '--bypass'] },
      { ...canonical, description: 'Harmless status' },
      { ...canonical, confirmationRequired: false },
      { ...canonical, produces: ['approval'] },
      { ...canonical, extra: true },
      { ...canonical, actionId: undefined, input: undefined },
    ];

    expect(isRegisteredStep(canonical)).toBe(true);
    for (const mutation of mutations) {
      expect(BUILTIN_ACTION_REGISTRY.revalidateStep(mutation).valid).toBe(false);
    }
  });

  it('fails closed on accessor and revoked-proxy step fields without invoking them', () => {
    const canonical = createRegisteredStep('status.show', {}, 's1');
    let getterInvoked = false;
    const accessorStep = Object.defineProperty({ ...canonical }, 'command', {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return 'status';
      },
    });
    const accessorArgs = ['placeholder'];
    Object.defineProperty(accessorArgs, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterInvoked = true;
        return 'status';
      },
    });
    const { proxy, revoke } = Proxy.revocable<string[]>([], {});
    revoke();
    const revokedRoot = Proxy.revocable<Record<string, unknown>>({}, {});
    const revokedInput = Proxy.revocable<Record<string, unknown>>({}, {});
    revokedRoot.revoke();
    revokedInput.revoke();

    expect(BUILTIN_ACTION_REGISTRY.revalidateStep(accessorStep).valid).toBe(false);
    expect(BUILTIN_ACTION_REGISTRY.revalidateStep({ ...canonical, args: accessorArgs }).valid).toBe(
      false,
    );
    expect(getterInvoked).toBe(false);
    expect(BUILTIN_ACTION_REGISTRY.revalidateStep({ ...canonical, args: proxy }).valid).toBe(false);
    expect(BUILTIN_ACTION_REGISTRY.revalidateStep(revokedRoot.proxy).valid).toBe(false);
    expect(
      BUILTIN_ACTION_REGISTRY.revalidateStep({ ...canonical, input: revokedInput.proxy }).valid,
    ).toBe(false);
  });

  it('rejects prototype-named unknown input fields without dropping or inheriting them', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const input = JSON.parse(`{"${key}":"unexpected"}`) as Record<string, string>;
      const canonical = createRegisteredStep('status.show', {}, 's1');

      expect(() => createRegisteredStep('status.show', input, 's1')).toThrow(
        `Unknown input: ${key}`,
      );
      expect(BUILTIN_ACTION_REGISTRY.revalidateStep({ ...canonical, input }).valid).toBe(false);
    }
  });

  it('creates typed registered steps', () => {
    const step = createRegisteredStep('pr.doctor', { prNumber: 12 }, 's1');
    expect(step.actionId).toBe('pr.doctor');
    expect(step.command).toBe('pr');
    expect(step.args).toEqual(['doctor', '12']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('rejects unknown actions instead of accepting raw shell', () => {
    expect(() => createRegisteredStep('shell.run', { command: 'rm -rf .' }, 's1')).toThrow(
      'Unregistered',
    );
  });

  it('rejects invalid action input', () => {
    expect(() => createRegisteredStep('pr.doctor', { prNumber: '12' }, 's1')).toThrow(
      'expected number',
    );
  });

  it('registers task creation preview instead of raw issue commands', () => {
    const step = createRegisteredStep(
      'task.create.preview',
      { title: 'Investigate setup', template: 'investigation' },
      's1',
    );
    expect(step.command).toBe('task');
    expect(step.args).toEqual([
      'create',
      '--template',
      'investigation',
      '--title',
      'Investigate setup',
    ]);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('requires owner and PR evidence for the deprecated issue completion action', () => {
    expect(() => createRegisteredStep('github.issue_done', { issueNumber: 42 }, 's1')).toThrow(
      'agentId',
    );

    const step = createRegisteredStep(
      'github.issue_done',
      { issueNumber: 42, agentId: 'agent-one', prUrl: 'https://github.com/acme/repo/pull/7' },
      's1',
    );
    expect(step.args).toEqual([
      'issue-done',
      '--issue-number',
      '42',
      '--agent-id',
      'agent-one',
      '--pr-url',
      'https://github.com/acme/repo/pull/7',
    ]);
  });

  it('enforces the compound plan step limit', () => {
    const calls = Array.from({ length: LLM_PLANNER_MAX_TOOL_STEPS + 1 }, () => ({
      actionId: 'status.show',
      input: {},
    }));
    expect(() =>
      buildActionPlanFromRegisteredActions(
        'too many',
        { kind: 'status', slots: {}, confidence: 1 },
        calls,
      ),
    ).toThrow('max tool step limit');
  });
});
