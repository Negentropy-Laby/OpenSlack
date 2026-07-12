// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowMetaShape {
  name: string
  version?: string
  description: string
  whenToUse?: string
  phases: Array<{ title: string; detail: string }>
  inputs?: Record<string, { type: 'string' | 'number' | 'boolean'; default?: unknown; description: string }>
  permissions?: { github?: string[]; git?: string[]; filesystem?: string[]; openslack?: string[] }
  sideEffects?: string[]
  forbidden?: string[]
  risk?: 'low' | 'medium' | 'high'
}

export interface WorkflowModuleShape {
  meta: WorkflowMetaShape
  format: string
  hash: string
  sourceBody?: string
  source?: string
}

export interface WorkflowRunStatusShape {
  runId: string
  workflowName: string
  mode: string
  status: string
  startedAt: string
  updatedAt?: string
  actor?: string
  workflowHash?: string
  currentPhase?: string
  phases?: Array<{ phase: string; timestamp: string; status: string; result?: unknown }>
  pendingApprovals?: Array<{ id: string; operation: string; detail: string; status: string }>
}

export interface WorkflowGovernanceIssue {
  schema: 'openslack.workflow_governance.v1'
  prNumber: number
  artifactFiles: string[]
  changeKind: 'added' | 'modified' | 'deleted' | 'mixed'
  baseSha: string
  headSha: string
  evidenceHash: string
  requestedBy: string
}

export function renderWorkflowGovernanceBody(issue: WorkflowGovernanceIssue): string {
  const lines = [
    `## Workflow Governance: PR #${issue.prNumber}`,
    '',
    '```openslack-workflow-governance',
    `schema: ${JSON.stringify(issue.schema)}`,
    `pr: ${issue.prNumber}`,
    `change_kind: ${JSON.stringify(issue.changeKind)}`,
    `base_sha: ${JSON.stringify(issue.baseSha)}`,
    `head_sha: ${JSON.stringify(issue.headSha)}`,
    `evidence_hash: ${JSON.stringify(issue.evidenceHash)}`,
    `requested_by: ${JSON.stringify(issue.requestedBy)}`,
    'artifact_files:',
    ...issue.artifactFiles.map((path) => `  - ${JSON.stringify(path)}`),
    '```',
    '',
    '### Human decision',
    '',
    'Record the decision once on the current PR head:',
    '',
    '```text',
    'Workflow-Trust: trusted|untrusted|core',
    '```',
    '',
    'The post-merge finalizer appends the reviewer, reviewed commit, trust level, and verified evidence hash.',
  ]
  return lines.join('\n')
}

export function workflowGovernanceLabels(): string[] {
  return ['workflow:governance']
}

// ── Workflow Proposal Issue ───────────────────────────────────────────────────

export interface WorkflowProposalIssue {
  schema: 'openslack.workflow_proposal.v1'
  workflowId: string
  format: 'claude-ambient' | 'openslack-native' | string
  sourcePath: string
  risk: 'low' | 'medium' | 'high'
  requestedBy: string
  permissions: { read: string[]; sideEffects: string[]; forbidden: string[] }
}

export function renderWorkflowProposalBody(proposal: WorkflowProposalIssue): string {
  const lines: string[] = []
  lines.push(`## Workflow Proposal: ${proposal.workflowId}`)
  lines.push('')
  lines.push('```openslack-workflow-proposal')
  lines.push(`schema: ${JSON.stringify(proposal.schema)}`)
  lines.push(`workflow_id: ${JSON.stringify(proposal.workflowId)}`)
  lines.push(`format: ${JSON.stringify(proposal.format)}`)
  lines.push(`source_path: ${JSON.stringify(proposal.sourcePath)}`)
  lines.push(`risk: ${JSON.stringify(proposal.risk)}`)
  lines.push(`requested_by: ${JSON.stringify(proposal.requestedBy)}`)
  lines.push('permissions:')
  lines.push('  read:')
  for (const r of proposal.permissions.read) lines.push(`    - ${r}`)
  if (proposal.permissions.sideEffects.length > 0) {
    lines.push('  side_effects:')
    for (const s of proposal.permissions.sideEffects) lines.push(`    - ${s}`)
  }
  if (proposal.permissions.forbidden.length > 0) {
    lines.push('  forbidden:')
    for (const f of proposal.permissions.forbidden) lines.push(`    - ${f}`)
  }
  lines.push('```')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('### Review Checklist')
  lines.push('- [ ] Meta is a pure object literal')
  lines.push('- [ ] No forbidden APIs used')
  lines.push('- [ ] Permissions are minimal')
  lines.push('- [ ] Side effects are declared')
  lines.push('- [ ] Trust level is appropriate')
  lines.push('')
  lines.push('### Trust Decision')
  lines.push('<!-- After review, record the trust decision below -->')
  lines.push('<!-- Trust decision: untrusted | trusted | core -->')
  lines.push('<!-- PR: #... -->')
  lines.push('<!-- Hash: sha256:... -->')
  return lines.join('\n')
}

