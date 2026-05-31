import { describe, it, expect } from 'vitest'
import { evaluateProfileSyncGate } from '../profile-sync-gate.js'

describe('evaluateProfileSyncGate', () => {
  it('returns N/A for non-profile-sync PR', () => {
    const result = evaluateProfileSyncGate(
      ['src/index.ts'],
      'Regular PR body',
      'feature/new-stuff',
    )
    expect(result.overall).toBe('N/A')
    expect(result.touchedProfileSyncFiles).toBe(false)
  })

  it('PASS for legal profile-sync PR', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
validation_summary: 5 valid, 3 published, 3 selected
\`\`\``
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    )
    expect(result.overall).toBe('PASS')
    expect(result.touchedProfileSyncFiles).toBe(true)
    expect(result.criteria.every((c) => c.status === 'PASS' || c.status === 'N/A')).toBe(true)
  })

  it('FAIL when modifying extra files', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``
    const result = evaluateProfileSyncGate(
      ['profile/README.md', 'src/index.ts'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    )
    expect(result.overall).toBe('FAIL')
    expect(result.criteria.some((c) => c.name === 'Only modifies profile/README.md' && c.status === 'FAIL')).toBe(true)
  })

  it('FAIL when missing metadata', () => {
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      'profile: sync latest latest-insights',
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    )
    expect(result.overall).toBe('FAIL')
    expect(result.criteria.some((c) => c.name === 'Required metadata present' && c.status === 'FAIL')).toBe(true)
  })

  it('FAIL when direct-main write', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'main',
    )
    expect(result.overall).toBe('FAIL')
    expect(result.criteria.some((c) => c.name === 'Not direct-main write' && c.status === 'FAIL')).toBe(true)
  })

  it('detects profile-sync PR by branch prefix', () => {
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      'Some body without metadata',
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    )
    expect(result.touchedProfileSyncFiles).toBe(true)
  })

  it('detects profile-sync PR by body title', () => {
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      'profile: sync latest latest-insights',
      'feature/something',
    )
    expect(result.touchedProfileSyncFiles).toBe(true)
  })
})
