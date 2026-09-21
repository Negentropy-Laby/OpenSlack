import { createHash } from 'node:crypto';
import type { CleanupBrokerRequest } from '../cleanup-broker-client.js';

/**
 * Cross-language operation identity, not authorization. Input must first pass
 * the closed wire validator and OS-subject binding. Status locates the same
 * execution intent; mode is deliberately outside the digest.
 */
export function cleanupBrokerExecutionDigest(request: CleanupBrokerRequest): string {
  const fields = [
    request.agentId,
    request.principalId,
    request.runtimeUid,
    request.runId,
    request.repo,
    request.remote,
    String(request.prNumber),
    request.permitId,
    request.operationId,
  ];
  if (
    request.schema !== 'openslack.cleanup_request.v1' ||
    !['execute', 'status'].includes(request.mode) ||
    !Number.isSafeInteger(request.prNumber) ||
    request.prNumber <= 0 ||
    !fields.every(
      (field) => typeof field === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(field),
    )
  )
    throw new TypeError('CLEANUP_EXECUTION_DIGEST_INVALID');
  return createHash('sha256')
    .update(JSON.stringify(['openslack.cleanup_execution_digest.v1', ...fields]), 'utf8')
    .digest('hex');
}
