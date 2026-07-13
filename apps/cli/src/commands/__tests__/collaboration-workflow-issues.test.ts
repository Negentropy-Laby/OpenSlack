import { beforeEach, describe, it, expect, vi } from 'vitest'
import { Command } from 'commander'
import { collaborationCommands } from '../collaboration.js'

const hoisted = vi.hoisted(() => ({
  evaluateWorkflowGate: vi.fn(),
  fetchPRDetails: vi.fn(),
  finalizeWorkflowPR: vi.fn(),
  loadPRCodeownerEvidence: vi.fn(),
}))

vi.mock('@openslack/github', () => ({
  publishWorkflowProposal: vi.fn(),
  publishWorkflowReviewRequest: vi.fn(),
  publishWorkflowRunAudit: vi.fn(),
  publishWorkflowImprovement: vi.fn(),
  publishWorkflowSplit: vi.fn(),
  bootstrapWorkflowLabels: vi.fn(),
  finalizeWorkflowPR: (...args: unknown[]) => hoisted.finalizeWorkflowPR(...args),
}))

vi.mock('@openslack/pr', () => ({
  evaluateWorkflowGate: (...args: unknown[]) => hoisted.evaluateWorkflowGate(...args),
  fetchPRDetails: (...args: unknown[]) => hoisted.fetchPRDetails(...args),
  loadPRCodeownerEvidence: (...args: unknown[]) => hoisted.loadPRCodeownerEvidence(...args),
}))

vi.mock('@openslack/workflows', () => ({
  findWorkflow: vi.fn(),
  loadWorkflow: vi.fn(),
  discoverJsWorkflows: vi.fn().mockResolvedValue([]),
  discoverYamlTemplates: vi.fn().mockResolvedValue([]),
  executePreview: vi.fn(),
  executeDryRun: vi.fn(),
  executeRun: vi.fn(),
  executeResume: vi.fn(),
  RunStore: vi.fn().mockImplementation(() => ({
    loadMeta: vi.fn().mockResolvedValue(null),
    getRunStatus: vi.fn().mockResolvedValue(null),
    listRunsByStatus: vi.fn().mockResolvedValue([]),
  })),
  checkResumable: vi.fn(),
  prepareResume: vi.fn(),
  renderRunHtml: vi.fn(),
  renderRunJson: vi.fn(),
  renderRunMarkdown: vi.fn(),
  listWorkflowPatterns: vi.fn().mockReturnValue([]),
  getWorkflowPattern: vi.fn(),
  renderWorkflowPattern: vi.fn(),
  generateWorkflowDraft: vi.fn(),
  previewWorkflowDraft: vi.fn(),
  renderWorkflowDraftPreview: vi.fn(),
  readWorkflowPolicy: vi.fn().mockReturnValue({ enabled: true, ultracode: false, maxConcurrency: 16, maxAgentsPerRun: 1000, source: 'default' }),
  writeWorkflowPolicy: vi.fn(),
  renderWorkflowPolicy: vi.fn(),
  listWorkflowRuns: vi.fn().mockResolvedValue([]),
  showWorkflowRun: vi.fn(),
  controlWorkflowRun: vi.fn(),
  renderWorkflowRuns: vi.fn(),
  renderWorkflowRun: vi.fn(),
  saveWorkflow: vi.fn(),
  exportWorkflowSkill: vi.fn(),
  TrustStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue('untrusted'),
    set: vi.fn(),
    save: vi.fn(),
    list: vi.fn().mockReturnValue({}),
  })),
  resolveTrustLevel: vi.fn().mockReturnValue('untrusted'),
  getPermissionsForTrustLevel: vi.fn().mockReturnValue(new Set(['read'])),
}))

