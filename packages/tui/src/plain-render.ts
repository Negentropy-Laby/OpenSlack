/**
 * plain-render.ts -- Plain-text fallback renderer for terminals without TUI support.
 *
 * All output is ASCII-only (no box-drawing characters), word-wrapped at the requested width,
 * and uses text labels like [PASS] [FAIL] [WARN] instead of color. CJK characters
 * are preserved as-is since they are valid Unicode content, not decorative glyphs.
 */

import type { HomeViewModel } from './view-models/home.js'
import type { DoctorViewModel } from './view-models/doctor.js'
import type { PrQueueViewModel } from './view-models/pr-queue.js'
import type { ProfileViewModel } from './view-models/profile.js'
import { mapCanonicalStages } from './view-models/workflow-lifecycle.js'
import type { WorkflowLifecycleViewModel } from './view-models/workflow-lifecycle.js'
import type { WorkflowGalleryViewModel } from './view-models/workflow-gallery.js'
import type { DashboardViewModel } from './view-models/dashboard.js'
import { visibleWidth, wrapVisible, wrapIndentVisible } from './layout/index.js'

const MAX_WIDTH = 80

/** Word-wrap a line to MAX_WIDTH, preserving existing newlines. */
function wrap(text: string, width: number = MAX_WIDTH): string {
  if (visibleWidth(text) <= width) return text
  return wrapVisible(text, width)
}

/** Wrap but indent subsequent lines by `indent` spaces. */
function wrapIndent(text: string, indent: number, width: number = MAX_WIDTH): string {
  const inner = width - indent
  if (inner <= 0 || visibleWidth(text) <= inner) return text
  return wrapIndentVisible(text, indent, width)
}

function separator(char = '-', width: number = MAX_WIDTH): string {
  return char.repeat(width)
}

function statusLabel(status: string): string {
  const upper = status.toUpperCase()
  if (upper === 'PASS' || upper === 'SUCCESS' || upper === 'COMPLETE') return '[PASS]'
  if (upper === 'FAIL' || upper === 'FAILED' || upper === 'ERROR') return '[FAIL]'
  if (upper === 'WARN' || upper === 'WARNING' || upper === 'PENDING') return '[WARN]'
  return '[INFO]'
}

function syncStatusLabel(status: string): string {
  switch (status) {
    case 'synced': return '[SYNCED]'
    case 'pending': return '[PENDING]'
    case 'failed': return '[FAILED]'
    case 'never': return '[NEVER]'
    default: return '[UNKNOWN]'
  }
}

function canonicalStatusLabel(status: string): string {
  switch (status) {
    case 'complete': return '[DONE]'
    case 'current': return '[ACTIVE]'
    case 'failed': return '[FAILED]'
    case 'pending': return '[ ]'
    default: return '[ ]'
  }
}

// --- Renderers ---

export function renderPlainHome(vm: HomeViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = []
  lines.push(separator('=', width))
  lines.push('OpenSlack Home')
  lines.push(separator('=', width))
  lines.push('')

  // Attention items
  if (vm.attentionItems.length > 0) {
    lines.push('Attention:')
    for (const item of vm.attentionItems) {
      lines.push(wrap(`  ! ${item.label}`, width))
      if (item.detail) {
        lines.push(wrapIndent(`    ${item.detail}`, 4, width))
      }
    }
    lines.push('')
  } else {
    lines.push(wrap('All clear -- nothing needs attention right now.', width))
    lines.push('')
  }

  // Tasks
  if (vm.tasks.length > 0) {
    lines.push('What do you want to do?')
    vm.tasks.forEach((t) => {
      const badge = t.attentionBadge ? ` (${t.attentionBadge})` : ''
      lines.push(wrap(`  [${t.shortcut}] ${t.label}${badge}`, width))
      lines.push(wrapIndent(`     ${t.description}`, 5, width))
    })
    lines.push('')
  }

  // Next recommended action
  if (vm.nextRecommendedAction) {
    lines.push('Next Recommended Action:')
    lines.push('  > ' + vm.nextRecommendedAction.label)
    lines.push(wrapIndent('    ' + vm.nextRecommendedAction.reason, 4))
    lines.push('')
  }

  // Navigation
  if (vm.navItems.length > 0) {
    lines.push('Quick Navigation:')
    for (const nav of vm.navItems) {
      lines.push(wrap(`  [${nav.shortcut}] ${nav.label}`, width))
    }
    lines.push('')
  }

  lines.push(wrap(`System: ${vm.systemStatus}`, width))
  lines.push(separator('-', width))
  return lines.join('\n')
}

