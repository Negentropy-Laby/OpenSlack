import { describe, expect, it } from 'vitest';
import {
  canonicalGovernedJson,
  canonicalizeGovernedJson,
  createCanonicalGovernedPlan,
  GOVERNED_PLAN_CONTRACT_LIMITS,
  hashGovernedValue,
  hashOpaqueValue,
  validateGovernedPlanRecord,
} from '../governed-plan.js';

function canonicalPlan() {
  return createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate scenario',
    input: { z: 2, a: 1 },
    actions: [{ actionId: 'scenario.instantiate', input: { name: 'demo' } }],
    effects: [
      {
        type: 'scenario.instance',
        summary: 'Create one scenario instance',
        risk: 'medium',
      },
    ],
  });
}

describe('governed plan contract', () => {
  it('canonicalizes, sorts, and deeply freezes inert JSON', () => {
    const value = canonicalizeGovernedJson({ z: [{ b: 2, a: 1 }], a: true });

    expect(canonicalGovernedJson(value)).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(Object.isFrozen(value)).toBe(true);
    const object = value as { readonly z: readonly object[] };
    expect(Object.isFrozen(object.z)).toBe(true);
    expect(Object.isFrozen(object.z[0])).toBe(true);
  });

  it('rejects proxies and accessors without invoking traps or getters', () => {
    let touched = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          touched += 1;
          return [];
        },
      },
    );
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        touched += 1;
        return 'secret';
      },
    });

    expect(() => canonicalizeGovernedJson(proxy)).toThrow('Proxy');
    expect(() => canonicalizeGovernedJson(accessor)).toThrow('own data');
    expect(touched).toBe(0);
  });

  it('rejects prototype-pollution keys and structural limits', () => {
    expect(() => canonicalizeGovernedJson(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(
      'forbidden key',
    );

    let tooDeep: unknown = 'leaf';
    for (let depth = 0; depth < 13; depth += 1) tooDeep = [tooDeep];
    expect(() => canonicalizeGovernedJson(tooDeep)).toThrow('structural limit');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(canonicalGovernedJson('\ud800')).toBe('"\\ud800"');
    expect(canonicalGovernedJson({ ['\udc00']: true })).toBe('{"\\udc00":true}');
  });

  it('binds exact canonical input and plan hashes', () => {
    const plan = canonicalPlan();
    const timestamp = '2026-07-27T00:00:00.000Z';
    const hash = hashGovernedValue;
    const record = {
      schema: 'openslack.governed_plan.v1',
      revision: 1,
      planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
      state: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: '2026-07-27T00:15:00.000Z',
      canonicalPlan: plan,
      bindings: {
        actorId: 'qoder.local',
        workspaceId: 'workspace.demo',
        correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
        inputHash: hash(plan.input),
        planHash: hash(plan),
        sourceVersionHash: hash({ github: 'abc' }),
        permissionSnapshotHash: hash({ capabilities: ['scenario.instantiate'] }),
        actionCatalogHash: hash(['scenario.instantiate']),
        executorBindingHash: hash(['scenario.instantiate@v1']),
        buildNonceHash: hash('build-nonce'),
        processNonceHash: hash('process-nonce'),
      },
      confirmationTokenHash: hash('confirmation-token'),
    };

    expect(validateGovernedPlanRecord(record).bindings.planHash).toBe(hash(plan));
    expect(
      validateGovernedPlanRecord({
        ...record,
        createdAt: '2026-02-30T06:00:00.000Z',
        updatedAt: '2026-02-30T06:00:00.000Z',
      }).createdAt,
    ).toBe('2026-02-30T06:00:00.000Z');
    expect(() =>
      validateGovernedPlanRecord({
        ...record,
        canonicalPlan: { ...plan, input: { changed: true } },
      }),
    ).toThrow('Input hash');
  });

  it('freezes existing v1 opaque UTF-16-unit boundaries and surrogate hashing', () => {
    const minimum = GOVERNED_PLAN_CONTRACT_LIMITS.minOpaqueBindingCharacters;
    const maximum = GOVERNED_PLAN_CONTRACT_LIMITS.maxOpaqueBindingCharacters;
    expect(() => hashOpaqueValue('a'.repeat(minimum - 1))).toThrow('outside allowed bounds');
    expect(hashOpaqueValue('a'.repeat(minimum))).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueValue('a'.repeat(maximum))).toMatch(/^[0-9a-f]{64}$/);
    expect(() => hashOpaqueValue('a'.repeat(maximum + 1))).toThrow('outside allowed bounds');
    expect(hashOpaqueValue('\ud800'.repeat(minimum))).toBe(
      hashOpaqueValue('\ufffd'.repeat(minimum)),
    );
  });
});
