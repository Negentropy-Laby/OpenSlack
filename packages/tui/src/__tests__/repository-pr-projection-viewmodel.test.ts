import { describe, expect, it } from 'vitest'
import { mapRepositoryPrProjectionToViewModel } from '../view-models/repository-pr-projection.js'

describe('mapRepositoryPrProjectionToViewModel', () => {
  it('keeps multi-repository projection informational and sanitizes display text', () => {
    const model = mapRepositoryPrProjectionToViewModel({
      fetchedAt: '2026-07-17T02:00:00.000Z',
      partial: true,
      budget: { used: 2, limit: 2, exhausted: true },
      repositories: [{ repository: { fullName: 'Acme/Project' } }],
      items: [
        {
          repository: { fullName: 'Acme/Project' },
          prNumber: 42,
          title: 'Unsafe\u001b[31m title',
          author: 'alice',
          state: 'open',
          draft: false,
          headSha: '1234567890abcdef',
          updatedAt: '2026-07-17T01:00:00.000Z',
          checks: {
            successful: 1,
            failed: 0,
            pending: 1,
            neutral: 0,
            complete: false,
          },
          fetchedAt: '2026-07-17T02:00:00.000Z',
          ageSeconds: 0,
          stale: false,
          partial: true,
          source: 'github-live',
        },
      ],
    })

    expect(model).toMatchObject({
      partial: true,
      budgetLabel: '2/2 exhausted',
      authorityLabel: 'Human approval and merge readiness are not evaluated.',
      items: [
        {
          repository: 'Acme/Project',
          prNumber: 42,
          headSha: '1234567890ab',
          warning: true,
        },
      ],
    })
    expect(model.items[0]?.title).not.toContain('\u001b')
    expect(model.items[0]?.checksLabel).toContain('(partial)')
  })
})