export function renderPlainDoctor(vm: DoctorViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = []
  lines.push(separator('=', width))
  lines.push(`PR Doctor -- #${vm.prNumber}`)
  lines.push(separator('=', width))

  lines.push(wrap(`Title: ${vm.title}`, width))
  lines.push(wrap(`Author: ${vm.author}`, width))
  lines.push(wrap(`State: ${vm.state}  Draft: ${vm.draft ? 'yes' : 'no'}`, width))
  lines.push(wrap(`Risk Zone: ${vm.riskZone.toUpperCase()}`, width))
  lines.push(wrap(`Mergeable: ${vm.mergeable ? 'yes' : 'no'}`, width))
  lines.push(wrap(`Decision: ${vm.decision}`, width))
  if (vm.reason) lines.push(wrap(`Reason: ${vm.reason}`, width))
  if (vm.recommendation) lines.push(wrap(`Recommendation: ${vm.recommendation}`, width))
  lines.push('')

  // Compressed summary
  if (vm.compressed) {
    const canMerge = vm.decision === 'READY_TO_MERGE' && vm.mergeable
    lines.push('Compressed Summary:')
    lines.push(`  Can merge? ${canMerge ? 'YES' : 'NO'}`)
    if (!canMerge) {
      const blocker = vm.gates.find(g => g.status === 'FAIL' || g.status === 'WARN')
      if (blocker) {
        lines.push(wrap(`  Blocker: ${blocker.name} -- ${blocker.detail}`, width))
      }
      lines.push(wrap(`  Why: ${vm.reason}`, width))
    }
    lines.push(wrap(`  Next action: openslack pr doctor ${vm.prNumber}`, width))
    lines.push('')
  }

  // Gates
  lines.push('Gates:')
  for (const gate of vm.gates) {
    lines.push(wrap(`  ${statusLabel(gate.status)} ${gate.name}: ${gate.detail}`, width))
  }
  lines.push('')

  // Checks
  if (vm.checks.length > 0) {
    lines.push('Checks:')
    for (const check of vm.checks) {
      lines.push(wrap(`  ${statusLabel(check.status)} ${check.name} (${check.conclusion})`, width))
    }
    lines.push('')
  }

  // Reviews
  if (vm.reviews.length > 0) {
    lines.push('Reviews:')
    for (const review of vm.reviews) {
      const valid = review.valid ? 'valid' : 'not valid'
      lines.push(wrap(`  ${review.user}: ${review.state} (${valid})`, width))
    }
    lines.push('')
  }

  // Evidence
  if (vm.evidence.length > 0) {
    lines.push('Evidence:')
    for (const e of vm.evidence) {
      lines.push(wrapIndent(`  - ${e}`, 4, width))
    }
    lines.push('')
  }

  // Profile Sync Gate
  if (vm.profileSyncGate) {
    lines.push('Profile Sync Gate:')
    lines.push(wrap(`  ${vm.profileSyncGate.passed ? '[PASS]' : '[FAIL]'} ${vm.profileSyncGate.detail}`, width))
    lines.push('')
  }

  lines.push(separator('-', width))
  return lines.join('\n')
}

