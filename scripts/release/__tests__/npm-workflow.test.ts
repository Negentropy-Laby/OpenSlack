import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'npm-stage-publish.yml',
  ),
  'utf8',
);

describe('npm staged publishing workflow', () => {
  it('uses a protected GitHub-hosted OIDC boundary', () => {
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:/mu);
    expect(workflow).not.toMatch(/^  (?:pull_request|push):/mu);
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('environment: npm-production');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('node-version: 22.14.0');
    expect(workflow).toContain('npm@11.15.0');
    expect(workflow).toContain('test "$(npm --version)" = "11.15.0"');
    expect(workflow).toContain('persist-credentials: false');
    const actions = [...workflow.matchAll(/^\s*-\s+uses:\s+(\S+)$/gmu)].map(
      (match) => match[1],
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => /@[a-f0-9]{40}$/u.test(action ?? ''))).toBe(true);
  });

  it('limits the token bootstrap and makes later delivery stage-only', () => {
    expect(workflow).toContain("inputs.mode == 'bootstrap-0.2.0'");
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}');
    expect(workflow).toContain('test "$REQUESTED_VERSION" = "0.2.0"');
    expect(workflow).toContain("inputs.mode == 'stage'");
    expect(workflow).toContain('npm stage publish');
    expect(workflow).not.toContain('npm stage approve');
  });

  it('submits only the four explicit public packages', () => {
    expect(workflow).toContain('for package in plugin-api plugin-host sdk plugin-testkit');
    expect(workflow).not.toContain('NPM_TOKEN');
  });
});
