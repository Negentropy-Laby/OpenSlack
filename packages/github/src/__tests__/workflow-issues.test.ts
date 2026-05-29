import { describe, it, expect } from 'vitest'
import {
  renderWorkflowProposalBody,
  renderWorkflowReviewBody,
  renderWorkflowRunBody,
  renderWorkflowRunPhaseComment,
  renderWorkflowImprovementBody,
  renderWorkflowSplitBody,
  renderWorkflowPhaseSubIssueBody,
  workflowProposalLabels,
  workflowReviewLabels,
  workflowRunLabels,
  workflowImprovementLabels,
  workflowSplitLabels,
  workflowPhaseLabels,
  WORKFLOW_LABEL_DEFINITIONS,
} from '../workflow-issues.js'
import type {
  WorkflowProposalIssue,
  WorkflowReviewIssue,
  WorkflowRunIssue,
  WorkflowImprovementIssue,
  WorkflowSplitIssue,
} from '../workflow-issues.js'

describe('workflow issue renderers', () => {
  describe('renderWorkflowProposalBody', () => {
    it('renders a proposal with all fields', () => {
      const proposal: WorkflowProposalIssue = {
        schema: 'openslack.workflow_proposal.v1',
        workflowId: 'full-lifecycle',
        format: 'claude-ambient',
        sourcePath: '.claude/workflows/full-lifecycle.js',
        risk: 'high',
        requestedBy: 'wsman',
        permissions: {
          read: ['repo.files', 'github.issues'],
          sideEffects: ['github.issue.create', 'git.branch.create'],
          forbidden: ['github.pr.approve'],
        },
      }
      const body = renderWorkflowProposalBody(proposal)
      expect(body).toContain('## Workflow Proposal: full-lifecycle')
      expect(body).toContain('```openslack-workflow-proposal')
      expect(body).toContain('workflow_id: full-lifecycle')
      expect(body).toContain('format: claude-ambient')
      expect(body).toContain('risk: high')
      expect(body).toContain('repo.files')
      expect(body).toContain('github.issue.create')
      expect(body).toContain('github.pr.approve')
      expect(body).toContain('### Review Checklist')
    })

    it('renders a proposal with empty side effects and forbidden', () => {
      const proposal: WorkflowProposalIssue = {
        schema: 'openslack.workflow_proposal.v1',
        workflowId: 'simple',
        format: 'openslack-native',
        sourcePath: '.openslack/workflows/simple.ts',
        risk: 'low',
        requestedBy: 'bot',
        permissions: { read: ['repo.files'], sideEffects: [], forbidden: [] },
      }
      const body = renderWorkflowProposalBody(proposal)
      expect(body).toContain('schema: openslack.workflow_proposal.v1')
      expect(body).not.toContain('side_effects:')
      expect(body).not.toContain('forbidden:')
    })
  })

  describe('renderWorkflowReviewBody', () => {
    it('renders a review with analysis results', () => {
      const review: WorkflowReviewIssue = {
        schema: 'openslack.workflow_review.v1',
        workflowId: 'full-lifecycle',
        workflowHash: 'sha256:abc123',
        trustLevel: 'untrusted',
        staticAnalysis: {
          pureMeta: true,
          hasForbiddenApis: false,
          minPermissions: true,
          declaredSideEffects: true,
        },
      }
      const body = renderWorkflowReviewBody(review)
      expect(body).toContain('## Workflow Review: full-lifecycle')
      expect(body).toContain('workflow_hash: sha256:abc123')
      expect(body).toContain('trust_level: untrusted')
      expect(body).toContain('| Meta is pure literal | PASS |')
      expect(body).toContain('| No forbidden APIs | PASS |')
      expect(body).toContain('```openslack-workflow-review')
    })

    it('shows FAIL for failed checks', () => {
      const review: WorkflowReviewIssue = {
        schema: 'openslack.workflow_review.v1',
        workflowId: 'bad',
        workflowHash: 'sha256:bad',
        trustLevel: 'untrusted',
        staticAnalysis: {
          pureMeta: false,
          hasForbiddenApis: true,
          minPermissions: false,
          declaredSideEffects: false,
        },
      }
      const body = renderWorkflowReviewBody(review)
      expect(body).toContain('| Meta is pure literal | FAIL |')
      expect(body).toContain('| No forbidden APIs | FAIL |')
      expect(body).toContain('| Minimal permissions | FAIL |')
      expect(body).toContain('| Declared side effects | FAIL |')
    })
  })

  describe('renderWorkflowRunBody', () => {
    it('renders run metadata', () => {
      const run: WorkflowRunIssue = {
        schema: 'openslack.workflow_run.v1',
        runId: 'run_20260530_001',
        workflowId: 'full-lifecycle',
        workflowHash: 'sha256:abc',
        mode: 'execute',
        actor: 'openslack-agent-operator',
        startedAt: '2026-05-30T00:00:00Z',
        status: 'running',
      }
      const body = renderWorkflowRunBody(run)
      expect(body).toContain('## Workflow Run: full-lifecycle')
      expect(body).toContain('run_id: run_20260530_001')
      expect(body).toContain('mode: execute')
      expect(body).toContain('status: running')
      expect(body).toContain('### Phase Log')
    })
  })

  describe('renderWorkflowRunPhaseComment', () => {
    it('renders completed phase with checkmark', () => {
      const comment = renderWorkflowRunPhaseComment('Scan', 'completed')
      expect(comment).toContain('✅')
      expect(comment).toContain('Phase Scan')
      expect(comment).toContain('completed')
    })

    it('renders failed phase with x', () => {
      const comment = renderWorkflowRunPhaseComment('Verify', 'failed', 'timeout')
      expect(comment).toContain('❌')
      expect(comment).toContain('timeout')
    })

    it('renders paused phase with pause symbol', () => {
      const comment = renderWorkflowRunPhaseComment('Implement', 'paused')
      expect(comment).toContain('⏸️')
    })
  })

  describe('renderWorkflowImprovementBody', () => {
    it('renders improvement with affected phases', () => {
      const improvement: WorkflowImprovementIssue = {
        schema: 'openslack.workflow_improvement.v1',
        workflowId: 'full-lifecycle',
        problem: 'Verify phase is too slow',
        proposedChange: 'Split Verify into parallel checks',
        affectedPhases: ['Verify', 'Triage'],
        backwardCompatible: true,
      }
      const body = renderWorkflowImprovementBody(improvement)
      expect(body).toContain('## Workflow Improvement: full-lifecycle')
      expect(body).toContain('### Problem')
      expect(body).toContain('Verify phase is too slow')
      expect(body).toContain('### Proposed Change')
      expect(body).toContain('Split Verify into parallel checks')
      expect(body).toContain('affected_phases:')
      expect(body).toContain('backward_compatible: true')
    })
  })

  describe('renderWorkflowSplitBody', () => {
    it('renders split with phase table', () => {
      const split: WorkflowSplitIssue = {
        schema: 'openslack.workflow_split.v1',
        workflowId: 'full-lifecycle',
        parentIssue: 42,
        phaseNames: ['Scan', 'Verify', 'Triage'],
      }
      const body = renderWorkflowSplitBody(split)
      expect(body).toContain('## Workflow Split: full-lifecycle')
      expect(body).toContain('parent_issue: 42')
      expect(body).toContain('| Phase | Sub-Issue | Status |')
      expect(body).toContain('| Scan |')
    })
  })

  describe('renderWorkflowPhaseSubIssueBody', () => {
    it('renders phase sub-issue with parent link', () => {
      const body = renderWorkflowPhaseSubIssueBody('full-lifecycle', 'Scan', 42)
      expect(body).toContain('## Workflow Phase: full-lifecycle / Scan')
      expect(body).toContain('#42')
      expect(body).toContain('Scope')
      expect(body).toContain('Acceptance Criteria')
    })
  })

  describe('label builders', () => {
    it('workflowProposalLabels includes risk and format', () => {
      expect(workflowProposalLabels('high', 'claude-ambient')).toEqual([
        'workflow:proposal',
        'risk:high',
        'workflow:claude-ambient',
      ])
      expect(workflowProposalLabels('low', 'openslack-native')).toEqual([
        'workflow:proposal',
        'risk:low',
        'workflow:openslack-native',
      ])
    })

    it('workflowReviewLabels includes trust level', () => {
      expect(workflowReviewLabels('trusted')).toEqual([
        'workflow:review',
        'workflow:trusted',
      ])
    })

    it('workflowRunLabels includes mode and status', () => {
      expect(workflowRunLabels('execute', 'completed')).toEqual([
        'workflow:run',
        'mode:execute',
        'result:completed',
      ])
    })

    it('workflowImprovementLabels is constant', () => {
      expect(workflowImprovementLabels()).toEqual(['workflow:improvement'])
    })

    it('workflowSplitLabels is constant', () => {
      expect(workflowSplitLabels()).toEqual(['workflow:split'])
    })

    it('workflowPhaseLabels is constant', () => {
      expect(workflowPhaseLabels()).toEqual(['workflow:phase'])
    })
  })

  describe('WORKFLOW_LABEL_DEFINITIONS', () => {
    it('contains all required labels', () => {
      const names = WORKFLOW_LABEL_DEFINITIONS.map((l) => l.name)
      expect(names).toContain('workflow:proposal')
      expect(names).toContain('workflow:review')
      expect(names).toContain('workflow:run')
      expect(names).toContain('workflow:split')
      expect(names).toContain('risk:high')
      expect(names).toContain('mode:execute')
      expect(names).toContain('result:completed')
      expect(names).toHaveLength(24)
    })

    it('every label has a 6-character hex color', () => {
      for (const def of WORKFLOW_LABEL_DEFINITIONS) {
        expect(def.color).toMatch(/^[0-9a-fA-F]{6}$/)
        expect(def.description.length).toBeGreaterThan(0)
      }
    })
  })
})
