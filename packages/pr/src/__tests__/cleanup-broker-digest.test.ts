import { describe, expect, it } from 'vitest';
import type { CleanupBrokerRequest } from '../cleanup-broker-client.js';
import { cleanupBrokerExecutionDigest } from '../internal/cleanup-broker-digest.js';

const request: CleanupBrokerRequest = {
  schema: 'openslack.cleanup_request.v1',
  mode: 'execute',
  agentId: 'cleanup',
  principalId: 'agent:cleanup',
  runtimeUid: 'runtime-1',
  runId: 'run-1',
  repo: 'owner/repo',
  remote: 'qualification',
  prNumber: 42,
  permitId: 'permit-1',
  operationId: 'operation-1',
};

describe('Go/TypeScript fixed execution digest vectors', () => {
  it.each([
    [42, '04d357307c5087c2699a89571825a4219403f9763dfd53420dcc9302206c3337'],
    [9007199254740991, '0b9694e37d7fdd3eeeb1447040a549a8a7d4f1691d5fd760fa8069a500fd77c2'],
  ] as const)('matches fixed vector for PR %s in both modes', (prNumber, digest) => {
    expect(cleanupBrokerExecutionDigest({ ...request, prNumber })).toBe(digest);
    expect(cleanupBrokerExecutionDigest({ ...request, mode: 'status', prNumber })).toBe(digest);
  });
  it.each([
    'agentId',
    'principalId',
    'runtimeUid',
    'runId',
    'repo',
    'remote',
    'permitId',
    'operationId',
  ] as const)('binds %s', (key) => {
    expect(cleanupBrokerExecutionDigest({ ...request, [key]: `${request[key]}-changed` })).not.toBe(
      cleanupBrokerExecutionDigest(request),
    );
  });
  it.each([
    { mode: 'preview' as const },
    { operationId: undefined },
    { prNumber: 0 },
    { prNumber: 9007199254740992 },
    { runId: 'run<&>' },
    { runId: '\ud800' },
  ])('rejects non-execution or noncanonical input %j', (change) => {
    expect(() => cleanupBrokerExecutionDigest({ ...request, ...change })).toThrow(
      'CLEANUP_EXECUTION_DIGEST_INVALID',
    );
  });
});
