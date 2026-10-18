import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeStrictJSON } from '@openslack/core';
import { validateCleanupBrokerRegistry } from '../internal/cleanup-broker-authorization.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const grant = decodeStrictJSON(
  readFileSync(
    join(root, '.openslack/policies/pr-cleanup-grants/permit-batch2-single-pr-20261018-r1.json'),
  ),
  65_536,
) as {
  subject: { principalId: string; runtimeUid: string; runId: string };
  target: { repository: string };
};
const registry = readFileSync(
  join(root, '.openslack/agents/registry/cleanup_qualification_pr418.yaml'),
  'utf8',
);
const expected = {
  agentId: 'cleanup_qualification_pr418',
  principalId: grant.subject.principalId,
  runtimeUid: grant.subject.runtimeUid,
  runId: grant.subject.runId,
  repository: grant.target.repository,
};

describe('committed qualification registry binding', () => {
  it('passes the production strict YAML/schema/action/repository validator', () => {
    expect(validateCleanupBrokerRegistry(registry, expected).action).toBe(
      'pr.cleanup_branch_scoped.v1',
    );
  });

  it.each([
    { principalId: 'principal:other' },
    { runtimeUid: 'other' },
    { repository: 'Negentropy-Laby/unauthorized' },
  ])('refuses a changed committed subject or repository: %j', (change) => {
    expect(() => validateCleanupBrokerRegistry(registry, { ...expected, ...change })).toThrow(
      'CLEANUP_BROKER_REGISTRY_REJECTED',
    );
  });
});
