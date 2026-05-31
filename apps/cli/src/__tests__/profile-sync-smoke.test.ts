import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mocks ──────────────────────────────────────────────────────────

const mockCheckProfileSync = vi.fn()
const mockPreviewProfileSync = vi.fn()
const mockRunProfileSync = vi.fn()
const mockLoadProfileSyncConfig = vi.fn()

vi.mock('@openslack/github', () => ({
  loadProfileSyncConfig: (...args: unknown[]) => mockLoadProfileSyncConfig(...args),
  checkProfileSync: (...args: unknown[]) => mockCheckProfileSync(...args),
  previewProfileSync: (...args: unknown[]) => mockPreviewProfileSync(...args),
  runProfileSync: (...args: unknown[]) => mockRunProfileSync(...args),
}))

// Import after mocks are set up — this exercises the real production handler factory
import { createProfileSyncHandlers } from '../commands/tui-executors.js'
import type { ProfileSyncConfig } from '@openslack/github'

// ── Test fixtures ───────────────────────────────────────────────────────────────

const testRoot = '/test/repo/root'

const autoPrConfig: ProfileSyncConfig = {
  schema: 'openslack.profile_sync.v1',
  source: { repo: 'org/whitepapers', branch: 'main', path: 'posts' },
  target: { repo: 'org/.github', branch: 'main', path: 'profile/README.md', marker: 'latest-insights' },
  mode: 'auto-pr',
  max_posts: 5,
  pr: { draft: true, labels: ['profile:sync'] },
  failure_issue: { enabled: false },
  on_existing_pr: 'skip',
}

