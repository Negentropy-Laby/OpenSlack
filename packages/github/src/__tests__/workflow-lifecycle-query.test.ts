import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  getClient: vi.fn(),
}))

import { getClient } from '../client.js'
import { fetchWorkflowLifecycleIssues } from '../workflow-lifecycle.js'

const mockGetClient = vi.mocked(getClient)

describe('fetchWorkflowLifecycleIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockOctokit(issueMap: Record<string, unknown[]>, prs: unknown[] = []) {
    return {
      issues: {
        listForRepo: vi.fn().mockImplementation(({ labels }: { labels: string }) => {
          const key = labels.split(':')[1] as string
          const data = issueMap[key] ?? []
          return Promise.resolve({ data })
        }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: prs }),
      },
    }
  }

  function mockIssue(overrides: Partial<{
    number: number
    title: string
    html_url: string
    state: 'open' | 'closed'
    body: string | null
    pull_request?: unknown
  }> = {}): unknown {
    return {
      number: 1,
      title: 'Issue',
      html_url: 'https://github.com/test/repo/issues/1',
      state: 'open',
      body: null,
      ...overrides,
    }
  }

  it('returns empty result in dry-run mode', async () => {
    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: {} as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'dry_run',
      isDryRun: true,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')
    expect(result.phaseIssues).toHaveLength(0)
    expect(result.runIssues).toHaveLength(0)
    expect(result.improvementIssues).toHaveLength(0)
    expect(result.linkedPRs).toHaveLength(0)
    expect(result.subIssueMode).toBe('unknown')
    expect(result.dependencyMode).toBe('none')
  })

  it('finds proposal, review, and split issues', async () => {
    const octokit = mockOctokit({
      proposal: [
        mockIssue({ number: 10, title: '[Workflow Proposal] test-workflow', html_url: 'https://github.com/test/repo/issues/10' }),
      ],
      review: [
        mockIssue({ number: 20, title: '[Workflow Review] test-workflow', html_url: 'https://github.com/test/repo/issues/20', state: 'closed' }),
      ],
      split: [
        mockIssue({ number: 30, title: '[Workflow Split] test-workflow', html_url: 'https://github.com/test/repo/issues/30' }),
      ],
      phase: [],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.proposalIssue).toEqual({ number: 10, state: 'open', url: 'https://github.com/test/repo/issues/10' })
    expect(result.reviewIssue).toEqual({ number: 20, state: 'closed', url: 'https://github.com/test/repo/issues/20' })
    expect(result.splitIssue).toEqual({ number: 30, state: 'open', url: 'https://github.com/test/repo/issues/30' })
  })

  it('extracts phase names from phase issue titles', async () => {
    const octokit = mockOctokit({
      proposal: [],
      review: [],
      split: [],
      phase: [
        mockIssue({ number: 40, title: '[Workflow Phase] test-workflow / Scan', html_url: 'https://github.com/test/repo/issues/40' }),
        mockIssue({ number: 41, title: '[Workflow Phase] test-workflow / Fix', html_url: 'https://github.com/test/repo/issues/41', state: 'closed' }),
      ],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.phaseIssues).toHaveLength(2)
    expect(result.phaseIssues[0]).toEqual({ number: 40, phase: 'Scan', state: 'open', url: 'https://github.com/test/repo/issues/40' })
    expect(result.phaseIssues[1]).toEqual({ number: 41, phase: 'Fix', state: 'closed', url: 'https://github.com/test/repo/issues/41' })
  })

  it('extracts runId and status from run issue titles and bodies', async () => {
    const octokit = mockOctokit({
      proposal: [],
      review: [],
      split: [],
      phase: [],
      run: [
        mockIssue({
          number: 50,
          title: '[Workflow Run] test-workflow / run_001',
          html_url: 'https://github.com/test/repo/issues/50',
          body: 'status: completed\nmode: execute',
        }),
      ],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.runIssues).toHaveLength(1)
    expect(result.runIssues[0]).toEqual({ number: 50, runId: 'run_001', state: 'open', url: 'https://github.com/test/repo/issues/50', status: 'completed' })
  })

  it('finds improvement issues', async () => {
    const octokit = mockOctokit({
      proposal: [],
      review: [],
      split: [],
      phase: [],
      run: [],
      improvement: [
        mockIssue({ number: 60, title: '[Workflow Improvement] test-workflow', html_url: 'https://github.com/test/repo/issues/60' }),
      ],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.improvementIssues).toHaveLength(1)
    expect(result.improvementIssues[0]).toEqual({ number: 60, state: 'open', url: 'https://github.com/test/repo/issues/60' })
  })

  it('filters out PR-shaped items', async () => {
    const octokit = mockOctokit({
      proposal: [
        mockIssue({ number: 10, title: '[Workflow Proposal] test-workflow', pull_request: { url: 'https://api.github.com/repos/test/repo/pulls/10' } }),
      ],
      review: [],
      split: [],
      phase: [],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.proposalIssue).toBeUndefined()
  })

  it('filters issues by workflow name case-insensitively', async () => {
    const octokit = mockOctokit({
      proposal: [
        mockIssue({ number: 10, title: '[Workflow Proposal] TEST-WORKFLOW' }),
        mockIssue({ number: 11, title: '[Workflow Proposal] other-workflow' }),
      ],
      review: [],
      split: [],
      phase: [],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.proposalIssue?.number).toBe(10)
  })

  it('detects fallback dependency mode from phase issue bodies', async () => {
    const octokit = mockOctokit({
      proposal: [],
      review: [],
      split: [],
      phase: [
        mockIssue({
          number: 40,
          title: '[Workflow Phase] test-workflow / Scan',
          body: '<!-- workflow-dependency -->\nblocked_by: #41',
        }),
      ],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.dependencyMode).toBe('fallback')
    expect(result.phaseIssues[0]?.blockedBy).toEqual([41])
  })

  it('detects native dependency mode from blocked_by without fallback marker', async () => {
    const octokit = mockOctokit({
      proposal: [],
      review: [],
      split: [],
      phase: [
        mockIssue({
          number: 40,
          title: '[Workflow Phase] test-workflow / Scan',
          body: 'blocked_by: #41',
        }),
      ],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.dependencyMode).toBe('native')
    expect(result.phaseIssues[0]?.blockedBy).toEqual([41])
  })

  it('detects fallback sub-issue mode from split issue body', async () => {
    const octokit = mockOctokit({
      proposal: [],
      review: [],
      split: [
        mockIssue({
          number: 30,
          title: '[Workflow Split] test-workflow',
          body: '## Phase Sub-Issues\n- [ ] Phase 1',
        }),
      ],
      phase: [],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.subIssueMode).toBe('fallback')
  })

  it('detects native sub-issues and native issue dependencies from REST endpoints', async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockImplementation(({ labels }: { labels: string }) => {
          const key = labels.split(':')[1] as string
          const data = {
            split: [
              mockIssue({ number: 30, title: '[Workflow Split] test-workflow', body: '' }),
            ],
            phase: [
              mockIssue({ number: 40, title: '[Workflow Phase] test-workflow / Scan', body: '' }),
              mockIssue({ number: 41, title: '[Workflow Phase] test-workflow / Fix', body: '' }),
            ],
          }[key] ?? []
          return Promise.resolve({ data })
        }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      request: vi.fn().mockImplementation((route: string, params: { issue_number: number }) => {
        if (route.includes('/sub_issues')) {
          return Promise.resolve({ data: [{ number: 40 }, { number: 41 }] })
        }
        if (route.includes('/dependencies/blocked_by') && params.issue_number === 41) {
          return Promise.resolve({ data: [{ number: 40 }] })
        }
        return Promise.resolve({ data: [] })
      }),
    }

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.subIssueMode).toBe('native')
    expect(result.dependencyMode).toBe('native')
    expect(result.phaseIssues.map(p => p.trackingMode)).toEqual(['native', 'native'])
    expect(result.phaseIssues.find(p => p.number === 41)?.blockedBy).toEqual([40])
  })

  it('detects fallback sub-issue mode and reasons from parent fallback comments', async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockImplementation(({ labels }: { labels: string }) => {
          const key = labels.split(':')[1] as string
          const data = {
            split: [
              mockIssue({ number: 30, title: '[Workflow Split] test-workflow', body: '' }),
            ],
            phase: [
              mockIssue({ number: 40, title: '[Workflow Phase] test-workflow / Scan', body: '' }),
              mockIssue({ number: 41, title: '[Workflow Phase] test-workflow / Fix', body: '' }),
            ],
          }[key] ?? []
          return Promise.resolve({ data })
        }),
        listComments: vi.fn().mockImplementation(({ issue_number }: { issue_number: number }) => {
          if (issue_number === 30) {
            return Promise.resolve({
              data: [
                {
                  body: [
                    '<!-- workflow-link-fallback -->',
                    '## Phase Sub-Issues',
                    '- **Scan**: #40',
                    '- **Fix**: #41',
                    '',
                    '### Native Link Fallback Reasons',
                    '- sub-issue #40: native_sub_issues_unavailable_422',
                  ].join('\n'),
                },
              ],
            })
          }
          return Promise.resolve({ data: [] })
        }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      request: vi.fn().mockResolvedValue({ data: [] }),
    }

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.subIssueMode).toBe('fallback')
    expect(result.phaseIssues.map(p => p.trackingMode)).toEqual(['fallback', 'fallback'])
    expect(result.fallbackReasons).toContain('sub-issue #40: native_sub_issues_unavailable_422')
  })

  it('marks mixed sub-issue mode per phase issue', async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockImplementation(({ labels }: { labels: string }) => {
          const key = labels.split(':')[1] as string
          const data = {
            split: [
              mockIssue({ number: 30, title: '[Workflow Split] test-workflow', body: '' }),
            ],
            phase: [
              mockIssue({ number: 40, title: '[Workflow Phase] test-workflow / Scan', body: '' }),
              mockIssue({ number: 41, title: '[Workflow Phase] test-workflow / Fix', body: '' }),
            ],
          }[key] ?? []
          return Promise.resolve({ data })
        }),
        listComments: vi.fn().mockImplementation(({ issue_number }: { issue_number: number }) => {
          if (issue_number === 30) {
            return Promise.resolve({
              data: [
                {
                  body: [
                    '<!-- workflow-link-fallback -->',
                    '## Phase Sub-Issues',
                    '- **Fix**: #41',
                    '',
                    '### Native Link Fallback Reasons',
                    '- sub-issue #41: native_sub_issues_unavailable_422',
                  ].join('\n'),
                },
              ],
            })
          }
          return Promise.resolve({ data: [] })
        }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      request: vi.fn().mockImplementation((route: string) => {
        if (route.includes('/sub_issues')) {
          return Promise.resolve({ data: [{ number: 40 }] })
        }
        return Promise.resolve({ data: [] })
      }),
    }

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.subIssueMode).toBe('mixed')
    expect(result.phaseIssues.find(p => p.number === 40)?.trackingMode).toBe('native')
    expect(result.phaseIssues.find(p => p.number === 41)?.trackingMode).toBe('fallback')
  })

  it('finds linked PRs with workflow name in title', async () => {
    const octokit = mockOctokit(
      {
        proposal: [],
        review: [],
        split: [],
        phase: [],
        run: [],
        improvement: [],
      },
      [
        { number: 100, title: 'feat: add test-workflow', html_url: 'https://github.com/test/repo/pull/100', state: 'open' },
        { number: 101, title: 'chore: unrelated', html_url: 'https://github.com/test/repo/pull/101', state: 'closed' },
      ],
    )

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.linkedPRs).toHaveLength(1)
    expect(result.linkedPRs[0]).toEqual({ number: 100, state: 'open', url: 'https://github.com/test/repo/pull/100' })
  })

  it('handles multiple blocked_by values', async () => {
    const octokit = mockOctokit({
      proposal: [],
      review: [],
      split: [],
      phase: [
        mockIssue({
          number: 42,
          title: '[Workflow Phase] test-workflow / Final',
          body: 'blocked_by: #40, #41',
        }),
      ],
      run: [],
      improvement: [],
    })

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.phaseIssues[0]?.blockedBy).toEqual([40, 41])
  })

  it('handles API errors gracefully', async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockRejectedValue(new Error('rate limited')),
      },
      pulls: {
        list: vi.fn().mockRejectedValue(new Error('rate limited')),
      },
    }

    mockGetClient.mockResolvedValue({
      owner: 'test',
      repo: 'repo',
      octokit: octokit as unknown as import('../client.js').GitHubClient['octokit'],
      authMode: 'token',
      isDryRun: false,
    })

    const result = await fetchWorkflowLifecycleIssues('test-workflow')

    expect(result.proposalIssue).toBeUndefined()
    expect(result.phaseIssues).toHaveLength(0)
    expect(result.linkedPRs).toHaveLength(0)
  })
})
