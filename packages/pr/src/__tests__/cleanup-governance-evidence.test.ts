import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeStrictJSON } from '@openslack/core';
import { validateCleanupBrokerRegistry } from '../internal/cleanup-broker-authorization.js';
import {
  CLEANUP_ADMIN_BINDINGS,
  CLEANUP_REGISTRY_SHA256,
  CLEANUP_RUNTIME_BINDING,
} from '../internal/cleanup-administration-contract.js';

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
const historicalRoot = join(
  root,
  'services/cleanup-broker/internal/permit/testdata/batch2-single-pr-20261018',
);
const snapshot = decodeStrictJSON(readFileSync(join(historicalRoot, 'snapshot.json')), 65_536) as {
  sourceCommit: string;
  contract: { file: string; sha256: string };
  registry: { file: string; sha256: string };
};
if (snapshot.sourceCommit !== '44deef2651b8964448f4f0ef603114f2524eb046')
  throw new Error('HISTORICAL_BINDING_PROVENANCE_CHANGED');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function historicalBytes(name: 'contract' | 'registry') {
  const ref = snapshot[name];
  if (ref.file !== (name === 'contract' ? 'administration-contract.json' : 'registry.yaml'))
    throw new Error('HISTORICAL_BINDING_REFERENCE_INVALID');
  const bytes = readFileSync(join(historicalRoot, ref.file));
  if (sha(bytes) !== ref.sha256) throw new Error('HISTORICAL_BINDING_BYTES_CHANGED');
  return bytes;
}
const historicalContract = decodeStrictJSON(historicalBytes('contract'), 65_536) as {
  registrySHA256: string;
  bindings: { repository: string };
};
const registry = historicalBytes('registry').toString('utf8');
const currentRegistry = readFileSync(
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

const currentExpected = {
  agentId: CLEANUP_RUNTIME_BINDING.agent_id,
  principalId: CLEANUP_RUNTIME_BINDING.principal_id,
  runtimeUid: CLEANUP_RUNTIME_BINDING.runtime_uid_claim,
  runId: CLEANUP_RUNTIME_BINDING.run_id,
  repository: CLEANUP_ADMIN_BINDINGS.repository,
};

describe('current and frozen historical qualification registry bindings', () => {
  it('validates both exact pairs and refuses transplanting their repository scopes', () => {
    expect(historicalContract.bindings.repository).toBe(grant.target.repository);
    expect(sha(registry)).toBe(historicalContract.registrySHA256);
    expect(sha(currentRegistry)).toBe(CLEANUP_REGISTRY_SHA256);
    expect(currentExpected.repository).toBe(
      'Negentropy-Laby/openslack-cleanup-qualification-public',
    );
    for (const [bytes, binding] of [
      [registry, expected],
      [currentRegistry, currentExpected],
    ] as const) {
      expect(validateCleanupBrokerRegistry(bytes, binding).action).toBe(
        'pr.cleanup_branch_scoped.v1',
      );
    }
    expect(() => validateCleanupBrokerRegistry(currentRegistry, expected)).toThrow(
      'CLEANUP_BROKER_REGISTRY_REJECTED',
    );
    expect(() => validateCleanupBrokerRegistry(registry, currentExpected)).toThrow(
      'CLEANUP_BROKER_REGISTRY_REJECTED',
    );
  });

  it.each([
    { principalId: 'principal:other' },
    { runtimeUid: 'other' },
    { repository: 'Negentropy-Laby/unauthorized' },
  ])('refuses a changed committed subject or repository: %j', (change) => {
    for (const [bytes, binding] of [
      [registry, expected],
      [currentRegistry, currentExpected],
    ] as const) {
      expect(() => validateCleanupBrokerRegistry(bytes, { ...binding, ...change })).toThrow(
        'CLEANUP_BROKER_REGISTRY_REJECTED',
      );
    }
  });
});
