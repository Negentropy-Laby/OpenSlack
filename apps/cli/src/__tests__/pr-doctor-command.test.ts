import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class MockGitHubAuthRequiredError extends Error {
    readonly code = 'AUTH_REQUIRED';

    constructor(message: string) {
      super(message);
      this.name = 'GitHubAuthRequiredError';
    }
  }

  return {
    mockGetClient: vi.fn(),
    mockFetchPRDetails: vi.fn(),
    mockGetCODEOWNERS: vi.fn(),
    mockCommentOnPR: vi.fn(),
    MockGitHubAuthRequiredError,
  };
});

vi.mock('@openslack/github', () => ({
  getClient: (...args: unknown[]) => hoisted.mockGetClient(...args),
  getCODEOWNERS: (...args: unknown[]) => hoisted.mockGetCODEOWNERS(...args),
  commentOnPR: (...args: unknown[]) => hoisted.mockCommentOnPR(...args),
  GitHubAuthRequiredError: hoisted.MockGitHubAuthRequiredError,
}));

vi.mock('@openslack/pr', () => ({
  fetchPRDetails: (...args: unknown[]) => hoisted.mockFetchPRDetails(...args),
  classifyPRReport: (report: unknown) => report,
  checkMergeReadiness: vi.fn(),
  generateReviewReport: vi.fn(),
  generateDoctorReport: () => 'DOCTOR_REPORT',
  loadPRReviewPolicy: () => ({
    no_auto_approval: true,
    no_self_review: true,
    red_zone_human_required: true,
    black_zone_never_merge: true,
  }),
  diagnosePR: (report: unknown) => report,
  parseCODEOWNERS: () => [],
  resolveCodeowners: () => [],
  postReviewComment: vi.fn(),
  watchPR: vi.fn(),
  buildPRQueue: vi.fn(),
  renderPRQueue: vi.fn(),
  summarizePRDecision: () => ({ evidence: ['Checks: pass'] }),
}));

vi.mock('@openslack/collaboration', () => ({
  recordEvent: vi.fn(),
}));

import { prCommands } from '../commands/pr.js';

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    prNumber: 42,
    title: 'Test PR',
    author: 'app/openslack-agent-operator',
    state: 'open',
    draft: false,
    baseRef: 'main',
    headRef: 'feature',
    riskZone: 'green',
    changedFiles: ['docs/example.md'],
    filePatches: [],
    checks: [{ name: 'validate', status: 'completed', conclusion: 'success' }],
    reviews: [{ user: 'wsman', state: 'APPROVED' }],
    humanApprovals: [{ user: 'wsman' }],
    decision: 'READY_TO_MERGE',
    reason: 'All gates pass',
    recommendation: 'Merge',
    mergeable: true,
    body: '',
    ...overrides,
  };
}

async function runPrCommand(args: string[]) {
  const cmd = prCommands();
  await cmd.parseAsync(args, { from: 'user' });
}

describe('pr doctor command live evidence gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('fails closed when live GitHub credentials are missing', async () => {
    hoisted.mockGetClient.mockRejectedValue(new hoisted.MockGitHubAuthRequiredError('AUTH_REQUIRED: missing credential'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPrCommand(['doctor', '42']);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('AUTH_REQUIRED');
    expect(hoisted.mockFetchPRDetails).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('keeps dry-run explicit and does not fetch PR details', async () => {
    hoisted.mockGetClient.mockResolvedValue({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      authMode: 'dry_run',
      isDryRun: true,
      octokit: {},
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runPrCommand(['doctor', '42', '--dry-run']);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('GitHub evidence: DRY-RUN');
    expect(out).toContain('Decision: NOT_EVALUATED');
    expect(out).not.toContain('READY_TO_MERGE');
    expect(out).not.toContain('BLOCKED_POLICY');
    expect(hoisted.mockFetchPRDetails).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('passes repo and auth options into live PR fetches', async () => {
    hoisted.mockGetClient.mockResolvedValue({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      authMode: 'token',
      isDryRun: false,
      octokit: {},
    });
    hoisted.mockFetchPRDetails.mockResolvedValue(makeReport());
    hoisted.mockGetCODEOWNERS.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runPrCommand(['doctor', '42', '--repo', 'Negentropy-Laby/OpenSlack', '--auth', 'token']);

    expect(hoisted.mockGetClient).toHaveBeenCalledWith({
      repoFullName: 'Negentropy-Laby/OpenSlack',
      auth: 'token',
      requireLive: true,
    });
    expect(hoisted.mockFetchPRDetails).toHaveBeenCalledWith(42, {
      repoFullName: 'Negentropy-Laby/OpenSlack',
      auth: 'token',
      requireLive: true,
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('GitHub evidence: LIVE');
    logSpy.mockRestore();
  });

  it('rejects comment posting without bot app authentication', async () => {
    hoisted.mockGetClient.mockResolvedValue({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      authMode: 'token',
      isDryRun: false,
      octokit: {},
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPrCommand(['doctor', '42', '--comment', '--auth', 'token']);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('BOT_AUTH_REQUIRED');
    expect(hoisted.mockCommentOnPR).not.toHaveBeenCalled();
    expect(hoisted.mockFetchPRDetails).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
