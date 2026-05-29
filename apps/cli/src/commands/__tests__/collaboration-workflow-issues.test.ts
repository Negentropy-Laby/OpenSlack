import { describe, it, expect, vi } from 'vitest'
import { Command } from 'commander'
import { collaborationCommands } from '../collaboration.js'

vi.mock('@openslack/github', () => ({
  publishWorkflowProposal: vi.fn(),
  publishWorkflowReviewRequest: vi.fn(),
  publishWorkflowRunAudit: vi.fn(),
  publishWorkflowImprovement: vi.fn(),
  publishWorkflowSplit: vi.fn(),
  bootstrapWorkflowLabels: vi.fn(),
  finalizeWorkflowPR: vi.fn(),
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
})
