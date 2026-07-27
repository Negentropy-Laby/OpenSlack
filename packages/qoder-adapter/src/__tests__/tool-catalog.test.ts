import { describe, expect, it } from 'vitest';
import {
  OPENSLACK_READ_TOOL_CATALOG,
  OPENSLACK_READ_TOOL_NAMES,
  ToolInputValidationError,
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
