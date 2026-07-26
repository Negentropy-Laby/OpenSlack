import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const governedSources = [
  '../governed-plan.ts',
  '../governed-plan-store.ts',
  '../action-execution-registry.ts',
  '../governed-plan-service.ts',
] as const;

describe('governed plan source invariants', () => {
  it('does not import or call legacy CLI and workflow execution paths', () => {
    for (const source of governedSources) {
      const text = readFileSync(new URL(source, import.meta.url), 'utf8');
      for (const forbidden of [
        "from './executor",
        'executePlan',
        'runCLIStep',
        'executeWorkflowTemplate',
        'allowUnattended',
        'node:child_process',
        'spawn(',
        '@openslack/workflows',
      ]) {
        expect(text, `${source} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
