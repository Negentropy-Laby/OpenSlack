import { describe, expect, it, vi } from 'vitest';
import type { PluginAuditEvent } from '@openslack/plugin-api';
import { HostAuditWriter, buildPluginAuditEvent } from '../audit.js';
import { PluginHostError } from '../findings.js';

const baseInput = {
  type: 'plugin.activation.allowed' as const,
  plugin: { id: 'reader', version: '1.0.0' },
  providerKind: 'workspace' as const,
};

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as PluginHostError).findings[0]?.code;
  }
  return undefined;
}

describe('buildPluginAuditEvent', () => {
  it('generates the summary and occurrence time inside the host', () => {
    const event = buildPluginAuditEvent(
      {
        ...baseInput,
        evidenceRefs: ['review:123'],
        facts: [
          { key: 'decisionCode', value: 'PLUGIN_ACTIVATION_ALLOWED' },
          { key: 'capabilityCount', value: 2 },
          { key: 'integrityMatched', value: true },
        ],
      },
      () => '2026-07-16T00:00:00.000Z',
    );
    expect(event).toEqual({
      schema: 'openslack.plugin_audit_event.v1',
      type: 'plugin.activation.allowed',
      plugin: { id: 'reader', version: '1.0.0' },
      providerKind: 'workspace',
      occurredAt: '2026-07-16T00:00:00.000Z',
      summary: 'Plugin activation allowed.',
      evidenceRefs: ['review:123'],
      metadata: {
        decisionCode: 'PLUGIN_ACTIVATION_ALLOWED',
        capabilityCount: 2,
        integrityMatched: true,
      },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.plugin)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
  });

  it('redacts secret-shaped scalar facts and evidence references', () => {
    const event = buildPluginAuditEvent({
      ...baseInput,
      evidenceRefs: ['Bearer should-never-persist'],
      facts: [{ key: 'reasonCode', value: 'token=super-secret-value' }],
    });
    expect(event.evidenceRefs).toEqual(['[REDACTED]']);
    expect(event.metadata?.reasonCode).toBe('[REDACTED]');
  });

  it('rejects unknown keys, duplicate keys, objects, non-finite numbers, and oversized facts', () => {
    expect(
      code(() =>
        buildPluginAuditEvent({
          ...baseInput,
          facts: [{ key: 'rawPayload' as 'outcome', value: 'unsafe' }],
        }),
      ),
    ).toBe('PLUGIN_AUDIT_FACT_INVALID');
    expect(
      code(() =>
        buildPluginAuditEvent({
          ...baseInput,
          facts: [
            { key: 'outcome', value: 'allow' },
            { key: 'outcome', value: 'allow-again' },
          ],
        }),
      ),
    ).toBe('PLUGIN_AUDIT_FACT_INVALID');
    expect(
      code(() =>
        buildPluginAuditEvent({
          ...baseInput,
          facts: [{ key: 'capabilityCount', value: Number.NaN }],
        }),
      ),
    ).toBe('PLUGIN_AUDIT_FACT_INVALID');
    expect(
      code(() =>
        buildPluginAuditEvent({
          ...baseInput,
          facts: [{ key: 'outcome', value: { nested: true } as unknown as string }],
        }),
      ),
    ).toBe('PLUGIN_AUDIT_FACT_INVALID');
    expect(
      code(() =>
        buildPluginAuditEvent({
          ...baseInput,
          facts: [{ key: 'reasonCode', value: 'x'.repeat(257) }],
        }),
      ),
    ).toBe('PLUGIN_AUDIT_FACT_INVALID');
  });

  it('does not invoke getters hidden inside audit facts or plugin identity', () => {
    let accessed = false;
    const fact = {} as { key: 'outcome'; value: string };
    Object.defineProperty(fact, 'key', {
      enumerable: true,
      get() {
        accessed = true;
        return 'outcome';
      },
    });
    expect(code(() => buildPluginAuditEvent({ ...baseInput, facts: [fact] }))).toBe(
      'PLUGIN_AUDIT_FACT_INVALID',
    );
    expect(accessed).toBe(false);
  });
});

describe('HostAuditWriter', () => {
  it('records the exact frozen event and returns it', async () => {
    const received: PluginAuditEvent[] = [];
    const writer = new HostAuditWriter(
      { recordAuditEvent: (event) => void received.push(event) },
      () => '2026-07-16T00:00:00.000Z',
    );
    const event = await writer.recordRequired(baseInput);
    expect(received).toEqual([event]);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it('fails closed on an allow-path sink failure and hides the sink error', async () => {
    const sink = vi.fn(() => {
      throw new Error('database password=do-not-leak');
    });
    const writer = new HostAuditWriter({ recordAuditEvent: sink });
    try {
      await writer.recordRequired(baseInput);
      throw new Error('expected audit failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginHostError);
      expect((error as PluginHostError).findings[0]?.code).toBe('PLUGIN_AUDIT_WRITE_FAILED');
      expect((error as Error).message).not.toContain('password');
      expect((error as Error).message).not.toContain('database');
    }
  });
});