describe('collaboration workflow issue commands', () => {
  function createTestProgram(): Command {
    const program = new Command()
    program.addCommand(collaborationCommands())
    return program
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
  })

  it('workflow publish command exists', () => {
    const program = createTestProgram()
    const publish = program.commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'publish')
    expect(publish).toBeDefined()
    expect(publish?.description()).toContain('proposal')
  })

  it('workflow review-request command exists', () => {
    const program = createTestProgram()
    const review = program.commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'review-request')
    expect(review).toBeDefined()
    expect(review?.description()).toContain('review')
  })

  it('workflow audit-run command exists', () => {
    const program = createTestProgram()
    const audit = program.commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'audit-run')
    expect(audit).toBeDefined()
    expect(audit?.description()).toContain('audit')
  })

  it('workflow split command exists', () => {
    const program = createTestProgram()
    const split = program.commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'split')
    expect(split).toBeDefined()
    expect(split?.description()).toContain('Split')
  })

  it('workflow labels command exists', () => {
    const program = createTestProgram()
    const labels = program.commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'labels')
    expect(labels).toBeDefined()
    expect(labels?.description()).toContain('labels')
  })

  it('workflow improvement command exists', () => {
    const program = createTestProgram()
    const improvement = program.commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'improvement')
    expect(improvement).toBeDefined()
    expect(improvement?.description()).toContain('improvement')
  })

  it('workflow finalize-pr command exists', () => {
    const program = createTestProgram()
    const finalize = program.commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'finalize-pr')
    expect(finalize).toBeDefined()
    expect(finalize?.description()).toContain('Finalize')
  })

  it('exits nonzero and does not report completion when a GitHub finalizer write fails', async () => {
    const workflowEvidence = {
      schema: 'openslack.workflow-evidence.v1',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      evidenceHash: 'sha256:evidence',
      artifactFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      addedFiles: [],
      modifiedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      deletedFiles: [],
      changeKind: 'modified',
    }
    hoisted.fetchPRDetails.mockResolvedValue({
      prNumber: 185,
      author: 'openslack-agent-operator[bot]',
      body: 'Workflow governance #186',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      changedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      reviews: [],
      workflowEvidence,
    })
    hoisted.loadPRCodeownerEvidence.mockResolvedValue({
      ref: 'base-sha',
      owners: ['@wsman'],
      entries: [],
    })
    hoisted.evaluateWorkflowGate.mockReturnValue({
      overall: 'PASS',
      evidenceHash: 'sha256:evidence',
      trustDecision: 'core',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
      governanceIssue: 186,
    })
    hoisted.finalizeWorkflowPR.mockResolvedValue({
      closedIssues: [],
      commentedIssues: [186],
      updatedLabels: [],
      errors: ['Failed to finalize governance issue #186: write failed'],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previousExitCode = process.exitCode
    process.exitCode = undefined

    try {
      await createTestProgram().parseAsync([
        'node',
        'test',
        'collaboration',
        'workflow',
        'finalize-pr',
        '185',
        '--governance-issue',
        '186',
        '--hash',
        'sha256:evidence',
        '--trust',
        'core',
      ])

      expect(process.exitCode).toBe(1)
      expect(hoisted.finalizeWorkflowPR).toHaveBeenCalledWith(185, {
        governanceIssue: 186,
        proposalIssue: undefined,
        reviewIssue: undefined,
        phaseIssues: undefined,
        workflowHash: 'sha256:evidence',
        trustDecision: 'core',
        trustReviewer: 'wsman',
        trustReviewCommitOid: 'head-sha',
      })
      expect(log.mock.calls.flat().join('\n')).toContain('Failed to finalize workflow PR #185')
      expect(log.mock.calls.flat().join('\n')).not.toContain('finalize complete')
    } finally {
      process.exitCode = previousExitCode
      log.mockRestore()
    }
  })

  it.each([
    ['hash', ['--governance-issue', '186', '--hash', 'sha256:wrong', '--trust', 'core']],
    ['trust', ['--governance-issue', '186', '--hash', 'sha256:evidence', '--trust', 'trusted']],
    ['issue', ['--governance-issue', '187', '--hash', 'sha256:evidence', '--trust', 'core']],
  ])('rejects a CLI %s override before any finalizer write', async (_name, overrides) => {
    hoisted.fetchPRDetails.mockResolvedValue({
      prNumber: 185,
      author: 'openslack-agent-operator[bot]',
      body: 'Workflow governance #186',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      changedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      reviews: [],
      workflowEvidence: {
        schema: 'openslack.workflow-evidence.v1',
        baseSha: 'base-sha',
        headSha: 'head-sha',
        evidenceHash: 'sha256:evidence',
        artifactFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
        addedFiles: [],
        modifiedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
        deletedFiles: [],
        changeKind: 'modified',
      },
    })
    hoisted.loadPRCodeownerEvidence.mockResolvedValue({
      ref: 'base-sha',
      owners: ['@wsman'],
      entries: [],
    })
    hoisted.evaluateWorkflowGate.mockReturnValue({
      overall: 'PASS',
      evidenceHash: 'sha256:evidence',
      trustDecision: 'core',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
      governanceIssue: 186,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await createTestProgram().parseAsync([
        'node',
        'test',
        'collaboration',
        'workflow',
        'finalize-pr',
        '185',
        ...overrides,
      ])

      expect(process.exitCode).toBe(1)
      expect(hoisted.finalizeWorkflowPR).not.toHaveBeenCalled()
      expect(log.mock.calls.flat().join('\n')).toContain('Cannot override')
    } finally {
      log.mockRestore()
    }
  })

  it('dynamic workflow parity commands exist', () => {
    const workflow = createTestProgram().commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
    const names = workflow?.commands.map((c) => c.name()) ?? []
    expect(names).toEqual(expect.arrayContaining([
      'patterns',
      'generate',
      'preview-draft',
      'runs',
      'config',
      'save',
      'export-skill',
    ]))
  })
})
