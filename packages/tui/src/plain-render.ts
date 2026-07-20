/**
 * plain-render.ts -- Plain-text fallback renderer for terminals without TUI support.
 *
 * All output is ASCII-only (no box-drawing characters), word-wrapped at the requested width,
 * and uses text labels like [PASS] [FAIL] [WARN] instead of color. CJK characters
 * are preserved as-is since they are valid Unicode content, not decorative glyphs.
 */

import type { HomeViewModel } from './view-models/home.js';
import type { DoctorViewModel } from './view-models/doctor.js';
import type { PrQueueViewModel } from './view-models/pr-queue.js';
import type { ProfileViewModel } from './view-models/profile.js';
import { mapCanonicalStages } from './view-models/workflow-lifecycle.js';
import type { WorkflowLifecycleViewModel } from './view-models/workflow-lifecycle.js';
import type { WorkflowGalleryViewModel } from './view-models/workflow-gallery.js';
import type { DashboardViewModel } from './view-models/dashboard.js';
import type { ActivityViewModel } from './view-models/activity.js';
import type { DecisionListViewModel, DecisionDetailViewModel } from './view-models/decision.js';
import type { DigestViewModel } from './view-models/digest.js';
import type { HandoffListViewModel, HandoffDetailViewModel } from './view-models/handoff.js';
import type { IssuesPrViewModel } from './view-models/issues-pr.js';
import type { SetupViewModel } from './view-models/setup.js';
import type { StatusViewModel } from './view-models/status.js';
import type { WorkflowPreviewViewModel } from './view-models/workflow-preview.js';
import type { AgentRuntimeDiagnosticsViewModel } from './view-models/agent-runtime.js';
import type { ShellViewData } from './views/render-shell.js';
import { visibleWidth, wrapVisible, wrapIndentVisible } from './layout/index.js';

const MAX_WIDTH = 80;

/** Word-wrap a line to MAX_WIDTH, preserving existing newlines. */
function wrap(text: string, width: number = MAX_WIDTH): string {
  if (visibleWidth(text) <= width) return text;
  return wrapVisible(text, width);
}
/** Wrap but indent subsequent lines by `indent` spaces. */
function wrapIndent(text: string, indent: number, width: number = MAX_WIDTH): string {
  const inner = width - indent;
  if (inner <= 0 || visibleWidth(text) <= inner) return text;
  return wrapIndentVisible(text, indent, width);
}

function separator(char = '-', width: number = MAX_WIDTH): string {
  return char.repeat(width);
}

function statusLabel(status: string): string {
  const upper = status.toUpperCase();
  if (upper === 'PASS' || upper === 'SUCCESS' || upper === 'COMPLETE') return '[PASS]';
  if (upper === 'FAIL' || upper === 'FAILED' || upper === 'ERROR') return '[FAIL]';
  if (upper === 'WARN' || upper === 'WARNING' || upper === 'PENDING') return '[WARN]';
  return '[INFO]';
}

function syncStatusLabel(status: string): string {
  switch (status) {
    case 'synced':
      return '[SYNCED]';
    case 'pending':
      return '[PENDING]';
    case 'failed':
      return '[FAILED]';
    case 'never':
      return '[NEVER]';
    default:
      return '[UNKNOWN]';
  }
}

function canonicalStatusLabel(status: string): string {
  switch (status) {
    case 'complete':
      return '[DONE]';
    case 'current':
      return '[ACTIVE]';
    case 'failed':
      return '[FAILED]';
    case 'pending':
      return '[ ]';
    default:
      return '[ ]';
  }
}

// --- Renderers ---

