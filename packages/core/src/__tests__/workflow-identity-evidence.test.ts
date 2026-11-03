import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  WORKFLOW_IDENTITY,
  WORKFLOW_IDENTITY_DOMAINS,
  WORKFLOW_IDENTITY_PROVENANCES,
  isWorkflowIdentityDigest,
  isWorkflowIdentityDomain,
  isWorkflowIdentityProvenance,
  isExecutableWorkflowIdentityDomain,
} from '../index.js';
import type {
  WorkflowIdentityDomain,
  WorkflowIdentityEvidence,
  WorkflowIdentityProvenance,
} from '../index.js';

describe('shared workflow diagnostic identity contract', () => {
  it('owns the closed diagnostic domain vocabulary', () => {
    expectTypeOf<WorkflowIdentityDomain>().toEqualTypeOf<
      | 'raw-sha256'
      | 'openslack.workflow-runner.workflow-source.v2'
      | 'function-source-sha256'
      | 'unknown'
    >();
  });

  it('owns the closed provenance vocabulary', () => {
    expectTypeOf<WorkflowIdentityProvenance>().toEqualTypeOf<'recorded' | 'inferred' | 'unknown'>();
  });

  it('exports read-only evidence without an execution capability', () => {
    expectTypeOf<WorkflowIdentityEvidence>().toEqualTypeOf<{
      readonly digest: string;
      readonly domain: WorkflowIdentityDomain;
      readonly provenance: WorkflowIdentityProvenance;
    }>();
  });

  it('exports one frozen runtime vocabulary matching the diagnostic types', () => {
    expect(Object.isFrozen(WORKFLOW_IDENTITY)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_IDENTITY_DOMAINS)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_IDENTITY_PROVENANCES)).toBe(true);
    expect(WORKFLOW_IDENTITY_DOMAINS).toEqual([
      'raw-sha256',
      'openslack.workflow-runner.workflow-source.v2',
      'function-source-sha256',
      'unknown',
    ]);
    expect(WORKFLOW_IDENTITY_PROVENANCES).toEqual(['recorded', 'inferred', 'unknown']);
    expectTypeOf<
      (typeof WORKFLOW_IDENTITY_DOMAINS)[number]
    >().toEqualTypeOf<WorkflowIdentityDomain>();
    expectTypeOf<
      (typeof WORKFLOW_IDENTITY_PROVENANCES)[number]
    >().toEqualTypeOf<WorkflowIdentityProvenance>();
  });

  it.each(['raw-sha256', 'openslack.workflow-runner.workflow-source.v2'])(
    'recognizes %s without accepting diagnostic-only domains for execution',
    (domain) => {
      expect(isWorkflowIdentityDomain(domain)).toBe(true);
      expect(isExecutableWorkflowIdentityDomain(domain)).toBe(true);
    },
  );

  it.each(['function-source-sha256', 'unknown'])(
    'does not grant executable identity to %s',
    (domain) => {
      expect(isWorkflowIdentityDomain(domain)).toBe(true);
      expect(isExecutableWorkflowIdentityDomain(domain)).toBe(false);
    },
  );

  it.each([null, undefined, 1, {}, 'runner-v2-manifest', 'RAW-SHA256'])(
    'rejects an unrecognized domain %j',
    (domain) => {
      expect(isWorkflowIdentityDomain(domain)).toBe(false);
      expect(isExecutableWorkflowIdentityDomain(domain)).toBe(false);
    },
  );

  it('uses full lowercase digests and the closed provenance set', () => {
    expect(isWorkflowIdentityDigest('a'.repeat(64))).toBe(true);
    for (const value of [
      undefined,
      null,
      1,
      'A'.repeat(64),
      'a'.repeat(63),
      `sha256:${'a'.repeat(64)}`,
    ])
      expect(isWorkflowIdentityDigest(value)).toBe(false);
    for (const value of WORKFLOW_IDENTITY_PROVENANCES)
      expect(isWorkflowIdentityProvenance(value)).toBe(true);
    for (const value of ['verified', 'recorded ', null, 1])
      expect(isWorkflowIdentityProvenance(value)).toBe(false);
  });
});
