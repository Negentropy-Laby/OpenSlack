import { types as nodeTypes } from 'node:util';
import fixtureSource from './fixtures/contract-to-delivery-source.json' with { type: 'json' };
import type { ContractToDeliverySourceSnapshot } from './contract-to-delivery-types.js';
import { validateContractToDeliverySourceSnapshot } from './contract-to-delivery-validation.js';

export const CONTRACT_TO_DELIVERY_DEMO_SOURCE_ID = 'contract-to-delivery-lite-example' as const;

export interface CreateContractToDeliveryDemoSourceInput {
  readonly scenarioInstanceId: string;
  readonly cursor: string;
  readonly generatedAt: string;
}

export class ContractToDeliveryDemoSourceError extends Error {
  readonly code: 'CONTRACT_DELIVERY_DEMO_SOURCE_INPUT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ContractToDeliveryDemoSourceError';
    this.code = 'CONTRACT_DELIVERY_DEMO_SOURCE_INPUT_INVALID';
  }
}

interface MutableEvidence {
  id: string;
  authorityVersion?: string;
  observedAt?: string;
  sourceEventIds: string[];
  evidenceRefs: string[];
  authorityRef?: {
    provider: string;
    objectType: string;
    objectId: string;
    version: string;
    observedAt: string;
  };
}

interface MutableBatch {
  status: string;
  batchVersion?: string;
  observedAt?: string;
  items: MutableEvidence[];
  warningCodes?: string[];
}

interface MutableDemoSource {
  scenarioInstanceId: string;
  cursor: string;
  generatedAt: string;
  softwareDelivery: {
    scenarioInstanceId: string;
    cursor: string;
    generatedAt: string;
    sources: Record<string, MutableBatch>;
  };
  business: Record<string, MutableBatch>;
}

const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const TEMPLATE = validateContractToDeliverySourceSnapshot(fixtureSource);

function fail(message: string): never {
  throw new ContractToDeliveryDemoSourceError(message);
}

function runtimeId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    !SAFE_RUNTIME_ID.test(value)
  ) {
    return fail(`${label} is not a bounded runtime identifier.`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail('generatedAt must be a canonical RFC3339 timestamp.');
  }
  return value;
}

function inspectInput(
  value: CreateContractToDeliveryDemoSourceInput,
): CreateContractToDeliveryDemoSourceInput {
  if (
    !value ||
    typeof value !== 'object' ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail('Demo source input must be inert host-owned data.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ['cursor', 'generatedAt', 'scenarioInstanceId'];
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expected.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !expected.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    return fail('Demo source input has missing or unknown fields.');
  }
  return Object.freeze({
    scenarioInstanceId: runtimeId(descriptors.scenarioInstanceId!.value, 'scenarioInstanceId'),
    cursor: runtimeId(descriptors.cursor!.value, 'cursor'),
    generatedAt: timestamp(descriptors.generatedAt!.value),
  });
}

function markFixtureBatch(
  batch: MutableBatch,
  family: 'business' | 'software_delivery',
  kind: string,
  generatedAt: string,
): void {
  if (batch.status === 'missing') return;
  batch.batchVersion = `demo-fixture-${family}-${kind}-v1`;
  batch.observedAt = generatedAt;
  batch.warningCodes = [
    ...new Set([...(batch.warningCodes ?? []), 'demo_fixture_recorded_evidence']),
  ].sort();
  for (const item of batch.items) {
    if (family === 'software_delivery') item.observedAt = generatedAt;
    item.sourceEventIds = [`fixture-event:${family}:${kind}:${item.id}`];
    item.evidenceRefs = [`fixture:${CONTRACT_TO_DELIVERY_DEMO_SOURCE_ID}:${kind}:${item.id}`];
    if (item.authorityVersion !== undefined) {
      item.authorityVersion = `demo-fixture:${kind}:${item.id}:v1`;
    }
    if (item.authorityRef !== undefined) {
      item.authorityRef.provider = 'demo_fixture';
      item.authorityRef.version = `demo-fixture:${kind}:${item.id}:v1`;
      item.authorityRef.observedAt = generatedAt;
    }
  }
}

/**
 * Create the checked, visibly non-live source used by the local governed rehearsal.
 *
 * Some Software Delivery observations retain `observationKind: live` because the projector uses
 * that field to exercise current-head/check/review authority rules. Every batch and evidence
 * reference is nevertheless rewritten with an explicit demo-fixture marker, so this asset cannot
 * be presented as a live GitHub observation.
 */
export function createContractToDeliveryDemoSource(
  inputValue: CreateContractToDeliveryDemoSourceInput,
): ContractToDeliverySourceSnapshot {
  const input = inspectInput(inputValue);
  const source = structuredClone(TEMPLATE) as unknown as MutableDemoSource;
  source.scenarioInstanceId = input.scenarioInstanceId;
  source.cursor = input.cursor;
  source.generatedAt = input.generatedAt;
  source.softwareDelivery.scenarioInstanceId = input.scenarioInstanceId;
  source.softwareDelivery.cursor = input.cursor;
  source.softwareDelivery.generatedAt = input.generatedAt;
  for (const [kind, batch] of Object.entries(source.softwareDelivery.sources)) {
    markFixtureBatch(batch, 'software_delivery', kind, input.generatedAt);
  }
  for (const [kind, batch] of Object.entries(source.business)) {
    markFixtureBatch(batch, 'business', kind, input.generatedAt);
  }
  return validateContractToDeliverySourceSnapshot(source);
}
