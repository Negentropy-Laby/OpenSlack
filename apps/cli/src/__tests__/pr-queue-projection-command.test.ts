import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  buildPRQueue: vi.fn(),
  renderPRQueue: vi.fn((_value: unknown) => 'LEGACY_QUEUE'),
  buildRepositoryPRProjection: vi.fn(),
  renderRepositoryPRProjection: vi.fn((_value: unknown) => 'REPOSITORY_PROJECTION'),
  loadGitHubWatchConfig: vi.fn(),
}));

vi.mock('@openslack/runtime', () => ({
  renderFindingsPlain: vi.fn(),
}));

vi.mock('@openslack/github', () => ({
  commentOnPR: vi.fn(),
  getClient: vi.fn(),
  GitHubAuthRequiredError: class extends Error {},
  GitHubEvidenceUnavailableError: class extends Error {},
  canonicalizeRepositoryName: (owner: string, repo: string) =>
    /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repo)
      ? {
          owner,
          repo,
          fullName: `${owner}/${repo}`,
          canonicalFullName: `${owner}/${repo}`.toLocaleLowerCase('en-US'),
        }
      : null,
  loadGitHubWatchConfig: (...args: unknown[]) => hoisted.loadGitHubWatchConfig(...args),
  parseGitHubRepoSpec: (value: string) => {
    const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
    return match ? { owner: match[1], repo: match[2] } : null;
  },
  publishWorkflowGovernance: vi.fn(),
  findWorkflowGovernanceIssue: vi.fn(),
  updatePRBody: vi.fn(),
}));

vi.mock('@openslack/pr', () => ({
  fetchPRDetails: vi.fn(),
  classifyPRReport: vi.fn(),
  checkMergeReadiness: vi.fn(),
  generateReviewReport: vi.fn(),
  generateDoctorReport: vi.fn(),
  loadPRReviewPolicy: vi.fn(),
  diagnosePR: vi.fn(),
  loadPRCodeownerEvidence: vi.fn(),
  PRCodeownerEvidenceUnavailableError: class extends Error {},
  postReviewComment: vi.fn(),
  watchPR: vi.fn(),
  buildPRQueue: (...args: unknown[]) => hoisted.buildPRQueue(...args),
  buildRepositoryPRProjection: (...args: unknown[]) =>
    hoisted.buildRepositoryPRProjection(...args),
  renderPRQueue: (value: unknown) => hoisted.renderPRQueue(value),
  renderRepositoryPRProjection: (value: unknown) =>
    hoisted.renderRepositoryPRProjection(value),
  isCoreWorkflowArtifactPath: vi.fn(),
  computeLocalWorkflowEvidence: vi.fn(),
}));

vi.mock('@openslack/collaboration', () => ({
  recordEvent: vi.fn(),
}));

import { prCommands } from '../commands/pr.js';

async function runQueue(args: string[]): Promise<void> {
  await prCommands().parseAsync(['queue', ...args], { from: 'user' });
}

function projection(partial = false) {
  return {
    schema: 'openslack.repository_pr_projection.v1',
    fetchedAt: '2026-07-17T02:00:00.000Z',
    repositories: [],
    items: [],
    changes: [],
    partial,
    budget: { limit: 100, used: 0, remaining: 100, exhausted: false },
    authority: {
      humanApproval: 'not_evaluated',
      mergeReadiness: 'not_evaluated',
    },
    informational: true,
  };
}

describe('pr queue repository projection command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    hoisted.buildPRQueue.mockResolvedValue([]);
    hoisted.buildRepositoryPRProjection.mockResolvedValue(projection());
  });

  it('preserves the legacy PRMS queue when no repository selector is provided', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runQueue(['--limit', '8']);

    expect(hoisted.buildPRQueue).toHaveBeenCalledWith(8);
    expect(hoisted.buildRepositoryPRProjection).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('LEGACY_QUEUE');
    log.mockRestore();
  });

  it('accepts repeated repositories and passes bounded projection options', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runQueue([
      '--repo',
      'Acme/One',
      '--repo',
      'Acme/Two',
      '--limit',
      '12',
      '--concurrency',
      '3',
      '--api-budget',
      '40',
      '--cache-ttl',
      '90',
    ]);

    expect(hoisted.buildPRQueue).not.toHaveBeenCalled();
    expect(hoisted.buildRepositoryPRProjection).toHaveBeenCalledWith({
      repositories: [
        { owner: 'Acme', repo: 'One' },
        { owner: 'Acme', repo: 'Two' },
      ],
      workspaceRoot: process.cwd(),
      limit: 12,
      concurrency: 3,
      apiBudget: 40,
      cacheTtlSeconds: 90,
    });
    expect(log).toHaveBeenCalledWith('REPOSITORY_PROJECTION');
    log.mockRestore();
  });

  it('resolves --all exclusively from the configured GitHub Watch repositories', async () => {
    hoisted.loadGitHubWatchConfig.mockReturnValue({
      valid: true,
      config: {
        schema: 'openslack.github_watch.v1',
        repositories: [
          { owner: 'Acme', repo: 'One', events: ['pull_request.opened'] },
          { owner: 'Acme', repo: 'Two', events: ['check_run.completed'] },
        ],
      },
      errors: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runQueue(['--all', '--config', 'watch.yaml']);

    expect(hoisted.loadGitHubWatchConfig).toHaveBeenCalledWith('watch.yaml');
    expect(hoisted.buildRepositoryPRProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          { owner: 'Acme', repo: 'One' },
          { owner: 'Acme', repo: 'Two' },
        ],
      }),
    );
    log.mockRestore();
  });

  it('rejects --repo with --all before reading config or GitHub state', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runQueue(['--repo', 'Acme/One', '--all']);

    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('mutually exclusive');
    expect(hoisted.loadGitHubWatchConfig).not.toHaveBeenCalled();
    expect(hoisted.buildRepositoryPRProjection).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('fails closed on invalid watch config and numeric options', async () => {
    hoisted.loadGitHubWatchConfig.mockReturnValue({
      valid: false,
      errors: ['repositories missing'],
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runQueue(['--all']);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('repositories missing');

    process.exitCode = undefined;
    await runQueue(['--repo', 'Acme/One', '--api-budget', '-1']);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('--api-budget');
    expect(hoisted.buildRepositoryPRProjection).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('returns exit code 2 for bounded partial output while still rendering it', async () => {
    hoisted.buildRepositoryPRProjection.mockResolvedValue(projection(true));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runQueue(['--repo', 'Acme/One']);

    expect(process.exitCode).toBe(2);
    expect(log).toHaveBeenCalledWith('REPOSITORY_PROJECTION');
    log.mockRestore();
  });
});