export function renderPlainPrQueue(vm: PrQueueViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = []
  lines.push(separator('=', width))
  lines.push('PR Queue')
  lines.push(separator('=', width))
  lines.push(wrap(`Total: ${vm.totalPRs}  Ready: ${vm.readyCount}  Blocked: ${vm.blockedCount}  Pending: ${vm.pendingCount}`, width))
  lines.push('')

  if (vm.items.length === 0) {
    lines.push('No open PRs.')
  }

  for (const item of vm.items) {
    const status = item.canMerge ? '[READY]' : '[BLOCKED]'
    lines.push(wrap(`${status} #${item.prNumber} ${item.title}`, width))
    lines.push(wrap(`  Author: ${item.author}  Zone: ${item.riskZone.toUpperCase()}  Owner: ${item.owner}`, width))
    lines.push(wrap(`  Decision: ${item.decision}  Blocker: ${item.blockerCategory}`, width))
    if (item.workflowGate.touched) {
      const gateLabel = item.workflowGate.overall === 'PASS' ? '[PASS]' : item.workflowGate.overall === 'FAIL' ? '[FAIL]' : '[N/A]'
      lines.push(wrap(`  Workflow Gate: ${gateLabel}`, width))
      for (const c of item.workflowGate.criteria) {
        lines.push(wrap(`    ${c.passed ? '[PASS]' : '[FAIL]'} ${c.name}`, width))
      }
    }
    lines.push(wrapIndent(`  Next: ${item.nextAction}`, 4, width))
    lines.push(wrap(`  Rerun: ${item.rerunCommand}`, width))
    lines.push('')
  }

  lines.push(separator('-', width))
  return lines.join('\n')
}

export function renderPlainProfile(vm: ProfileViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = []
  lines.push(separator('=', width))
  lines.push(vm.title)
  lines.push(separator('=', width))

  lines.push(wrap(`Target: ${vm.targetRepo}/${vm.targetPath}`, width))
  lines.push(wrap(`Marker: ${vm.marker} (${vm.markerStatus})`, width))
  lines.push(wrap(`Sync Status: ${syncStatusLabel(vm.syncStatus)} ${vm.syncStatus}`, width))
  lines.push(wrap(`Mode: ${vm.mode}`, width))
  if (vm.lastSyncDate) lines.push(wrap(`Last Sync: ${vm.lastSyncDate}`, width))
  if (vm.lastPrUrl) lines.push(wrap(`Last PR: ${vm.lastPrUrl}`, width))
  lines.push('')

  // Failure details
  if (vm.failureDetails) {
    lines.push('FAILURE DETAILS:')
    lines.push(wrapIndent(`  Reason: ${vm.failureDetails.reason}`, 4, width))
    lines.push(wrapIndent(`  Next Action: ${vm.failureDetails.nextAction}`, 4, width))
    lines.push('')
  }

  // Sync details
  if (vm.syncDetails) {
    lines.push('Sync Details:')
    if (vm.syncDetails.sourceCommit) lines.push(wrap(`  Source Commit: ${vm.syncDetails.sourceCommit}`, width))
    if (vm.syncDetails.sourceDate) lines.push(wrap(`  Source Date: ${vm.syncDetails.sourceDate}`, width))
    if (vm.syncDetails.targetHash) lines.push(wrap(`  Target Hash: ${vm.syncDetails.targetHash}`, width))
    if (vm.syncDetails.pendingPR) {
      lines.push(wrap(`  Pending PR: #${vm.syncDetails.pendingPR.number} (${vm.syncDetails.pendingPR.status})`, width))
    }
    if (vm.syncDetails.lastSync) {
      const resultLabel = vm.syncDetails.lastSync.result === 'success' ? '[PASS]' : vm.syncDetails.lastSync.result === 'failed' ? '[FAIL]' : '[INFO]'
      lines.push(wrap(`  Last Sync: ${resultLabel} ${vm.syncDetails.lastSync.timestamp}`, width))
    }
    lines.push('')
  }

  // Pending PR
  if (vm.pendingPR) {
    lines.push(wrap(`Pending PR: #${vm.pendingPR.number}`, width))
    lines.push(wrap(`  URL: ${vm.pendingPR.url}`, width))
    lines.push(wrap(`  Branch: ${vm.pendingPR.branch}`, width))
    lines.push('')
  }

  // Validation summary
  lines.push(wrap(`Validation: ${vm.validationSummary.total} total, ${vm.validationSummary.published} published, ${vm.validationSummary.failed} failed`, width))
  lines.push('')

  // Posts
  if (vm.posts.length > 0) {
    lines.push('Posts:')
    for (const post of vm.posts) {
      lines.push(wrap(`  - ${post.title} (${post.date})`, width))
      if (post.summary) lines.push(wrapIndent(`    ${post.summary}`, 4, width))
    }
    lines.push('')
  }

  // Actions
  if (vm.actions.length > 0) {
    lines.push('Actions:')
    for (const action of vm.actions) {
      lines.push(wrap(`  [${action.key}] ${action.label} -- ${action.description} (risk: ${action.risk})`, width))
    }
    lines.push('')
  }

  // Action result
  if (vm.actionResult) {
    const resultLabel = vm.actionResult.success ? '[PASS]' : '[FAIL]'
    lines.push(wrap(`Last Action: ${resultLabel} ${vm.actionResult.actionId}`, width))
    lines.push(wrapIndent(vm.actionResult.message, 2, width))
    lines.push('')
  }

  lines.push(separator('-', width))
  return lines.join('\n')
}

