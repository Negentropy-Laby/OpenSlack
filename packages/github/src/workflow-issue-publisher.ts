import { getClient } from './client.js'
import { createTaskIssue } from './issue-tasks.js'
import type {
  WorkflowModuleShape,
  WorkflowRunStatusShape,
  WorkflowProposalIssue,
  WorkflowReviewIssue,
  WorkflowRunIssue,
  WorkflowImprovementIssue,
  WorkflowSplitIssue,
} from './workflow-issues.js'
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
} from './workflow-issues.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPermissions(meta: WorkflowModuleShape['meta']): { read: string[]; sideEffects: string[]; forbidden: string[] } {
  const read: string[] = []
  const sideEffects: string[] = []
  const forbidden: string[] = []

  if (meta.permissions) {
    for (const [cat, actions] of Object.entries(meta.permissions)) {
      if (Array.isArray(actions)) {
        for (const a of actions) {
          read.push(`${cat}.${a}`)
        }
      }
    }
  }
  if (meta.sideEffects) {
    for (const s of meta.sideEffects) sideEffects.push(s)
  }
  if (meta.forbidden) {
    for (const f of meta.forbidden) forbidden.push(f)
  }

  return { read, sideEffects, forbidden }
}

function extractSourcePath(_meta: WorkflowModuleShape['meta'], module: WorkflowModuleShape): string {
  // Best-effort source path inference
  if (module.source === 'builtin') return 'builtins/'
  if (module.source === 'openslack-project') return `.openslack/workflows/${module.meta.name}`
  if (module.source === 'claude-project') return `.claude/workflows/${module.meta.name}`
  if (module.source === 'claude-user') return `~/.claude/workflows/${module.meta.name}`
  return 'unknown'
}

function inferFormat(module: WorkflowModuleShape): string {
  if (module.format === 'claude-ambient') return 'claude-ambient'
  if (module.format === 'openslack-native') return 'openslack-native'
  if (module.sourceBody) return 'claude-ambient'
  return 'openslack-native'
}

// ── Publish Workflow Proposal ─────────────────────────────────────────────────

export async function publishWorkflowProposal(
  workflow: WorkflowModuleShape,
  opts: { requestedBy: string; extraLabels?: string[] },
): Promise<{ issueNumber: number; url: string }> {
  const perms = extractPermissions(workflow.meta)
  const proposal: WorkflowProposalIssue = {
    schema: 'openslack.workflow_proposal.v1',
    workflowId: workflow.meta.name,
    format: inferFormat(workflow),
    sourcePath: extractSourcePath(workflow.meta, workflow),
    risk: workflow.meta.risk ?? 'medium',
    requestedBy: opts.requestedBy,
    permissions: perms,
  }

  const title = `[Workflow Proposal] ${workflow.meta.name}`
  const body = renderWorkflowProposalBody(proposal)
  const labels = workflowProposalLabels(proposal.risk, proposal.format)
  if (opts.extraLabels) labels.push(...opts.extraLabels)

  const result = await createTaskIssue(title, body, labels)
  return { issueNumber: result.issueNumber, url: result.url }
}

// ── Publish Workflow Review Request ───────────────────────────────────────────

export async function publishWorkflowReviewRequest(
  workflow: WorkflowModuleShape,
  opts: { requestedBy: string; trustLevel: string },
): Promise<{ issueNumber: number; url: string }> {
  // Run lightweight static analysis on sourceBody if available
  const source = workflow.sourceBody ?? ''
  const hasForbiddenApis = checkForbiddenApis(source)
  const declaredSideEffects = (workflow.meta.sideEffects?.length ?? 0) > 0
  const minPermissions = checkMinPermissions(workflow.meta)

  const review: WorkflowReviewIssue = {
    schema: 'openslack.workflow_review.v1',
    workflowId: workflow.meta.name,
    workflowHash: workflow.hash,
    trustLevel: opts.trustLevel,
    staticAnalysis: {
      pureMeta: true, // loadWorkflow already enforces this
      hasForbiddenApis,
      minPermissions,
      declaredSideEffects,
    },
  }

  const title = `[Workflow Review] ${workflow.meta.name}`
  const body = renderWorkflowReviewBody(review)
  const labels = workflowReviewLabels(opts.trustLevel)

  const result = await createTaskIssue(title, body, labels)
  return { issueNumber: result.issueNumber, url: result.url }
}

