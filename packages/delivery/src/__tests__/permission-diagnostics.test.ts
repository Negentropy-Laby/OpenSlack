import { describe, expect, it } from 'vitest';
import { assertDeliveryPermissions, DeliveryError, diagnoseDeliveryPermissions } from '../index.js';

describe('delivery permission diagnostics', () => {
  it('requires only contents and pull requests for basic delivery', () => {
    const checks = diagnoseDeliveryPermissions({ contents: 'write', pull_requests: 'write' });
    expect(checks).toEqual([
      expect.objectContaining({ capability: 'contents', status: 'PASS' }),
      expect.objectContaining({ capability: 'pull_requests', status: 'PASS' }),
    ]);
    expect(() => assertDeliveryPermissions(checks)).not.toThrow();
  });

  it('requires issues write only for the full task loop and fails unknown permissions closed', () => {
    const checks = diagnoseDeliveryPermissions(
      { contents: 'write', pull_requests: 'write', issues: 'read' },
      true,
    );
    expect(checks.at(-1)).toMatchObject({ capability: 'issues', actual: 'read', status: 'FAIL' });
    expect(() => assertDeliveryPermissions(checks)).toThrow(DeliveryError);
    expect(() =>
      assertDeliveryPermissions(diagnoseDeliveryPermissions({ contents: 'write' })),
    ).toThrow(/pull_requests:write/);
  });
});
