import type { Intent, ActionPlan, PlanStep, MissingParam } from './types.js';
import { identifyMissingParams } from './clarify.js';
import { assessRisk, hasSideEffects } from './risk.js';

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
  'pr_watch',
  'pr_merge',
  'governance_audit',
]);

function buildSteps(intent: Intent): PlanStep[] {
  const prNumber = intent.slots.prNumber as number | undefined;
  const issueNumber = intent.slots.issueNumber as number | undefined;
  const agentId = intent.slots.agentId as string | undefined;
  const paths = intent.slots.paths as string | undefined;

  switch (intent.kind) {
    case 'status': {
      const scope = intent.slots.scope as string | undefined;
      if (scope === 'workspace') {
        return [{ id: 's1', tool: 'openslack-cli', command: 'workspace', args: ['status'], description: 'Show workspace status', confirmationRequired: false }];
      }
      if (scope === 'metrics') {
        return [{ id: 's1', tool: 'openslack-cli', command: 'github', args: ['metrics'], description: 'Show task loop metrics', confirmationRequired: false }];
      }
      if (scope === 'index') {
        return [{ id: 's1', tool: 'openslack-cli', command: 'workspace', args: ['index'], description: 'Build workspace index', confirmationRequired: false }];
      }
      return [{ id: 's1', tool: 'openslack-cli', command: 'status', args: [], description: 'Show product dashboard', confirmationRequired: false }];
    }

    case 'doctor': {
      const scope = intent.slots.scope as string | undefined;
      if (scope === 'workspace') {
        return [{ id: 's1', tool: 'openslack-cli', command: 'workspace', args: ['validate'], description: 'Validate workspace', confirmationRequired: false }];
      }
      if (scope === 'eval') {
        return [{ id: 's1', tool: 'openslack-cli', command: 'self', args: ['eval', '--suite', 'golden'], description: 'Run golden evals', confirmationRequired: false }];
      }
      if (scope === 'observe') {
        return [{ id: 's1', tool: 'openslack-cli', command: 'self', args: ['observe'], description: 'Check system health', confirmationRequired: false }];
      }
      return [{ id: 's1', tool: 'openslack-cli', command: 'doctor', args: [], description: 'Run multi-module health check', confirmationRequired: false }];
    }

    case 'governance_audit':
      return [{ id: 's1', tool: 'openslack-cli', command: 'governance', args: ['audit'], description: 'Audit recent commits for compliance', confirmationRequired: false }];

    case 'pr_status':
      if (!prNumber) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'pr', args: ['status', String(prNumber)], description: `Show PR #${prNumber} status`, confirmationRequired: false }];

    case 'pr_doctor':
      if (!prNumber) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'pr', args: ['doctor', String(prNumber)], description: `Diagnose PR #${prNumber} governance`, confirmationRequired: false }];

    case 'pr_review':
      if (!prNumber) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'pr', args: ['review', String(prNumber)], description: `Review PR #${prNumber}`, confirmationRequired: false }];

    case 'pr_watch':
      if (!prNumber) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'pr', args: ['watch', String(prNumber)], description: `Watch PR #${prNumber} until ready`, confirmationRequired: false }];

    case 'pr_merge':
      if (!prNumber) return [];
      return [
        { id: 's1', tool: 'openslack-cli', command: 'pr', args: ['doctor', String(prNumber)], description: `Verify PR #${prNumber} passes all gates`, confirmationRequired: false, produces: ['diagnosis'] },
        { id: 's2', tool: 'openslack-cli', command: 'pr', args: ['merge', String(prNumber)], description: `Merge PR #${prNumber}`, confirmationRequired: true },
      ];

    case 'create_task':
      return [{ id: 's1', tool: 'openslack-cli', command: 'self', args: ['triage', '--create-issues'], description: 'Create EVOL tasks on GitHub', confirmationRequired: false }];

    case 'claim_task':
      if (!agentId) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'agent', args: ['tick', '--source', 'github-issues', '--agent-id', agentId], description: `Claim task for ${agentId}`, confirmationRequired: false }];

    case 'checkout_task':
      if (!issueNumber || !agentId) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'task', args: ['checkout', '--issue-number', String(issueNumber), '--agent-id', agentId], description: `Create worktree for issue #${issueNumber}`, confirmationRequired: false }];

    case 'sync_task':
      if (!issueNumber || !agentId || !paths) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'task', args: ['sync', '--issue-number', String(issueNumber), '--agent-id', agentId, '--paths', paths], description: `Propose workspace PR for issue #${issueNumber}`, confirmationRequired: true }];

    case 'issue_done':
      if (!issueNumber) return [];
      return [{ id: 's1', tool: 'openslack-cli', command: 'github', args: ['issue-done', '--issue-number', String(issueNumber)], description: `Mark issue #${issueNumber} as done`, confirmationRequired: true }];

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
    case 'pr_watch': return `Watch PR #${intent.slots.prNumber}`;
    case 'pr_merge': return `Merge PR #${intent.slots.prNumber}`;
    case 'create_task': return 'Create EVOL tasks';
    case 'claim_task': return 'Claim a task from GitHub Issues';
    case 'checkout_task': return `Checkout issue #${intent.slots.issueNumber}`;
    case 'sync_task': return `Sync issue #${intent.slots.issueNumber}`;
    case 'issue_done': return `Mark issue #${intent.slots.issueNumber} done`;
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