export function renderPlainWorkflowLifecycle(vm: WorkflowLifecycleViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = []
  lines.push(separator('=', width))
  lines.push('Workflow Lifecycle')
  lines.push(separator('=', width))

  lines.push(wrap(`Workflow: ${vm.workflowName}`, width))
  lines.push(wrap(`Hash: ${vm.workflowHash}`, width))
  lines.push(wrap(`Trust: ${vm.trustLevel}  Risk: ${vm.risk}`, width))
  lines.push(wrap(`Source: ${vm.sourcePath}`, width))
  lines.push('')

  // Current run
  if (vm.currentRun) {
    lines.push('Current Run:')
    lines.push(wrap(`  Run ID: ${vm.currentRun.runId}`, width))
    lines.push(wrap(`  Status: ${vm.currentRun.status}`, width))
    lines.push(wrap(`  Started: ${vm.currentRun.startedAt}`, width))
    lines.push(wrap(`  Phase: ${vm.currentRun.phaseIndex}`, width))
    lines.push('')
  }

  // PR
  if (vm.prNumber !== undefined) {
    lines.push(wrap(`PR: #${vm.prNumber}${vm.prStatus ? ` (${vm.prStatus})` : ''}`, width))
    lines.push('')
  }

  // Canonical stages (horizontal progress)
  if (vm.stages.length > 0) {
    lines.push('Canonical Stages:')
    const canonical = mapCanonicalStages(vm.stages)
    for (const slot of canonical) {
      const label = canonicalStatusLabel(slot.status)
      const issue = slot.issueNumber ? ` (#${slot.issueNumber})` : ''
      lines.push(wrap(`  ${label} ${slot.label}${issue}`, width))
    }
    lines.push('')
  }

  // Detailed stages
  if (vm.stages.length > 0) {
    lines.push('Stages:')
    for (const stage of vm.stages) {
      lines.push(wrap(`  ${statusLabel(stage.status)} ${stage.label} [${stage.name}]`, width))
      if (stage.detail) lines.push(wrapIndent(`    ${stage.detail}`, 4, width))
      if (stage.issueNumber) lines.push(wrap(`    Issue: #${stage.issueNumber}`, width))
    }
    lines.push('')
  }

  // Phase issues
  if (vm.phaseIssues.length > 0) {
    lines.push('Phase Issues:')
    for (const pi of vm.phaseIssues) {
      const blocked = pi.blockedBy && pi.blockedBy.length > 0 ? ` (blocked by: ${pi.blockedBy.join(', ')})` : ''
      lines.push(wrap(`  #${pi.issueNumber ?? '?'} ${pi.phase} -- ${pi.status}${blocked}`, width))
    }
    lines.push('')
  }

  if (vm.nextAction) {
    lines.push(wrap(`Next: ${vm.nextAction}`, width))
    lines.push('')
  }

  // Status summary
  if (vm.statusSummary) {
    lines.push(wrap(`Status: ${vm.statusSummary}`, width))
    lines.push('')
  }

  // Blocked gate items
  if (vm.blockedGateItems && vm.blockedGateItems.length > 0) {
    lines.push('Blocked Gates:')
    const gateIndent = '  [FAIL] '.length
    for (const g of vm.blockedGateItems) {
      lines.push(`  [FAIL] ${g.gate}: ${g.detail}`)
      if (g.action) lines.push(wrapIndent(`${' '.repeat(gateIndent)}Fix: ${g.action}`, gateIndent, width))
    }
    lines.push('')
  }

  // Modes
  if (vm.subIssueMode) lines.push(wrap(`Sub-issue mode: ${vm.subIssueMode}`, width))
  if (vm.dependencyMode) lines.push(wrap(`Dependency mode: ${vm.dependencyMode}`, width))
  if (vm.fallbackReasons && vm.fallbackReasons.length > 0) {
    lines.push('Fallback reasons:')
    for (const r of vm.fallbackReasons) {
      lines.push(wrapIndent(`  - ${r}`, 4, width))
    }
  }

  lines.push(separator('-', width))
  return lines.join('\n')
}