const updateConfig: ProfileSyncConfig = {
  ...autoPrConfig,
  on_existing_pr: 'update',
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('Profile Sync CLI smoke tests (real handlers)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadProfileSyncConfig.mockReturnValue(autoPrConfig)
  })

  // ── Full auto-pr flow: check -> preview -> run ──────────────────────────────

  describe('full auto-pr flow', () => {
    it('check detects change, preview shows diff, run creates PR with correct metadata', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      // Step 1: checkProfileSync detects change
      mockCheckProfileSync.mockResolvedValue({
        ok: true,
        source: {
          repo: 'org/whitepapers',
          branch: 'main',
          path: 'posts',
          accessible: true,
          postCount: 3,
        },
        target: {
          repo: 'org/.github',
          branch: 'main',
          path: 'profile/README.md',
          accessible: true,
          markerExists: true,
        },
        posts: { total: 3, published: 3, failed: 0, failures: [] },
        config: autoPrConfig,
        errors: [],
      })

      const checkResult = await handlers.checkProfileSync()
      expect(checkResult.success).toBe(true)
      expect(checkResult.message).toContain('check passed')
      expect(checkResult.data?.posts).toBe(3)
      expect(checkResult.data?.marker).toBe(true)

      // Verify config was loaded with the root path
      expect(mockLoadProfileSyncConfig).toHaveBeenCalledWith(testRoot)

      // Step 2: previewProfileSync shows diff
      mockPreviewProfileSync.mockResolvedValue({
        ok: true,
        checkResult: { ok: true, errors: [] },
        diff: '--- a/profile/README.md\n+++ b/profile/README.md\n@@ -1,3 +1,3 @@\n-Old insight\n+New insight',
        renderedSection: '- [New Post](...) -- 2026-05-31\n  A new post summary',
        wouldCreateBranch: 'openslack/profile-sync/latest-insights-20260531-abc123d-run456',
        patchedContent: '<!-- openslack:latest-insights:start -->\nNew content\n<!-- openslack:latest-insights:end -->',
      })

      const previewResult = await handlers.previewProfileSync()
      expect(previewResult.success).toBe(true)
      expect(previewResult.message).toContain('Preview ready')
      expect(previewResult.message).toContain('openslack/profile-sync/latest-insights-')
      expect(previewResult.data?.diffLength).toBeGreaterThan(0)

      // Step 3: runProfileSync with mode=auto-pr creates branch + PR
      mockRunProfileSync.mockResolvedValue({
        status: 'completed',
        prUrl: 'https://github.com/org/.github/pull/47',
        prNumber: 47,
        branchName: 'openslack/profile-sync/latest-insights-20260531-abc123d-run456',
      })

      const runResult = await handlers.createProfileSyncPR()
      expect(runResult.success).toBe(true)
      expect(runResult.message).toContain('Created PR')
      expect(runResult.message).toContain('https://github.com/org/.github/pull/47')
      expect(runResult.data?.prUrl).toBe('https://github.com/org/.github/pull/47')
      expect(runResult.data?.prNumber).toBe(47)

      // Verify config was loaded with root for each handler call
      expect(mockLoadProfileSyncConfig).toHaveBeenCalledTimes(3)
      for (const call of mockLoadProfileSyncConfig.mock.calls) {
        expect(call[0]).toBe(testRoot)
      }
    })

    it('check failure short-circuits the flow', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockCheckProfileSync.mockResolvedValue({
        ok: false,
        source: {
          repo: 'org/whitepapers',
          branch: 'main',
          path: 'posts',
          accessible: false,
          postCount: 0,
        },
        target: {
          repo: 'org/.github',
          branch: 'main',
          path: 'profile/README.md',
          accessible: false,
          markerExists: false,
        },
        posts: { total: 0, published: 0, failed: 0, failures: [] },
        config: autoPrConfig,
        errors: ['Source repository inaccessible: Not found'],
      })

      const checkResult = await handlers.checkProfileSync()
      expect(checkResult.success).toBe(false)
      expect(checkResult.message).toContain('Check failed')
      expect(checkResult.message).toContain('Source repository inaccessible')
    })
  })

  // ── Root propagation ─────────────────────────────────────────────────────────

  describe('root propagation', () => {
    it('all handlers pass root to loadProfileSyncConfig', async () => {
      const customRoot = '/custom/path/to/repo'
      const handlers = createProfileSyncHandlers(customRoot)

      mockCheckProfileSync.mockResolvedValue({
        ok: true, source: { repo: 'org/wp', branch: 'main', path: 'posts', accessible: true, postCount: 1 },
        target: { repo: 'org/dotgithub', branch: 'main', path: 'profile/README.md', accessible: true, markerExists: true },
        posts: { total: 1, published: 1, failed: 0, failures: [] }, config: autoPrConfig, errors: [],
      })
      mockPreviewProfileSync.mockResolvedValue({
        ok: true, checkResult: { ok: true, errors: [] }, diff: 'diff', renderedSection: 'section', wouldCreateBranch: 'branch', patchedContent: 'patch',
      })
      mockRunProfileSync.mockResolvedValue({
        status: 'completed', prUrl: 'https://github.com/org/dotgithub/pull/1', prNumber: 1, branchName: 'branch',
      })

      await handlers.checkProfileSync()
      await handlers.previewProfileSync()
      await handlers.dryRunProfileSync()
      await handlers.createProfileSyncPR()

      // Every handler must have called loadProfileSyncConfig with customRoot
      for (const call of mockLoadProfileSyncConfig.mock.calls) {
        expect(call[0]).toBe(customRoot)
      }
    })
  })

  // ── on_existing_pr: skip ────────────────────────────────────────────────────

  describe('on_existing_pr=skip', () => {
    it('returns skipped status when open PR already exists', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockRunProfileSync.mockResolvedValue({
        status: 'skipped',
        reason: 'Open profile-sync PR already exists: https://github.com/org/.github/pull/40',
        prUrl: 'https://github.com/org/.github/pull/40',
        prNumber: 40,
        branchName: 'openslack/profile-sync/latest-insights-20260530-oldsha-oldrun',
      })

      const result = await handlers.createProfileSyncPR()

      expect(result.success).toBe(false)
      expect(result.message).toContain('Skipped')
      expect(result.message).toContain('already exists')
    })

    it('dry-run reports would-skip when open PR exists', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockRunProfileSync.mockResolvedValue({
        status: 'skipped',
        reason: 'Open profile-sync PR already exists: https://github.com/org/.github/pull/40',
        prUrl: 'https://github.com/org/.github/pull/40',
        prNumber: 40,
        branchName: 'openslack/profile-sync/latest-insights-20260530-oldsha-oldrun',
      })

      const result = await handlers.dryRunProfileSync()

      expect(result.success).toBe(true)
      expect(result.message).toContain('Skipped')
    })
  })

  // ── on_existing_pr: update ──────────────────────────────────────────────────

  describe('on_existing_pr=update', () => {
    beforeEach(() => {
      mockLoadProfileSyncConfig.mockReturnValue(updateConfig)
    })

    it('updates existing PR and returns updated metadata', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockRunProfileSync.mockResolvedValue({
        status: 'completed',
        prUrl: 'https://github.com/org/.github/pull/40',
        prNumber: 40,
        branchName: 'openslack/profile-sync/latest-insights-20260530-oldsha-oldrun',
        reason: 'Updated existing PR #40',
      })

      const result = await handlers.createProfileSyncPR()

      expect(result.success).toBe(true)
      expect(result.message).toContain('Created PR')
      expect(result.data?.prNumber).toBe(40)
      expect(result.data?.prUrl).toBe('https://github.com/org/.github/pull/40')

      // Verify runProfileSync was called with the update config
      expect(mockRunProfileSync).toHaveBeenCalledWith({ config: updateConfig })
    })
  })

  // ── Dry-run path ────────────────────────────────────────────────────────────

  describe('dry-run', () => {
    it('does not create branch or PR, returns simulated result', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockRunProfileSync.mockResolvedValue({
        status: 'completed',
        prUrl: '[DRY-RUN] would create PR from branch openslack/profile-sync/latest-insights-20260531-abc123d-run456',
        branchName: 'openslack/profile-sync/latest-insights-20260531-abc123d-run456',
        reason: 'Dry-run: 3 posts ready to sync. Would create branch and open PR.',
      })

      const result = await handlers.dryRunProfileSync()

      expect(result.success).toBe(true)
      expect(result.message).toContain('[DRY-RUN]')
      // Verify dryRun flag was passed
      expect(mockRunProfileSync).toHaveBeenCalledWith({
        config: autoPrConfig,
        dryRun: true,
      })
    })

    it('handles dry-run failure gracefully', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockRunProfileSync.mockResolvedValue({
        status: 'failed',
        error: 'Marker "openslack:latest-insights" not found in target',
        reason: 'patch: Marker not found',
      })

      const result = await handlers.dryRunProfileSync()

      expect(result.success).toBe(false)
      expect(result.message).toContain('Dry-run failed')
      expect(result.message).toContain('Marker')
    })
  })

  // ── Error handling ──────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles check exception gracefully', async () => {
      const handlers = createProfileSyncHandlers(testRoot)
      mockCheckProfileSync.mockRejectedValue(new Error('Network timeout'))

      const result = await handlers.checkProfileSync()

      expect(result.success).toBe(false)
      expect(result.message).toContain('Check error')
      expect(result.message).toContain('Network timeout')
    })

    it('handles preview exception gracefully', async () => {
      const handlers = createProfileSyncHandlers(testRoot)
      mockPreviewProfileSync.mockRejectedValue(new Error('API rate limit'))

      const result = await handlers.previewProfileSync()

      expect(result.success).toBe(false)
      expect(result.message).toContain('Preview error')
      expect(result.message).toContain('API rate limit')
    })

    it('handles run exception gracefully', async () => {
      const handlers = createProfileSyncHandlers(testRoot)
      mockRunProfileSync.mockRejectedValue(new Error('Authentication failed'))

      const result = await handlers.createProfileSyncPR()

      expect(result.success).toBe(false)
      expect(result.message).toContain('Run error')
      expect(result.message).toContain('Authentication failed')
    })
  })

  // ── PR metadata verification ────────────────────────────────────────────────

  describe('PR metadata verification', () => {
    it('PR result contains correct branch naming pattern', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockRunProfileSync.mockResolvedValue({
        status: 'completed',
        prUrl: 'https://github.com/org/.github/pull/51',
        prNumber: 51,
        branchName: 'openslack/profile-sync/latest-insights-20260531-deadbee-abc123',
      })

      const result = await handlers.createProfileSyncPR()

      expect(result.success).toBe(true)
      expect(result.data?.prUrl).toBe('https://github.com/org/.github/pull/51')
      expect(result.data?.prNumber).toBe(51)
    })

    it('PR URL points to target repo', async () => {
      const handlers = createProfileSyncHandlers(testRoot)

      mockRunProfileSync.mockResolvedValue({
        status: 'completed',
        prUrl: 'https://github.com/org/.github/pull/52',
        prNumber: 52,
        branchName: 'openslack/profile-sync/latest-insights-20260531-feedface-def456',
      })

      const result = await handlers.createProfileSyncPR()

      expect(result.data?.prUrl).toContain('org/.github')
    })

    it('preview branch name matches run branch naming convention', async () => {
      const handlers = createProfileSyncHandlers(testRoot)
      const branchName = 'openslack/profile-sync/latest-insights-20260531-cafe123-run789'

      mockPreviewProfileSync.mockResolvedValue({
        ok: true,
        checkResult: { ok: true, errors: [] },
        diff: '--- a/profile/README.md\n+++ b/profile/README.md',
        renderedSection: 'rendered content',
        wouldCreateBranch: branchName,
      })

      const preview = await handlers.previewProfileSync()

      expect(preview.success).toBe(true)
      expect(preview.message).toContain(branchName)
      expect(branchName).toMatch(/^openslack\/profile-sync\/latest-insights-\d{8}-[a-f0-9]{7}-[a-zA-Z0-9]+$/)
    })
  })
})
