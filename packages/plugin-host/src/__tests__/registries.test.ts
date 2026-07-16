import { describe, expect, it } from 'vitest';
import type { PluginHostError } from '../findings.js';
import {
  PluginRegistrySet,
  canonicalPluginContributionId,
  type PluginRegistryBatch,
  type RegistryPreflight,
} from '../registries.js';

type Value = { readonly marker: string };

function batch(
  id: string,
  sourceRef: string,
  overrides: Partial<PluginRegistryBatch<Value, Value, Value, Value, Value, Value>> = {},
): PluginRegistryBatch<Value, Value, Value, Value, Value, Value> {
  return {
    plugin: {
      id,
      version: '1.0.0',
      providerKind: 'workspace',
      sourceRef,
      value: { marker: `plugin:${id}` },
    },
    ...overrides,
  };
}

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as PluginHostError).findings[0]?.code;
  }
  return undefined;
}

describe('PluginRegistrySet', () => {
  it('constructs namespaced IDs inside the host and commits all per-kind maps atomically', () => {
    const registries = new PluginRegistrySet<Value, Value, Value, Value>();
    const result = registries.registerBatches([
      batch('reader', '.openslack/plugins/reader/plugin.json', {
        actionAliases: [{ localId: 'status', value: { marker: 'alias-action' } }],
        workflowAliases: [{ localId: 'status', value: { marker: 'alias-workflow' } }],
        bundledActions: [{ localId: 'plan', value: { marker: 'bundled-action' } }],
        bundledWorkflows: [{ localId: 'run', value: { marker: 'bundled-workflow' } }],
        prmsBlockers: [{ localId: 'policy', value: { marker: 'blocker' } }],
      }),
    ]);

    expect(result.pluginIds).toEqual(['reader']);
    expect(result.contributionIds).toEqual([
      'plugin:reader:plan',
      'plugin:reader:policy',
      'plugin:reader:run',
      'plugin:reader:status',
      'plugin:reader:status',
    ]);
    expect(registries.getAction('plugin:reader:status')?.kind).toBe('action_alias');
    expect(registries.getAction('plugin:reader:plan')?.kind).toBe('bundled_action');
    expect(registries.getWorkflow('plugin:reader:status')?.kind).toBe('workflow_alias');
    expect(registries.getWorkflow('plugin:reader:run')?.kind).toBe('bundled_workflow');
    expect(registries.getPrmsBlocker('plugin:reader:policy')?.kind).toBe('prms_blocker');
    expect(registries.getPlugin('reader')?.sourceRef).toBe('.openslack/plugins/reader/plugin.json');
    expect(Object.isFrozen(registries.getAction('plugin:reader:status'))).toBe(true);
  });

  it('allows action and workflow namespaces to share a local ID but rejects alias/bundled collisions in-kind', () => {
    const registries = new PluginRegistrySet<Value, Value, Value, Value>();
    const conflicting = batch('reader', 'reader/plugin.json', {
      actionAliases: [{ localId: 'status', value: { marker: 'alias' } }],
      bundledActions: [{ localId: 'status', value: { marker: 'bundled' } }],
      workflowAliases: [{ localId: 'status', value: { marker: 'workflow' } }],
    });

    expect(code(() => registries.registerBatches([conflicting]))).toBe(
      'PLUGIN_REGISTRY_ACTION_COLLISION',
    );
    expect(registries.listPlugins()).toEqual([]);
    expect(registries.listActions()).toEqual([]);
    expect(registries.listWorkflows()).toEqual([]);
    expect(registries.revision).toBe(0);
  });

  it('rejects the entire multi-plugin batch for plugin, workflow, and PRMS collisions', () => {
    const registries = new PluginRegistrySet<Value, Value, Value, Value>();
    const first = batch('duplicate', 'z/plugin.json', {
      workflowAliases: [{ localId: 'show', value: { marker: 'first-workflow' } }],
      prmsBlockers: [{ localId: 'gate', value: { marker: 'first-blocker' } }],
    });
    const second = batch('duplicate', 'a/plugin.json', {
      workflowAliases: [{ localId: 'show', value: { marker: 'second-workflow' } }],
      prmsBlockers: [{ localId: 'gate', value: { marker: 'second-blocker' } }],
    });

    try {
      registries.preflight([first, second]);
      throw new Error('expected collision');
    } catch (error) {
      const findings = (error as PluginHostError).findings;
      expect(findings.map((finding) => finding.code)).toEqual([
        'PLUGIN_REGISTRY_PLUGIN_COLLISION',
        'PLUGIN_REGISTRY_PRMS_BLOCKER_COLLISION',
        'PLUGIN_REGISTRY_WORKFLOW_COLLISION',
      ]);
    }
    expect(registries.listPlugins()).toEqual([]);
    expect(registries.listPrmsBlockers()).toEqual([]);
  });

  it('preflights canonical source order independent of caller order', () => {
    const first = new PluginRegistrySet<Value, Value, Value, Value>().preflight([
      batch('zeta', 'z/plugin.json'),
      batch('alpha', 'a/plugin.json'),
    ]);
    const second = new PluginRegistrySet<Value, Value, Value, Value>().preflight([
      batch('alpha', 'a/plugin.json'),
      batch('zeta', 'z/plugin.json'),
    ]);
    expect(first.pluginIds).toEqual(['alpha', 'zeta']);
    expect(first.pluginIds).toEqual(second.pluginIds);
    expect(first.contributionIds).toEqual(second.contributionIds);
  });

  it('rejects reserved, openslack-prefixed, malformed, and caller-supplied full IDs', () => {
    const registries = new PluginRegistrySet<Value, Value, Value, Value>();
    for (const id of ['openslack', 'openslack-core', 'Bad_Id']) {
      expect(code(() => registries.preflight([batch(id, `${id}/plugin.json`)]))).toBe(
        'PLUGIN_REGISTRY_INVALID_ID',
      );
    }

    const fullId = batch('reader', 'reader/plugin.json', {
      actionAliases: [{ localId: 'plugin:attacker:action', value: { marker: 'caller-namespace' } }],
    });
    expect(code(() => registries.preflight([fullId]))).toBe('PLUGIN_REGISTRY_INVALID_ID');
    expect(canonicalPluginContributionId('reader', 'status')).toBe('plugin:reader:status');
  });

  it('rejects forged, cross-instance, stale, and reused preflight handles', () => {
    const first = new PluginRegistrySet<Value, Value, Value, Value>();
    const second = new PluginRegistrySet<Value, Value, Value, Value>();
    const prepared = first.preflight([batch('reader', 'reader/plugin.json')]);

    expect(code(() => second.commit(prepared))).toBe('PLUGIN_REGISTRY_PREFLIGHT_FOREIGN');
    expect(
      code(() =>
        first.commit({ revision: 0, pluginIds: [], contributionIds: [] } as RegistryPreflight),
      ),
    ).toBe('PLUGIN_REGISTRY_PREFLIGHT_FOREIGN');

    first.registerBatches([batch('other', 'other/plugin.json')]);
    expect(code(() => first.commit(prepared))).toBe('PLUGIN_REGISTRY_PREFLIGHT_STALE');

    const fresh = first.preflight([batch('reader', 'reader/plugin.json')]);
    first.commit(fresh);
    expect(code(() => first.commit(fresh))).toBe('PLUGIN_REGISTRY_PREFLIGHT_REUSED');
  });

  it('does not leak registrations across host instances and exposes sorted snapshots only', () => {
    const first = new PluginRegistrySet<Value, Value, Value, Value>();
    const second = new PluginRegistrySet<Value, Value, Value, Value>();
    first.registerBatches([batch('zeta', 'z/plugin.json'), batch('alpha', 'a/plugin.json')]);
    expect(first.listPlugins().map((plugin) => plugin.id)).toEqual(['alpha', 'zeta']);
    expect(second.listPlugins()).toEqual([]);
    expect(Object.isFrozen(first.listPlugins())).toBe(true);
  });

  it('rejects an existing plugin in a later transaction without mutating prior state', () => {
    const registries = new PluginRegistrySet<Value, Value, Value, Value>();
    registries.registerBatches([batch('reader', 'reader/plugin.json')]);
    expect(
      code(() => registries.registerBatches([batch('reader', 'replacement/plugin.json')])),
    ).toBe('PLUGIN_REGISTRY_PLUGIN_COLLISION');
    expect(registries.getPlugin('reader')?.sourceRef).toBe('reader/plugin.json');
    expect(registries.revision).toBe(1);
  });
});
