import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BundledPluginContext, HostPlanStep, PluginManifestV1 } from '@openslack/plugin-api';
import {
  defineActionAlias,
  defineBundledAction,
  defineBundledPlugin,
  defineManifest,
  definePrmsBlocker,
  defineWorkflowAlias,
} from '../index.js';

describe('@openslack/sdk authoring helpers', () => {
  it('preserves manifest identity without registering global state', () => {
    const input = {
      schema: 'openslack.plugin.v1',
      id: 'sdk-example',
      version: '1.0.0',
      name: 'SDK example',
      requires: { openslack: '>=0.2.0' },
      gate: { mode: 'SHADOW', gateId: 'host.read-only' },
      capabilities: ['host.actions.read'],
      contributes: [
        {
          kind: 'action_alias',
          id: 'status',
          target: { kind: 'host_action', id: 'status.show' },
        },
      ],
    } as const;
    const first = defineManifest(input);
    const second = defineManifest(structuredClone(input));
    expect(first).toBe(input);
    expect(second).not.toBe(first);
    expect(first).toEqual(second);
    expectTypeOf(first).toMatchTypeOf<PluginManifestV1>();
    if (false) {
      // @ts-expect-error Executable root fields are not part of the manifest authoring shape.
      defineManifest({ ...input, entry: './evil.js' });
    }
  });

  it('preserves declarative descriptor identity', () => {
    const action = defineActionAlias({
      kind: 'action_alias',
      id: 'doctor',
      target: { kind: 'host_action', id: 'pr.doctor' },
    });
    const workflow = defineWorkflowAlias({
      kind: 'workflow_alias',
      id: 'digest',
      target: { kind: 'host_workflow', id: 'collaboration.digest' },
    });
    expect(action.kind).toBe('action_alias');
    expect(workflow.kind).toBe('workflow_alias');
  });

  it('keeps bundled executable contributions explicit and typed', async () => {
    const action = defineBundledAction({
      kind: 'bundled_action',
      id: 'status-plan',
      buildPlanStep: async (_input, _context): Promise<HostPlanStep> => ({
        id: 'step-1',
        actionId: 'status.show',
        input: {},
      }),
    });
    const blocker = definePrmsBlocker<{ blocked: boolean }>({
      kind: 'prms_blocker',
      id: 'extra-blocker',
      evaluate: (report, _context) => ({
        blockers: report.blocked
          ? [{ kind: 'blocker', code: 'BUNDLED_BLOCKER', summary: 'Blocked by fixture.' }]
          : [],
        outcome: 'PASS' as const,
        approvalCount: 99,
        mergeable: true,
      }),
    });
    const plugin = defineBundledPlugin({
      providerKind: 'bundled',
      id: 'reviewed-bundle',
      version: '1.0.0',
      name: 'Reviewed bundle',
      requires: { openslack: '>=0.2.0' },
      gate: { mode: 'ENFORCE', gateId: 'host.reviewed-bundle' },
      requestedCapabilities: ['host.actions.plan', 'prms.blockers.append'],
      contributions: [action, blocker],
    });
    expect(plugin.providerKind).toBe('bundled');
    expect(plugin.contributions).toEqual([action, blocker]);
    expectTypeOf<
      BundledPluginContext['activationEvidence']['providerKind']
    >().toEqualTypeOf<'bundled'>();
    const context = {} as BundledPluginContext;
    await expect(action.buildPlanStep({}, context)).resolves.toMatchObject({
      actionId: 'status.show',
    });
    expect(await blocker.evaluate({ blocked: true }, context)).toEqual({
      blockers: [{ kind: 'blocker', code: 'BUNDLED_BLOCKER', summary: 'Blocked by fixture.' }],
    });
    if (false) {
      const result = await blocker.evaluate({ blocked: true }, context);
      // @ts-expect-error Blocker results cannot represent an approval or PASS outcome.
      expect(result.outcome).toBeUndefined();
    }
  });
});
