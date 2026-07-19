import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../issue-tasks.js', () => ({
  createTaskIssue: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getClient: vi.fn(),
}));

import { createTaskIssue } from '../issue-tasks.js';
import { getClient } from '../client.js';
import {
  publishProfileSyncProposal,
  publishProfileSyncFailure,
  publishProfileSyncImprovement,
  bootstrapProfileSyncLabels,
} from '../profile-sync-issue-publisher.js';

const mockCreateTaskIssue = vi.mocked(createTaskIssue);
const mockGetClient = vi.mocked(getClient);

describe('profile sync issue publishers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('publishProfileSyncProposal', () => {
    it('creates a proposal issue with correct title and labels', async () => {
      mockCreateTaskIssue.mockResolvedValue({
        issueNumber: 42,
        url: 'https://github.com/test/42',
        nodeId: 'node_42',
      });

      const result = await publishProfileSyncProposal({
        schema: 'openslack.profile_sync_proposal.v1',
        sourceRepo: 'Negentropy-Laby/whitepapers',
        targetRepo: 'Negentropy-Laby/.github',
        targetPath: 'profile/README.md',
        marker: 'latest-insights',
        maxPosts: 5,
        requestedBy: 'test-user',
      });

      expect(result.issueNumber).toBe(42);
      expect(mockCreateTaskIssue).toHaveBeenCalledWith(
        '[Profile Sync] Latest insights from Negentropy-Laby/whitepapers',
        expect.stringContaining('Profile Sync Proposal'),
        expect.arrayContaining(['profile-sync:proposal']),
      );
    });
  });

  describe('publishProfileSyncFailure', () => {
    it('creates a failure issue with phase label', async () => {
      mockCreateTaskIssue.mockResolvedValue({
        issueNumber: 43,
        url: 'https://github.com/test/43',
        nodeId: 'node_43',
      });

      const result = await publishProfileSyncFailure({
        schema: 'openslack.profile_sync_failure.v1',
        sourceRepo: 'Negentropy-Laby/whitepapers',
        targetRepo: 'Negentropy-Laby/.github',
        error: 'Marker not found in target content',
        phase: 'patch',
        runId: 'run-abc',
      });

      expect(result.issueNumber).toBe(43);
      expect(mockCreateTaskIssue).toHaveBeenCalledWith(
        '[Profile Sync Failure] Marker not found in target content',
        expect.stringContaining('Profile Sync Failure'),
        expect.arrayContaining(['profile-sync:failure', 'phase:patch']),
      );
    });
  });

  describe('publishProfileSyncImprovement', () => {
    it('creates an improvement issue', async () => {
      mockCreateTaskIssue.mockResolvedValue({
        issueNumber: 44,
        url: 'https://github.com/test/44',
        nodeId: 'node_44',
      });

      const result = await publishProfileSyncImprovement({
        schema: 'openslack.profile_sync_improvement.v1',
        problem: 'Only one marker is supported.',
        proposedChange: 'Add support for multiple markers.',
        affectedPhase: 'render',
      });

      expect(result.issueNumber).toBe(44);
      expect(mockCreateTaskIssue).toHaveBeenCalledWith(
        '[Profile Sync Improvement] Add support for multiple markers.',
        expect.stringContaining('Profile Sync Improvement'),
        expect.arrayContaining(['profile-sync:improvement']),
      );
    });
  });

  describe('bootstrapProfileSyncLabels', () => {
    it('creates labels in normal mode', async () => {
      const mockOctokit = { issues: { createLabel: vi.fn().mockResolvedValue({}) } };
      mockGetClient.mockResolvedValue({
        owner: 'test',
        repo: 'repo',
        octokit: mockOctokit as unknown as import('../client.js').GitHubClient['octokit'],
        authMode: 'token',
        isDryRun: false,
      });

      const result = await bootstrapProfileSyncLabels();

      expect(result.created.length).toBeGreaterThan(0);
      expect(mockOctokit.issues.createLabel).toHaveBeenCalledTimes(9);
    });

    it('skips existing labels', async () => {
      const mockOctokit = {
        issues: {
          createLabel: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('Validation Failed'), { status: 422 })),
        },
      };
      mockGetClient.mockResolvedValue({
        owner: 'test',
        repo: 'repo',
        octokit: mockOctokit as unknown as import('../client.js').GitHubClient['octokit'],
        authMode: 'token',
        isDryRun: false,
      });

      const result = await bootstrapProfileSyncLabels();

      expect(result.created).toHaveLength(0);
      expect(result.existing.length).toBe(9);
    });

    it('works in dry-run mode', async () => {
      mockGetClient.mockResolvedValue({
        owner: 'test',
        repo: 'repo',
        octokit: {} as unknown as import('../client.js').GitHubClient['octokit'],
        authMode: 'dry_run',
        isDryRun: true,
      });

      const result = await bootstrapProfileSyncLabels();

      expect(result.created.length).toBe(9);
      expect(result.existing).toHaveLength(0);
    });
  });
});
