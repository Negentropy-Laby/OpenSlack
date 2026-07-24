import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('PR Base Policy workflow', () => {
  it('checks every pull request without checkout or repository permissions', () => {
    const source = readFileSync(
      new URL('../../../../.github/workflows/openslack-pr-base-policy.yml', import.meta.url),
      'utf8',
    );
    const workflow = parse(source) as {
      on: { pull_request: Record<string, unknown> | null };
      permissions: Record<string, unknown>;
      jobs: {
        'canonical-base': {
          name: string;
          'timeout-minutes': number;
          steps: Array<{ uses?: string; run?: string }>;
        };
      };
    };

    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    expect(workflow.on.pull_request ?? {}).not.toHaveProperty('branches');
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['canonical-base']);
    expect(workflow.jobs['canonical-base']).toMatchObject({
      name: 'canonical-base',
      'timeout-minutes': 1,
    });
    expect(workflow.jobs['canonical-base'].steps.every((step) => !step.uses)).toBe(true);
    expect(source).not.toContain('actions/checkout');
    expect(source).toContain('github.base_ref');
    expect(source).toContain('gh pr edit $PR_NUMBER --base main');
  });
});
