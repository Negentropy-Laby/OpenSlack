import type { Intent, ActionPlan, PlanStep, MissingParam } from './types.js';
import { identifyMissingParams } from './clarify.js';
import { assessRisk, hasSideEffects } from './risk.js';
import { createRegisteredStep } from './tool-registry.js';

const ALLOWLISTED_INTENTS = new Set([
  'status',
  'doctor',
  'create_task',
  'claim_task',
  'checkout_task',
  'sync_task',
  'issue_done',
  'pr_status',
  'pr_doctor',
  'pr_review',
  'pr_queue',
  'pr_watch',
  'pr_merge',
  'github_repair_labels',
  'github_repair_claims',
  'task_repair_worktrees',
  'governance_audit',
]);

function buildSteps(intent: Intent): PlanStep[] {
  const prNumber = intent.slots.prNumber as number | undefined;
  const issueNumber = intent.slots.issueNumber as number | undefined;
  const agentId = intent.slots.agentId as string | undefined;
  const paths = intent.slots.paths as string | undefined;
  const title = intent.slots.title as string | undefined;
  const step = (actionId: string, input: Record<string, string | number | boolean | undefined> = {}, id = 's1') =>
    createRegisteredStep(actionId, input, id);

  switch (intent.kind) {
    case 'status': {
      const scope = intent.slots.scope as string | undefined;
      if (scope === 'workspace') return [step('workspace.status')];
      if (scope === 'metrics') return [step('github.metrics')];
      if (scope === 'index') return [step('workspace.index')];
      return [step('status.show')];
    }

    case 'doctor': {
      const scope = intent.slots.scope as string | undefined;
      if (scope === 'workspace') return [step('workspace.validate')];
      if (scope === 'eval') return [step('self.eval.golden')];
      if (scope === 'observe') return [step('self.observe')];
      return [step('doctor.run')];
    }

    case 'governance_audit':
      return [step('governance.audit')];

    case 'pr_status':
      if (!prNumber) return [];
      return [step('pr.status', { prNumber })];

    case 'pr_doctor':
      if (!prNumber) return [];
      return [step('pr.doctor', { prNumber })];

    case 'pr_review':
      if (!prNumber) return [];
      return [step('pr.review', { prNumber })];

    case 'pr_queue':
      return [step('pr.queue')];

    case 'pr_watch':
      if (!prNumber) return [];
      return [step('pr.watch', { prNumber })];

    case 'pr_merge':
      if (!prNumber) return [];
      return [
        step('pr.doctor', { prNumber }, 's1'),
        step('pr.merge', { prNumber }, 's2'),
      ];

    case 'create_task':
      if (!title) return [];
      return [step('task.create.preview', { title, template: 'investigation' })];

    case 'claim_task':
      if (!agentId) return [];
      return [step('agent.claim_task', { agentId })];

    case 'checkout_task':
      if (!issueNumber || !agentId) return [];
      return [step('task.checkout', { issueNumber, agentId })];

    case 'sync_task':
      if (!issueNumber || !agentId || !paths) return [];
      return [step('task.sync', { issueNumber, agentId, paths })];

    case 'issue_done':
      if (!issueNumber) return [];
      return [step('github.issue_done', { issueNumber })];

    case 'github_repair_labels':
      return [step('github.repair.labels.preview')];

    case 'github_repair_claims':
      return [step('github.repair.claims.preview')];

    case 'task_repair_worktrees':
      return [step('task.repair.worktrees.preview')];

    case 'unknown':
    default:
      return [];
  }
}

function buildGoal(intent: Intent): string {
  switch (intent.kind) {
    case 'status': return 'Check OpenSlack status';
    case 'doctor': return 'Run health diagnostics';
    case 'governance_audit': return 'Audit governance compliance';
    case 'pr_status': return `Check PR #${intent.slots.prNumber} status`;
    case 'pr_doctor': return `Diagnose PR #${intent.slots.prNumber}`;
    case 'pr_review': return `Review PR #${intent.slots.prNumber}`;
    case 'pr_queue': return 'Show PR queue';
    case 'pr_watch': return `Watch PR #${intent.slots.prNumber}`;
    case 'pr_merge': return `Merge PR #${intent.slots.prNumber}`;
    case 'create_task': return `Preview task "${intent.slots.title}"`;
    case 'claim_task': return 'Claim a task from GitHub Issues';
    case 'checkout_task': return `Checkout issue #${intent.slots.issueNumber}`;
    case 'sync_task': return `Sync issue #${intent.slots.issueNumber}`;
    case 'issue_done': return `Mark issue #${intent.slots.issueNumber} done`;
    case 'github_repair_labels': return 'Preview GitHub label repair';
    case 'github_repair_claims': return 'Preview GitHub claim repair';
    case 'task_repair_worktrees': return 'Preview local worktree repair';
    default: return 'Unknown request';
  }
}

export function planActions(intent: Intent): ActionPlan {
  // Security: block unallowlisted intents
  if (intent.kind !== 'unknown' && !ALLOWLISTED_INTENTS.has(intent.kind)) {
    return {
      goal: 'Unknown request',
      intent,
      steps: [],
      riskLevel: 'none',
      missingParams: [],
      requiresConfirmation: false,
      sideEffects: false,
    };
  }

  const missing = identifyMissingParams(intent);
  const steps = missing.length === 0 ? buildSteps(intent) : [];
  const risk = assessRisk(intent);

  // Any step that requires confirmation triggers plan-level confirmation
  const hasConfirmStep = steps.some((s) => s.confirmationRequired);
  const requiresConfirmation = risk.level === 'high' || risk.level === 'medium' || hasConfirmStep;

  return {
    goal: buildGoal(intent),
    intent,
    steps,
    riskLevel: risk.level,
    riskExplanation: risk.explanation,
    missingParams: missing,
    requiresConfirmation,
    sideEffects: hasSideEffects(intent),
  };
}
