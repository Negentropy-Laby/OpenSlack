import { parseIntent } from './intent.js';
import { planActions } from './planner.js';
import { formatPlan } from './summarizer.js';
import type { ActionPlan, PlanStep, RiskLevel } from './types.js';

export interface ConversationActionCard {
  id: string;
  label: string;
  detail: string;
  kind: 'route' | 'command' | 'workflow_draft' | 'approval' | 'agent_run';
  route?: string;
  routeParams?: Record<string, unknown>;
  command?: string;
  prompt?: string;
  riskLevel: RiskLevel;
  confirmationRequired: boolean;
  linkedObject?: { kind: 'issue' | 'pr' | 'workflow_run'; id: string };
}

export interface TuiAskPlan {
  message: string;
  plan: ActionPlan;
  cards: ConversationActionCard[];
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stepCommand(step: PlanStep): string {
  return `openslack ${step.command} ${step.args.join(' ')}`.trim();
}

function cardFromStep(step: PlanStep, index: number): ConversationActionCard {
  const id = `step-${index + 1}`;
  const base = {
    id,
    detail: step.description,
    riskLevel: 'low' as RiskLevel,
    confirmationRequired: step.confirmationRequired,
  };

  if (step.actionId === 'status.show') {
    return { ...base, label: 'Open Status', kind: 'route', route: 'status' };
  }
  if (step.actionId === 'doctor.run') {
    return {
      ...base,
      label: 'Open Status and run doctor from CLI',
      kind: 'route',
      route: 'status',
      command: stepCommand(step),
    };
  }
  if (step.actionId === 'pr.queue') {
    return { ...base, label: 'Open PR Queue', kind: 'route', route: 'pr-queue' };
  }
  if (step.actionId === 'pr.doctor' || step.actionId === 'pr.review' || step.actionId === 'pr.status') {
    const prNumber = step.input?.prNumber;
    return {
      ...base,
      label: step.actionId === 'pr.doctor' ? 'Run PR Doctor' : step.actionId === 'pr.review' ? 'Review PR' : 'Check PR Status',
      kind: 'command',
      command: stepCommand(step),
      linkedObject: typeof prNumber === 'number' ? { kind: 'pr', id: String(prNumber) } : undefined,
    };
  }
  if (step.actionId === 'pr.merge') {
    const prNumber = step.input?.prNumber;
    return {
      ...base,
      label: 'Open PR Queue for merge gate',
      kind: 'approval',
      route: 'pr-queue',
      command: stepCommand(step),
      riskLevel: 'medium',
      confirmationRequired: true,
      linkedObject: typeof prNumber === 'number' ? { kind: 'pr', id: String(prNumber) } : undefined,
    };
  }
  if (step.actionId?.startsWith('task.')) {
    const issueNumber = step.input?.issueNumber;
    return {
      ...base,
      label: step.description,
      kind: 'command',
      command: stepCommand(step),
      linkedObject: typeof issueNumber === 'number' ? { kind: 'issue', id: String(issueNumber) } : undefined,
    };
  }

  return {
    ...base,
    label: step.description,
    kind: step.confirmationRequired ? 'approval' : 'command',
    route: step.confirmationRequired ? 'approvals' : undefined,
    command: stepCommand(step),
  };
}

function workflowCards(prompt: string, risk: RiskLevel): ConversationActionCard[] {
  const generateCommand = `openslack collaboration workflow generate --prompt ${quote(prompt)}`;
  return [
    {
      id: 'workflow-generate-draft',
      label: 'Generate Draft',
      detail: 'Create a workflow draft from this prompt; this does not execute it.',
      kind: 'workflow_draft',
      command: generateCommand,
      prompt,
      riskLevel: risk,
      confirmationRequired: false,
    },
    {
      id: 'workflow-preview-draft',
      label: 'Preview Draft',
      detail: 'Inspect generated phases, budget, permissions, and side effects before dry-run or execution.',
      kind: 'command',
      route: 'workflows',
      command: 'openslack collaboration workflow preview-draft <draftId>',
      riskLevel: 'low',
      confirmationRequired: false,
    },
    {
      id: 'workflow-dry-run',
      label: 'Dry-run after draft review',
      detail: 'Use after a draft exists and has been inspected.',
      kind: 'command',
      command: 'openslack collaboration workflow dry-run <workflow-file>',
      riskLevel: 'low',
      confirmationRequired: false,
    },
    {
      id: 'workflow-run',
      label: 'Run after approval',
      detail: 'Execution can create side effects and must pass workflow approval gates.',
      kind: 'approval',
      route: 'approvals',
      command: 'openslack collaboration workflow run <workflow-file>',
      riskLevel: 'medium',
      confirmationRequired: true,
    },
  ];
}

function profileSyncCards(): ConversationActionCard[] {
  return [
    {
      id: 'profile-sync-check',
      label: 'Check Profile Sync',
      detail: 'Open the Profile workbench and run the existing check action.',
      kind: 'route',
      route: 'profile',
      command: 'openslack collaboration workflow profile-sync check',
      riskLevel: 'low',
      confirmationRequired: false,
    },
    {
      id: 'profile-sync-preview',
      label: 'Preview Patch',
      detail: 'Preview the profile patch before creating any PR.',
      kind: 'route',
      route: 'profile',
      command: 'openslack collaboration workflow profile-sync preview',
      riskLevel: 'low',
      confirmationRequired: false,
    },
    {
      id: 'profile-sync-create-pr',
      label: 'Create Profile Sync PR',
      detail: 'Open Profile Sync and create a PR only after explicit confirmation.',
      kind: 'approval',
      route: 'profile',
      command: 'openslack collaboration workflow profile-sync run',
      riskLevel: 'medium',
      confirmationRequired: true,
    },
  ];
}

function cardsForPlan(plan: ActionPlan, originalText: string): ConversationActionCard[] {
  if (plan.intent.kind === 'profile_sync') {
    return profileSyncCards();
  }

  if (plan.workflowRecommendation) {
    return workflowCards(originalText, plan.workflowRecommendation.risk);
  }

  if (plan.missingParams.length > 0) {
    return [
      {
        id: 'missing-params',
        label: 'Clarify Request',
        detail: plan.missingParams.map(p => `${p.name}: ${p.description}`).join('; '),
        kind: 'command',
        command: `openslack ask ${quote(originalText)}`,
        riskLevel: 'none',
        confirmationRequired: false,
      },
    ];
  }

  if (plan.steps.length > 0) {
    return plan.steps.map(cardFromStep);
  }

  return [
    {
      id: 'fallback-ask',
      label: 'Use OpenSlack Ask',
      detail: 'This request is not mapped to a TUI action yet.',
      kind: 'command',
      command: `openslack ask ${quote(originalText)}`,
      riskLevel: 'none',
      confirmationRequired: false,
    },
  ];
}

export function buildTuiAskPlan(text: string): TuiAskPlan {
  const intent = parseIntent(text);
  const plan = planActions(intent);
  const message = formatPlan(plan);
  return {
    message,
    plan,
    cards: cardsForPlan(plan, text),
  };
}