export function workflowProposalLabels(risk: string, format: string): string[] {
  const labels = ['workflow:proposal']
  if (risk) labels.push(`risk:${risk}`)
  if (format === 'claude-ambient') labels.push('workflow:claude-ambient')
  else if (format === 'openslack-native') labels.push('workflow:openslack-native')
  return labels
}

// ── Workflow Review Issue ─────────────────────────────────────────────────────

export interface WorkflowReviewIssue {
  schema: 'openslack.workflow_review.v1'
  workflowId: string
  workflowHash: string
  trustLevel: string
  staticAnalysis: {
    pureMeta: boolean
    hasForbiddenApis: boolean
    minPermissions: boolean
    declaredSideEffects: boolean
  }
}

export function renderWorkflowReviewBody(review: WorkflowReviewIssue): string {
  const lines: string[] = []
  lines.push(`## Workflow Review: ${review.workflowId}`)
  lines.push('')
  lines.push('```openslack-workflow-review')
  lines.push(`schema: ${JSON.stringify(review.schema)}`)
  lines.push(`workflow_id: ${JSON.stringify(review.workflowId)}`)
  lines.push(`workflow_hash: ${JSON.stringify(review.workflowHash)}`)
  lines.push(`trust_level: ${JSON.stringify(review.trustLevel)}`)
  lines.push('static_analysis:')
  lines.push(`  pure_meta: ${review.staticAnalysis.pureMeta}`)
  lines.push(`  has_forbidden_apis: ${review.staticAnalysis.hasForbiddenApis}`)
  lines.push(`  min_permissions: ${review.staticAnalysis.minPermissions}`)
  lines.push(`  declared_side_effects: ${review.staticAnalysis.declaredSideEffects}`)
  lines.push('```')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('### Security Review Checklist')
  lines.push('')
  lines.push('| Criterion | Status |')
  lines.push('|-----------|--------|')
  lines.push(`| Meta is pure literal | ${review.staticAnalysis.pureMeta ? 'PASS' : 'FAIL'} |`)
  lines.push(`| No forbidden APIs | ${review.staticAnalysis.hasForbiddenApis ? 'FAIL' : 'PASS'} |`)
  lines.push(`| Minimal permissions | ${review.staticAnalysis.minPermissions ? 'PASS' : 'FAIL'} |`)
  lines.push(`| Declared side effects | ${review.staticAnalysis.declaredSideEffects ? 'PASS' : 'FAIL'} |`)
  lines.push('')
  lines.push('### Decision')
  lines.push('<!-- Record the final trust decision here -->')
  lines.push('<!-- Example: Trust decision: trusted. PR: #123. Hash: sha256:abc... -->')
  return lines.join('\n')
}

export function workflowReviewLabels(trustLevel: string): string[] {
  const labels = ['workflow:review']
  if (trustLevel) labels.push(`workflow:${trustLevel}`)
  return labels
}

// ── Workflow Run Issue ────────────────────────────────────────────────────────

export interface WorkflowRunIssue {
  schema: 'openslack.workflow_run.v1'
  runId: string
  workflowId: string
  workflowHash: string
  mode: string
  actor: string
  startedAt: string
  status: string
}

