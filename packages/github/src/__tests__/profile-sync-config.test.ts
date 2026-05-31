import { describe, it, expect } from 'vitest'
import {
  parseProfileSyncConfig,
  validateProfileSyncConfig,
  DEFAULT_PROFILE_SYNC_CONFIG,
} from '../profile-sync-config.js'

describe('parseProfileSyncConfig', () => {
  it('parses a valid config', () => {
    const yaml = `schema: openslack.profile_sync.v1
source:
  repo: owner/source-repo
  branch: main
  path: posts
target:
  repo: owner/target-repo
  branch: main
  path: profile/README.md
  marker: latest-insights
mode: watch
max_posts: 3
pr:
  draft: true
  labels: [profile:sync, docs]
failure_issue:
  enabled: true
on_existing_pr: update`

    const result = parseProfileSyncConfig(yaml)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.config).toEqual({
      schema: 'openslack.profile_sync.v1',
      source: { repo: 'owner/source-repo', branch: 'main', path: 'posts' },
      target: { repo: 'owner/target-repo', branch: 'main', path: 'profile/README.md', marker: 'latest-insights' },
      mode: 'watch',
      max_posts: 3,
      pr: { draft: true, labels: ['profile:sync', 'docs'] },
      failure_issue: { enabled: true },
      on_existing_pr: 'update',
    })
  })

  it('uses defaults for optional fields', () => {
    const yaml = `schema: openslack.profile_sync.v1
source:
  repo: owner/source-repo
  branch: main
  path: posts
target:
  repo: owner/target-repo
  branch: main
  path: profile/README.md
  marker: latest-insights
mode: manual
max_posts: 5
pr:
  draft: true
  labels: [profile:sync]
failure_issue:
  enabled: true`

    const result = parseProfileSyncConfig(yaml)
    expect(result.valid).toBe(true)
    expect(result.config?.on_existing_pr).toBe('skip')
  })

  it('rejects invalid schema', () => {
    const result = parseProfileSyncConfig('schema: wrong.schema.v1')
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('schema'))).toBe(true)
  })

  it('rejects missing source.repo', () => {
    const yaml = `schema: openslack.profile_sync.v1
source:
  branch: main
  path: posts
target:
  repo: owner/target-repo
  branch: main
  path: profile/README.md
  marker: latest-insights
mode: manual
max_posts: 5
pr:
  draft: true
  labels: [profile:sync]
failure_issue:
  enabled: true`

    const result = parseProfileSyncConfig(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('source.repo'))).toBe(true)
  })

  it('rejects invalid mode', () => {
    const yaml = `schema: openslack.profile_sync.v1
source:
  repo: owner/source-repo
  branch: main
  path: posts
target:
  repo: owner/target-repo
  branch: main
  path: profile/README.md
  marker: latest-insights
mode: auto-merge
max_posts: 5
pr:
  draft: true
  labels: [profile:sync]
failure_issue:
  enabled: true`

    const result = parseProfileSyncConfig(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('mode'))).toBe(true)
  })

  it('rejects max_posts out of range', () => {
    const yaml = `schema: openslack.profile_sync.v1
source:
  repo: owner/source-repo
  branch: main
  path: posts
target:
  repo: owner/target-repo
  branch: main
  path: profile/README.md
  marker: latest-insights
mode: manual
max_posts: 25
pr:
  draft: true
  labels: [profile:sync]
failure_issue:
  enabled: true`

    const result = parseProfileSyncConfig(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('max_posts'))).toBe(true)
  })

  it('rejects invalid on_existing_pr', () => {
    const yaml = `schema: openslack.profile_sync.v1
source:
  repo: owner/source-repo
  branch: main
  path: posts
target:
  repo: owner/target-repo
  branch: main
  path: profile/README.md
  marker: latest-insights
mode: manual
max_posts: 5
pr:
  draft: true
  labels: [profile:sync]
failure_issue:
  enabled: true
on_existing_pr: invalid`

    const result = parseProfileSyncConfig(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('on_existing_pr'))).toBe(true)
  })
})

describe('validateProfileSyncConfig', () => {
  it('accepts a valid config object', () => {
    const result = validateProfileSyncConfig(DEFAULT_PROFILE_SYNC_CONFIG)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects non-object', () => {
    const result = validateProfileSyncConfig(null)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('object')
  })

  it('rejects missing source', () => {
    const result = validateProfileSyncConfig({
      schema: 'openslack.profile_sync.v1',
      target: { repo: 'o/r', branch: 'main', path: 'p', marker: 'm' },
      mode: 'manual',
      max_posts: 5,
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('source'))).toBe(true)
  })

  it('rejects missing target.marker', () => {
    const result = validateProfileSyncConfig({
      schema: 'openslack.profile_sync.v1',
      source: { repo: 'o/r', branch: 'main', path: 'p' },
      target: { repo: 'o/r', branch: 'main', path: 'p' },
      mode: 'manual',
      max_posts: 5,
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('marker'))).toBe(true)
  })
})

describe('DEFAULT_PROFILE_SYNC_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_PROFILE_SYNC_CONFIG.schema).toBe('openslack.profile_sync.v1')
    expect(DEFAULT_PROFILE_SYNC_CONFIG.mode).toBe('manual')
    expect(DEFAULT_PROFILE_SYNC_CONFIG.max_posts).toBe(5)
    expect(DEFAULT_PROFILE_SYNC_CONFIG.pr.draft).toBe(true)
    expect(DEFAULT_PROFILE_SYNC_CONFIG.failure_issue.enabled).toBe(true)
    expect(DEFAULT_PROFILE_SYNC_CONFIG.on_existing_pr).toBe('skip')
  })
})
