import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getClient: (...args: unknown[]) => hoisted.mockGetClient(...args),
}));

import {
  GitHubEvidenceUnavailableError,
  getCODEOWNERS,
  getPRChecks,
  getPRReviews,
  getRepositoryTree,
  listPRFiles,
  mergePR,
} from '../pr.js';

function serverError(message = 'server error') {
  const error = new Error(message) as Error & { status?: number };
  error.status = 500;
  return error;
}

function makeClient(octokit: Record<string, unknown>) {
  hoisted.mockGetClient.mockResolvedValue({
    owner: 'Negentropy-Laby',
    repo: 'OpenSlack',
    authMode: 'token',
    isDryRun: false,
    octokit,
  });
}

describe('strict PR live evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits a merge head constraint by default and sends one only when explicitly supplied', async () => {
    const merge = vi
      .fn()
      .mockResolvedValue({ data: { merged: true, sha: 'merged-sha', message: 'Merged' } });
    makeClient({ pulls: { merge } });

    await mergePR(352, { method: 'merge' });
    expect(merge).toHaveBeenNthCalledWith(1, {
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      pull_number: 352,
      merge_method: 'merge',
      commit_title: undefined,
      commit_message: undefined,
    });
    expect(merge.mock.calls[0]?.[0]).not.toHaveProperty('sha');

    await mergePR(352, { method: 'merge', expectedHeadSha: 'current-head' });
    expect(merge).toHaveBeenNthCalledWith(2, {
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      pull_number: 352,
      merge_method: 'merge',
      commit_title: undefined,
      commit_message: undefined,
      sha: 'current-head',
    });
  });

  it('uses GraphQL fallback when REST PR files, reviews, and checks fail', async () => {
    const graphql = vi.fn().mockImplementation((query: string) => {
      if (query.includes('OpenSlackPrFiles')) {
        return Promise.resolve({
          repository: {
            pullRequest: {
              files: {
                nodes: [{ path: '.github/workflows/openslack-tui-gate.yml' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      if (query.includes('OpenSlackPrReviews')) {
        return Promise.resolve({
          repository: {
            pullRequest: {
              reviews: {
                nodes: [
                  {
                    author: { login: 'wsman' },
                    state: 'APPROVED',
                    body: 'Approved',
                    submittedAt: '2026-06-01T14:32:04Z',
                    commit: { oid: '63029b4' },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      if (query.includes('OpenSlackPrDetail')) {
        return Promise.resolve({
          repository: {
            pullRequest: {
              number: 138,
              title: 'tui: complete productization closure repairs',
              body: '',
              state: 'OPEN',
              isDraft: false,
              headRefName: 'ux/productization-closure-p1-p2',
              headRefOid: '63029b4',
              baseRefName: 'main',
              baseRefOid: 'fac52ef',
              author: { login: 'openslack-agent-operator[bot]' },
              mergeable: 'MERGEABLE',
              merged: false,
              url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/138',
              createdAt: '2026-06-01T14:00:00Z',
              updatedAt: '2026-06-01T14:32:04Z',
            },
          },
        });
      }
      if (query.includes('OpenSlackPrChecks')) {
        return Promise.resolve({
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: 'validate / validate',
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS',
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        });
      }
      return Promise.reject(serverError('unexpected query'));
    });

    makeClient({
      pulls: {
        get: vi.fn().mockRejectedValue(serverError('pulls.get failed')),
        listFiles: vi.fn().mockRejectedValue(serverError('listFiles failed')),
        listReviews: vi.fn().mockRejectedValue(serverError('listReviews failed')),
      },
      checks: {
        listForRef: vi.fn().mockRejectedValue(serverError('checks failed')),
      },
      graphql,
    });

    await expect(listPRFiles(138, { strictEvidence: true })).resolves.toEqual([
      '.github/workflows/openslack-tui-gate.yml',
    ]);
    await expect(getPRReviews(138, { strictEvidence: true })).resolves.toEqual([
      {
        user: { login: 'wsman' },
        state: 'APPROVED',
        body: 'Approved',
        submittedAt: '2026-06-01T14:32:04Z',
        commitOid: '63029b4',
      },
    ]);
    await expect(getPRChecks(138, { strictEvidence: true })).resolves.toEqual([
      {
        name: 'validate / validate',
        status: 'completed',
        conclusion: 'success',
      },
    ]);
  });

  it('reads all REST pages before returning live evidence', async () => {
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          filename: `packages/a/file-${index}.ts`,
        })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            filename: 'packages/b/final.ts',
            previous_filename: 'packages/a/renamed.ts',
          },
        ],
      });
    const listReviews = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          user: { login: `reviewer-${index}` },
          state: 'COMMENTED',
          body: '',
          submitted_at: '2026-06-01T14:00:00Z',
        })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            user: { login: 'wsman' },
            state: 'APPROVED',
            body: 'approved',
            submitted_at: '2026-06-01T14:32:04Z',
            commit_id: '63029b4',
          },
        ],
      });
    const listForRef = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          check_runs: Array.from({ length: 100 }, (_, index) => ({
            name: `check-${index}`,
            status: 'completed',
            conclusion: 'success',
          })),
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [
            {
              name: 'validate / validate',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      });

    makeClient({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 138,
            title: 'tui: complete productization closure repairs',
            body: '',
            state: 'open',
            draft: false,
            head: { ref: 'ux/productization-closure-p1-p2', sha: '63029b4' },
            base: { ref: 'main', sha: 'fac52ef' },
            user: { login: 'openslack-agent-operator[bot]' },
            mergeable: true,
            mergeable_state: 'clean',
            merged: false,
            html_url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/138',
            created_at: '2026-06-01T14:00:00Z',
            updated_at: '2026-06-01T14:32:04Z',
          },
        }),
        listFiles,
        listReviews,
      },
      checks: {
        listForRef,
      },
      graphql: vi.fn(),
    });

    const files = await listPRFiles(138, { strictEvidence: true });
    expect(files).toHaveLength(102);
    expect(files).toEqual(expect.arrayContaining(['packages/b/final.ts', 'packages/a/renamed.ts']));
    const reviews = await getPRReviews(138, { strictEvidence: true });
    expect(reviews).toHaveLength(101);
    expect(reviews.at(-1)).toMatchObject({ commitOid: '63029b4' });
    await expect(getPRChecks(138, { strictEvidence: true })).resolves.toHaveLength(101);
    expect(listFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ per_page: 100, page: 1 }),
    );
    expect(listFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ per_page: 100, page: 2 }),
    );
    expect(listReviews).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ per_page: 100, page: 1 }),
    );
    expect(listReviews).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ per_page: 100, page: 2 }),
    );
    expect(listForRef).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ per_page: 100, page: 1 }),
    );
    expect(listForRef).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ per_page: 100, page: 2 }),
    );
  });

  it('throws instead of returning placeholder evidence when REST and GraphQL fail in strict mode', async () => {
    makeClient({
      pulls: {
        listFiles: vi.fn().mockRejectedValue(serverError('listFiles failed')),
      },
      graphql: vi.fn().mockRejectedValue(serverError('graphql failed')),
    });

    await expect(listPRFiles(138, { strictEvidence: true })).rejects.toBeInstanceOf(
      GitHubEvidenceUnavailableError,
    );
  });

  it('fails closed when REST page or file evidence limits are exceeded', async () => {
    const graphql = vi.fn();
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          filename: `packages/a/file-${index}.ts`,
        })),
      })
      .mockResolvedValueOnce({
        data: [{ filename: 'a.ts' }, { filename: 'b.ts' }, { filename: 'c.ts' }],
      });
    makeClient({ pulls: { listFiles }, graphql });

    await expect(
      listPRFiles(138, {
        strictEvidence: true,
        evidenceLimits: { maxPages: 1, maxFiles: 500 },
      }),
    ).rejects.toThrow(/GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED/);
    await expect(
      listPRFiles(138, {
        strictEvidence: true,
        evidenceLimits: { maxPages: 2, maxFiles: 2 },
      }),
    ).rejects.toThrow(/GITHUB_EVIDENCE_FILES_LIMIT_EXCEEDED/);
    expect(graphql).not.toHaveBeenCalled();
  });

  it('fails closed when REST review or check evidence limits are exceeded', async () => {
    makeClient({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 138,
            title: 'bounded evidence',
            body: '',
            state: 'open',
            draft: false,
            head: { ref: 'bounded', sha: '63029b4' },
            base: { ref: 'main', sha: 'fac52ef' },
            user: { login: 'bot' },
            mergeable: true,
            mergeable_state: 'clean',
            merged: false,
            html_url: 'https://example.test/pr/138',
            created_at: '2026-06-01T14:00:00Z',
            updated_at: '2026-06-01T14:32:04Z',
          },
        }),
        listReviews: vi.fn().mockResolvedValue({
          data: Array.from({ length: 3 }, (_, index) => ({
            user: { login: `reviewer-${index}` },
            state: 'COMMENTED',
          })),
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: Array.from({ length: 3 }, (_, index) => ({
              name: `check-${index}`,
              status: 'completed',
              conclusion: 'success',
            })),
          },
        }),
      },
      graphql: vi.fn(),
    });

    await expect(getPRReviews(138, { evidenceLimits: { maxReviews: 2 } })).rejects.toThrow(
      /GITHUB_EVIDENCE_REVIEWS_LIMIT_EXCEEDED/,
    );
    await expect(getPRChecks(138, { evidenceLimits: { maxChecks: 2 } })).rejects.toThrow(
      /GITHUB_EVIDENCE_CHECKS_LIMIT_EXCEEDED/,
    );
  });

  it('fails closed on REST CODEOWNERS byte and encoding boundaries without fallback', async () => {
    const graphql = vi.fn();
    const getContent = vi
      .fn()
      .mockResolvedValueOnce({ data: { content: Buffer.from('four').toString('base64') } })
      .mockResolvedValueOnce({ data: { content: Buffer.from([0xc3, 0x28]).toString('base64') } });
    makeClient({ repos: { getContent }, graphql });

    await expect(
      getCODEOWNERS('immutable-base-sha', {
        strictEvidence: true,
        evidenceLimits: { maxCodeownersBytes: 3 },
      }),
    ).rejects.toThrow('GITHUB_EVIDENCE_CODEOWNERS_BYTES_LIMIT_EXCEEDED');
    await expect(
      getCODEOWNERS('immutable-base-sha', {
        strictEvidence: true,
        evidenceLimits: { maxCodeownersBytes: 10 },
      }),
    ).rejects.toThrow('GITHUB_EVIDENCE_CODEOWNERS_INVALID');
    expect(graphql).not.toHaveBeenCalled();
  });

  it('applies the same CODEOWNERS byte boundary to GraphQL fallback', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: { object: { text: 'four' } },
    });
    makeClient({
      repos: { getContent: vi.fn().mockRejectedValue(serverError('REST unavailable')) },
      graphql,
    });

    await expect(
      getCODEOWNERS('immutable-base-sha', {
        strictEvidence: true,
        evidenceLimits: { maxCodeownersBytes: 3 },
      }),
    ).rejects.toThrow('GITHUB_EVIDENCE_CODEOWNERS_BYTES_LIMIT_EXCEEDED');
    expect(graphql).toHaveBeenCalledOnce();
  });

  it('enforces GraphQL pagination limits instead of returning partial evidence', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          files: {
            nodes: Array.from({ length: 100 }, (_, index) => ({
              path: `packages/a/file-${index}.ts`,
            })),
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          },
        },
      },
    });
    makeClient({
      pulls: { listFiles: vi.fn().mockRejectedValue(serverError('REST unavailable')) },
      graphql,
    });

    await expect(
      listPRFiles(138, {
        strictEvidence: true,
        evidenceLimits: { maxPages: 1, maxFiles: 500 },
      }),
    ).rejects.toThrow(/GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED/);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation to the active REST request', async () => {
    let requestSignal: AbortSignal | undefined;
    const listFiles = vi.fn().mockImplementation(
      (input: { request?: { signal?: AbortSignal } }) =>
        new Promise((_, reject) => {
          requestSignal = input.request?.signal;
          requestSignal?.addEventListener(
            'abort',
            () => {
              const error = new Error('request aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    makeClient({ pulls: { listFiles }, graphql: vi.fn() });
    const controller = new AbortController();
    const pending = listPRFiles(138, { strictEvidence: true, signal: controller.signal });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('propagates cancellation to the active GraphQL fallback request', async () => {
    let requestSignal: AbortSignal | undefined;
    const restError = Object.assign(new Error('REST unavailable'), { status: 400 });
    const graphql = vi.fn().mockImplementation(
      (_query: string, variables: { request?: { signal?: AbortSignal } }) =>
        new Promise((_, reject) => {
          requestSignal = variables.request?.signal;
          requestSignal?.addEventListener(
            'abort',
            () => {
              const error = new Error('request aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    makeClient({
      pulls: { listFiles: vi.fn().mockRejectedValue(restError) },
      graphql,
    });
    const controller = new AbortController();
    const pending = listPRFiles(138, { strictEvidence: true, signal: controller.signal });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('keeps non-strict legacy callers best-effort', async () => {
    makeClient({
      pulls: {
        listFiles: vi.fn().mockRejectedValue(serverError('listFiles failed')),
      },
      graphql: vi.fn().mockRejectedValue(serverError('graphql failed')),
    });

    await expect(listPRFiles(138)).resolves.toEqual([]);
  });

  it('returns complete Git tree identity evidence and rejects truncated evidence in every mode', async () => {
    const getTree = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          truncated: false,
          tree: [
            {
              path: 'templates/workflows/feature.yaml',
              mode: '100644',
              type: 'blob',
              sha: 'blob-sha',
            },
            { path: null, mode: '100644', type: 'blob', sha: 'ignored' },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { truncated: true, tree: [] } });
    makeClient({ git: { getTree } });

    await expect(getRepositoryTree('head', { strictEvidence: true })).resolves.toEqual([
      { path: 'templates/workflows/feature.yaml', mode: '100644', type: 'blob', sha: 'blob-sha' },
    ]);
    await expect(getRepositoryTree('truncated')).rejects.toBeInstanceOf(
      GitHubEvidenceUnavailableError,
    );
  });
});
