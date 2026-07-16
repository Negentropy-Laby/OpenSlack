import { describe, expect, it } from 'vitest';
import {
  BundledPluginValidationError,
  normalizeBundledPluginDefinition,
  normalizePrmsBlockerResult,
} from '../bundled-policy.js';

function bundled() {
  return {
    providerKind: 'bundled',
    id: 'reviewed-bundle',
    version: '1.0.0',
    name: 'Reviewed bundle',
    requires: { openslack: '>=0.1.0 <1.0.0' },
    gate: { mode: 'SHADOW', gateId: 'host.reviewed' },
    requestedCapabilities: ['prms.blockers.append'],
    contributions: [{ kind: 'prms_blocker', id: 'extra', evaluate: () => ({ blockers: [] }) }],
  };
}

describe('bundled host policy', () => {
  it('accepts executable hooks only through the explicit bundled API', () => {
    expect(normalizeBundledPluginDefinition(bundled())).toMatchObject({
      providerKind: 'bundled',
      contributions: [{ kind: 'prms_blocker' }],
    });
  });

  it('does not trust provider strings, brands, accessors, or missing capabilities', () => {
    expect(() =>
      normalizeBundledPluginDefinition({ ...bundled(), providerKind: 'workspace' }),
    ).toThrowError(BundledPluginValidationError);
    expect(() =>
      normalizeBundledPluginDefinition({ ...bundled(), requestedCapabilities: [] }),
    ).toThrowError(BundledPluginValidationError);
    const accessor = bundled() as Record<string, unknown>;
    Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'spoof' });
    expect(() => normalizeBundledPluginDefinition(accessor)).toThrowError(
      BundledPluginValidationError,
    );
  });

  it('requires and rebuilds a fixed host action target', () => {
    const definition = {
      ...bundled(),
      requestedCapabilities: ['host.actions.plan'],
      contributions: [
        {
          kind: 'bundled_action',
          id: 'status-plan',
          target: { kind: 'host_action', id: 'status.show' },
          buildPlanStep: () => ({ id: 'status.step', actionId: 'status.show', input: {} }),
        },
      ],
    };
    const normalized = normalizeBundledPluginDefinition(definition);
    expect(normalized.contributions[0]).toMatchObject({
      kind: 'bundled_action',
      target: { kind: 'host_action', id: 'status.show' },
    });
    expect(Object.isFrozen((normalized.contributions[0] as { target: object }).target)).toBe(true);
    expect(() =>
      normalizeBundledPluginDefinition({
        ...definition,
        contributions: [{ ...definition.contributions[0], target: undefined }],
      }),
    ).toThrowError(BundledPluginValidationError);
  });

  it('rebuilds blocker-only output and rejects approval or PASS laundering', () => {
    const result = normalizePrmsBlockerResult({
      blockers: [{ kind: 'blocker', code: 'EXTRA_BLOCKER', summary: 'Blocked.' }],
    });
    expect(Object.isFrozen(result.blockers[0])).toBe(true);
    expect(result).toEqual({
      blockers: [{ kind: 'blocker', code: 'EXTRA_BLOCKER', summary: 'Blocked.' }],
    });
    for (const extra of [{ outcome: 'PASS' }, { approvalCount: 99 }, { mergeable: true }]) {
      expect(() => normalizePrmsBlockerResult({ blockers: [], ...extra })).toThrowError(
        BundledPluginValidationError,
      );
    }
  });

  it('rejects getters, symbols, custom prototypes, and non-enumerable blocker fields', () => {
    let getterCalled = false;
    const result = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(result, 'blockers', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return [];
      },
    });
    expect(() => normalizePrmsBlockerResult(result)).toThrowError(BundledPluginValidationError);
    expect(getterCalled).toBe(false);
    const symbolResult = { blockers: [] } as Record<PropertyKey, unknown>;
    symbolResult[Symbol('pass')] = true;
    expect(() => normalizePrmsBlockerResult(symbolResult)).toThrowError(
      BundledPluginValidationError,
    );
  });

  it.each(['PASS', 'HUMAN_APPROVED', 'APPROVAL', 'READY_TO_MERGE', 'MERGEABLE', 'ACTION_ALLOWED'])(
    'rejects authority-bearing blocker code %s',
    (code) => {
      expect(() =>
        normalizePrmsBlockerResult({
          blockers: [{ kind: 'blocker', code, summary: 'Spoofed positive outcome.' }],
        }),
      ).toThrowError(BundledPluginValidationError);
    },
  );
});