export function renderWorkflowRunBody(run: WorkflowRunIssue): string {
  const lines: string[] = []
  lines.push(`## Workflow Run: ${run.workflowId}`)
  lines.push('')
  lines.push('```openslack-workflow-run')
  lines.push(`schema: ${JSON.stringify(run.schema)}`)
  lines.push(`run_id: ${JSON.stringify(run.runId)}`)
  lines.push(`workflow_id: ${JSON.stringify(run.workflowId)}`)
  lines.push(`workflow_hash: ${JSON.stringify(run.workflowHash)}`)
  lines.push(`mode: ${JSON.stringify(run.mode)}`)
  lines.push(`actor: ${JSON.stringify(run.actor)}`)
  lines.push(`started_at: ${JSON.stringify(run.startedAt)}`)
  lines.push(`status: ${JSON.stringify(run.status)}`)
  lines.push('```')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('### Phase Log')
  lines.push('<!-- Phase completion comments will be appended below -->')
  return lines.join('\n')
}

export function renderWorkflowRunPhaseComment(
  phase: string,
  status: string,
  details?: string,
  timestamp?: string,
): string {
  const emoji = status === 'completed' ? '✅' : status === 'failed' ? '❌' : status === 'paused' ? '⏸️' : '🔄'
  const lines: string[] = []
  lines.push(`**${emoji} Phase ${phase}** — ${status}`)
  if (details) lines.push(details)
  lines.push(`<sub>Logged at ${timestamp || new Date().toISOString()}</sub>`)
  return lines.join('\n')
}

export function workflowRunLabels(mode: string, status: string): string[] {
  const labels = ['workflow:run']
  if (mode) labels.push(`mode:${mode}`)
  if (status) labels.push(`result:${status}`)
  return labels
}

// ── Workflow Improvement Issue ────────────────────────────────────────────────

export interface WorkflowImprovementIssue {
  schema: 'openslack.workflow_improvement.v1'
  workflowId: string
  problem: string
  proposedChange: string
  affectedPhases: string[]
  backwardCompatible: boolean
}

export function renderWorkflowImprovementBody(improvement: WorkflowImprovementIssue): string {
  const lines: string[] = []
  lines.push(`## Workflow Improvement: ${improvement.workflowId}`)
  lines.push('')
  lines.push('```openslack-workflow-improvement')
  lines.push(`schema: ${JSON.stringify(improvement.schema)}`)
  lines.push(`workflow_id: ${JSON.stringify(improvement.workflowId)}`)
  lines.push(`backward_compatible: ${JSON.stringify(improvement.backwardCompatible)}`)
  if (improvement.affectedPhases.length > 0) {
    lines.push('affected_phases:')
    for (const p of improvement.affectedPhases) lines.push(`  - ${p}`)
  }
  lines.push('```')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('### Problem')
  lines.push(improvement.problem)
  lines.push('')
  lines.push('### Proposed Change')
  lines.push(improvement.proposedChange)
  lines.push('')
  lines.push('### Related PR')
  lines.push('<!-- Link the PR that implements this improvement -->')
  return lines.join('\n')
}

export function workflowImprovementLabels(): string[] {
  return ['workflow:improvement']
}

// ── Workflow Split Issue ──────────────────────────────────────────────────────

export interface WorkflowSplitIssue {
  schema: 'openslack.workflow_split.v1'
  workflowId: string
  parentIssue?: number
  phaseNames: string[]
}

export function renderWorkflowSplitBody(split: WorkflowSplitIssue): string {
  const lines: string[] = []
  lines.push(`## Workflow Split: ${split.workflowId}`)
  lines.push('')
  lines.push('```openslack-workflow-split')
  lines.push(`schema: ${JSON.stringify(split.schema)}`)
  lines.push(`workflow_id: ${JSON.stringify(split.workflowId)}`)
  if (split.parentIssue) lines.push(`parent_issue: ${JSON.stringify(split.parentIssue)}`)
  lines.push('phases:')
  for (const p of split.phaseNames) lines.push(`  - ${p}`)
  lines.push('```')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('### Phase Decomposition')
  lines.push('')
  lines.push('| Phase | Sub-Issue | Status |')
  lines.push('|-------|-----------|--------|')
  for (const p of split.phaseNames) {
    lines.push(`| ${p} | <!-- issue number --> | <!-- status --> |`)
  }
  lines.push('')
  lines.push('### Dependencies')
  lines.push('<!-- Use GitHub sub-issues and dependencies to encode execution order -->')
  return lines.join('\n')
}

