/**
 * plain-render.ts -- Plain-text fallback renderer for terminals without TUI support.
 *
 * All output is ASCII-only (no box-drawing characters), word-wrapped at 80 columns,
 * and uses text labels like [PASS] [FAIL] [WARN] instead of color. CJK characters
 * are preserved as-is since they are valid Unicode content, not decorative glyphs.
 */

import type { HomeViewModel } from './view-models/home.js'
import type { DoctorViewModel } from './view-models/doctor.js'
import type { PrQueueViewModel } from './view-models/pr-queue.js'
import type { ProfileViewModel } from './view-models/profile.js'
import { mapCanonicalStages } from './view-models/workflow-lifecycle.js'
import type { WorkflowLifecycleViewModel, CanonicalStageSlot } from './view-models/workflow-lifecycle.js'
import type { WorkflowGalleryViewModel } from './view-models/workflow-gallery.js'
import type { DashboardViewModel } from './view-models/dashboard.js'

const MAX_WIDTH = 80

/** Word-wrap a line to MAX_WIDTH, preserving existing newlines. */
function wrap(text: string, width: number = MAX_WIDTH): string {
  return text
    .split('\n')
    .map(line => {
      if (line.length === 0) return ''
      const words = line.split(/\s+/)
      const result: string[] = []
      let current = ''
      for (const word of words) {
        if (word.length === 0) continue
        if (current.length === 0) {
          current = word
        } else if (current.length + 1 + word.length <= width) {
          current += ' ' + word
        } else {
          result.push(current)
          current = word
        }
      }
      if (current.length > 0) result.push(current)
      return result.join('\n')
    })
    .join('\n')
}

