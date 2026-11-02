import { describe, expectTypeOf, it } from 'vitest';
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
});
