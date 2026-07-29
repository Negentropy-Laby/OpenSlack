import { describe, expect, it } from 'vitest';
import { GraphContractError, validateContractToDeliverySourceSnapshot } from '../index.js';
import { contractToDeliverySource } from './contract-to-delivery-fixtures.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function mutableSource(): DeepMutable<ReturnType<typeof contractToDeliverySource>> {
  return structuredClone(contractToDeliverySource()) as DeepMutable<
    ReturnType<typeof contractToDeliverySource>
  >;
}

function expectContractError(value: unknown, code: GraphContractError['code']): void {
  try {
    validateContractToDeliverySourceSnapshot(value);
    throw new Error('Expected contract validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(GraphContractError);
    expect((error as GraphContractError).code).toBe(code);
  }
}

describe('Contract-to-Delivery source validation', () => {
  it('accepts and reconstructs the bounded closed source contract', () => {
    const source = contractToDeliverySource();
    const validated = validateContractToDeliverySourceSnapshot(source);

    expect(validated).toEqual(source);
    expect(validated).not.toBe(source);
    expect(validated.business.customers.items).not.toBe(source.business.customers.items);
  });

  it('rejects unknown fields and active or credential-like content', () => {
    const unknown = mutableSource() as unknown as Record<string, unknown>;
    unknown.command = 'run';
    expectContractError(unknown, 'GRAPH_SCHEMA_INVALID');

    const active = mutableSource();
    active.business.customers.items[0]!.title = 'https://unsafe.example';
    expectContractError(active, 'GRAPH_PROPERTY_UNSAFE');

    const credential = mutableSource();
    credential.business.customers.items[0]!.title = `github_pat_${'a'.repeat(20)}`;
    expectContractError(credential, 'GRAPH_PROPERTY_UNSAFE');
  });

  it('rejects accessors without invoking caller code', () => {
    const source = mutableSource();
    let getterHits = 0;
    Object.defineProperty(source, 'schema', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterHits += 1;
        return 'openslack.contract_to_delivery_source_snapshot.v1';
      },
    });

    expectContractError(source, 'GRAPH_SCHEMA_INVALID');
    expect(getterHits).toBe(0);
  });

  it('rejects named and symbol properties on otherwise dense source arrays', () => {
    const named = mutableSource();
    Object.defineProperty(named.business.customers.items, 'command', {
      enumerable: true,
      value: 'run',
    });
    expectContractError(named, 'GRAPH_SCHEMA_INVALID');

    const symbol = mutableSource();
    Object.defineProperty(symbol.business.customers.items, Symbol('hidden'), {
      enumerable: true,
      value: 'run',
    });
    expectContractError(symbol, 'GRAPH_SCHEMA_INVALID');
  });

  it('enforces the direct validator JSON-node ceiling before schema reconstruction', () => {
    const source = mutableSource();
    const expand = <
      T extends {
        id: string;
        authorityRef: { objectId: string; version: string };
        sourceEventIds: string[];
        evidenceRefs: string[];
      },
    >(
      batch: { items: T[] },
      prefix: string,
    ): void => {
      const template = batch.items[0];
      if (template === undefined) throw new Error(`Fixture batch ${prefix} must not be empty.`);
      batch.items = Array.from({ length: 500 }, (_, index) => {
        const id = `${prefix}-${index}`;
        return {
          ...structuredClone(template),
          id,
          authorityRef: {
            ...template.authorityRef,
            objectId: id,
            version: `fixture-${id}-v1`,
          },
          sourceEventIds: Array.from(
            { length: 10 },
            (_value, referenceIndex) => `event:${id}:${referenceIndex}`,
          ),
          evidenceRefs: Array.from(
            { length: 10 },
            (_value, referenceIndex) => `fixture:${id}:${referenceIndex}`,
          ),
        };
      });
    };

    expand(source.business.customers, 'customer');
    expand(source.business.contracts, 'contract');
    expand(source.business.projects, 'project');
    expand(source.business.milestones, 'milestone');
    expand(source.business.acceptances, 'acceptance');
    expand(source.business.outcomes, 'outcome');

    expect(Buffer.byteLength(JSON.stringify(source), 'utf8')).toBeLessThan(4 * 1024 * 1024);
    expectContractError(source, 'GRAPH_BOUND_EXCEEDED');
  });

  it.each([
    ['scenarioDefinitionId', 'other-scenario'],
    ['scenarioInstanceId', 'other-instance'],
    ['cursor', 'other-cursor'],
    ['generatedAt', '2026-07-27T02:00:01.000Z'],
  ] as const)('rejects nested %s scope drift', (field, value) => {
    const source = mutableSource();
    source.softwareDelivery[field] = value;
    expectContractError(source, 'GRAPH_SCOPE_INVALID');
  });

  it('rejects duplicate observation and authority identities', () => {
    const duplicateId = mutableSource();
    if (duplicateId.business.customers.status === 'missing') {
      throw new Error('Fixture customers must be observed.');
    }
    duplicateId.business.customers.items.push({
      ...duplicateId.business.customers.items[0]!,
    });
    expectContractError(duplicateId, 'GRAPH_REFERENCE_INVALID');

    const duplicateAuthority = mutableSource();
    const customer = duplicateAuthority.business.customers.items[0]!;
    duplicateAuthority.business.contracts.items[0]!.authorityRef = {
      ...customer.authorityRef,
    };
    expectContractError(duplicateAuthority, 'GRAPH_REFERENCE_INVALID');
  });

  it('rejects caller-selected bridge node types and future authority observations', () => {
    const wrongType = mutableSource();
    wrongType.business.projects.items[0]!.workItem.targetType = 'reviewable_deliverable';
    expectContractError(wrongType, 'GRAPH_REFERENCE_INVALID');

    const future = mutableSource();
    future.business.customers.items[0]!.authorityRef.observedAt = '2026-07-27T02:00:01.000Z';
    expectContractError(future, 'GRAPH_SCHEMA_INVALID');
  });
});