/** Wrap but indent subsequent lines by `indent` spaces. */
function wrapIndent(text: string, indent: number, width: number = MAX_WIDTH): string {
  const inner = width - indent
  if (inner <= 0) return text
  const pad = ' '.repeat(indent)
  return wrap(text, width)
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n')
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

export function renderPlainHome(vm: HomeViewModel): string {
  const lines: string[] = []
  lines.push(separator('='))
  lines.push('OpenSlack Home')
  lines.push(separator('='))
  lines.push('')

  // Attention items
  if (vm.attentionItems.length > 0) {
    lines.push('Attention:')
    for (const item of vm.attentionItems) {
      lines.push(`  ! ${item.label}`)
      if (item.detail) {
        lines.push(wrapIndent(`    ${item.detail}`, 4))
      }
    }
    lines.push('')
  } else {
    lines.push('All clear -- nothing needs attention right now.')
    lines.push('')
  }

  // Tasks
  if (vm.tasks.length > 0) {
    lines.push('What do you want to do?')
    vm.tasks.forEach((t) => {
      const badge = t.attentionBadge ? ` (${t.attentionBadge})` : ''
      lines.push(`  [${t.shortcut}] ${t.label}${badge}`)
      lines.push(wrapIndent(`     ${t.description}`, 5))
    })
    lines.push('')
  }

  // Navigation
  if (vm.navItems.length > 0) {
    lines.push('Quick Navigation:')
    for (const nav of vm.navItems) {
      lines.push(`  [${nav.shortcut}] ${nav.label}`)
    }
    lines.push('')
  }

  lines.push(`System: ${vm.systemStatus}`)
  lines.push(separator())
  return lines.join('\n')
}

export function renderPlainDoctor(vm: DoctorViewModel): string {
  const lines: string[] = []
  lines.push(separator('='))
  lines.push(`PR Doctor -- #${vm.prNumber}`)
  lines.push(separator('='))

  lines.push(wrap(`Title: ${vm.title}`))
  lines.push(`Author: ${vm.author}`)
  lines.push(`State: ${vm.state}  Draft: ${vm.draft ? 'yes' : 'no'}`)
  lines.push(`Risk Zone: ${vm.riskZone.toUpperCase()}`)
  lines.push(`Mergeable: ${vm.mergeable ? 'yes' : 'no'}`)
  lines.push(`Decision: ${vm.decision}`)
  if (vm.reason) lines.push(wrap(`Reason: ${vm.reason}`))
  if (vm.recommendation) lines.push(wrap(`Recommendation: ${vm.recommendation}`))
  lines.push('')

  // Compressed summary
  if (vm.compressed) {
    const canMerge = vm.decision === 'READY_TO_MERGE' && vm.mergeable
    lines.push('Compressed Summary:')
    lines.push(`  Can merge? ${canMerge ? 'YES' : 'NO'}`)
    if (!canMerge) {
      const blocker = vm.gates.find(g => g.status === 'FAIL' || g.status === 'WARN')
      if (blocker) {
        lines.push(`  Blocker: ${blocker.name} -- ${blocker.detail}`)
      }
      lines.push(`  Why: ${vm.reason}`)
    }
    lines.push('  Next action: openslack pr doctor ' + vm.prNumber)
    lines.push('')
  }

  // Gates
  lines.push('Gates:')
  for (const gate of vm.gates) {
    lines.push(`  ${statusLabel(gate.status)} ${gate.name}: ${gate.detail}`)
  }
  lines.push('')

  // Checks
  if (vm.checks.length > 0) {
    lines.push('Checks:')
    for (const check of vm.checks) {
      lines.push(`  ${statusLabel(check.status)} ${check.name} (${check.conclusion})`)
    }
    lines.push('')
  }

  // Reviews
  if (vm.reviews.length > 0) {
    lines.push('Reviews:')
    for (const review of vm.reviews) {
      const valid = review.valid ? 'valid' : 'not valid'
      lines.push(`  ${review.user}: ${review.state} (${valid})`)
    }
    lines.push('')
  }

  // Evidence
  if (vm.evidence.length > 0) {
    lines.push('Evidence:')
    for (const e of vm.evidence) {
      lines.push(wrapIndent(`  - ${e}`, 4))
    }
    lines.push('')
  }

  // Profile Sync Gate
  if (vm.profileSyncGate) {
    lines.push('Profile Sync Gate:')
    lines.push(`  ${vm.profileSyncGate.passed ? '[PASS]' : '[FAIL]'} ${vm.profileSyncGate.detail}`)
    lines.push('')
  }

  lines.push(separator())
  return lines.join('\n')
}

export function renderPlainPrQueue(vm: PrQueueViewModel): string {
  const lines: string[] = []
  lines.push(separator('='))
  lines.push('PR Queue')
  lines.push(separator('='))
  lines.push(`Total: ${vm.totalPRs}  Ready: ${vm.readyCount}  Blocked: ${vm.blockedCount}  Pending: ${vm.pendingCount}`)
  lines.push('')

  if (vm.items.length === 0) {
    lines.push('No open PRs.')
  }

  for (const item of vm.items) {
    const status = item.canMerge ? '[READY]' : '[BLOCKED]'
    lines.push(`${status} #${item.prNumber} ${item.title}`)
    lines.push(`  Author: ${item.author}  Zone: ${item.riskZone.toUpperCase()}  Owner: ${item.owner}`)
    lines.push(`  Decision: ${item.decision}  Blocker: ${item.blockerCategory}`)
    if (item.workflowGate.touched) {
      const gateLabel = item.workflowGate.overall === 'PASS' ? '[PASS]' : item.workflowGate.overall === 'FAIL' ? '[FAIL]' : '[N/A]'
      lines.push(`  Workflow Gate: ${gateLabel}`)
      for (const c of item.workflowGate.criteria) {
        lines.push(`    ${c.passed ? '[PASS]' : '[FAIL]'} ${c.name}`)
      }
    }
    lines.push(wrapIndent(`  Next: ${item.nextAction}`, 4))
    lines.push(`  Rerun: ${item.rerunCommand}`)
    lines.push('')
  }

  lines.push(separator())
  return lines.join('\n')
}

export function renderPlainProfile(vm: ProfileViewModel): string {
  const lines: string[] = []
  lines.push(separator('='))
  lines.push(vm.title)
  lines.push(separator('='))

  lines.push(`Target: ${vm.targetRepo}/${vm.targetPath}`)
  lines.push(`Marker: ${vm.marker} (${vm.markerStatus})`)
  lines.push(`Sync Status: ${syncStatusLabel(vm.syncStatus)} ${vm.syncStatus}`)
  lines.push(`Mode: ${vm.mode}`)
  if (vm.lastSyncDate) lines.push(`Last Sync: ${vm.lastSyncDate}`)
  if (vm.lastPrUrl) lines.push(wrap(`Last PR: ${vm.lastPrUrl}`))
  lines.push('')

  // Failure details
  if (vm.failureDetails) {
    lines.push('FAILURE DETAILS:')
    lines.push(wrapIndent(`  Reason: ${vm.failureDetails.reason}`, 4))
    lines.push(wrapIndent(`  Next Action: ${vm.failureDetails.nextAction}`, 4))
    lines.push('')
  }

  // Sync details
  if (vm.syncDetails) {
    lines.push('Sync Details:')
    if (vm.syncDetails.sourceCommit) lines.push(`  Source Commit: ${vm.syncDetails.sourceCommit}`)
    if (vm.syncDetails.sourceDate) lines.push(`  Source Date: ${vm.syncDetails.sourceDate}`)
    if (vm.syncDetails.targetHash) lines.push(`  Target Hash: ${vm.syncDetails.targetHash}`)
    if (vm.syncDetails.pendingPR) {
      lines.push(`  Pending PR: #${vm.syncDetails.pendingPR.number} (${vm.syncDetails.pendingPR.status})`)
    }
    if (vm.syncDetails.lastSync) {
      const resultLabel = vm.syncDetails.lastSync.result === 'success' ? '[PASS]' : vm.syncDetails.lastSync.result === 'failed' ? '[FAIL]' : '[INFO]'
      lines.push(`  Last Sync: ${resultLabel} ${vm.syncDetails.lastSync.timestamp}`)
    }
    lines.push('')
  }

  // Pending PR
  if (vm.pendingPR) {
    lines.push(`Pending PR: #${vm.pendingPR.number}`)
    lines.push(wrap(`  URL: ${vm.pendingPR.url}`))
    lines.push(`  Branch: ${vm.pendingPR.branch}`)
    lines.push('')
  }

  // Validation summary
  lines.push(`Validation: ${vm.validationSummary.total} total, ${vm.validationSummary.published} published, ${vm.validationSummary.failed} failed`)
  lines.push('')

  // Posts
  if (vm.posts.length > 0) {
    lines.push('Posts:')
    for (const post of vm.posts) {
      lines.push(`  - ${post.title} (${post.date})`)
      if (post.summary) lines.push(wrapIndent(`    ${post.summary}`, 4))
    }
    lines.push('')
  }

  // Actions
  if (vm.actions.length > 0) {
    lines.push('Actions:')
    for (const action of vm.actions) {
      lines.push(`  [${action.key}] ${action.label} -- ${action.description} (risk: ${action.risk})`)
    }
    lines.push('')
  }

  // Action result
  if (vm.actionResult) {
    const resultLabel = vm.actionResult.success ? '[PASS]' : '[FAIL]'
    lines.push(`Last Action: ${resultLabel} ${vm.actionResult.actionId}`)
    lines.push(wrapIndent(vm.actionResult.message, 2))
    lines.push('')
  }

  lines.push(separator())
  return lines.join('\n')
}

export function renderPlainWorkflowLifecycle(vm: WorkflowLifecycleViewModel): string {
  const lines: string[] = []
  lines.push(separator('='))
  lines.push('Workflow Lifecycle')
  lines.push(separator('='))

  lines.push(wrap(`Workflow: ${vm.workflowName}`))
  lines.push(`Hash: ${vm.workflowHash}`)
  lines.push(`Trust: ${vm.trustLevel}  Risk: ${vm.risk}`)
  lines.push(`Source: ${vm.sourcePath}`)
  lines.push('')

  // Current run
  if (vm.currentRun) {
    lines.push('Current Run:')
    lines.push(`  Run ID: ${vm.currentRun.runId}`)
    lines.push(`  Status: ${vm.currentRun.status}`)
    lines.push(`  Started: ${vm.currentRun.startedAt}`)
    lines.push(`  Phase: ${vm.currentRun.phaseIndex}`)
    lines.push('')
  }

  // PR
  if (vm.prNumber !== undefined) {
    lines.push(`PR: #${vm.prNumber}${vm.prStatus ? ` (${vm.prStatus})` : ''}`)
    lines.push('')
  }

  // Canonical stages (horizontal progress)
  if (vm.stages.length > 0) {
    lines.push('Canonical Stages:')
    const canonical = mapCanonicalStages(vm.stages)
    for (const slot of canonical) {
      const label = canonicalStatusLabel(slot.status)
      const issue = slot.issueNumber ? ` (#${slot.issueNumber})` : ''
      lines.push(`  ${label} ${slot.label}${issue}`)
    }
    lines.push('')
  }

  // Detailed stages
  if (vm.stages.length > 0) {
    lines.push('Stages:')
    for (const stage of vm.stages) {
      lines.push(`  ${statusLabel(stage.status)} ${stage.label} [${stage.name}]`)
      if (stage.detail) lines.push(wrapIndent(`    ${stage.detail}`, 4))
      if (stage.issueNumber) lines.push(`    Issue: #${stage.issueNumber}`)
    }
    lines.push('')
  }

  // Phase issues
  if (vm.phaseIssues.length > 0) {
    lines.push('Phase Issues:')
    for (const pi of vm.phaseIssues) {
      const blocked = pi.blockedBy && pi.blockedBy.length > 0 ? ` (blocked by: ${pi.blockedBy.join(', ')})` : ''
      lines.push(`  #${pi.issueNumber ?? '?'} ${pi.phase} -- ${pi.status}${blocked}`)
    }
    lines.push('')
  }

  if (vm.nextAction) {
    lines.push(wrap(`Next: ${vm.nextAction}`))
    lines.push('')
  }

  // Modes
  if (vm.subIssueMode) lines.push(`Sub-issue mode: ${vm.subIssueMode}`)
  if (vm.dependencyMode) lines.push(`Dependency mode: ${vm.dependencyMode}`)
  if (vm.fallbackReasons && vm.fallbackReasons.length > 0) {
    lines.push('Fallback reasons:')
    for (const r of vm.fallbackReasons) {
      lines.push(wrapIndent(`  - ${r}`, 4))
    }
  }

  lines.push(separator())
  return lines.join('\n')
}

export function renderPlainWorkflowWorkbench(vm: WorkflowGalleryViewModel): string {
  const lines: string[] = []
  lines.push(separator('='))
  lines.push('Workflow Workbench')
  lines.push(separator('='))
  lines.push(`Total: ${vm.summary.total}  YAML: ${vm.summary.yaml}  JS: ${vm.summary.js}`)
  lines.push('')

  if (vm.workflows.length === 0) {
    lines.push('No workflows found.')
  }

  for (const wf of vm.workflows) {
    const runStatus = wf.lastRunStatus ? ` Last run: ${wf.lastRunStatus}` : ''
    lines.push(`  ${wf.name} (${wf.format})`)
    lines.push(`    Trust: ${wf.trustLevel}  Risk: ${wf.risk}  Phases: ${wf.phases}${runStatus}`)
    if (wf.description) {
      lines.push(wrapIndent(`    ${wf.description}`, 4))
    }
    lines.push('')
  }

  lines.push(separator())
  return lines.join('\n')
}

export function renderPlainDashboard(vm: DashboardViewModel): string {
  const lines: string[] = []
  lines.push(separator('='))
  lines.push(vm.title)
  lines.push(separator('='))
  lines.push(`Generated: ${vm.generatedAt}`)
  lines.push(`Blockers: ${vm.summary.blockers}  Handoffs: ${vm.summary.handoffs}  Decisions: ${vm.summary.decisions}`)
  lines.push('')

  // Blockers
  if (vm.blockers.length > 0) {
    lines.push('Blockers:')
    for (const b of vm.blockers) {
      const owner = b.owner ? ` (owner: ${b.owner})` : ''
      lines.push(wrapIndent(`  [!!] ${b.object}: ${b.summary}${owner}`, 4))
      if (b.nextAction) lines.push(wrapIndent(`       Next: ${b.nextAction}`, 8))
    }
    lines.push('')
  }

  // Handoffs
  if (vm.handoffs.length > 0) {
    lines.push('Open Handoffs:')
    for (const h of vm.handoffs) {
      lines.push(`  ${h.from} -> ${h.to} (${h.status}, ${h.age})`)
      lines.push(wrapIndent(`    ${h.context}`, 4))
    }
    lines.push('')
  }

  // Decisions
  if (vm.decisions.length > 0) {
    lines.push('Active Decisions:')
    for (const d of vm.decisions) {
      lines.push(`  ${d.topic} (${d.status}, by: ${d.decidedBy})`)
    }
    lines.push('')
  }

  // Recent activity
  if (vm.recentActivity.length > 0) {
    lines.push('Recent Activity:')
    for (const a of vm.recentActivity) {
      lines.push(wrapIndent(`  [${a.time}] ${a.type} -- ${a.summary} (${a.actor})`, 4))
    }
    lines.push('')
  }

  lines.push(separator())
  return lines.join('\n')
}

/**
 * Render plain output for a given view name and view model.
 * Used by the CLI fallback path.
 */
export function renderPlain(viewName: string, vm: unknown): string {
  switch (viewName) {
    case 'home': return renderPlainHome(vm as HomeViewModel)
    case 'doctor': return renderPlainDoctor(vm as DoctorViewModel)
    case 'pr-queue': return renderPlainPrQueue(vm as PrQueueViewModel)
    case 'profile': return renderPlainProfile(vm as ProfileViewModel)
    case 'workflow-lifecycle': return renderPlainWorkflowLifecycle(vm as WorkflowLifecycleViewModel)
    case 'workflow-workbench': return renderPlainWorkflowWorkbench(vm as WorkflowGalleryViewModel)
    case 'dashboard': return renderPlainDashboard(vm as DashboardViewModel)
    default: return `Plain rendering not available for view: ${viewName}`
  }
}
