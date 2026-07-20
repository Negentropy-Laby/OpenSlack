import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class MockGitHubAuthRequiredError extends Error {
    readonly code = 'AUTH_REQUIRED';

    constructor(message: string) {
      super(message);
      this.name = 'GitHubAuthRequiredError';
    }
  }
  class MockGitHubEvidenceUnavailableError extends Error {
    readonly code = 'GITHUB_EVIDENCE_UNAVAILABLE';
    readonly operation: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber?: number;
    readonly status?: number;
    readonly causeMessage: string;

    constructor(input: {
      operation: string;
      owner: string;
      repo: string;
      prNumber?: number;
      status?: number;
      causeMessage: string;
    }) {
      super(
        `GITHUB_EVIDENCE_UNAVAILABLE: ${input.operation} failed for ${input.owner}/${input.repo}. ${input.causeMessage}`,
      );
      this.name = 'GitHubEvidenceUnavailableError';
      this.operation = input.operation;
      this.owner = input.owner;
      this.repo = input.repo;
      this.prNumber = input.prNumber;
      this.status = input.status;
      this.causeMessage = input.causeMessage;
    }
  }
  class MockPRCodeownerEvidenceUnavailableError extends Error {
    readonly code = 'PR_CODEOWNER_EVIDENCE_UNAVAILABLE';
    readonly operation = 'load immutable PR CODEOWNERS';
    readonly prNumber?: number;

    constructor(message: string, prNumber?: number) {
      super(`PR_CODEOWNER_EVIDENCE_UNAVAILABLE: ${message}`);
      this.name = 'PRCodeownerEvidenceUnavailableError';
      this.prNumber = prNumber;
    }
  }

  return {
    mockGetClient: vi.fn(),
    mockFetchPRDetails: vi.fn(),
    mockGetCODEOWNERS: vi.fn(),
    mockLoadPRCodeownerEvidence: vi.fn(),
    mockCommentOnPR: vi.fn(),
    mockPublishWorkflowGovernance: vi.fn(),
    mockFindWorkflowGovernanceIssue: vi.fn(),
    mockUpdatePRBody: vi.fn(),
    mockBuildRepositoryPRProjection: vi.fn(),
    mockRenderRepositoryPRProjection: vi.fn(),
    MockGitHubAuthRequiredError,
    MockGitHubEvidenceUnavailableError,
    MockPRCodeownerEvidenceUnavailableError,
  };
});