export function renderPlainHome(vm: HomeViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push('OpenSlack Home');
  lines.push(separator('=', width));
  lines.push('');

  lines.push('Ask OpenSlack:');
  lines.push(wrap('  > What do you want OpenSlack to do?', width));
  lines.push('');

  // Attention items
  if (vm.attentionItems.length > 0) {
    lines.push('Attention:');
    for (const item of vm.attentionItems) {
      lines.push(wrap(`  ! ${item.label}`, width));
      if (item.detail) {
        lines.push(wrapIndent(`    ${item.detail}`, 4, width));
      }
    }
    lines.push('');
  } else {
    lines.push(wrap('All clear -- nothing needs attention right now.', width));
    lines.push('');
  }

  // Tasks
  if (vm.tasks.length > 0) {
    lines.push('Suggested shortcuts:');
    vm.tasks.forEach((t) => {
      const badge = t.attentionBadge ? ` (${t.attentionBadge})` : '';
      lines.push(wrap(`  [${t.shortcut}] ${t.label}${badge}`, width));
      lines.push(wrapIndent(`     ${t.description}`, 5, width));
    });
    lines.push('');
  }

  // Next recommended action
  if (vm.nextRecommendedAction) {
    lines.push('Next Recommended Action:');
    lines.push(wrap(`  > ${vm.nextRecommendedAction.label}`, width));
    lines.push(wrapIndent(`    ${vm.nextRecommendedAction.reason}`, 4, width));
    lines.push('');
  }

  // Navigation
  if (vm.navItems.length > 0) {
    lines.push('Quick Navigation:');
    for (const nav of vm.navItems) {
      lines.push(wrap(`  [${nav.shortcut}] ${nav.label}`, width));
    }
    lines.push('');
  }

  lines.push(wrap(`System: ${vm.systemStatus}`, width));
  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainDoctor(vm: DoctorViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(`PR Doctor -- #${vm.prNumber}`);
  lines.push(separator('=', width));

  lines.push(wrap(`Title: ${vm.title}`, width));
  lines.push(wrap(`Author: ${vm.author}`, width));
  lines.push(wrap(`State: ${vm.state}  Draft: ${vm.draft ? 'yes' : 'no'}`, width));
  lines.push(wrap(`Risk Zone: ${vm.riskZone.toUpperCase()}`, width));
  lines.push(wrap(`Mergeable: ${vm.mergeable ? 'yes' : 'no'}`, width));
  lines.push(wrap(`Decision: ${vm.decision}`, width));
  if (vm.reason) lines.push(wrap(`Reason: ${vm.reason}`, width));
  if (vm.recommendation) lines.push(wrap(`Recommendation: ${vm.recommendation}`, width));
  lines.push('');

  // Compressed summary
  if (vm.compressed) {
    const canMerge = vm.decision === 'READY_TO_MERGE' && vm.mergeable;
    lines.push('Compressed Summary:');
    lines.push(`  Can merge? ${canMerge ? 'YES' : 'NO'}`);
    if (!canMerge) {
      const blocker = vm.gates.find((g) => g.status === 'FAIL' || g.status === 'WARN');
      if (blocker) {
        lines.push(wrap(`  Blocker: ${blocker.name} -- ${blocker.detail}`, width));
      }
      lines.push(wrap(`  Why: ${vm.reason}`, width));
    }
    lines.push(wrap(`  Next action: openslack pr doctor ${vm.prNumber}`, width));
    lines.push('');
  }

  // Gates
  lines.push('Gates:');
  for (const gate of vm.gates) {
    lines.push(wrap(`  ${statusLabel(gate.status)} ${gate.name}: ${gate.detail}`, width));
  }
  lines.push('');

  // Checks
  if (vm.checks.length > 0) {
    lines.push('Checks:');
    for (const check of vm.checks) {
      lines.push(wrap(`  ${statusLabel(check.status)} ${check.name} (${check.conclusion})`, width));
    }
    lines.push('');
  }

  // Reviews
  if (vm.reviews.length > 0) {
    lines.push('Reviews:');
    for (const review of vm.reviews) {
      const valid = review.valid ? 'valid' : 'not valid';
      lines.push(wrap(`  ${review.user}: ${review.state} (${valid})`, width));
    }
    lines.push('');
  }

  // Evidence
  if (vm.evidence.length > 0) {
    lines.push('Evidence:');
    for (const e of vm.evidence) {
      lines.push(wrapIndent(`  - ${e}`, 4, width));
    }
    lines.push('');
  }

  // Profile Sync Gate
  if (vm.profileSyncGate) {
    lines.push('Profile Sync Gate:');
    lines.push(
      wrap(
        `  ${vm.profileSyncGate.passed ? '[PASS]' : '[FAIL]'} ${vm.profileSyncGate.detail}`,
        width,
      ),
    );
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainPrQueue(vm: PrQueueViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push('PR Queue');
  lines.push(separator('=', width));
  lines.push(
    wrap(
      `Total: ${vm.totalPRs}  Ready: ${vm.readyCount}  Blocked: ${vm.blockedCount}  Pending: ${vm.pendingCount}`,
      width,
    ),
  );
  lines.push('');

  if (vm.items.length === 0) {
    lines.push('No open PRs.');
  }

  for (const item of vm.items) {
    const status = item.canMerge ? '[READY]' : '[BLOCKED]';
    lines.push(wrap(`${status} #${item.prNumber} ${item.title}`, width));
    lines.push(
      wrap(
        `  Author: ${item.author}  Zone: ${item.riskZone.toUpperCase()}  Owner: ${item.owner}`,
        width,
      ),
    );
    lines.push(wrap(`  Decision: ${item.decision}  Blocker: ${item.blockerCategory}`, width));
    if (item.workflowGate.touched) {
      const gateLabel =
        item.workflowGate.overall === 'PASS'
          ? '[PASS]'
          : item.workflowGate.overall === 'FAIL'
            ? '[FAIL]'
            : '[N/A]';
      lines.push(wrap(`  Workflow Gate: ${gateLabel}`, width));
      for (const c of item.workflowGate.criteria) {
        lines.push(wrap(`    ${c.passed ? '[PASS]' : '[FAIL]'} ${c.name}`, width));
      }
    }
    lines.push(wrapIndent(`  Next: ${item.nextAction}`, 4, width));
    lines.push(wrap(`  Rerun: ${item.rerunCommand}`, width));
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainProfile(vm: ProfileViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(vm.title, width));
  lines.push(separator('=', width));

  lines.push(wrap(`Target: ${vm.targetRepo}/${vm.targetPath}`, width));
  lines.push(wrap(`Marker: ${vm.marker} (${vm.markerStatus})`, width));
  lines.push(wrap(`Sync Status: ${syncStatusLabel(vm.syncStatus)} ${vm.syncStatus}`, width));
  lines.push(wrap(`Mode: ${vm.mode}`, width));
  if (vm.lastSyncDate) lines.push(wrap(`Last Sync: ${vm.lastSyncDate}`, width));
  if (vm.lastPrUrl) lines.push(wrap(`Last PR: ${vm.lastPrUrl}`, width));
  lines.push('');

  // Guided flow step
  if (vm.guidedStep) {
    const stepLabels: Record<string, string> = {
      check: '1.Check',
      preview: '2.Preview',
      'create-pr': '3.PR',
      complete: 'Done',
    };
    const steps = ['check', 'preview', 'create-pr'];
    const current = steps.indexOf(vm.guidedStep === 'complete' ? 'create-pr' : vm.guidedStep);
    const bar = steps
      .map((s, i) =>
        i < current
          ? `[x]${stepLabels[s]}`
          : i === current
            ? `[>]${stepLabels[s]}`
            : `[ ]${stepLabels[s]}`,
      )
      .join(' > ');
    const suffix = vm.guidedStep === 'complete' ? ' > Done' : '';
    lines.push(wrap(`Guided Flow: ${bar}${suffix}`, width));
    lines.push('');
  }

  // Check result groups
  if (vm.checkGroups && vm.checkGroups.length > 0) {
    lines.push('Check Results:');
    for (const g of vm.checkGroups) {
      const label =
        g.status === 'pass'
          ? '[PASS]'
          : g.status === 'fail'
            ? '[FAIL]'
            : g.status === 'warn'
              ? '[WARN]'
              : '[INFO]';
      lines.push(wrap(`  ${label} ${g.label}: ${g.detail}`, width));
    }
    lines.push('');
  }

  // Failure details
  if (vm.failureDetails) {
    lines.push('FAILURE DETAILS:');
    lines.push(wrapIndent(`  Reason: ${vm.failureDetails.reason}`, 4, width));
    lines.push(wrapIndent(`  Next Action: ${vm.failureDetails.nextAction}`, 4, width));
    lines.push('');
  }

  // Sync details
  if (vm.syncDetails) {
    lines.push('Sync Details:');
    if (vm.syncDetails.sourceCommit)
      lines.push(wrap(`  Source Commit: ${vm.syncDetails.sourceCommit}`, width));
    if (vm.syncDetails.sourceDate)
      lines.push(wrap(`  Source Date: ${vm.syncDetails.sourceDate}`, width));
    if (vm.syncDetails.targetHash)
      lines.push(wrap(`  Target Hash: ${vm.syncDetails.targetHash}`, width));
    if (vm.syncDetails.pendingPR) {
      lines.push(
        wrap(
          `  Pending PR: #${vm.syncDetails.pendingPR.number} (${vm.syncDetails.pendingPR.status})`,
          width,
        ),
      );
    }
    if (vm.syncDetails.lastSync) {
      const resultLabel =
        vm.syncDetails.lastSync.result === 'success'
          ? '[PASS]'
          : vm.syncDetails.lastSync.result === 'failed'
            ? '[FAIL]'
            : '[INFO]';
      lines.push(wrap(`  Last Sync: ${resultLabel} ${vm.syncDetails.lastSync.timestamp}`, width));
    }
    lines.push('');
  }

  // Pending PR
  if (vm.pendingPR) {
    lines.push(wrap(`Pending PR: #${vm.pendingPR.number}`, width));
    lines.push(wrap(`  URL: ${vm.pendingPR.url}`, width));
    lines.push(wrap(`  Branch: ${vm.pendingPR.branch}`, width));
    lines.push('');
  }

  // Validation summary
  lines.push(
    wrap(
      `Validation: ${vm.validationSummary.total} total, ${vm.validationSummary.published} published, ${vm.validationSummary.failed} failed`,
      width,
    ),
  );
  lines.push('');

  // Posts
  if (vm.posts.length > 0) {
    lines.push('Posts:');
    for (const post of vm.posts) {
      lines.push(wrap(`  - ${post.title} (${post.date})`, width));
      if (post.summary) lines.push(wrapIndent(`    ${post.summary}`, 4, width));
    }
    lines.push('');
  }

  // Actions
  if (vm.actions.length > 0) {
    lines.push('Actions:');
    for (const action of vm.actions) {
      lines.push(
        wrap(
          `  [${action.key}] ${action.label} -- ${action.description} (risk: ${action.risk})`,
          width,
        ),
      );
    }
    lines.push('');
  }

  // Action result
  if (vm.actionResult) {
    const resultLabel = vm.actionResult.success ? '[PASS]' : '[FAIL]';
    lines.push(wrap(`Last Action: ${resultLabel} ${vm.actionResult.actionId}`, width));
    lines.push(wrapIndent(vm.actionResult.message, 2, width));
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainWorkflowLifecycle(
  vm: WorkflowLifecycleViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push('Workflow Lifecycle');
  lines.push(separator('=', width));

  lines.push(wrap(`Workflow: ${vm.workflowName}`, width));
  lines.push(wrap(`Hash: ${vm.workflowHash}`, width));
  lines.push(wrap(`Trust: ${vm.trustLevel}  Risk: ${vm.risk}`, width));
  lines.push(wrap(`Source: ${vm.sourcePath}`, width));
  lines.push('');

  // Current run
  if (vm.currentRun) {
    lines.push('Current Run:');
    lines.push(wrap(`  Run ID: ${vm.currentRun.runId}`, width));
    lines.push(wrap(`  Status: ${vm.currentRun.status}`, width));
    lines.push(wrap(`  Started: ${vm.currentRun.startedAt}`, width));
    lines.push(wrap(`  Phase: ${vm.currentRun.phaseIndex}`, width));
    lines.push('');
  }

  // PR
  if (vm.prNumber !== undefined) {
    lines.push(wrap(`PR: #${vm.prNumber}${vm.prStatus ? ` (${vm.prStatus})` : ''}`, width));
    lines.push('');
  }

  // Canonical stages (horizontal progress)
  if (vm.stages.length > 0) {
    lines.push('Canonical Stages:');
    const canonical = mapCanonicalStages(vm.stages);
    for (const slot of canonical) {
      const label = canonicalStatusLabel(slot.status);
      const issue = slot.issueNumber ? ` (#${slot.issueNumber})` : '';
      lines.push(wrap(`  ${label} ${slot.label}${issue}`, width));
    }
    lines.push('');
  }

  // Detailed stages
  if (vm.stages.length > 0) {
    lines.push('Stages:');
    for (const stage of vm.stages) {
      lines.push(wrap(`  ${statusLabel(stage.status)} ${stage.label} [${stage.name}]`, width));
      if (stage.detail) lines.push(wrapIndent(`    ${stage.detail}`, 4, width));
      if (stage.issueNumber) lines.push(wrap(`    Issue: #${stage.issueNumber}`, width));
    }
    lines.push('');
  }

  // Phase issues
  if (vm.phaseIssues.length > 0) {
    lines.push('Phase Issues:');
    for (const pi of vm.phaseIssues) {
      const blocked =
        pi.blockedBy && pi.blockedBy.length > 0 ? ` (blocked by: ${pi.blockedBy.join(', ')})` : '';
      lines.push(wrap(`  #${pi.issueNumber ?? '?'} ${pi.phase} -- ${pi.status}${blocked}`, width));
    }
    lines.push('');
  }

  if (vm.nextAction) {
    lines.push(wrap(`Next: ${vm.nextAction}`, width));
    lines.push('');
  }

  // Status summary
  if (vm.statusSummary) {
    lines.push(wrap(`Status: ${vm.statusSummary}`, width));
    lines.push('');
  }

  // Blocked gate items
  if (vm.blockedGateItems && vm.blockedGateItems.length > 0) {
    lines.push('Blocked Gates:');
    const gateIndent = '  [FAIL] '.length;
    for (const g of vm.blockedGateItems) {
      lines.push(`  [FAIL] ${g.gate}: ${g.detail}`);
      if (g.action)
        lines.push(wrapIndent(`${' '.repeat(gateIndent)}Fix: ${g.action}`, gateIndent, width));
    }
    lines.push('');
  }

  // Modes
  if (vm.subIssueMode) lines.push(wrap(`Sub-issue mode: ${vm.subIssueMode}`, width));
  if (vm.dependencyMode) lines.push(wrap(`Dependency mode: ${vm.dependencyMode}`, width));
  if (vm.fallbackReasons && vm.fallbackReasons.length > 0) {
    lines.push('Fallback reasons:');
    for (const r of vm.fallbackReasons) {
      lines.push(wrapIndent(`  - ${r}`, 4, width));
    }
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainWorkflowWorkbench(
  vm: WorkflowGalleryViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push('Workflow Workbench');
  lines.push(separator('=', width));
  lines.push(
    wrap(`Total: ${vm.summary.total}  YAML: ${vm.summary.yaml}  JS: ${vm.summary.js}`, width),
  );
  lines.push('');

  lines.push('Workflow Home Actions:');
  lines.push(wrap('  [1] Start', width));
  lines.push(
    wrapIndent('      Generate from prompt, choose pattern, or open a saved workflow', 6, width),
  );
  lines.push(wrap('  [2] Watch', width));
  lines.push(wrapIndent('      Running and paused workflow runs', 6, width));
  lines.push(wrap('  [3] Approve', width));
  lines.push(wrapIndent('      Workflow side effects and budget pauses', 6, width));
  lines.push(wrap('  [4] Reuse', width));
  lines.push(wrapIndent('      Save, export, or share workflow outputs', 6, width));
  lines.push(wrap('  [5] Publish', width));
  lines.push(wrapIndent('      GitHub Issues lifecycle', 6, width));
  lines.push('');

  if (vm.patterns && vm.patterns.length > 0) {
    lines.push('Pattern Start:');
    for (const pattern of vm.patterns) {
      lines.push(wrap(`  ${pattern.id} -- ${pattern.name}`, width));
      if (pattern.description) {
        lines.push(wrapIndent(`    ${pattern.description}`, 4, width));
      }
    }
    lines.push('');
  }

  if (vm.workflows.length === 0) {
    lines.push('No workflows found.');
  }

  for (const wf of vm.workflows) {
    const runStatus = wf.lastRunStatus ? ` Last run: ${wf.lastRunStatus}` : '';
    lines.push(wrap(`  ${wf.name} (${wf.format})`, width));
    lines.push(
      wrap(
        `    Trust: ${wf.trustLevel}  Risk: ${wf.risk}  Phases: ${wf.phases}${runStatus}`,
        width,
      ),
    );
    if (wf.description) {
      lines.push(wrapIndent(`    ${wf.description}`, 4, width));
    }
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainDashboard(vm: DashboardViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(vm.title, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Generated: ${vm.generatedAt}`, width));
  lines.push(
    wrap(
      `Blockers: ${vm.summary.blockers}  Handoffs: ${vm.summary.handoffs}  Decisions: ${vm.summary.decisions}`,
      width,
    ),
  );
  lines.push('');

  // Blockers
  if (vm.blockers.length > 0) {
    lines.push('Blockers:');
    for (const b of vm.blockers) {
      const owner = b.owner ? ` (owner: ${b.owner})` : '';
      lines.push(wrapIndent(`  [!!] ${b.object}: ${b.summary}${owner}`, 4, width));
      if (b.nextAction) lines.push(wrapIndent(`       Next: ${b.nextAction}`, 8, width));
    }
    lines.push('');
  }

  // Handoffs
  if (vm.handoffs.length > 0) {
    lines.push('Open Handoffs:');
    for (const h of vm.handoffs) {
      lines.push(wrap(`  ${h.from} -> ${h.to} (${h.status}, ${h.age})`, width));
      lines.push(wrapIndent(`    ${h.context}`, 4, width));
    }
    lines.push('');
  }

  // Decisions
  if (vm.decisions.length > 0) {
    lines.push('Active Decisions:');
    for (const d of vm.decisions) {
      lines.push(wrap(`  ${d.topic} (${d.status}, by: ${d.decidedBy})`, width));
    }
    lines.push('');
  }

  // Recent activity
  if (vm.recentActivity.length > 0) {
    lines.push('Recent Activity:');
    for (const a of vm.recentActivity) {
      lines.push(wrapIndent(`  [${a.time}] ${a.type} -- ${a.summary} (${a.actor})`, 4, width));
    }
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainActivity(vm: ActivityViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(vm.title, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Period: ${vm.periodHours}h  Total events: ${vm.totalEvents}`, width));
  lines.push('');

  const renderBucket = (label: string, events: ActivityViewModel['events']) => {
    if (events.length === 0) return;
    lines.push(`${label}:`);
    for (const e of events) {
      const owner = e.owner ? ` (owner: ${e.owner})` : '';
      lines.push(
        wrapIndent(`  [${e.time}] ${e.type} -- ${e.summary} (${e.actor})${owner}`, 4, width),
      );
      if (e.nextAction) lines.push(wrapIndent(`    Next: ${e.nextAction}`, 6, width));
    }
    lines.push('');
  };

  renderBucket('Today', vm.today);
  renderBucket('Yesterday', vm.yesterday);
  renderBucket('Older', vm.older);

  if (vm.totalEvents === 0) {
    lines.push('No events in this period.');
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainDecisionList(
  vm: DecisionListViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(vm.title, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Total: ${vm.totalCount}  Active: ${vm.activeCount}`, width));
  lines.push('');

  if (vm.items.length === 0) {
    lines.push('No decisions recorded.');
  }

  for (const item of vm.items) {
    const statusLabel =
      item.status === 'active' ? '[ACTIVE]' : item.status === 'superseded' ? '[OLD]' : '[INFO]';
    lines.push(wrap(`${statusLabel} ${item.topic}`, width));
    lines.push(wrap(`  Decision: ${item.decision}`, width));
    lines.push(wrap(`  By: ${item.decidedBy}  Age: ${item.age}  Status: ${item.status}`, width));
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainDecisionDetail(
  vm: DecisionDetailViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(`Decision: ${vm.topic}`, width));
  lines.push(separator('=', width));

  lines.push(wrap(`ID: ${vm.id}`, width));
  lines.push(wrap(`Decision: ${vm.decision}`, width));
  lines.push(wrap(`Status: ${vm.status}`, width));
  lines.push(wrap(`Decided by: ${vm.decidedBy}`, width));
  lines.push(wrap(`Created: ${vm.createdAt}`, width));
  lines.push('');

  if (vm.rationale) {
    lines.push('Rationale:');
    lines.push(wrapIndent(vm.rationale, 2, width));
    lines.push('');
  }

  if (vm.alternatives.length > 0) {
    lines.push('Alternatives:');
    for (const alt of vm.alternatives) {
      lines.push(wrapIndent(`  - ${alt}`, 4, width));
    }
    lines.push('');
  }

  if (vm.consequences.length > 0) {
    lines.push('Consequences:');
    for (const c of vm.consequences) {
      lines.push(wrapIndent(`  - ${c}`, 4, width));
    }
    lines.push('');
  }

  if (vm.supersededBy) {
    lines.push(wrap(`Superseded by: ${vm.supersededBy}`, width));
    if (vm.supersededAt) lines.push(wrap(`Superseded at: ${vm.supersededAt}`, width));
    lines.push('');
  }

  if (vm.tags.length > 0) {
    lines.push(wrap(`Tags: ${vm.tags.join(', ')}`, width));
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainDigest(vm: DigestViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(vm.title, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Period: ${vm.periodHours}h  Total events: ${vm.totalEvents}`, width));
  lines.push('');

  if (vm.groups.length === 0) {
    lines.push('No events in this period.');
    lines.push('');
  }

  for (const group of vm.groups) {
    const label =
      group.status === 'pass'
        ? '[PASS]'
        : group.status === 'fail'
          ? '[FAIL]'
          : group.status === 'warn'
            ? '[WARN]'
            : '[INFO]';
    lines.push(wrap(`${label} ${group.label} (${group.count} events)`, width));
    for (const e of group.events) {
      lines.push(
        wrapIndent(
          `  [${e.time}] ${e.type} -- ${e.summary} (${e.objectKind}:${e.objectId})`,
          4,
          width,
        ),
      );
    }
    lines.push('');
  }

  if (vm.recommendedNext.length > 0) {
    lines.push('Recommended Next:');
    for (const r of vm.recommendedNext) {
      lines.push(wrapIndent(`  - ${r.objectKind}:${r.objectId} -- ${r.action}`, 4, width));
    }
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainHandoffList(
  vm: HandoffListViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(vm.title, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Total: ${vm.totalCount}  Open: ${vm.openCount}`, width));
  lines.push('');

  if (vm.items.length === 0) {
    lines.push('No handoffs.');
  }

  for (const item of vm.items) {
    const statusLabel =
      item.status === 'open' ? '[OPEN]' : item.status === 'accepted' ? '[ACCEPTED]' : '[CLOSED]';
    lines.push(
      wrap(`${statusLabel} ${item.from} -> ${item.to} (${item.status}, ${item.age})`, width),
    );
    lines.push(wrapIndent(`  ${item.context}`, 2, width));
    lines.push(wrap(`  Ref: ${item.ref}`, width));
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainHandoffDetail(
  vm: HandoffDetailViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(`Handoff: ${vm.id}`, width));
  lines.push(separator('=', width));

  lines.push(wrap(`Status: ${vm.status}`, width));
  lines.push(wrap(`From: ${vm.from}  To: ${vm.to}`, width));
  lines.push(wrap(`Created: ${vm.createdAt}`, width));
  if (vm.acceptedAt) lines.push(wrap(`Accepted: ${vm.acceptedAt}`, width));
  if (vm.closedAt) lines.push(wrap(`Closed: ${vm.closedAt}`, width));
  lines.push('');

  if (vm.issueRef) lines.push(wrap(`Issue: ${vm.issueRef}`, width));
  if (vm.prRef) lines.push(wrap(`PR: ${vm.prRef}`, width));
  lines.push('');

  lines.push('Context:');
  lines.push(wrapIndent(vm.context, 2, width));
  lines.push('');

  if (vm.nextSteps.length > 0) {
    lines.push('Next Steps:');
    for (const step of vm.nextSteps) {
      lines.push(wrapIndent(`  - ${step}`, 4, width));
    }
    lines.push('');
  }

  if (vm.notes) {
    lines.push('Notes:');
    lines.push(wrapIndent(vm.notes, 2, width));
    lines.push('');
  }

  lines.push(
    wrap(
      `Can accept: ${vm.canAccept ? 'yes' : 'no'}  Can close: ${vm.canClose ? 'yes' : 'no'}`,
      width,
    ),
  );
  lines.push('');
  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainIssuesPr(vm: IssuesPrViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(vm.tab === 'issues' ? 'Issues' : 'Pull Requests');
  lines.push(separator('=', width));

  const si = vm.summary.issues;
  const sp = vm.summary.prs;
  lines.push(
    wrap(
      `Issues: ${si.total} total, ${si.ready} ready, ${si.claimed} claimed, ${si.blocked} blocked`,
      width,
    ),
  );
  lines.push(
    wrap(
      `PRs: ${sp.total} total, ${sp.ready} ready, ${sp.blocked} blocked, ${sp.pending} pending`,
      width,
    ),
  );
  lines.push('');

  // Always show issues section
  lines.push('Issues:');
  if (vm.issues.length === 0) {
    lines.push('  No issues.');
  }
  for (const issue of vm.issues) {
    const statusLabel =
      issue.status === 'ready'
        ? '[READY]'
        : issue.status === 'claimed'
          ? '[CLAIMED]'
          : issue.status === 'running'
            ? '[RUNNING]'
            : issue.status === 'blocked'
              ? '[BLOCKED]'
              : issue.status === 'review'
                ? '[REVIEW]'
                : '[STALE]';
    const assignee = issue.assignee ? ` (assigned: ${issue.assignee})` : '';
    const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
    lines.push(wrap(`  ${statusLabel} #${issue.number} ${issue.title}${assignee}${labels}`, width));
  }
  lines.push('');

  // Always show PRs section
  lines.push('Pull Requests:');
  if (vm.prs.length === 0) {
    lines.push('  No pull requests.');
  }
  for (const pr of vm.prs) {
    const statusLabel =
      pr.status === 'ready'
        ? '[READY]'
        : pr.status === 'blocked'
          ? '[BLOCKED]'
          : pr.status === 'pending'
            ? '[PENDING]'
            : '[CHECKING]';
    lines.push(
      wrap(
        `  ${statusLabel} #${pr.number} ${pr.title} (${pr.author}, zone: ${pr.riskZone})`,
        width,
      ),
    );
    if (pr.blocker) lines.push(wrapIndent(`    Blocker: ${pr.blocker}`, 6, width));
    if (pr.nextAction) lines.push(wrapIndent(`    Next: ${pr.nextAction}`, 6, width));
  }
  lines.push('');

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainSetup(vm: SetupViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push('OpenSlack Setup Report');
  lines.push(separator('=', width));

  const readinessLabel =
    vm.readiness === 'ready' ? '[PASS]' : vm.readiness === 'almost ready' ? '[WARN]' : '[FAIL]';
  lines.push(wrap(`Readiness: ${readinessLabel} ${vm.readiness}`, width));
  lines.push(wrap(`Checks: ${vm.passedChecks}/${vm.totalChecks} passed  Root: ${vm.root}`, width));
  lines.push('');

  if (vm.fixable.length > 0) {
    lines.push(`Fixable (${vm.fixable.length}):`);
    for (const f of vm.fixable) {
      lines.push(wrap(`  [WARN] ${f.title}`, width));
      lines.push(wrapIndent(`    ${f.command || f.nextAction || f.detail}`, 4, width));
    }
    lines.push('');
  }

  if (vm.needsAction.length > 0) {
    lines.push(`Needs Action (${vm.needsAction.length}):`);
    for (const f of vm.needsAction) {
      lines.push(wrap(`  [FAIL] ${f.title}`, width));
      lines.push(wrapIndent(`    ${f.nextAction || f.detail}`, 4, width));
    }
    lines.push('');
  }

  if (vm.ok.length > 0) {
    lines.push(`Passed (${vm.ok.length}):`);
    for (const f of vm.ok) {
      const label =
        f.status === 'PASS' ? '[PASS]' : f.status === 'info' ? '[INFO]' : statusLabel(f.status);
      lines.push(wrap(`  ${label} ${f.title}: ${f.detail}`, width));
    }
    lines.push('');
  }

  if (vm.fixable.length === 0 && vm.needsAction.length === 0) {
    lines.push('OpenSlack is fully set up.');
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainStatus(vm: StatusViewModel, width: number = MAX_WIDTH): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(vm.title, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Version: ${vm.version}`, width));
  lines.push(wrap(`Mode: ${vm.mode}`, width));
  lines.push(wrap(`Commit: ${vm.commit}`, width));
  lines.push(wrap(vm.commitSubject, width));
  lines.push('');

  // Modules
  if (vm.modules.length > 0) {
    lines.push(`Modules (${vm.modules.length}):`);
    for (const m of vm.modules) {
      const testInfo = m.tests !== null ? ` (${m.tests} tests)` : '';
      const label =
        m.maturity === 'LIVE_VERIFIED' || m.maturity === 'PRODUCTION_READY'
          ? '[PASS]'
          : m.maturity === 'LOCAL_READY'
            ? '[WARN]'
            : '[INFO]';
      lines.push(
        wrap(
          `  ${label} ${m.name}${testInfo}: lifecycle ${m.lifecycle}; maturity ${m.maturity}; declared operator baseline ${m.operatorConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED'}`,
          width,
        ),
      );
      lines.push(wrapIndent(`    Blockers: ${m.externalBlockers.join(', ') || 'none'}`, 4, width));
      lines.push(wrapIndent(`    Evidence: ${m.evidenceRefs.join(', ') || 'none'}`, 4, width));
      for (const component of m.components) {
        const componentLabel =
          component.maturity === 'LIVE_VERIFIED' || component.maturity === 'PRODUCTION_READY'
            ? '[PASS]'
            : component.maturity === 'LOCAL_READY'
              ? '[WARN]'
              : '[INFO]';
        lines.push(
          wrap(
            `    ${componentLabel} Component ${component.name}: maturity ${component.maturity}; declared operator baseline ${component.operatorConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED'}`,
            width,
          ),
        );
      }
    }
    lines.push('');
  }

  if (vm.deferredWork.length > 0) {
    lines.push('Deferred (excluded from standalone):');
    for (const item of vm.deferredWork) {
      lines.push(
        wrap(
          `  [INFO] ${item.name}: ${item.maturity}${item.branch ? `; ${item.branch}` : ''}`,
          width,
        ),
      );
    }
    lines.push('');
  }

  // GitHub
  lines.push('GitHub:');
  if (vm.gitHub.available) {
    lines.push(
      wrap(
        `  Tasks ready: ${vm.gitHub.tasksReady}  claimed: ${vm.gitHub.tasksClaimed}  blocked: ${vm.gitHub.tasksBlocked}`,
        width,
      ),
    );
    lines.push(
      wrap(
        `  PRs open: ${vm.gitHub.prsOpen}  blocked: ${vm.gitHub.prsBlocked}  ready: ${vm.gitHub.prsReady}`,
        width,
      ),
    );
  } else {
    lines.push('  unavailable');
  }
  lines.push('');

  // Test Suite
  lines.push(
    wrap(
      `Test Suite: ${vm.testSuite.totalTests} tests across ${vm.testSuite.totalFiles} files`,
      width,
    ),
  );
  lines.push('');

  // Recommendations
  if (vm.recommendations.length > 0) {
    lines.push('Recommended Next Steps:');
    vm.recommendations.forEach((r, i) => {
      const detail = r.command ? `Run: ${r.command}` : r.action;
      lines.push(wrap(`  ${i + 1}. ${r.title}`, width));
      lines.push(wrapIndent(`     ${detail}`, 5, width));
    });
    lines.push('');
  }

  // Attention Items
  if (vm.attentionItems.length > 0) {
    lines.push('Needs Attention:');
    for (const a of vm.attentionItems) {
      const prioLabel =
        a.priority === 'high' ? '[FAIL]' : a.priority === 'medium' ? '[WARN]' : '[INFO]';
      lines.push(
        wrap(`  ${prioLabel} [${a.priority.toUpperCase()}] ${a.type}: ${a.description}`, width),
      );
      lines.push(wrapIndent(`    ${a.action}`, 4, width));
    }
    lines.push('');
  } else {
    lines.push('All clear');
    lines.push('');
  }

  lines.push(wrap(`Next: ${vm.nextAction}`, width));
  lines.push('');
  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainAgentRuntimeDiagnostics(
  vm: AgentRuntimeDiagnosticsViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(`Agent Runtime / ${vm.provider}`, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Status: ${statusLabel(vm.status)} ${vm.status}`, width));
  if (vm.readiness) lines.push(wrap(`Readiness: ${vm.readiness}`, width));
  lines.push(wrap(`Config source: ${vm.configSource}`, width));
  lines.push(wrap(`Config path: ${vm.configPath}`, width));
  lines.push(wrap(`Aby root: ${vm.root}`, width));
  lines.push(wrap(`Command: ${vm.command}`, width));
  lines.push(wrap(`Args: ${vm.args.length > 0 ? vm.args.join(' ') : 'not recorded'}`, width));
  lines.push(wrap(`Timeout: ${vm.timeoutMs}`, width));
  lines.push('');
  lines.push(wrap(`Safe env allowed: ${vm.safeEnvAllowed.join(', ') || 'none'}`, width));
  lines.push(wrap(`Safe env rejected: ${vm.safeEnvRejected.join(', ') || 'none'}`, width));
  lines.push('');
  lines.push('Checks:');
  for (const check of vm.checks) {
    lines.push(
      wrapIndent(`  ${statusLabel(check.status)} ${check.name}: ${check.detail}`, 4, width),
    );
  }
  lines.push('');
  lines.push('Last Smoke:');
  if (vm.lastSmokeRun) {
    lines.push(wrap(`  Run: ${vm.lastSmokeRun.runId} (${vm.lastSmokeRun.status})`, width));
    lines.push(wrap(`  Started: ${vm.lastSmokeRun.startedAt}`, width));
    lines.push(wrap(`  Transcript: ${vm.lastSmokeRun.transcriptJsonl}`, width));
  } else {
    lines.push('  not recorded');
  }
  lines.push('');
  lines.push('Remediation:');
  for (const remediation of vm.remediations) {
    lines.push(wrapIndent(`  - ${remediation}`, 4, width));
  }
  lines.push(separator('-', width));
  return lines.join('\n');
}

export function renderPlainShell(data: ShellViewData, width: number = MAX_WIDTH): string {
  const sections: string[] = [];

  if (data.dashboard) {
    sections.push(renderPlainDashboard(data.dashboard, width));
  }
  if (data.prQueue) {
    sections.push(renderPlainPrQueue(data.prQueue, width));
  }
  if (data.status) {
    sections.push(renderPlainStatus(data.status, width));
  }
  if (data.digest) {
    sections.push(renderPlainDigest(data.digest, width));
  }
  if (data.handoffs) {
    sections.push(renderPlainHandoffList(data.handoffs, width));
  }
  if (data.decisions) {
    sections.push(renderPlainDecisionList(data.decisions, width));
  }
  if (data.workflowGallery) {
    sections.push(renderPlainWorkflowWorkbench(data.workflowGallery, width));
  }
  if (data.profile) {
    sections.push(renderPlainProfile(data.profile, width));
  }
  if (data.agentRuntime) {
    sections.push(renderPlainAgentRuntimeDiagnostics(data.agentRuntime, width));
  }

  if (sections.length === 0) {
    const lines: string[] = [];
    lines.push(separator('=', width));
    lines.push('OpenSlack Shell');
    lines.push(separator('=', width));
    lines.push('No views loaded.');
    lines.push('');
    lines.push(separator('-', width));
    return lines.join('\n');
  }

  return sections.join('\n\n');
}

export function renderPlainWorkflowPreview(
  vm: WorkflowPreviewViewModel,
  width: number = MAX_WIDTH,
): string {
  const lines: string[] = [];
  lines.push(separator('=', width));
  lines.push(wrap(`Workflow: ${vm.name}`, width));
  lines.push(separator('=', width));
  lines.push(wrap(`Template: ${vm.templateId}  Correlation: ${vm.correlationId}`, width));
  lines.push(
    wrap(
      `Steps: ${vm.stepCount}  Phases: ${vm.phaseCount}  Side effects: ${vm.hasSideEffects ? 'yes' : 'no'}`,
      width,
    ),
  );
  if (vm.requiresConfirmation) {
    lines.push(wrap('Requires confirmation: yes', width));
  }
  lines.push('');

  // Errors
  if (vm.hasErrors && vm.errors.length > 0) {
    lines.push('Errors:');
    for (const error of vm.errors) {
      lines.push(wrap(`  [FAIL] ${error}`, width));
    }
    lines.push('');
  }

  // Steps grouped by phase
  for (const phase of vm.phases) {
    const phaseSteps = vm.steps.filter((s) => s.phase === phase);
    lines.push(wrap(`Phase: ${phase}`, width));
    for (const step of phaseSteps) {
      const flags: string[] = [];
      if (step.sideEffects) flags.push('side-effect');
      if (step.requiresConfirmation) flags.push('confirmation');
      if (step.requiredRole) flags.push(`role:${step.requiredRole}`);
      const detail = flags.length > 0 ? flags.join(', ') : 'read-only';
      const label = step.requiresConfirmation ? '[WARN]' : step.sideEffects ? '[INFO]' : '[PASS]';
      lines.push(wrap(`  ${label} ${step.title} (${step.type})`, width));
      lines.push(wrapIndent(`    ${detail}`, 4, width));
    }
    lines.push('');
  }

  if (vm.steps.length === 0 && !vm.hasErrors) {
    lines.push('No steps in this workflow.');
    lines.push('');
  }

  lines.push(separator('-', width));
  return lines.join('\n');
}

/**
 * Render plain output for a given view name and view model.
 * Used by the CLI fallback path.
 */
export function renderPlain(viewName: string, vm: unknown, width: number = MAX_WIDTH): string {
  switch (viewName) {
    case 'home':
      return renderPlainHome(vm as HomeViewModel, width);
    case 'doctor':
      return renderPlainDoctor(vm as DoctorViewModel, width);
    case 'pr-queue':
      return renderPlainPrQueue(vm as PrQueueViewModel, width);
    case 'profile':
      return renderPlainProfile(vm as ProfileViewModel, width);
    case 'workflow-lifecycle':
      return renderPlainWorkflowLifecycle(vm as WorkflowLifecycleViewModel, width);
    case 'workflow-workbench':
      return renderPlainWorkflowWorkbench(vm as WorkflowGalleryViewModel, width);
    case 'dashboard':
      return renderPlainDashboard(vm as DashboardViewModel, width);
    case 'activity':
      return renderPlainActivity(vm as ActivityViewModel, width);
    case 'decision-list':
      return renderPlainDecisionList(vm as DecisionListViewModel, width);
    case 'decision-detail':
      return renderPlainDecisionDetail(vm as DecisionDetailViewModel, width);
    case 'digest':
      return renderPlainDigest(vm as DigestViewModel, width);
    case 'handoff-list':
      return renderPlainHandoffList(vm as HandoffListViewModel, width);
    case 'handoff-detail':
      return renderPlainHandoffDetail(vm as HandoffDetailViewModel, width);
    case 'issues-pr':
      return renderPlainIssuesPr(vm as IssuesPrViewModel, width);
    case 'setup':
      return renderPlainSetup(vm as SetupViewModel, width);
    case 'status':
      return renderPlainStatus(vm as StatusViewModel, width);
    case 'agent-runtime':
      return renderPlainAgentRuntimeDiagnostics(vm as AgentRuntimeDiagnosticsViewModel, width);
    case 'shell':
      return renderPlainShell(vm as ShellViewData, width);
    case 'workflow-preview':
      return renderPlainWorkflowPreview(vm as WorkflowPreviewViewModel, width);
    default:
      return `Plain rendering not available for view: ${viewName}`;
  }
}