export function renderPlainWorkflowWorkbench(vm: WorkflowGalleryViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = []
  lines.push(separator('=', width))
  lines.push('Workflow Workbench')
  lines.push(separator('=', width))
  lines.push(wrap(`Total: ${vm.summary.total}  YAML: ${vm.summary.yaml}  JS: ${vm.summary.js}`, width))
  lines.push('')

  if (vm.workflows.length === 0) {
    lines.push('No workflows found.')
  }

  for (const wf of vm.workflows) {
    const runStatus = wf.lastRunStatus ? ` Last run: ${wf.lastRunStatus}` : ''
    lines.push(wrap(`  ${wf.name} (${wf.format})`, width))
    lines.push(wrap(`    Trust: ${wf.trustLevel}  Risk: ${wf.risk}  Phases: ${wf.phases}${runStatus}`, width))
    if (wf.description) {
      lines.push(wrapIndent(`    ${wf.description}`, 4, width))
    }
    lines.push('')
  }

  lines.push(separator('-', width))
  return lines.join('\n')
}

export function renderPlainDashboard(vm: DashboardViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = []
  lines.push(separator('=', width))
  lines.push(vm.title)
  lines.push(separator('=', width))
  lines.push(wrap(`Generated: ${vm.generatedAt}`, width))
  lines.push(wrap(`Blockers: ${vm.summary.blockers}  Handoffs: ${vm.summary.handoffs}  Decisions: ${vm.summary.decisions}`, width))
  lines.push('')

  // Blockers
  if (vm.blockers.length > 0) {
    lines.push('Blockers:')
    for (const b of vm.blockers) {
      const owner = b.owner ? ` (owner: ${b.owner})` : ''
      lines.push(wrapIndent(`  [!!] ${b.object}: ${b.summary}${owner}`, 4, width))
      if (b.nextAction) lines.push(wrapIndent(`       Next: ${b.nextAction}`, 8, width))
    }
    lines.push('')
  }

  // Handoffs
  if (vm.handoffs.length > 0) {
    lines.push('Open Handoffs:')
    for (const h of vm.handoffs) {
      lines.push(wrap(`  ${h.from} -> ${h.to} (${h.status}, ${h.age})`, width))
      lines.push(wrapIndent(`    ${h.context}`, 4, width))
    }
    lines.push('')
  }

  // Decisions
  if (vm.decisions.length > 0) {
    lines.push('Active Decisions:')
    for (const d of vm.decisions) {
      lines.push(wrap(`  ${d.topic} (${d.status}, by: ${d.decidedBy})`, width))
    }
    lines.push('')
  }

  // Recent activity
  if (vm.recentActivity.length > 0) {
    lines.push('Recent Activity:')
    for (const a of vm.recentActivity) {
      lines.push(wrapIndent(`  [${a.time}] ${a.type} -- ${a.summary} (${a.actor})`, 4, width))
    }
    lines.push('')
  }

  lines.push(separator('-', width))
  return lines.join('\n')
}

/**
 * Render plain output for a given view name and view model.
 * Used by the CLI fallback path.
 */
export function renderPlain(viewName: string, vm: unknown, width: number = MAX_WIDTH): string {
  switch (viewName) {
    case 'home': return renderPlainHome(vm as HomeViewModel, width)
    case 'doctor': return renderPlainDoctor(vm as DoctorViewModel, width)
    case 'pr-queue': return renderPlainPrQueue(vm as PrQueueViewModel, width)
    case 'profile': return renderPlainProfile(vm as ProfileViewModel, width)
    case 'workflow-lifecycle': return renderPlainWorkflowLifecycle(vm as WorkflowLifecycleViewModel, width)
    case 'workflow-workbench': return renderPlainWorkflowWorkbench(vm as WorkflowGalleryViewModel, width)
    case 'dashboard': return renderPlainDashboard(vm as DashboardViewModel, width)
    default: return `Plain rendering not available for view: ${viewName}`
  }
}
