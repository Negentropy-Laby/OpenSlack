import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mocks ──────────────────────────────────────────────────────────

vi.mock('../profile-sync.js', () => ({
  readRepoDirectory: vi.fn(),
  readRepoFile: vi.fn(),
  parseFrontmatter: vi.fn(),
  validatePost: vi.fn(),
  sortPostsByDate: vi.fn((posts: Array<{ date: string }>) =>
    [...posts].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
  ),
  renderLatestInsightsSection: vi.fn(
    (posts: unknown[], sourceRepo: string) =>
      `Rendered ${(posts as Array<{ title: string }>).length} posts from ${sourceRepo}`,
  ),
  patchMarkerSection: vi.fn(),
  createBranch: vi.fn(),
  commitFileToBranch: vi.fn(),
  createProfileSyncPR: vi.fn(),
  MarkerNotFoundError: class MarkerNotFoundError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'MarkerNotFoundError'
    }
  },
}))

vi.mock('../pr.js', () => ({
  listOpenPRs: vi.fn(),
}))

vi.mock('../profile-sync-issue-publisher.js', () => ({
  publishProfileSyncFailure: vi.fn(),
}))

import {
  readRepoDirectory,
  readRepoFile,
  parseFrontmatter,
  validatePost,
  patchMarkerSection,
  createBranch,
  commitFileToBranch,
  createProfileSyncPR,
} from '../profile-sync.js'
import { listOpenPRs } from '../pr.js'
import { publishProfileSyncFailure } from '../profile-sync-issue-publisher.js'
import { runProfileSync } from '../profile-sync-run.js'
import type { ProfileSyncConfig } from '../profile-sync-config.js'

const mockReadRepoDirectory = readRepoDirectory as ReturnType<typeof vi.fn>
const mockReadRepoFile = readRepoFile as ReturnType<typeof vi.fn>
const mockParseFrontmatter = parseFrontmatter as ReturnType<typeof vi.fn>
const mockValidatePost = validatePost as ReturnType<typeof vi.fn>
const mockPatchMarkerSection = patchMarkerSection as ReturnType<typeof vi.fn>
const mockCreateBranch = createBranch as ReturnType<typeof vi.fn>
const mockCommitFileToBranch = commitFileToBranch as ReturnType<typeof vi.fn>
const mockCreateProfileSyncPR = createProfileSyncPR as ReturnType<typeof vi.fn>
const mockListOpenPRs = listOpenPRs as ReturnType<typeof vi.fn>
const mockPublishProfileSyncFailure = publishProfileSyncFailure as ReturnType<typeof vi.fn>

// ── Test fixtures ───────────────────────────────────────────────────────────────

const baseConfig: ProfileSyncConfig = {
  schema: 'openslack.profile_sync.v1',
  source: { repo: 'org/whitepapers', branch: 'main', path: 'posts' },
  target: { repo: 'org/.github', branch: 'main', path: 'profile/README.md', marker: 'latest-insights' },
  mode: 'auto-pr',
  max_posts: 5,
  pr: { draft: true, labels: ['profile:sync'] },
  failure_issue: { enabled: false },
  on_existing_pr: 'skip',
}

const markerContent =
  '# Profile\n\n<!-- openslack:latest-insights:start -->\nOld content\n<!-- openslack:latest-insights:end -->\n'

/**
 * Seeds all mocks for a standard happy-path with the given number of published posts.
 */
