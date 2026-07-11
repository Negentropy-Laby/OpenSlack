import { DeliveryError } from './errors.js';
import type { DeliveryPermissionCheck } from './types.js';

export function diagnoseDeliveryPermissions(
  permissions: Readonly<Record<string, string>>,
  requireIssuesWrite = false,
): DeliveryPermissionCheck[] {
  const required: DeliveryPermissionCheck['capability'][] = ['contents', 'pull_requests'];
  if (requireIssuesWrite) required.push('issues');
  return required.map((capability) => {
    const actual = permissions[capability] ?? null;
    return {
      capability,
      required: 'write',
      actual,
      status: actual === 'write' ? 'PASS' : actual === null ? 'WARN' : 'FAIL',
    };
  });
}

export function assertDeliveryPermissions(checks: DeliveryPermissionCheck[]): void {
  const failures = checks.filter((check) => check.status !== 'PASS');
  if (failures.length === 0) return;
  throw new DeliveryError(
    'DELIVERY_PERMISSION_DENIED',
    `GitHub App installation lacks required delivery permissions: ${failures
      .map((check) => `${check.capability}:write`)
      .join(', ')}.`,
    false,
  );
}
