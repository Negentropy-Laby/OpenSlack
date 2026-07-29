import { describe, expect, it } from 'vitest';
import {
  createContractToDeliveryDemoSource,
  validateContractToDeliverySourceSnapshot,
} from '../index.js';

describe('checked Contract-to-Delivery demo source', () => {
  it('binds one Scenario scope and visibly marks every source as demo fixture evidence', () => {
    const source = createContractToDeliveryDemoSource({
      scenarioInstanceId: 'scenario:sha256:demo',
      cursor: 'rehearsal:sha256:cursor',
      generatedAt: '2026-07-29T00:00:00.000Z',
    });

    expect(source.scenarioInstanceId).toBe('scenario:sha256:demo');
    expect(source.softwareDelivery.scenarioInstanceId).toBe('scenario:sha256:demo');
    expect(source.cursor).toBe('rehearsal:sha256:cursor');
    expect(source.softwareDelivery.cursor).toBe('rehearsal:sha256:cursor');
    for (const batch of [
      ...Object.values(source.softwareDelivery.sources),
      ...Object.values(source.business),
    ]) {
      if (batch.status === 'missing') continue;
      expect(batch.batchVersion).toContain('demo-fixture');
      expect(batch.warningCodes).toContain('demo_fixture_recorded_evidence');
      for (const item of batch.items) {
        expect(
          item.sourceEventIds.every((value: string) => value.startsWith('fixture-event:')),
        ).toBe(true);
        expect(item.evidenceRefs.every((value: string) => value.startsWith('fixture:'))).toBe(true);
      }
    }
    expect(validateContractToDeliverySourceSnapshot(source)).toEqual(source);
  });

  it('is deterministic, does not mutate its checked template, and rejects unsafe scope input', () => {
    const input = {
      scenarioInstanceId: 'scenario:sha256:demo',
      cursor: 'rehearsal:sha256:cursor',
      generatedAt: '2026-07-29T00:00:00.000Z',
    };
    expect(createContractToDeliveryDemoSource(input)).toEqual(
      createContractToDeliveryDemoSource(input),
    );
    expect(() =>
      createContractToDeliveryDemoSource({
        ...input,
        scenarioInstanceId: '../escape',
      }),
    ).toThrow('bounded runtime identifier');
    expect(() =>
      createContractToDeliveryDemoSource({
        ...input,
        generatedAt: '2026-07-29',
      }),
    ).toThrow('canonical RFC3339');
  });
});