function stripCommentsAndStrings(source: string): string {
  let cleaned = source.replace(/\/\/.*$/gm, '')
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '')
  cleaned = cleaned.replace(/\`(?:[^\`\\]|\\.)*\`/g, '').replace(/'(?:[^'\\]|\\.)*'/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '')
  return cleaned
}

function checkForbiddenApis(source: string): boolean {
  const cleaned = stripCommentsAndStrings(source)
  const forbiddenPatterns = [
    /\bprocess\.env/,
    /\brequire\s*\(/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\bchild_process/,
    /\bfs\./,
    /\bfetch\s*\(/,
  ]
  return forbiddenPatterns.some((p) => p.test(cleaned))
}

function checkMinPermissions(meta: WorkflowModuleShape['meta']): boolean {
  if (!meta.permissions) return false
  const hasRead = Object.values(meta.permissions).some((arr) => Array.isArray(arr) && arr.length > 0)
  return hasRead
}

// ── Publish Workflow Run Audit ────────────────────────────────────────────────

export async function publishWorkflowRunAudit(
  runStatus: WorkflowRunStatusShape,
  opts: { issueNumber?: number; createIssue?: boolean },
): Promise<{ issueNumber: number; url: string; isComment: boolean }> {
  const runIssue: WorkflowRunIssue = {
    schema: 'openslack.workflow_run.v1',
    runId: runStatus.runId,
    workflowId: runStatus.workflowName,
    workflowHash: runStatus.workflowHash ?? '',
    mode: runStatus.mode,
    actor: runStatus.actor ?? 'openslack-agent-operator',
    startedAt: runStatus.startedAt,
    status: runStatus.status,
  }

  // Append as comment to existing issue
  if (opts.issueNumber) {
    const client = await getClient()
    const body = renderWorkflowRunBody(runIssue)

    if (client.isDryRun) {
      console.log(`[DRY RUN] Would append run audit comment to issue #${opts.issueNumber}`)
      return { issueNumber: opts.issueNumber, url: '', isComment: true }
    }

    const { data } = await client.octokit.issues.createComment({
      owner: client.owner,
      repo: client.repo,
      issue_number: opts.issueNumber,
      body,
    })

    return { issueNumber: opts.issueNumber, url: data.html_url, isComment: true }
  }

  if (opts.createIssue === false) {
    throw new Error('No issue number provided and createIssue is false. Cannot create audit record.')
  }

  // Create new issue
  const title = `[Workflow Run] ${runStatus.workflowName} / ${runStatus.runId}`
  const body = renderWorkflowRunBody(runIssue)
  const labels = workflowRunLabels(runStatus.mode, runStatus.status)

  const result = await createTaskIssue(title, body, labels)
  return { issueNumber: result.issueNumber, url: result.url, isComment: false }
}

export async function appendWorkflowRunPhaseComment(
  issueNumber: number,
  phase: string,
  status: string,
  details?: string,
  timestamp?: string,
): Promise<{ url: string }> {
  const client = await getClient()
  const body = renderWorkflowRunPhaseComment(phase, status, details, timestamp)

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would append phase comment to issue #${issueNumber}: ${phase} = ${status}`)
    return { url: '' }
  }

  const { data } = await client.octokit.issues.createComment({
    owner: client.owner,
    repo: client.repo,
    issue_number: issueNumber,
    body,
  })

  return { url: data.html_url }
}

// ── Publish Workflow Improvement ──────────────────────────────────────────────

export async function publishWorkflowImprovement(
  improvement: WorkflowImprovementIssue,
): Promise<{ issueNumber: number; url: string }> {
  let title = `[Workflow Improvement] ${improvement.workflowId}: ${improvement.proposedChange.slice(0, 60)}`
  const MAX_TITLE = 256
  if (title.length > MAX_TITLE) {
    title = title.slice(0, MAX_TITLE - 3) + '...'
  }
  const body = renderWorkflowImprovementBody(improvement)
  const labels = workflowImprovementLabels()

  const result = await createTaskIssue(title, body, labels)
  return { issueNumber: result.issueNumber, url: result.url }
}

// ── Publish Workflow Split ────────────────────────────────────────────────────

export interface PhaseSubIssue {
  phase: string
  issueNumber: number
  url: string
}

export async function publishWorkflowSplit(
  workflow: WorkflowModuleShape,
  opts: { parentIssue?: number; phaseNames?: string[] },
): Promise<{ parentIssueNumber: number; subIssues: PhaseSubIssue[] }> {
  const phaseNames = opts.phaseNames ?? workflow.meta.phases.map((p) => p.title)
  const parentIssueNum = opts.parentIssue ?? 0

  const split: WorkflowSplitIssue = {
    schema: 'openslack.workflow_split.v1',
    workflowId: workflow.meta.name,
    parentIssue: parentIssueNum > 0 ? parentIssueNum : undefined,
    phaseNames,
  }

  // Create or reuse parent issue
  let actualParentIssue = parentIssueNum
  if (actualParentIssue === 0) {
    const title = `[Workflow Split] ${workflow.meta.name}`
    const body = renderWorkflowSplitBody(split)
    const labels = workflowSplitLabels()
    const result = await createTaskIssue(title, body, labels)
    actualParentIssue = result.issueNumber
  }

  // Create sub-issues for each phase
  const subIssues: PhaseSubIssue[] = []
  for (const phase of phaseNames) {
    const title = `[Workflow Phase] ${workflow.meta.name} / ${phase}`
    const body = renderWorkflowPhaseSubIssueBody(workflow.meta.name, phase, actualParentIssue)
    const labels = workflowPhaseLabels()

    const result = await createTaskIssue(title, body, labels)
    subIssues.push({ phase, issueNumber: result.issueNumber, url: result.url })
  }

  return { parentIssueNumber: actualParentIssue, subIssues }
}

// ── Label Bootstrap ───────────────────────────────────────────────────────────

export async function bootstrapWorkflowLabels(): Promise<{
  created: string[]
  existing: string[]
  failed: Array<{ name: string; reason: string }>
}> {
  const { WORKFLOW_LABEL_DEFINITIONS } = await import('./workflow-issues.js')
  const client = await getClient()

  const created: string[] = []
  const existing: string[] = []
  const failed: Array<{ name: string; reason: string }> = []

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would create ${WORKFLOW_LABEL_DEFINITIONS.length} workflow labels`)
    return {
      created: WORKFLOW_LABEL_DEFINITIONS.map((l) => l.name),
      existing: [],
      failed: [],
    }
  }

  for (const def of WORKFLOW_LABEL_DEFINITIONS) {
    try {
      await client.octokit.issues.createLabel({
        owner: client.owner,
        repo: client.repo,
        name: def.name,
        color: def.color,
        description: def.description,
      })
      created.push(def.name)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 422) {
        existing.push(def.name)
      } else {
        failed.push({ name: def.name, reason: (err as Error).message })
      }
    }
  }

  return { created, existing, failed }
}
