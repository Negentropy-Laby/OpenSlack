import { describe, expect, it } from 'vitest';

import {
  buildPRDoctorClientOptions,
  normalizePRDoctorAuth,
  renderDoctorDryRunReport,
} from '../commands/pr-doctor-evidence.js';

describe('pr doctor live evidence helpers', () => {
  it('defaults to live auto auth', () => {
    expect(buildPRDoctorClientOptions({ repo: 'Negentropy-Laby/OpenSlack' })).toEqual({
      repoFullName: 'Negentropy-Laby/OpenSlack',
      auth: 'auto',
      requireLive: true,
    });
  });

  it('treats --dry-run as explicit dry-run evidence mode', () => {
    expect(normalizePRDoctorAuth({ auth: 'token', dryRun: true })).toBe('dry-run');
    expect(buildPRDoctorClientOptions({ dryRun: true })).toMatchObject({
      auth: 'dry-run',
      requireLive: false,
    });
  });

  it('rejects invalid auth modes before diagnosis starts', () => {
    expect(() => normalizePRDoctorAuth({ auth: 'human-oauth' })).toThrow('Invalid --auth');
  });

  it('renders dry-run as not evaluated rather than a governance decision', () => {
    const out = renderDoctorDryRunReport(42, {
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      authMode: 'dry_run',
      isDryRun: true,
      octokit: {} as never,
    });

    expect(out).toContain('GitHub evidence: DRY-RUN');
    expect(out).toContain('Repo: Negentropy-Laby/OpenSlack');
    expect(out).toContain('Decision: NOT_EVALUATED');
    expect(out).not.toContain('READY_TO_MERGE');
    expect(out).not.toContain('BLOCKED_POLICY');
  });
});