vi.mock('@openslack/github', () => ({
  getClient: (...args: unknown[]) => hoisted.mockGetClient(...args),
  getCODEOWNERS: (...args: unknown[]) => hoisted.mockGetCODEOWNERS(...args),
  commentOnPR: (...args: unknown[]) => hoisted.mockCommentOnPR(...args),
  publishWorkflowGovernance: (...args: unknown[]) => hoisted.mockPublishWorkflowGovernance(...args),
  findWorkflowGovernanceIssue: (...args: unknown[]) =>
    hoisted.mockFindWorkflowGovernanceIssue(...args),
  updatePRBody: (...args: unknown[]) => hoisted.mockUpdatePRBody(...args),
  canonicalizeRepositoryName: (owner: string, repo: string) => ({
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    canonicalFullName: `${owner}/${repo}`.toLowerCase(),
  }),
  loadGitHubWatchConfig: vi.fn(),
  parseGitHubRepoSpec: (value: string) => {
    const [owner, repo] = value.split('/');
    return owner && repo ? { owner, repo } : null;
  },
  GitHubAuthRequiredError: hoisted.MockGitHubAuthRequiredError,
  GitHubEvidenceUnavailableError: hoisted.MockGitHubEvidenceUnavailableError,
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
  loadPRCodeownerEvidence: (...args: unknown[]) => hoisted.mockLoadPRCodeownerEvidence(...args),
  PRCodeownerEvidenceUnavailableError: hoisted.MockPRCodeownerEvidenceUnavailableError,
  parseCODEOWNERS: () => [],
  resolveCodeowners: () => [],
  postReviewComment: vi.fn(),
  watchPR: vi.fn(),
  buildPRQueue: vi.fn(),
  buildRepositoryPRProjection: (...args: unknown[]) =>
    hoisted.mockBuildRepositoryPRProjection(...args),
  renderPRQueue: vi.fn(),
  renderRepositoryPRProjection: (...args: unknown[]) =>
    hoisted.mockRenderRepositoryPRProjection(...args),
  summarizePRDecision: () => ({ evidence: ['Checks: pass'] }),
  isCoreWorkflowArtifactPath: (path: string) => path.includes('/builtins/'),
  computeLocalWorkflowEvidence: vi.fn(),
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
    baseSha: 'base-sha',
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
    hoisted.mockLoadPRCodeownerEvidence.mockResolvedValue({
      ref: 'base-sha',
      owners: [],
      entries: [],
    });
  });

  it('fails closed when live GitHub credentials are missing', async () => {
    hoisted.mockGetClient.mockRejectedValue(
      new hoisted.MockGitHubAuthRequiredError('AUTH_REQUIRED: missing credential'),
    );
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
      strictEvidence: true,
    });
    expect(hoisted.mockFetchPRDetails).toHaveBeenCalledWith(42, {
      repoFullName: 'Negentropy-Laby/OpenSlack',
      auth: 'token',
      requireLive: true,
      strictEvidence: true,
    });
    expect(hoisted.mockLoadPRCodeownerEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: 'base-sha' }),
      {
        repoFullName: 'Negentropy-Laby/OpenSlack',
        auth: 'token',
        requireLive: true,
        strictEvidence: true,
      },
    );
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

  it('fails closed when live GitHub evidence is unavailable', async () => {
    hoisted.mockGetClient.mockResolvedValue({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      authMode: 'github_app_installation',
      isDryRun: false,
      octokit: {},
    });
    hoisted.mockFetchPRDetails.mockRejectedValue(
      new hoisted.MockGitHubEvidenceUnavailableError({
        operation: 'fetch pull request reviews',
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        prNumber: 42,
        status: 500,
        causeMessage: 'server error',
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPrCommand(['doctor', '42', '--auth', 'app']);

    const out = errorSpy.mock.calls.flat().join('\n');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('GITHUB_EVIDENCE_UNAVAILABLE');
    expect(out).toContain('GitHub evidence: LIVE');
    expect(out).toContain('Operation: fetch pull request reviews');
    expect(out).not.toContain('NEEDS_HUMAN_APPROVAL');
    expect(hoisted.mockLoadPRCodeownerEvidence).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('renders missing immutable CODEOWNERS evidence without an unhandled exception', async () => {
    hoisted.mockGetClient.mockResolvedValue({
      owner: 'third-party',
      repo: 'project',
      authMode: 'github_app_installation',
      isDryRun: false,
      octokit: {},
    });
    hoisted.mockFetchPRDetails.mockResolvedValue(makeReport());
    hoisted.mockLoadPRCodeownerEvidence.mockRejectedValue(
      new hoisted.MockPRCodeownerEvidenceUnavailableError(
        'CODEOWNERS could not be loaded from base-sha.',
        42,
      ),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runPrCommand(['doctor', '42', '--auth', 'app'])).resolves.toBeUndefined();

    const out = errorSpy.mock.calls.flat().join('\n');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('PR_CODEOWNER_EVIDENCE_UNAVAILABLE');
    expect(out).toContain('GitHub evidence: LIVE');
    expect(out).toContain('Operation: load immutable PR CODEOWNERS');
    expect(out).toContain('PR: #42');
    expect(out).not.toContain('READY_TO_MERGE');
    errorSpy.mockRestore();
  });
});

describe('pr workflow-governance command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('requires bot authentication before creating governance state', async () => {
    hoisted.mockGetClient.mockResolvedValue({ authMode: 'token', isDryRun: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPrCommand(['workflow-governance', '42']);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('BOT_AUTH_REQUIRED');
    expect(hoisted.mockPublishWorkflowGovernance).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('creates and links one issue for a new artifact', async () => {
    hoisted.mockGetClient.mockResolvedValue({
      authMode: 'github_app_installation',
      isDryRun: false,
    });
    hoisted.mockFetchPRDetails.mockResolvedValue(
      makeReport({
        body: 'Summary',
        workflowEvidence: {
          schema: 'openslack.workflow-evidence.v1',
          baseSha: 'base',
          headSha: 'head',
          evidenceHash: 'sha256:evidence',
          artifactFiles: ['templates/workflows/new.yaml'],
          addedFiles: ['templates/workflows/new.yaml'],
          modifiedFiles: [],
          deletedFiles: [],
          changeKind: 'added',
        },
      }),
    );
    hoisted.mockPublishWorkflowGovernance.mockResolvedValue({ issueNumber: 177, url: 'issue-url' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runPrCommand(['workflow-governance', '42']);

    expect(hoisted.mockFetchPRDetails).toHaveBeenCalledWith(42, {
      requireLive: true,
      strictEvidence: true,
    });
    expect(hoisted.mockPublishWorkflowGovernance).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        evidenceHash: 'sha256:evidence',
      }),
    );
    expect(hoisted.mockUpdatePRBody).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Workflow governance #177'),
    );
    logSpy.mockRestore();
  });
});
