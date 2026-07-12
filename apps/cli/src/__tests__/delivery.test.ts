import { describe, expect, it, vi } from 'vitest';
import { DeliveryError } from '@openslack/delivery';
import {
  deliveryCommands,
  renderDeliveryError,
  renderDeliveryResult,
} from '../commands/delivery.js';

const result = {
  state: 'AWAITING_GATES' as const,
  history: ['PREPARED', 'PUSHED', 'PR_CREATED', 'HEAD_SYNCHRONIZED', 'AWAITING_GATES'] as const,
  action: 'created' as const,
  prNumber: 42,
  prUrl: 'https://github.com/acme/project/pull/42',
  branchSha: 'a'.repeat(40),
  prHeadSha: 'a'.repeat(40),
  checks: [],
  checksStatus: 'empty' as const,
  permissions: [],
  evidenceTimestamp: '2026-07-11T00:00:00.000Z',
};

describe('delivery command', () => {
  it('renders awaiting-gates evidence without treating empty checks as success', () => {
    const output = renderDeliveryResult(result);
    expect(output).toContain('State: AWAITING_GATES');
    expect(output).toContain('Checks: empty (0)');
    expect(output).toContain('Next: openslack pr doctor 42');
  });

  it('renders only typed safe delivery errors', () => {
    expect(
      renderDeliveryError(
        new DeliveryError('DELIVERY_AUTH_REQUIRED', 'GitHub App token is unavailable.', true),
      ),
    ).toBe('DELIVERY_AUTH_REQUIRED: GitHub App token is unavailable.');
    expect(renderDeliveryError(new Error('request headers contained token-canary'))).toBe(
      'DELIVERY_FAILED: Governed GitHub delivery failed. See diagnostics for remediation.',
    );
  });

  it('publishes through the package-backed service', async () => {
    const publish = vi.fn(async () => result);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await deliveryCommands({ publish }).parseAsync(
        [
          'node',
          'openslack delivery',
          'publish',
          '--branch',
          'agent/topic',
          '--title',
          'runtime: deliver topic',
          '--body',
          'body',
          '--repo',
          'acme/project',
        ],
        { from: 'node' },
      );
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'acme',
          repo: 'project',
          branch: 'agent/topic',
          body: 'body',
        }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
