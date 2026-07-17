import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  diagnoseGitHubAppInstallation,
  GitHubAppInstallationDiagnosticError,
  type GitHubAppInstallationSource,
} from '../app-installation-diagnostics.js';

const OWNER = 'acme';
const REPO = 'project';
const MANAGEMENT_URL = 'https://github.com/organizations/acme/settings/installations/456';

function installation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 456,
    app_id: 123,
    app_slug: 'openslack-agent-operator',
    permissions: {
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      workflows: 'write',
      checks: 'read',
    },
    events: ['issues', 'pull_request', 'pull_request_review', 'push', 'check_run', 'check_suite'],
    repository_selection: 'selected',
    html_url: MANAGEMENT_URL,
    suspended_at: null,
    ...overrides,
  };
}

function source(value: unknown = installation()): GitHubAppInstallationSource {
  return {
    configuredAppId: '123',
    configuredInstallationId: '456',
    value,
  };
}

function repositoryAccess(accessible = true) {
  return {
    owner: OWNER,
    repo: REPO,
    accessible,
    complete: true,
    totalAccessibleRepositories: 3,
    pagesScanned: 1,
  };
}

describe('GitHub App installation diagnostics', () => {
  it('reports the exact expected/actual contract when the installation is ready', async () => {
    const report = await diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () => source(),
        inspectRepositoryAccess: async () => repositoryAccess(),
      },
    );

    expect(report).toMatchObject({
      schema: 'openslack.github_app_installation_diagnostic.v1',
      ready: true,
      code: 'APP_INSTALLATION_READY',
      codes: ['APP_INSTALLATION_READY'],
      appId: '123',
      installationId: '456',
      permissions: { missing: [] },
      events: { missing: [] },
      repository: {
        fullName: 'acme/project',
        selection: 'selected',
        accessible: true,
      },
      managementUrl: MANAGEMENT_URL,
      administratorAction: null,
    });
    expect(report.permissions.expected).toMatchObject({ checks: 'read' });
    expect(report.events.expected).toContain('pull_request_review');
    expect(report.events.expected).toContain('check_run');
    expect(report.events.expected).toContain('check_suite');
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('reports permission reauthorization and missing event subscriptions together', async () => {
    const report = await diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () =>
          source(
            installation({
              permissions: {
                metadata: 'read',
                contents: 'write',
                issues: 'write',
                pull_requests: 'write',
                workflows: 'write',
              },
              events: ['issues', 'pull_request', 'push'],
            }),
          ),
        inspectRepositoryAccess: async () => repositoryAccess(),
      },
    );

    expect(report.ready).toBe(false);
    expect(report.codes).toEqual([
      'APP_REAUTHORIZATION_REQUIRED',
      'APP_EVENT_SUBSCRIPTION_MISSING',
    ]);
    expect(report.permissions.missing).toEqual([
      { name: 'checks', expected: 'read', actual: null },
    ]);
    expect(report.events.missing).toEqual(['pull_request_review', 'check_run', 'check_suite']);
    expect(report.administratorAction).toContain(MANAGEMENT_URL);
    expect(report.administratorAction).toContain(
      'have the GitHub App owner request the missing permissions (checks:read)',
    );
    expect(report.administratorAction).toContain(
      'have the installation owner accept the pending update',
    );
    expect(report.administratorAction).toContain('enable the missing webhook subscriptions');
    expect(report.administratorAction).toContain('OpenSlack will not change the installation');
  });

  it('reports selected-repository scope without treating App metadata as repository proof', async () => {
    const report = await diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () => source(),
        inspectRepositoryAccess: async () => repositoryAccess(false),
      },
    );

    expect(report.codes).toEqual(['APP_REPOSITORY_SCOPE_MISSING']);
    expect(report.repository).toMatchObject({
      selection: 'selected',
      accessible: false,
      complete: true,
    });
  });

  it('accepts a stronger actual permission and treats a suspended installation as not ready', async () => {
    const stronger = await diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () =>
          source(
            installation({
              permissions: {
                metadata: 'read',
                contents: 'write',
                issues: 'write',
                pull_requests: 'write',
                workflows: 'write',
                checks: 'write',
              },
            }),
          ),
        inspectRepositoryAccess: async () => repositoryAccess(),
      },
    );
    expect(stronger.code).toBe('APP_INSTALLATION_READY');

    const suspended = await diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () =>
          source(installation({ suspended_at: '2026-07-17T00:00:00Z' })),
        inspectRepositoryAccess: async () => repositoryAccess(),
      },
    );
    expect(suspended.suspended).toBe(true);
    expect(suspended.codes).toEqual(['APP_REAUTHORIZATION_REQUIRED']);
    expect(suspended.administratorAction).toContain('resume the suspended installation');
  });

  it.each([
    ['mismatched installation', source({ ...installation(), id: 999 })],
    ['invalid management URL', source(installation({ html_url: 'https://evil.example/admin' }))],
    [
      'management URL with query data',
      source(installation({ html_url: `${MANAGEMENT_URL}?token=credential-canary` })),
    ],
    ['invalid permission value', source(installation({ permissions: { checks: 'owner' } }))],
    ['duplicate event', source(installation({ events: ['issues', 'issues'] }))],
    ['invalid suspension timestamp', source(installation({ suspended_at: 'not-a-date' }))],
  ])('rejects %s with a fixed response code', async (_name, invalidSource) => {
    const result = diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () => invalidSource,
        inspectRepositoryAccess: async () => repositoryAccess(),
      },
    );
    await expect(result).rejects.toMatchObject({
      code: 'APP_INSTALLATION_RESPONSE_INVALID',
    });
  });

  it('uses an App JWT for installation metadata and never exposes it in the report', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(installation()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const report = await diagnoseGitHubAppInstallation(
      {
        owner: OWNER,
        repo: REPO,
        env: {
          OPENSLACK_GITHUB_APP_ID: '123',
          OPENSLACK_GITHUB_APP_INSTALLATION_ID: '456',
          OPENSLACK_GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        },
      },
      {
        fetchImpl,
        inspectRepositoryAccess: async () => repositoryAccess(),
      },
    );

    const request = fetchImpl.mock.calls[0]!;
    expect(request[0]).toBe('https://api.github.com/app/installations/456');
    const headers = (request[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_.-]+$/);
    expect(headers.Authorization).not.toContain(privateKeyPem);
    expect(JSON.stringify(report)).not.toContain(headers.Authorization);
  });

  it('maps transport and repository-access errors to fixed secret-free diagnostics', async () => {
    const requestFailure = diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () => {
          throw new Error('request failed with secret-canary');
        },
        inspectRepositoryAccess: async () => repositoryAccess(),
      },
    );
    await expect(requestFailure).rejects.toEqual(
      new GitHubAppInstallationDiagnosticError(
        'APP_INSTALLATION_REQUEST_FAILED',
        'GitHub App installation diagnostic request failed safely.',
      ),
    );

    const accessFailure = diagnoseGitHubAppInstallation(
      { owner: OWNER, repo: REPO },
      {
        loadInstallation: async () => source(),
        inspectRepositoryAccess: async () => {
          throw new Error('access failed with secret-canary');
        },
      },
    );
    const error = await accessFailure.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'APP_REPOSITORY_ACCESS_CHECK_FAILED' });
    expect(JSON.stringify(error)).not.toContain('secret-canary');
  });
});
