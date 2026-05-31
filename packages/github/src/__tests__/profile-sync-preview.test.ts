import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../profile-sync-check.js', () => ({
  checkProfileSync: vi.fn(),
}))

vi.mock('../profile-sync.js', () => ({
  readRepoDirectory: vi.fn(),
  readRepoFile: vi.fn(),
  parseFrontmatter: vi.fn(),
  validatePost: vi.fn(),
  sortPostsByDate: vi.fn((posts: Array<{ date: string }>) => [...posts].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())),
  renderLatestInsightsSection: vi.fn((posts: unknown[], sourceRepo: string) => `Rendered ${(posts as Array<{ title: string }>).length} posts from ${sourceRepo}`),
  patchMarkerSection: vi.fn(),
  MarkerNotFoundError: class MarkerNotFoundError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'MarkerNotFoundError'
    }
  },
}))

import { checkProfileSync } from '../profile-sync-check.js'
import { readRepoDirectory, readRepoFile, parseFrontmatter, validatePost, patchMarkerSection } from '../profile-sync.js'
import { previewProfileSync } from '../profile-sync-preview.js'
import type { ProfileSyncConfig } from '../profile-sync-config.js'

const mockCheckProfileSync = checkProfileSync as ReturnType<typeof vi.fn>
const mockReadRepoDirectory = readRepoDirectory as ReturnType<typeof vi.fn>
const mockReadRepoFile = readRepoFile as ReturnType<typeof vi.fn>
const mockParseFrontmatter = parseFrontmatter as ReturnType<typeof vi.fn>
const mockValidatePost = validatePost as ReturnType<typeof vi.fn>
const mockPatchMarkerSection = patchMarkerSection as ReturnType<typeof vi.fn>

const mockConfig: ProfileSyncConfig = {
  schema: 'openslack.profile_sync.v1',
  source: { repo: 'owner/whitepapers', branch: 'main', path: 'posts' },
  target: { repo: 'owner/.github', branch: 'main', path: 'profile/README.md', marker: 'latest-insights' },
  mode: 'manual',
  max_posts: 5,
  pr: { draft: true, labels: ['profile:sync'] },
  failure_issue: { enabled: true },
}

describe('previewProfileSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok=true with diff when check passes', async () => {
    mockCheckProfileSync.mockResolvedValue({
      ok: true,
      source: { repo: 'owner/whitepapers', branch: 'main', path: 'posts', accessible: true, postCount: 2 },
      target: { repo: 'owner/.github', branch: 'main', path: 'profile/README.md', accessible: true, markerExists: true },
      posts: { total: 2, published: 2, failed: 0, failures: [] },
      config: mockConfig,
      errors: [],
    })

    mockReadRepoDirectory.mockResolvedValue([
      { name: 'post-1.md', path: 'posts/post-1.md', type: 'file', sha: 'a' },
      { name: 'post-2.md', path: 'posts/post-2.md', type: 'file', sha: 'b' },
    ])

    mockReadRepoFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'posts/post-1.md') {
        return { content: '---\ntitle: First\ndate: 2026-05-30\nsummary: First summary\ntags: [tech]\nstatus: published\n---', sha: 'a' }
      }
      if (path === 'posts/post-2.md') {
        return { content: '---\ntitle: Second\ndate: 2026-05-29\nsummary: Second summary\ntags: [tech]\nstatus: published\n---', sha: 'b' }
      }
      if (path === 'profile/README.md') {
        return { content: '<!-- openslack:latest-insights:start -->\nOld content\n<!-- openslack:latest-insights:end -->', sha: 'c' }
      }
      return null
    })

    mockParseFrontmatter.mockImplementation((content: string) => {
      if (content.includes('First')) {
        return { title: 'First', date: '2026-05-30', summary: 'First summary', tags: ['tech'], status: 'published' }
      }
      return { title: 'Second', date: '2026-05-29', summary: 'Second summary', tags: ['tech'], status: 'published' }
    })

    mockValidatePost.mockReturnValue({ valid: true, errors: [] })
    mockPatchMarkerSection.mockReturnValue('<!-- openslack:latest-insights:start -->\nRendered 2 posts from owner/whitepapers\n<!-- openslack:latest-insights:end -->')

    const result = await previewProfileSync(mockConfig)

    expect(result.ok).toBe(true)
    expect(result.renderedSection).toBe('Rendered 2 posts from owner/whitepapers')
    expect(result.diff).toContain('--- a/profile/README.md')
    expect(result.diff).toContain('+++ b/profile/README.md')
    expect(result.wouldCreateBranch).toContain('openslack/profile-sync/latest-insights-')
  })

  it('returns ok=false when check fails', async () => {
    mockCheckProfileSync.mockResolvedValue({
      ok: false,
      source: { repo: 'owner/whitepapers', branch: 'main', path: 'posts', accessible: false, postCount: 0 },
      target: { repo: 'owner/.github', branch: 'main', path: 'profile/README.md', accessible: false, markerExists: false },
      posts: { total: 0, published: 0, failed: 0, failures: [] },
      config: mockConfig,
      errors: ['Source repository inaccessible: Not found'],
    })

    const result = await previewProfileSync(mockConfig)

    expect(result.ok).toBe(false)
    expect(result.diff).toBe('')
    expect(result.renderedSection).toBe('')
  })

  it('includes sourceSha and runId in branch name', async () => {
    mockCheckProfileSync.mockResolvedValue({
      ok: true,
      source: { repo: 'owner/whitepapers', branch: 'main', path: 'posts', accessible: true, postCount: 1 },
      target: { repo: 'owner/.github', branch: 'main', path: 'profile/README.md', accessible: true, markerExists: true },
      posts: { total: 1, published: 1, failed: 0, failures: [] },
      config: mockConfig,
      errors: [],
    })

    mockReadRepoDirectory.mockResolvedValue([
      { name: 'post-1.md', path: 'posts/post-1.md', type: 'file', sha: 'a' },
    ])
    mockReadRepoFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'posts/post-1.md') {
        return { content: '---\ntitle: Hello\ndate: 2026-05-30\nsummary: Summary\ntags: [tech]\nstatus: published\n---', sha: 'a' }
      }
      if (path === 'profile/README.md') {
        return { content: '<!-- openslack:latest-insights:start -->\nOld\n<!-- openslack:latest-insights:end -->', sha: 'c' }
      }
      return null
    })
    mockParseFrontmatter.mockReturnValue({ title: 'Hello', date: '2026-05-30', summary: 'Summary', tags: ['tech'], status: 'published' })
    mockValidatePost.mockReturnValue({ valid: true, errors: [] })
    mockPatchMarkerSection.mockReturnValue('<!-- openslack:latest-insights:start -->\nNew\n<!-- openslack:latest-insights:end -->')

    const result = await previewProfileSync(mockConfig, {
      sourceSha: 'abc123def456',
      runId: 'run-xyz789',
    })

    expect(result.wouldCreateBranch).toContain('abc123d')
    expect(result.wouldCreateBranch).toContain('xyz789')
  })
})