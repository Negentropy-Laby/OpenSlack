import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ getClient: vi.fn() }))
vi.mock('../client.js', () => ({ getClient: hoisted.getClient }))

import { finalizeWorkflowPR } from '../workflow-lifecycle.js'

describe('finalizeWorkflowPR governance evidence', () => {
  const createComment = vi.fn()
  const addLabels = vi.fn()
  const update = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.getClient.mockResolvedValue({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      isDryRun: false,
      octokit: { issues: { createComment, addLabels, update } },
    })
    createComment.mockResolvedValue({ data: {} })
    addLabels.mockResolvedValue({ data: {} })
    update.mockResolvedValue({ data: {} })
  })

  it('closes the single governance issue with reviewer, commit, trust, and hash evidence', async () => {
    const result = await finalizeWorkflowPR(176, {
      governanceIssue: 177,
      workflowHash: 'sha256:evidence',
      trustDecision: 'trusted',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
    })

    expect(result.errors).toEqual([])
    expect(result.closedIssues).toEqual([177])
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 177,
      body: expect.stringContaining('**Reviewed Commit**: head-sha'),
    }))
    expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 177,
      labels: ['lifecycle:accepted', 'workflow:trusted'],
    }))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 177,
      state: 'closed',
    }))
  })

  it.each([
    ['comment', createComment],
    ['label', addLabels],
    ['close', update],
  ])('keeps the governance issue open and reports a %s write failure', async (_step, operation) => {
    operation.mockRejectedValueOnce(new Error('write failed'))

    const result = await finalizeWorkflowPR(185, {
      governanceIssue: 186,
      workflowHash: 'sha256:evidence',
      trustDecision: 'core',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
    })

    expect(result.closedIssues).toEqual([])
    expect(result.errors).toEqual([
      'Failed to finalize governance issue #186: write failed',
    ])
    if (operation !== update) expect(update).not.toHaveBeenCalled()
  })
})
