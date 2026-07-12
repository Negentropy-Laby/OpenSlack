import { describe, expect, it } from 'vitest';
import { advanceDeliveryState, DeliveryError } from '../index.js';

describe('delivery state machine', () => {
  it('accepts only the governed publication sequence', () => {
    const history = ['PREPARED'] as const;
    const pushed = advanceDeliveryState(history, 'PUSHED');
    const created = advanceDeliveryState(pushed, 'PR_CREATED');
    const synchronized = advanceDeliveryState(created, 'HEAD_SYNCHRONIZED');
    expect(advanceDeliveryState(synchronized, 'AWAITING_GATES')).toEqual([
      'PREPARED',
      'PUSHED',
      'PR_CREATED',
      'HEAD_SYNCHRONIZED',
      'AWAITING_GATES',
    ]);
  });

  it('rejects skipped, repeated, and backward transitions', () => {
    expect(() => advanceDeliveryState(['PREPARED'], 'PR_CREATED')).toThrow(DeliveryError);
    expect(() => advanceDeliveryState(['PREPARED', 'PUSHED'], 'PUSHED')).toThrow(DeliveryError);
    expect(() => advanceDeliveryState(['PREPARED', 'PUSHED', 'PR_UPDATED'], 'PUSHED')).toThrow(
      DeliveryError,
    );
  });
});
