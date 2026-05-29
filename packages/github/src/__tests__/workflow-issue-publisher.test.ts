import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the client module before importing the publisher
vi.mock('../client.js', () => ({
  getClient: vi.fn(),
}))

vi.mock('../issue-tasks.js', () => ({
  createTaskIssue: vi.fn(),
}))

import { getClient } from '../client.js'
import { createTaskIssue } from '../issue-tasks.js'
import {
  publishWorkflowProposal,
  publishWorkflowReviewRequest,
  publishWorkflowRunAudit,
  publishWorkflowSplit,
  bootstrapWorkflowLabels,
} from '../workflow-issue-publisher.js'
import type { WorkflowModuleShape } from '../workflow-issues.js'

const mockGetClient = vi.mocked(getClient)
const mockCreateTaskIssue = vi.mocked(createTaskIssue)

describe('workflow issue publishers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockModule(overrides?: Partial<WorkflowModuleShape>): WorkflowModuleShape {
    return {
      meta: {
        name: 'test-workflow',
        description: 'A test workflow',
        phases: [
          { title: 'Scan', detail: 'Scan for issues' },
          { title: 'Fix', detail: 'Fix issues' },
        ],
        risk: 'medium',
        permissions: { github: ['issues.read'], git: ['branch.create'] },
        sideEffects: ['github.issue.create'],
        forbidden: ['github.pr.approve'],
      },
      format: 'claude-ambient',
      hash: 'sha256:abc123',
      sourceBody: 'export const meta = { name: "test-workflow" }',
      source: 'claude-project',
      ...overrides,
    }
  }

  describe('publishWorkflowProposal', () => {
    it('creates a proposal issue with correct labels', async () => {
      mockCreateTaskIssue.mockResolvedValue({ issueNumber: 42, url: 'https://github.com/test/42', nodeId: 'node_42' })

      const result = await publishWorkflowProposal(mockModule(), {
        requestedBy: 'test-user',
        extraLabels: ['custom:label'],
      })

      expect(result.issueNumber).toBe(42)
      expect(result.url).toBe('https://github.com/test/42')
      expect(mockCreateTaskIssue).toHaveBeenCalledWith(
        '[Workflow Proposal] test-workflow',
        expect.stringContaining('## Workflow Proposal: test-workflow'),
        expect.arrayContaining(['workflow:proposal', 'risk:medium', 'workflow:claude-ambient', 'custom:label']),
      )
    })

    it('infers openslack-native format', async () => {
      mockCreateTaskIssue.mockResolvedValue({ issueNumber: 1, url: 'https://github.com/test/1', nodeId: 'node_1' })

      await publishWorkflowProposal(mockModule({ format: 'openslack-native', sourceBody: undefined }), {
        requestedBy: 'test-user',
      })

      const labels = mockCreateTaskIssue.mock.calls[0]?.[2] as string[]
      expect(labels).toContain('workflow:openslack-native')
    })
  })

  describe('publishWorkflowReviewRequest', () => {
    it('creates a review issue with analysis results', async () => {
      mockCreateTaskIssue.mockResolvedValue({ issueNumber: 43, url: 'https://github.com/test/43', nodeId: 'node_43' })

      const result = await publishWorkflowReviewRequest(mockModule(), {
        requestedBy: 'test-user',
        trustLevel: 'trusted',
      })

      expect(result.issueNumber).toBe(43)
      expect(mockCreateTaskIssue).toHaveBeenCalledWith(
        '[Workflow Review] test-workflow',
        expect.stringContaining('## Workflow Review: test-workflow'),
        expect.arrayContaining(['workflow:review', 'workflow:trusted']),
      )
    })

    it('detects forbidden APIs in source body', async () => {
      mockCreateTaskIssue.mockResolvedValue({ issueNumber: 1, url: '', nodeId: '' })

      await publishWorkflowReviewRequest(
        mockModule({ sourceBody: 'const x = process.env.SECRET' }),
        { requestedBy: 'test', trustLevel: 'untrusted' },
      )

      const body = mockCreateTaskIssue.mock.calls[0]?.[1] as string
      expect(body).toContain('has_forbidden_apis: true')
    })
  })

  describe('publishWorkflowRunAudit', () => {
    it('creates a new run audit issue', async () => {
      mockCreateTaskIssue.mockResolvedValue({ issueNumber: 44, url: 'https://github.com/test/44', nodeId: 'node_44' })

      const result = await publishWorkflowRunAudit(
        {
          runId: 'run_001',
          workflowName: 'test-workflow',
          mode: 'execute',
          status: 'completed',
          startedAt: '2026-05-30T00:00:00Z',
        },
        { createIssue: true },
      )

      expect(result.issueNumber).toBe(44)
      expect(result.isComment).toBe(false)
      expect(mockCreateTaskIssue).toHaveBeenCalledWith(
        '[Workflow Run] test-workflow / run_001',
        expect.stringContaining('run_id: "run_001"'),
        expect.arrayContaining(['workflow:run', 'mode:execute', 'result:completed']),
      )
    })

    it('appends comment to existing issue', async () => {
      const mockOctokit = { issues: { createComment: vi.fn().mockResolvedValue({ data: { html_url: 'https://github.com/test/42#comment' } }) } }
      mockGetClient.mockResolvedValue({
        owner: 'test',
        repo: 'repo',
        octokit: mockOctokit as unknown as import('../client.js').GitHubClient['octokit'],
        authMode: 'token',
        isDryRun: false,
      })

      const result = await publishWorkflowRunAudit(
        {
          runId: 'run_001',
          workflowName: 'test-workflow',
          mode: 'execute',
          status: 'completed',
          startedAt: '2026-05-30T00:00:00Z',
        },
        { issueNumber: 42 },
      )

      expect(result.issueNumber).toBe(42)
      expect(result.isComment).toBe(true)
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 42 }),
      )
    })

    it('works in dry-run mode for new issues', async () => {
      mockCreateTaskIssue.mockResolvedValue({ issueNumber: 0, url: '', nodeId: '' })

      const result = await publishWorkflowRunAudit(
        { runId: 'run_001', workflowName: 'test', mode: 'dry-run', status: 'completed', startedAt: '2026-05-30T00:00:00Z' },
        { createIssue: true },
      )

      expect(result.issueNumber).toBe(0)
    })
  })

  describe('publishWorkflowSplit', () => {
    it('creates parent and sub-issues', async () => {
      mockCreateTaskIssue
        .mockResolvedValueOnce({ issueNumber: 100, url: 'https://github.com/test/100', nodeId: 'node_100' })
        .mockResolvedValueOnce({ issueNumber: 101, url: 'https://github.com/test/101', nodeId: 'node_101' })
        .mockResolvedValueOnce({ issueNumber: 102, url: 'https://github.com/test/102', nodeId: 'node_102' })

      const result = await publishWorkflowSplit(mockModule(), {})

      expect(result.parentIssueNumber).toBe(100)
      expect(result.subIssues).toHaveLength(2)
      expect(result.subIssues[0]?.phase).toBe('Scan')
      expect(result.subIssues[1]?.phase).toBe('Fix')
      expect(mockCreateTaskIssue).toHaveBeenCalledTimes(3)
    })

    it('uses provided parent issue', async () => {
      mockCreateTaskIssue
        .mockResolvedValueOnce({ issueNumber: 201, url: 'https://github.com/test/201', nodeId: 'node_201' })
        .mockResolvedValueOnce({ issueNumber: 202, url: 'https://github.com/test/202', nodeId: 'node_202' })

      const result = await publishWorkflowSplit(mockModule(), { parentIssue: 99 })

      expect(result.parentIssueNumber).toBe(99)
      expect(mockCreateTaskIssue).toHaveBeenCalledTimes(2)
    })
  })

  describe('bootstrapWorkflowLabels', () => {
    it('creates labels in normal mode', async () => {
      const mockOctokit = { issues: { createLabel: vi.fn().mockResolvedValue({}) } }
      mockGetClient.mockResolvedValue({
        owner: 'test',
        repo: 'repo',
        octokit: mockOctokit as unknown as import('../client.js').GitHubClient['octokit'],
        authMode: 'token',
        isDryRun: false,
      })

      const result = await bootstrapWorkflowLabels()

      expect(result.created.length).toBeGreaterThan(0)
      expect(mockOctokit.issues.createLabel).toHaveBeenCalledTimes(24)
    })

    it('skips existing labels', async () => {
      const mockOctokit = {
        issues: {
          createLabel: vi.fn().mockRejectedValue(new Error('already_exists')),
        },
      }
      mockGetClient.mockResolvedValue({
        owner: 'test',
        repo: 'repo',
        octokit: mockOctokit as unknown as import('../client.js').GitHubClient['octokit'],
        authMode: 'token',
        isDryRun: false,
      })

      const result = await bootstrapWorkflowLabels()

      expect(result.created).toHaveLength(0)
      expect(result.existing.length).toBe(24)
    })

    it('works in dry-run mode', async () => {
      mockGetClient.mockResolvedValue({
        owner: 'test',
        repo: 'repo',
        octokit: {} as unknown as import('../client.js').GitHubClient['octokit'],
        authMode: 'dry_run',
        isDryRun: true,
      })

      const result = await bootstrapWorkflowLabels()

      expect(result.created.length).toBe(24)
      expect(result.existing).toHaveLength(0)
    })
  })
})