export function renderWorkflowPhaseSubIssueBody(
  workflowId: string,
  phaseName: string,
  parentIssue: number,
): string {
  const lines: string[] = []
  lines.push(`## Workflow Phase: ${workflowId} / ${phaseName}`)
  lines.push('')
  lines.push(`This is a sub-issue of #${parentIssue} (Workflow Split).`)
  lines.push('')
  lines.push('### Scope')
  lines.push(`Implement the **${phaseName}** phase as a reusable workflow or module.`)
  lines.push('')
  lines.push('### Acceptance Criteria')
  lines.push('- [ ] Phase logic is self-contained')
  lines.push('- [ ] Can be imported and composed by the parent workflow')
  lines.push('- [ ] Tests cover the phase independently')
  lines.push('')
  lines.push('### Parent')
  lines.push(`- #${parentIssue}`)
  return lines.join('\n')
}

export function workflowSplitLabels(): string[] {
  return ['workflow:split']
}

export function workflowPhaseLabels(): string[] {
  return ['workflow:phase']
}

// ── Label Definitions ─────────────────────────────────────────────────────────

export const WORKFLOW_LABEL_DEFINITIONS: Array<{ name: string; color: string; description: string }> = [
  { name: 'workflow:governance', color: 'b60205', description: 'Workflow artifact governance evidence' },
  { name: 'workflow:proposal', color: '0366d6', description: 'Workflow proposal issue' },
  { name: 'workflow:review', color: 'd73a4a', description: 'Workflow security review' },
  { name: 'workflow:run', color: '28a745', description: 'Workflow run audit log' },
  { name: 'workflow:improvement', color: 'ffd54f', description: 'Workflow improvement request' },
  { name: 'workflow:split', color: '6f42c1', description: 'Workflow phase decomposition' },
  { name: 'workflow:phase', color: '8bc34a', description: 'Individual workflow phase' },
  { name: 'workflow:trusted', color: '28a745', description: 'Trusted workflow' },
  { name: 'workflow:untrusted', color: 'd73a4a', description: 'Untrusted workflow' },
  { name: 'workflow:core', color: '5319e7', description: 'Core workflow governed by CODEOWNERS' },
  { name: 'workflow:claude-ambient', color: '0366d6', description: 'Claude ambient DSL workflow' },
  { name: 'workflow:openslack-native', color: '6f42c1', description: 'OpenSlack native workflow' },
  { name: 'workflow:paused', color: 'ffd54f', description: 'Workflow run paused' },
  { name: 'workflow:needs-approval', color: 'd73a4a', description: 'Workflow pending approval' },
  { name: 'workflow:needs-prms', color: '6f42c1', description: 'Workflow needs PRMS check' },
  { name: 'workflow:deprecated', color: '959da5', description: 'Deprecated workflow' },
  { name: 'risk:low', color: '28a745', description: 'Low risk' },
  { name: 'risk:medium', color: 'ffd54f', description: 'Medium risk' },
  { name: 'risk:high', color: 'd73a4a', description: 'High risk' },
  { name: 'mode:preview', color: '0366d6', description: 'Preview mode' },
  { name: 'mode:dry-run', color: '6f42c1', description: 'Dry-run mode' },
  { name: 'mode:execute', color: 'd73a4a', description: 'Execute mode' },
  { name: 'result:completed', color: '28a745', description: 'Run completed' },
  { name: 'result:failed', color: 'd73a4a', description: 'Run failed' },
  { name: 'result:paused', color: 'ffd54f', description: 'Run paused' },
  { name: 'result:cancelled', color: '959da5', description: 'Run cancelled' },
  { name: 'workflow:blocked', color: 'd73a4a', description: 'Phase is blocked by another issue' },
  { name: 'workflow:dependency', color: '6f42c1', description: 'Has dependency relationships' },
  { name: 'lifecycle:proposed', color: '0366d6', description: 'Workflow is in proposed state' },
  { name: 'lifecycle:under-review', color: 'ffd54f', description: 'Workflow is under review' },
  { name: 'lifecycle:implementing', color: '6f42c1', description: 'Workflow is being implemented' },
  { name: 'lifecycle:accepted', color: '28a745', description: 'Workflow has been accepted' },
  { name: 'lifecycle:completed', color: '28a745', description: 'Workflow lifecycle completed' },
]
