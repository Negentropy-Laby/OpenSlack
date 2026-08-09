import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  getIssue: vi.fn(),
  searchIssues: vi.fn(),
}));

import { getIssueTaskByNumber, queryReadyIssueTasks } from '../issue-tasks.js';

const getClient = (options?: { requireLive?: boolean }) => mocks.getClient(options);

function issue(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    node_id: 'ISSUE_NODE_42',
    title: 'Targeted task',
    html_url: 'https://github.com/example/repo/issues/42',
    labels: ['openslack:task', { name: 'openslack:ready' }],
    body: 'task body',
    state: 'open',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClient.mockResolvedValue({
    isDryRun: false,
    owner: 'example',
    repo: 'repo',
    octokit: {
      issues: { get: mocks.getIssue },
      search: { issuesAndPullRequests: mocks.searchIssues },
    },
  });
});

describe('getIssueTaskByNumber', () => {
  it('returns one exact open issue task', async () => {
    mocks.getIssue.mockResolvedValue({ data: issue() });

    await expect(getIssueTaskByNumber(42, getClient)).resolves.toEqual({
      status: 'found',
      task: {
        issueNumber: 42,
        issueNodeId: 'ISSUE_NODE_42',
        title: 'Targeted task',
        url: 'https://github.com/example/repo/issues/42',
        labels: ['openslack:task', 'openslack:ready'],
        body: 'task body',
        state: 'open',
      },
    });
    expect(mocks.getIssue).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      issue_number: 42,
    });
    expect(mocks.getClient).toHaveBeenCalledWith({ requireLive: true });
  });

  it('preserves a closed issue state for the runtime gate', async () => {
    mocks.getIssue.mockResolvedValue({ data: issue({ state: 'closed' }) });

    const result = await getIssueTaskByNumber(42, getClient);
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.state).toBe('closed');
  });

  it('maps an unknown API state to an explicit fail-closed value', async () => {
    mocks.getIssue.mockResolvedValue({ data: issue({ state: 'queued' }) });
    const result = await getIssueTaskByNumber(42, getClient);
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.state).toBe('unknown');
  });

  it('distinguishes pull requests from issues', async () => {
    mocks.getIssue.mockResolvedValue({ data: issue({ pull_request: { url: 'pr-api' } }) });
    await expect(getIssueTaskByNumber(42, getClient)).resolves.toEqual({
      status: 'pull_request',
    });
  });

  it('maps only a 404 to not_found', async () => {
    mocks.getIssue.mockRejectedValue({ status: 404 });
    await expect(getIssueTaskByNumber(42, getClient)).resolves.toEqual({
      status: 'not_found',
    });

    mocks.getIssue.mockRejectedValueOnce({ status: 403, message: 'forbidden' });
    await expect(getIssueTaskByNumber(42, getClient)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects invalid numbers before creating a client', async () => {
    await expect(getIssueTaskByNumber(0, getClient)).rejects.toThrow('positive integer');
    expect(mocks.getClient).not.toHaveBeenCalled();
  });

  it('does not disguise a dry-run client as a missing issue', async () => {
    mocks.getClient.mockResolvedValue({ isDryRun: true });
    await expect(getIssueTaskByNumber(42, getClient)).rejects.toThrow('Live GitHub credentials');
    expect(mocks.getIssue).not.toHaveBeenCalled();
  });
});

describe('queryReadyIssueTasks', () => {
  it('maps search results with an explicit state', async () => {
    mocks.searchIssues.mockResolvedValue({ data: { items: [issue()] } });

    const result = await queryReadyIssueTasks({}, getClient);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ issueNumber: 42, state: 'open' });
  });

  it('does not coerce an unknown search state to open', async () => {
    mocks.searchIssues.mockResolvedValue({ data: { items: [issue({ state: 'queued' })] } });
    const result = await queryReadyIssueTasks({}, getClient);
    expect(result[0]).toMatchObject({ issueNumber: 42, state: 'unknown' });
  });
});
