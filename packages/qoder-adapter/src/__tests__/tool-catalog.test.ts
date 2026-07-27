import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
  OPENSLACK_MUTATION_TOOL_CATALOG,
  OPENSLACK_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_CATALOG,
  OPENSLACK_READ_TOOL_NAMES,
  OPENSLACK_TOOL_CATALOG_COMPOSITION,
  OPENSLACK_WORKFLOW_APPROVAL_TOOL_NAMES,
  ToolInputValidationError,
  getOpenSlackMutationToolDefinition,
  getOpenSlackToolCatalog,
  getOpenSlackReadToolDefinition,
  validateToolInput,
} from '../index.js';

describe('Qoder read-tool catalog', () => {
  it('is deeply frozen and contains exactly the twelve business tools', () => {
    expect(OPENSLACK_READ_TOOL_CATALOG.map((tool) => tool.name)).toEqual([
      'openslack_get_executive_overview',
      'openslack_list_work_items',
      'openslack_get_work_room',
      'openslack_get_activity',
      'openslack_get_workflow_progress',
      'openslack_get_pr_readiness',
      'openslack_list_pending_approvals',
      'openslack_get_business_outcomes',
      'openslack_get_notification_status',
      'openslack_list_scenarios',
      'openslack_query_graph',
      'openslack_explain_graph',
    ]);
    expect(OPENSLACK_READ_TOOL_NAMES).toHaveLength(12);
    expect(Object.isFrozen(OPENSLACK_READ_TOOL_CATALOG)).toBe(true);
    for (const tool of OPENSLACK_READ_TOOL_CATALOG) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(Object.isFrozen(tool.inputSchema)).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  it('contains no generic, shell, mutation, approval, or merge capability', () => {
    const names = OPENSLACK_READ_TOOL_CATALOG.map((tool) => tool.name);
    const forbidden = [
      'run_shell',
      'run_arbitrary_command',
      'github.approve',
      'pr.approve',
      'approve_github_pr',
      'direct_merge',
      'write_policy',
      'change_agent_permissions',
    ];
    expect(names).not.toEqual(expect.arrayContaining(forbidden));
    expect(names).not.toEqual(expect.arrayContaining(['pr.watch', 'workspace.index']));
    expect(names.every((name) => !/shell|raw_command|direct_merge/i.test(name))).toBe(true);
  });

  it('keeps mutation profiles nominal, explicit, and separate from the production twelve', () => {
    expect(OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES).toEqual([
      'openslack_preview_scenario',
      'openslack_preview_workflow',
      'openslack_confirm_plan',
      'openslack_cancel_plan',
    ]);
    expect(OPENSLACK_WORKFLOW_APPROVAL_TOOL_NAMES).toEqual(['openslack_decide_workflow_approval']);
    expect(OPENSLACK_MUTATION_TOOL_NAMES).toEqual([
      'openslack_preview_scenario',
      'openslack_preview_workflow',
      'openslack_confirm_plan',
      'openslack_cancel_plan',
      'openslack_decide_workflow_approval',
    ]);
    expect(OPENSLACK_TOOL_CATALOG_COMPOSITION).toEqual({
      components: {
        read: 12,
        governedMutations: 4,
        workflowApproval: 1,
        demoReset: 1,
      },
      profiles: {
        productionReadOnly: 12,
        agentBound: 16,
        humanAttested: 17,
      },
    });
    expect(Object.isFrozen(OPENSLACK_TOOL_CATALOG_COMPOSITION)).toBe(true);
    expect(Object.isFrozen(OPENSLACK_TOOL_CATALOG_COMPOSITION.components)).toBe(true);
    expect(Object.isFrozen(OPENSLACK_TOOL_CATALOG_COMPOSITION.profiles)).toBe(true);
    expect(OPENSLACK_MUTATION_TOOL_CATALOG).toHaveLength(5);
    expect(getOpenSlackToolCatalog({ includeDemoReset: false })).toHaveLength(12);
    expect(
      getOpenSlackToolCatalog({
        includeDemoReset: false,
        includeGovernedMutations: true,
      }).map((tool) => tool.name),
    ).toEqual([...OPENSLACK_READ_TOOL_NAMES, ...OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES]);
    expect(
      getOpenSlackToolCatalog({
        includeDemoReset: false,
        includeGovernedMutations: true,
        includeWorkflowApproval: true,
      }).map((tool) => tool.name),
    ).toEqual([...OPENSLACK_READ_TOOL_NAMES, ...OPENSLACK_MUTATION_TOOL_NAMES]);
    expect(
      getOpenSlackToolCatalog({
        includeDemoReset: true,
        includeGovernedMutations: true,
        includeWorkflowApproval: true,
      }).at(-1)?.name,
    ).toBe('openslack_demo_reset');
    expect(() =>
      getOpenSlackToolCatalog({
        includeDemoReset: false,
        includeWorkflowApproval: true,
      }),
    ).toThrow(/without governed mutations/);
  });

  it('accepts bounded business input but never accepts client authority or executable steps', () => {
    const scenario = getOpenSlackMutationToolDefinition('openslack_preview_scenario')!;
    expect(
      validateToolInput(scenario, {
        scenarioId: 'software-delivery',
        input: { objective: 'Explain delivery state.', days: 14 },
      }),
    ).toEqual({
      scenarioId: 'software-delivery',
      input: { objective: 'Explain delivery state.', days: 14 },
    });
    for (const forbidden of [
      'actorId',
      'workspaceId',
      'correlationId',
      'capabilities',
      'permissionSnapshot',
      'steps',
      'command',
      'approvalProvenance',
    ]) {
      expect(() =>
        validateToolInput(scenario, {
          scenarioId: 'software-delivery',
          input: {},
          [forbidden]: 'client-controlled',
        }),
      ).toThrow(/unexpected argument properties/);
    }

    const workflow = getOpenSlackMutationToolDefinition('openslack_preview_workflow')!;
    expect(() =>
      validateToolInput(workflow, {
        workflowId: '../../dynamic-module',
        input: {},
      }),
    ).toThrow(/invalid format/);
    expect(() =>
      validateToolInput(workflow, {
        workflowId: 'ai-org-transformation',
        input: {},
        repository: 'https://example.invalid/owner/repo',
      }),
    ).toThrow(/invalid format/);

    const confirm = getOpenSlackMutationToolDefinition('openslack_confirm_plan')!;
    expect(() =>
      validateToolInput(confirm, {
        planId: 'plan-1',
      }),
    ).toThrow(/confirmationToken is required/);
    expect(
      validateToolInput(confirm, {
        planId: 'plan-1',
        confirmationToken: 'A'.repeat(43),
      }),
    ).toEqual({
      planId: 'plan-1',
      confirmationToken: 'A'.repeat(43),
    });

    const cancel = getOpenSlackMutationToolDefinition('openslack_cancel_plan')!;
    expect(() =>
      validateToolInput(cancel, {
        planId: 'plan-1',
        confirmationToken: 'short',
      }),
    ).toThrow(/invalid format|shorter than 32/);
  });

  it('rebuilds inert JSON from another realm while rejecting custom prototypes', () => {
    const scenario = getOpenSlackMutationToolDefinition('openslack_preview_scenario')!;
    const foreign = runInNewContext(
      '({ scenarioId: "software-delivery", input: { objective: "Cross realm", tags: ["safe"] } })',
    ) as unknown;
    expect(validateToolInput(scenario, foreign)).toEqual({
      scenarioId: 'software-delivery',
      input: { objective: 'Cross realm', tags: ['safe'] },
    });
    expect(Object.getPrototypeOf(validateToolInput(scenario, foreign))).toBe(Object.prototype);

    class ExecutableCarrier {
      scenarioId = 'software-delivery';
      input = {};
    }
    expect(() => validateToolInput(scenario, new ExecutableCarrier())).toThrow(
      /inert plain object/,
    );
  });

  it('rejects unsafe nested mutation input before invoking getters or Proxy traps', () => {
    const scenario = getOpenSlackMutationToolDefinition('openslack_preview_scenario')!;
    let getterInvoked = false;
    const accessor = Object.defineProperty({}, 'objective', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'unsafe';
      },
    });
    expect(() =>
      validateToolInput(scenario, {
        scenarioId: 'software-delivery',
        input: accessor,
      }),
    ).toThrow(/data property/);
    expect(getterInvoked).toBe(false);

    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          throw new Error('trap');
        },
      },
    );
    expect(() =>
      validateToolInput(scenario, {
        scenarioId: 'software-delivery',
        input: { nested: proxy },
      }),
    ).toThrow(/must not contain a Proxy/);
    expect(traps).toBe(0);
  });

  it('rejects unknown and out-of-bound arguments', () => {
    const tool = getOpenSlackReadToolDefinition('openslack_get_activity');
    expect(tool).toBeDefined();
    expect(() => validateToolInput(tool!, { limit: 101 })).toThrow(ToolInputValidationError);
    expect(() => validateToolInput(tool!, { rawCommand: 'status' })).toThrow(
      /unexpected argument properties are not allowed/,
    );
    try {
      validateToolInput(tool!, { rawCommand: 'status' });
    } catch (error) {
      expect(error).toBeInstanceOf(ToolInputValidationError);
      expect(String(error)).not.toContain('rawCommand');
    }
  });

  it('requires and validates bounded identifiers', () => {
    const room = getOpenSlackReadToolDefinition('openslack_get_work_room')!;
    expect(() => validateToolInput(room, {})).toThrow(/roomId is required/);
    expect(() => validateToolInput(room, { roomId: '../../secret' })).toThrow(/invalid format/);
    expect(validateToolInput(room, { roomId: 'pr:312', limit: 20 })).toEqual({
      roomId: 'pr:312',
      limit: 20,
    });
  });

  it('accepts bounded graph arrays and rejects malformed inert input without invoking getters', () => {
    const graph = getOpenSlackReadToolDefinition('openslack_query_graph')!;
    expect(
      validateToolInput(graph, {
        scenarioInstanceId: 'scenario-1',
        rootNodeIds: ['node-1', 'node-2'],
        depth: 3,
        maxNodes: 200,
        maxEdges: 500,
        maxResponseBytes: 512 * 1_024,
      }),
    ).toMatchObject({ rootNodeIds: ['node-1', 'node-2'] });

    let invoked = false;
    const accessor = Object.defineProperty({}, 'scenarioInstanceId', {
      enumerable: true,
      get() {
        invoked = true;
        return 'scenario-1';
      },
    });
    expect(() => validateToolInput(graph, accessor)).toThrow(/data property/);
    expect(invoked).toBe(false);
    expect(() =>
      validateToolInput(graph, Object.assign(Object.create({ inherited: true }), {})),
    ).toThrow(/inert plain object/);
    const symbol = { scenarioInstanceId: 'scenario-1', [Symbol('unsafe')]: true };
    expect(() => validateToolInput(graph, symbol)).toThrow(/symbol/);
    const sparse = new Array(2);
    sparse[1] = 'node-2';
    expect(() =>
      validateToolInput(graph, { scenarioInstanceId: 'scenario-1', rootNodeIds: sparse }),
    ).toThrow(/sparse/);
    const named = ['node-1'];
    Object.defineProperty(named, 'named', { enumerable: true, value: true });
    expect(() =>
      validateToolInput(graph, { scenarioInstanceId: 'scenario-1', rootNodeIds: named }),
    ).toThrow(/named/);
  });

  it('rejects top-level and nested proxies before executing any traps', () => {
    const graph = getOpenSlackReadToolDefinition('openslack_query_graph')!;
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          traps += 1;
          throw new Error('get trap executed');
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error('descriptor trap executed');
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error('prototype trap executed');
        },
        ownKeys() {
          traps += 1;
          throw new Error('ownKeys trap executed');
        },
      },
    );

    expect(() => validateToolInput(graph, proxy)).toThrow(/must not be a Proxy/);
    expect(traps).toBe(0);
    expect(() =>
      validateToolInput(graph, {
        scenarioInstanceId: 'scenario-1',
        rootNodeIds: [proxy],
      }),
    ).toThrow(/must not contain a Proxy/);
    expect(traps).toBe(0);

    const callableProxy = new Proxy(() => undefined, {
      apply() {
        traps += 1;
        throw new Error('apply trap executed');
      },
    });
    expect(() =>
      validateToolInput(graph, {
        scenarioInstanceId: 'scenario-1',
        rootNodeIds: [callableProxy],
      }),
    ).toThrow(/must not contain a Proxy/);
    expect(traps).toBe(0);
  });

  it('bounds property names, object width, total nodes, depth, and validation findings', () => {
    const graph = getOpenSlackReadToolDefinition('openslack_query_graph')!;
    const overlongName = 'x'.repeat(100_000);
    const overlong = { [overlongName]: true };
    let error: unknown;
    try {
      validateToolInput(graph, overlong);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ToolInputValidationError);
    expect(String(error)).toContain('overlong property name');
    expect(String(error)).not.toContain(overlongName);
    expect(String(error).length).toBeLessThan(512);

    const wide = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`key-${index}`, index]),
    );
    expect(() => validateToolInput(graph, wide)).toThrow(/too many properties/);

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 8; index += 1) deep = { child: deep };
    expect(() => validateToolInput(graph, deep)).toThrow(/depth limit/);

    const nodeHeavy = {
      payload: Array.from({ length: 1_000 }, () => [null, null, null]),
    };
    expect(() => validateToolInput(graph, nodeHeavy)).toThrow(/total node limit/);

    try {
      validateToolInput(graph, {
        scenarioInstanceId: 'scenario-1',
        rootNodeIds: Array.from({ length: 200 }, (_, index) => index),
      });
      throw new Error('expected validation failure');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ToolInputValidationError);
      expect((caught as ToolInputValidationError).findings).toHaveLength(20);
      expect(String(caught).length).toBeLessThan(5_500);
    }
  });
});
