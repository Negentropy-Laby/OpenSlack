import type {
  HostPolicyPort,
  JsonPrimitive,
  PluginAuditEvent,
  PluginIdentity,
  PluginProviderKind,
} from '@openslack/plugin-api';
import { PluginHostError } from './findings.js';

export const HOST_AUDIT_FACT_KEYS = Object.freeze([
  'decisionCode',
  'lifecycleFrom',
  'lifecycleTo',
  'gateId',
  'contributionId',
  'targetId',
  'sourceKind',
  'capabilityCount',
  'outcome',
  'reasonCode',
  'compositionId',
  'integrityMatched',
] as const);

export type HostAuditFactKey = (typeof HOST_AUDIT_FACT_KEYS)[number];

export interface HostAuditFact {
  readonly key: HostAuditFactKey;
  readonly value: JsonPrimitive;
}

export interface BuildPluginAuditEventInput {
  readonly type: PluginAuditEvent['type'];
  readonly plugin: PluginIdentity;
  readonly providerKind: PluginProviderKind;
  readonly evidenceRefs?: readonly string[];
  readonly facts?: readonly HostAuditFact[];
}

export type AuditClock = () => string;

const DEFAULT_CLOCK: AuditClock = () => new Date().toISOString();
const AUDIT_FACT_KEY_SET = new Set<string>(HOST_AUDIT_FACT_KEYS);
const AUDIT_EVENT_TYPES = new Set<PluginAuditEvent['type']>([
  'plugin.activation.requested',
  'plugin.activation.allowed',
  'plugin.activation.denied',
  'plugin.action.requested',
  'plugin.action.allowed',
  'plugin.action.denied',
  'plugin.lifecycle.changed',
]);
const AUDIT_SUMMARIES: Readonly<Record<PluginAuditEvent['type'], string>> = Object.freeze({
  'plugin.activation.requested': 'Plugin activation requested.',
  'plugin.activation.allowed': 'Plugin activation allowed.',
  'plugin.activation.denied': 'Plugin activation denied.',
  'plugin.action.requested': 'Plugin action requested.',
  'plugin.action.allowed': 'Plugin action allowed.',
  'plugin.action.denied': 'Plugin action denied.',
  'plugin.lifecycle.changed': 'Plugin lifecycle changed.',
});
const PROVIDER_KINDS = new Set<PluginProviderKind>(['built-in', 'bundled', 'workspace', 'plugin']);
const SECRET_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bgh[pousr]_[A-Za-z0-9_]{12,}|\b(?:token|password|secret|private[_-]?key)\s*[:=]\s*\S+)/i;

function invalidAuditFact(summary: string): never {
  throw new PluginHostError([
    {
      phase: 'audit',
      code: 'PLUGIN_AUDIT_FACT_INVALID',
      summary,
    },
  ]);
}

function plainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) return undefined;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function boundedText(value: string, maxLength: number, field: string): string {
  if (value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    invalidAuditFact(`${field} is empty, oversized, or contains control characters.`);
  }
  return SECRET_PATTERN.test(value) ? '[REDACTED]' : value;
}

function normalizedFacts(facts: readonly HostAuditFact[]): Readonly<Record<string, JsonPrimitive>> {
  if (facts.length > 16) invalidAuditFact('Audit metadata exceeds the 16-fact limit.');
  const metadata: Record<string, JsonPrimitive> = Object.create(null) as Record<
    string,
    JsonPrimitive
  >;
  for (const factValue of facts) {
    const fact = plainDataRecord(factValue);
    if (!fact || typeof fact.key !== 'string' || !AUDIT_FACT_KEY_SET.has(fact.key)) {
      invalidAuditFact('Audit metadata contains a non-host fact key or non-data value.');
    }
    if (Object.hasOwn(metadata, fact.key)) {
      invalidAuditFact(`Audit metadata fact ${fact.key} is duplicated.`);
    }
    const value = fact.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      invalidAuditFact(`Audit metadata fact ${fact.key} is not scalar.`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      invalidAuditFact(`Audit metadata fact ${fact.key} is not finite.`);
    }
    metadata[fact.key] =
      typeof value === 'string' ? boundedText(value, 256, `Audit fact ${fact.key}`) : value;
  }
  return Object.freeze(metadata);
}

function normalizedEvidenceRefs(refs: readonly string[]): readonly string[] {
  if (refs.length > 16) invalidAuditFact('Audit evidence exceeds the 16-reference limit.');
  return Object.freeze(
    refs.map((reference) => boundedText(reference, 256, 'Audit evidence reference')),
  );
}

function normalizedIdentity(plugin: PluginIdentity): Readonly<PluginIdentity> {
  const record = plainDataRecord(plugin);
  if (!record || typeof record.id !== 'string' || typeof record.version !== 'string') {
    invalidAuditFact('Audit plugin identity is not a plain id/version value.');
  }
  return Object.freeze({
    id: boundedText(record.id, 64, 'Audit plugin ID'),
    version: boundedText(record.version, 128, 'Audit plugin version'),
  });
}

export function buildPluginAuditEvent(
  input: BuildPluginAuditEventInput,
  clock: AuditClock = DEFAULT_CLOCK,
): PluginAuditEvent {
  if (!AUDIT_EVENT_TYPES.has(input.type)) invalidAuditFact('Audit event type is not host-owned.');
  if (!PROVIDER_KINDS.has(input.providerKind)) {
    invalidAuditFact('Audit provider kind is not host-owned.');
  }
  const metadata = normalizedFacts(input.facts ?? []);
  const event: PluginAuditEvent = {
    schema: 'openslack.plugin_audit_event.v1',
    type: input.type,
    plugin: normalizedIdentity(input.plugin),
    providerKind: input.providerKind,
    occurredAt: boundedText(clock(), 64, 'Audit occurrence time'),
    summary: AUDIT_SUMMARIES[input.type],
    evidenceRefs: normalizedEvidenceRefs(input.evidenceRefs ?? []),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
  return Object.freeze(event);
}

/**
 * Required audit writes form part of an allow decision. Sink failure is mapped
 * to a stable host error and never leaks the sink's potentially sensitive text.
 */
export class HostAuditWriter {
  readonly #sink: Pick<HostPolicyPort, 'recordAuditEvent'>;
  readonly #clock: AuditClock;

  constructor(sink: Pick<HostPolicyPort, 'recordAuditEvent'>, clock: AuditClock = DEFAULT_CLOCK) {
    this.#sink = sink;
    this.#clock = clock;
  }

  async recordRequired(input: BuildPluginAuditEventInput): Promise<PluginAuditEvent> {
    const event = buildPluginAuditEvent(input, this.#clock);
    try {
      await this.#sink.recordAuditEvent(event);
    } catch {
      throw new PluginHostError([
        {
          phase: 'audit',
          code: 'PLUGIN_AUDIT_WRITE_FAILED',
          pluginId: event.plugin.id,
          summary: 'Required plugin audit persistence failed; the operation is denied.',
        },
      ]);
    }
    return event;
  }
}
