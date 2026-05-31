import { describe, it, expect } from 'vitest'
import { normalizePushEvent, matchesPushRepoConfig } from '../push-normalizer.js'

function makePushPayload(overrides?: {
  ref?: string
  commits?: Array<Record<string, unknown>>
  repository?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    ref: overrides?.ref ?? 'refs/heads/main',
    before: 'abc123',
    after: 'def456',
    pusher: { name: 'test-user' },
    commits: overrides?.commits ?? [
      {
        id: 'commit1',
        message: 'Add new post',
        added: ['posts/article.md'],
        modified: [],
        removed: [],
        timestamp: '2026-05-30T12:00:00Z',
      },
    ],
    repository: overrides?.repository ?? {
      name: 'whitepapers',
      owner: { login: 'Negentropy-Laby' },
    },
  }
}

describe('normalizePushEvent', () => {
  it('returns null for non-branch refs', () => {
    const payload = makePushPayload({ ref: 'refs/tags/v1.0.0' })
    const result = normalizePushEvent(payload, { 'x-github-delivery': 'del-1' })
    expect(result).toBeNull()
  })

  it('returns null when no commits touch posts/', () => {
    const payload = makePushPayload({
      commits: [
        {
          id: 'c1',
          message: 'Update README',
          added: ['README.md'],
          modified: [],
          removed: [],
          timestamp: '2026-05-30T12:00:00Z',
        },
      ],
    })
    const result = normalizePushEvent(payload, { 'x-github-delivery': 'del-1' })
    expect(result).toBeNull()
  })

  it('extracts push with posts changes', () => {
    const payload = makePushPayload()
    const result = normalizePushEvent(payload, { 'x-github-delivery': 'del-1' })
    expect(result).not.toBeNull()
    expect(result!.owner).toBe('Negentropy-Laby')
    expect(result!.repo).toBe('whitepapers')
    expect(result!.ref).toBe('refs/heads/main')
    expect(result!.after).toBe('def456')
    expect(result!.commits).toHaveLength(1)
    expect(result!.commits[0]!.added).toContain('posts/article.md')
  })

  it('filters commits to only those touching posts/', () => {
    const payload = makePushPayload({
      commits: [
        {
          id: 'c1',
          message: 'Add post',
          added: ['posts/article.md'],
          modified: [],
          removed: [],
          timestamp: '2026-05-30T12:00:00Z',
        },
        {
          id: 'c2',
          message: 'Update README',
          added: ['README.md'],
          modified: [],
          removed: [],
          timestamp: '2026-05-30T12:00:00Z',
        },
      ],
    })
    const result = normalizePushEvent(payload, { 'x-github-delivery': 'del-1' })
    expect(result).not.toBeNull()
    expect(result!.commits).toHaveLength(1)
    expect(result!.commits[0]!.id).toBe('c1')
  })

  it('returns null for invalid payload', () => {
    expect(normalizePushEvent(null, {})).toBeNull()
    expect(normalizePushEvent({}, {})).toBeNull()
    expect(normalizePushEvent('string', {})).toBeNull()
  })

  it('handles modified and removed posts paths', () => {
    const payload = makePushPayload({
      commits: [
        {
          id: 'c1',
          message: 'Edit post',
          added: [],
          modified: ['posts/article.md'],
          removed: [],
          timestamp: '2026-05-30T12:00:00Z',
        },
        {
          id: 'c2',
          message: 'Delete post',
          added: [],
          modified: [],
          removed: ['posts/old.md'],
          timestamp: '2026-05-30T12:00:00Z',
        },
      ],
    })
    const result = normalizePushEvent(payload, { 'x-github-delivery': 'del-1' })
    expect(result).not.toBeNull()
    expect(result!.commits).toHaveLength(2)
  })
})

describe('matchesPushRepoConfig', () => {
  it('matches when owner, repo, and event align', () => {
    const event = normalizePushEvent(makePushPayload(), { 'x-github-delivery': 'del-1' })!
    const result = matchesPushRepoConfig(event, {
      owner: 'Negentropy-Laby',
      repo: 'whitepapers',
      events: ['push'],
    })
    expect(result).toBe(true)
  })

  it('rejects when event is not push', () => {
    const event = normalizePushEvent(makePushPayload(), { 'x-github-delivery': 'del-1' })!
    const result = matchesPushRepoConfig(event, {
      owner: 'Negentropy-Laby',
      repo: 'whitepapers',
      events: ['issues.opened'],
    })
    expect(result).toBe(false)
  })

  it('rejects when repo does not match', () => {
    const event = normalizePushEvent(makePushPayload(), { 'x-github-delivery': 'del-1' })!
    const result = matchesPushRepoConfig(event, {
      owner: 'Negentropy-Laby',
      repo: 'other-repo',
      events: ['push'],
    })
    expect(result).toBe(false)
  })
})
