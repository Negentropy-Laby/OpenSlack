import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitHubAppInstallationDiagnosticError,
  type GitHubAppInstallationDiagnosticReport,
} from '@openslack/github';
import { describe, expect, it, vi } from 'vitest';

import { githubCommands } from '../commands/github.js';
import {
  formatGitHubAppInstallationDiagnosticFailure,
  renderGitHubAppInstallationDiagnostic,
} from '../commands/github-app-diagnostic.js';

function report(ready: boolean): GitHubAppInstallationDiagnosticReport {
  return {
    schema: 'openslack.github_app_installation_diagnostic.v1',
    ready,
    code: ready ? 'APP_INSTALLATION_READY' : 'APP_REAUTHORIZATION_REQUIRED',
    codes: ready
      ? ['APP_INSTALLATION_READY']
      : ['APP_REAUTHORIZATION_REQUIRED', 'APP_EVENT_SUBSCRIPTION_MISSING'],
    appId: '123',
    installationId: '456',
    appSlug: 'openslack-agent-operator',
    suspended: false,
    permissions: {
      expected: { checks: 'read', metadata: 'read' },
      actual: ready ? { checks: 'read', metadata: 'read' } : { metadata: 'read' },
      missing: ready ? [] : [{ name: 'checks', expected: 'read', actual: null }],
    },
    events: {
      expected: ['issues', 'check_run'],
      actual: ready ? ['issues', 'check_run'] : ['issues'],
      missing: ready ? [] : ['check_run'],
    },
    repository: {
      fullName: 'acme/project',
      selection: 'selected',
      accessible: true,
      complete: true,
      totalAccessibleRepositories: 1,
      pagesScanned: 1,
    },
    managementUrl: 'https://github.com/organizations/acme/settings/installations/456',
    administratorAction: ready
      ? null
      : 'An installation owner must accept the update. OpenSlack will not change the installation.',
  };
}

describe('GitHub App installation diagnostic CLI', () => {
  it('renders deterministic expected, actual, missing, management, and status lines', () => {
    const output = renderGitHubAppInstallationDiagnostic(report(false));

    expect(output).toContain('[FAIL] APP_REAUTHORIZATION_REQUIRED');
    expect(output).toContain('[FAIL] APP_EVENT_SUBSCRIPTION_MISSING');
    expect(output).toContain('Permissions expected: checks:read, metadata:read');
    expect(output).toContain('Permissions actual: metadata:read');
    expect(output).toContain('Permissions missing: checks:read (actual:none)');
    expect(output).toContain('Events missing: check_run');
    expect(output).toContain('Repository missing: none');
    expect(output).toContain('Installation management: https://github.com/');
    expect(output).toContain('OpenSlack will not change the installation');

    for (const code of [
      'APP_INSTALLATION_CONFIG_INVALID',
      'APP_INSTALLATION_REQUEST_FAILED',
      'APP_INSTALLATION_RESPONSE_INVALID',
      'APP_REPOSITORY_ACCESS_CHECK_FAILED',
    ] as const) {
      const fixedFailure = formatGitHubAppInstallationDiagnosticFailure(
        new GitHubAppInstallationDiagnosticError(code, 'response included secret-canary'),
      );
      expect(fixedFailure).toContain(code);
      expect(fixedFailure).not.toContain('secret-canary');
    }
    expect(formatGitHubAppInstallationDiagnosticFailure(new Error('secret-canary'))).toBe(
      'APP_INSTALLATION_DIAGNOSTIC_FAILED — App JWT installation inspection failed safely',
    );
  });

  it('makes github doctor consume the package diagnostic without mutating the installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-github-app-doctor-'));
    const previous = process.cwd();
    const diagnose = vi.fn(async () => report(true));
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/project.git'], {
        cwd: root,
        stdio: 'ignore',
      });
      writeFileSync(
        join(root, 'openslack.yaml'),
        [
          'schema: openslack.workspace.v1',
          'workspace:',
          '  state_root: .openslack',
          'mode: normal',
          'canonical_remote:',
          '  provider: github',
          '  owner: acme',
          '  repo: project',
          '',
        ].join('\n'),
      );
      mkdirSync(join(root, '.openslack', 'integrations'), { recursive: true });
      writeFileSync(
        join(root, '.openslack', 'integrations', 'github.yaml'),
        'schema: openslack.github.v1\nproject:\n  node_id: ""\n',
      );
      mkdirSync(join(root, '.github'), { recursive: true });
      writeFileSync(join(root, '.github', 'CODEOWNERS'), '* @owner\n');
      process.chdir(root);

      await githubCommands({
        getDoctorClient: vi.fn(async () => ({
          owner: 'acme',
          repo: 'project',
          authMode: 'github_app_installation',
          isDryRun: false,
          tokenExpiresAt: '2026-07-17T05:00:00Z',
        })) as never,
        diagnoseAppInstallation: diagnose,
      }).parseAsync(['node', 'openslack', 'doctor'], { from: 'node' });

      const output = logs.join('\n');
      expect(diagnose).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'acme', repo: 'project' }),
      );
      expect(output).toContain('[PASS] GitHub App installation: APP_INSTALLATION_READY');
      expect(output).toContain('Permissions expected: checks:read, metadata:read');
      expect(output).toContain('Events actual: issues, check_run');
      expect(output).toContain('Repository actual: selection=selected, accessible=yes');

      await expect(
        githubCommands({
          getDoctorClient: vi.fn(async () => ({
            owner: 'acme',
            repo: 'project',
            authMode: 'github_app_installation',
            isDryRun: false,
            tokenExpiresAt: '2026-07-17T05:00:00Z',
          })) as never,
          diagnoseAppInstallation: vi.fn(async () => {
            throw new GitHubAppInstallationDiagnosticError(
              'APP_INSTALLATION_RESPONSE_INVALID',
              'response included secret-canary',
            );
          }),
        }).parseAsync(['node', 'openslack', 'doctor'], { from: 'node' }),
      ).rejects.toThrow('process.exit unexpectedly called with "1"');

      const failureOutput = logs.join('\n');
      expect(failureOutput).toContain(
        '[FAIL] GitHub App installation: APP_INSTALLATION_RESPONSE_INVALID',
      );
      expect(failureOutput).not.toContain('secret-canary');
    } finally {
      process.chdir(previous);
      process.exitCode = undefined;
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