function seedHappyPathMocks(postCount: number): void {
  const files = Array.from({ length: postCount }, (_, i) => ({
    name: `post-${i + 1}.md`,
    path: `posts/post-${i + 1}.md`,
    type: 'file',
    sha: `sha-${i}`,
  }))

  mockReadRepoDirectory.mockResolvedValue(files)

  mockReadRepoFile.mockImplementation(
    async (_owner: string, _repo: string, path: string) => {
      const match = path.match(/^posts\/post-(\d+)\.md$/)
      if (match) {
        const idx = parseInt(match[1], 10)
        return {
          content:
            `---\ntitle: Post ${idx}\ndate: 2026-05-${String(30 - idx).padStart(2, '0')}\nsummary: Summary ${idx}\ntags: [tech]\nstatus: published\n---`,
          sha: `sha-${idx}`,
        }
      }
      if (path === 'profile/README.md') {
        return { content: markerContent, sha: 'target-sha' }
      }
      return null
    },
  )

  mockParseFrontmatter.mockImplementation((content: string) => {
    const titleMatch = content.match(/title: (.+)/)
    const dateMatch = content.match(/date: (.+)/)
    return {
      title: titleMatch?.[1] ?? 'Untitled',
      date: dateMatch?.[1] ?? '2026-01-01',
      summary: 'A summary',
      tags: ['tech'],
      status: 'published',
    }
  })

  mockValidatePost.mockReturnValue({ valid: true, errors: [] })

  mockPatchMarkerSection.mockReturnValue(
    '<!-- openslack:latest-insights:start -->\nRendered content\n<!-- openslack:latest-insights:end -->',
  )

  mockCreateBranch.mockResolvedValue({ sha: 'branch-sha' })
  mockCommitFileToBranch.mockResolvedValue({ commitSha: 'commit-sha' })
  mockCreateProfileSyncPR.mockResolvedValue({
    url: 'https://github.com/org/.github/pull/99',
    number: 99,
  })
  mockListOpenPRs.mockResolvedValue([])
  mockPublishProfileSyncFailure.mockResolvedValue({
    issueNumber: 0,
    url: '',
  })
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('runProfileSync smoke tests (auto-pr)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Auto-pr creates correct branch name ─────────────────────────────────────

  describe('branch naming', () => {
    it('creates branch with pattern openslack/profile-sync/{marker}-{date}-{sha}-{runId}', async () => {
      seedHappyPathMocks(2)

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'workflow-run-42abc',
        sourceSha: 'abcdef1234567890',
      })

      expect(result.status).toBe('completed')
      expect(result.branchName).toBeDefined()

      // Branch name must follow the naming convention
      const branch = result.branchName!
      expect(branch).toMatch(/^openslack\/profile-sync\/latest-insights-/)
      // Contains date (YYYYMMDD)
      expect(branch).toMatch(/\d{8}/)
      // Contains first 7 chars of source sha
      expect(branch).toContain('abcdef1')
      // Contains last 6 chars of runId
      expect(branch).toContain('42abc')

      // createBranch was called with the same branch name
      expect(mockCreateBranch).toHaveBeenCalledWith(
        'org',
        '.github',
        branch,
        'main',
      )
    })
  })

  // ── Auto-pr creates PR with correct metadata ────────────────────────────────

  describe('PR creation', () => {
    it('creates PR targeting the correct base branch with correct title', async () => {
      seedHappyPathMocks(3)

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'run-001',
        sourceSha: 'sha111122223333',
      })

      expect(result.status).toBe('completed')
      expect(result.prNumber).toBe(99)
      expect(result.prUrl).toBe('https://github.com/org/.github/pull/99')

      // Verify PR was created with correct args
      expect(mockCreateProfileSyncPR).toHaveBeenCalledWith(
        'org',
        '.github',
        expect.any(String), // branch name
        'profile: sync latest latest-insights',
        expect.stringContaining('openslack-profile-sync-metadata'), // PR body contains metadata block
        'main', // base branch
      )
    })

    it('PR body contains metadata block with source and target info', async () => {
      seedHappyPathMocks(2)

      await runProfileSync({
        config: baseConfig,
        runId: 'run-meta',
        sourceSha: 'metasha12345678',
      })

      const prBody = mockCreateProfileSyncPR.mock.calls[0][4] as string

      // Verify metadata block
      expect(prBody).toContain('openslack-profile-sync-metadata')
      expect(prBody).toContain('source_repo: org/whitepapers')
      expect(prBody).toContain('source_commit: metasha12345678')
      expect(prBody).toContain('target_repo: org/.github')
      expect(prBody).toContain('target_path: profile/README.md')
      expect(prBody).toContain('marker: openslack:latest-insights')
      expect(prBody).toContain('workflow_run_id: run-meta')
      expect(prBody).toContain('posts_included: 2')
    })

    it('PR body includes validation summary', async () => {
      seedHappyPathMocks(3)

      await runProfileSync({
        config: baseConfig,
        runId: 'run-validation',
        sourceSha: 'valsha123456789',
      })

      const prBody = mockCreateProfileSyncPR.mock.calls[0][4] as string
      expect(prBody).toContain('validation_summary')
      expect(prBody).toMatch(/3 valid.*3 published.*3 selected/)
    })

    it('records profile_sync.completed event via recordEvent callback', async () => {
      seedHappyPathMocks(2)

      const recordEvent = vi.fn()

      await runProfileSync({
        config: baseConfig,
        runId: 'run-event',
        sourceSha: 'eventsha1234567',
        recordEvent,
      })

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'profile_sync.completed',
          actor: { id: 'profile-sync', kind: 'system', provider: 'github' },
          object: expect.objectContaining({
            kind: 'pr',
            id: expect.stringContaining('org/.github#99'),
          }),
          source: { kind: 'github', ref: 'profile-sync.run' },
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
        }),
      )

      // Verify metadata in event
      const callArgs = recordEvent.mock.calls[0][0] as { metadata: Record<string, unknown> }
      expect(callArgs.metadata.postsIncluded).toHaveLength(2)
      expect(callArgs.metadata.sourceRepo).toBe('org/whitepapers')
      expect(callArgs.metadata.targetRepo).toBe('org/.github')
      expect(callArgs.metadata.runId).toBe('run-event')
      expect(callArgs.metadata.sourceSha).toBe('eventsha1234567')
    })
  })

  // ── dryRun: no branch created ───────────────────────────────────────────────

  describe('dry-run mode', () => {
    it('does not create branch, commit, or PR', async () => {
      seedHappyPathMocks(2)

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'dry-run-001',
        sourceSha: 'drysha123456789',
        dryRun: true,
      })

      expect(result.status).toBe('completed')
      expect(result.prUrl).toContain('[DRY-RUN]')
      expect(result.branchName).toBeDefined()
      expect(result.reason).toContain('Dry-run')
      expect(result.reason).toContain('2 posts ready to sync')

      expect(mockCreateBranch).not.toHaveBeenCalled()
      expect(mockCommitFileToBranch).not.toHaveBeenCalled()
      expect(mockCreateProfileSyncPR).not.toHaveBeenCalled()
    })

    it('dry-run does not create failure issues on error', async () => {
      seedHappyPathMocks(0) // no published posts triggers failure

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'dry-fail-001',
        dryRun: true,
      })

      expect(result.status).toBe('failed')
      expect(mockPublishProfileSyncFailure).not.toHaveBeenCalled()
      expect(mockCreateBranch).not.toHaveBeenCalled()
    })

    it('dry-run still returns would-be branch name', async () => {
      seedHappyPathMocks(1)

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'dry-branch-001',
        sourceSha: 'branchsha123456',
        dryRun: true,
      })

      expect(result.branchName).toMatch(/^openslack\/profile-sync\/latest-insights-/)
    })
  })

  // ── on_existing_pr: skip ────────────────────────────────────────────────────

  describe('on_existing_pr=skip', () => {
    it('returns skipped status with existing PR info when open PR found', async () => {
      seedHappyPathMocks(2)

      const existingBranch = 'openslack/profile-sync/latest-insights-20260530-oldsh01-oldrun'
      mockListOpenPRs.mockResolvedValue([
        {
          number: 40,
          title: 'profile: sync latest latest-insights',
          author: 'bot',
          draft: true,
          updatedAt: '2026-05-30',
          url: 'https://github.com/org/.github/pull/40',
          branch: existingBranch,
        },
      ])

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'skip-run-001',
        sourceSha: 'skipsha12345678',
      })

      expect(result.status).toBe('skipped')
      expect(result.reason).toContain('already exists')
      expect(result.prUrl).toBe('https://github.com/org/.github/pull/40')
      expect(result.prNumber).toBe(40)
      expect(result.branchName).toBe(existingBranch)

      // No new branch, commit, or PR created
      expect(mockCreateBranch).not.toHaveBeenCalled()
      expect(mockCommitFileToBranch).not.toHaveBeenCalled()
      expect(mockCreateProfileSyncPR).not.toHaveBeenCalled()
    })
  })

  // ── on_existing_pr: update ──────────────────────────────────────────────────

  describe('on_existing_pr=update', () => {
    const updateConfig: ProfileSyncConfig = {
      ...baseConfig,
      on_existing_pr: 'update',
    }

    it('reuses existing branch and commits to it without creating a new PR', async () => {
      seedHappyPathMocks(2)

      const existingBranch = 'openslack/profile-sync/latest-insights-20260530-oldsh01-oldrun'
      mockListOpenPRs.mockResolvedValue([
        {
          number: 40,
          title: 'profile: sync latest latest-insights',
          author: 'bot',
          draft: true,
          updatedAt: '2026-05-30',
          url: 'https://github.com/org/.github/pull/40',
          branch: existingBranch,
        },
      ])

      const recordEvent = vi.fn()

      const result = await runProfileSync({
        config: updateConfig,
        runId: 'update-run-001',
        sourceSha: 'updsha123456789',
        recordEvent,
      })

      expect(result.status).toBe('completed')
      expect(result.prUrl).toBe('https://github.com/org/.github/pull/40')
      expect(result.prNumber).toBe(40)
      expect(result.branchName).toBe(existingBranch)
      expect(result.reason).toContain('Updated existing PR #40')

      // Should NOT create a new branch (reuses existing)
      expect(mockCreateBranch).not.toHaveBeenCalled()
      // Should NOT create a new PR (updates existing)
      expect(mockCreateProfileSyncPR).not.toHaveBeenCalled()
      // Should commit the updated file to the existing branch
      expect(mockCommitFileToBranch).toHaveBeenCalledWith(
        'org',
        '.github',
        existingBranch,
        'profile/README.md',
        expect.any(String),
        'profile: sync latest latest-insights',
        'target-sha',
      )

      // Should record event with updatedExisting flag
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'profile_sync.completed',
          metadata: expect.objectContaining({ updatedExisting: true }),
        }),
      )
    })
  })

  // ── Multiple posts compiled correctly ───────────────────────────────────────

  describe('multiple posts compilation', () => {
    it('selects up to max_posts posts sorted by date', async () => {
      seedHappyPathMocks(8) // more than max_posts=5

      await runProfileSync({
        config: baseConfig,
        runId: 'multi-run-001',
        sourceSha: 'multisha1234567',
      })

      // Verify the PR body mentions exactly max_posts posts
      const prBody = mockCreateProfileSyncPR.mock.calls[0][4] as string
      expect(prBody).toContain('posts_included: 5')

      // renderLatestInsightsSection should have been called with exactly 5 posts
      // (via the sortPostsByDate mock which the real code uses)
      // The sortPostsByDate mock was provided in vi.mock above
    })

    it('selects all posts when fewer than max_posts', async () => {
      seedHappyPathMocks(3)

      await runProfileSync({
        config: baseConfig,
        runId: 'few-run-001',
        sourceSha: 'fewsha123456789',
      })

      const prBody = mockCreateProfileSyncPR.mock.calls[0][4] as string
      expect(prBody).toContain('posts_included: 3')
    })

    it('PR body lists each included post with link', async () => {
      seedHappyPathMocks(2)

      await runProfileSync({
        config: baseConfig,
        runId: 'list-run-001',
        sourceSha: 'listsha12345678',
      })

      const prBody = mockCreateProfileSyncPR.mock.calls[0][4] as string
      // Each post gets a bullet point
      expect(prBody).toContain('Post 1')
      expect(prBody).toContain('Post 2')
      // Links reference source repo
      expect(prBody).toContain('org/whitepapers')
    })
  })

  // ── Failure paths ───────────────────────────────────────────────────────────

  describe('failure paths', () => {
    it('returns failed when source directory is unreadable', async () => {
      mockReadRepoDirectory.mockRejectedValue(new Error('Permission denied'))
      mockListOpenPRs.mockResolvedValue([])

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'fail-read-001',
      })

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Permission denied')
    })

    it('returns failed with validation summary when no published posts', async () => {
      seedHappyPathMocks(0) // triggers empty directory or no valid posts

      // Override: provide files but all are draft
      mockReadRepoDirectory.mockResolvedValue([
        { name: 'draft.md', path: 'posts/draft.md', type: 'file', sha: 'a' },
      ])
      mockReadRepoFile.mockImplementation(async () => ({
        content: '---\ntitle: Draft\ndate: 2026-05-30\nsummary: Draft\ntags: [tech]\nstatus: draft\n---',
        sha: 'a',
      }))
      mockParseFrontmatter.mockReturnValue({
        title: 'Draft',
        date: '2026-05-30',
        summary: 'Draft',
        tags: ['tech'],
        status: 'draft',
      })
      mockValidatePost.mockReturnValue({ valid: true, errors: [] })
      mockListOpenPRs.mockResolvedValue([])

      const result = await runProfileSync({
        config: baseConfig,
        runId: 'fail-draft-001',
      })

      expect(result.status).toBe('failed')
      expect(result.error).toContain('No published posts')
    })

    it('records profile_sync.failed event on failure', async () => {
      mockReadRepoDirectory.mockRejectedValue(new Error('Connection refused'))
      mockListOpenPRs.mockResolvedValue([])

      const recordEvent = vi.fn()

      await runProfileSync({
        config: baseConfig,
        runId: 'fail-event-001',
        recordEvent,
      })

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'profile_sync.failed',
          summary: expect.stringContaining('Connection refused'),
        }),
      )
    })
  })
})
