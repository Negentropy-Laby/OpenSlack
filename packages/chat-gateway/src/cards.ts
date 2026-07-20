import type { PRChatSummary } from '@openslack/pr';
import type { Handoff } from '@openslack/collaboration';
import type { Decision } from '@openslack/collaboration';
import type { WorkflowPreview } from '@openslack/collaboration';
import type { ActionPlan } from '@openslack/operator';

export interface ChatCardField {
  label: string;
  value: string;
}

export type ChatActionKind =
  | 'show_doctor'
  | 'watch_pr'
  | 'confirm_merge'
  | 'cancel'
  | 'accept_handoff'
  | 'close_handoff'
  | 'record_decision'
  | 'execute_workflow'
  | 'preview_task'
  | 'claim_task'
  | 'approve_plan';

export interface ChatAction {
  id: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  action: ChatActionKind;
  value: string;
}

export interface ChatCard {
  title: string;
  summary: string;
  fields: ChatCardField[];
  actions: ChatAction[];
}

export function buildPRCard(summary: PRChatSummary): ChatCard {
  const fields: ChatCardField[] = [
    { label: 'Zone', value: summary.zone },
    { label: 'Status', value: summary.canMerge ? 'Ready to merge' : 'Blocked' },
  ];

  if (summary.blocker) {
    fields.push({ label: 'Blocker', value: summary.blocker });
  }
  if (summary.blockerCategory) {
    fields.push({ label: 'Category', value: summary.blockerCategory });
  }
  if (summary.owner) {
    fields.push({ label: 'Owner', value: summary.owner });
  }

  const actions: ChatAction[] = [];

  if (summary.canMerge) {
    actions.push({
      id: 'merge',
      label: 'Confirm merge',
      style: 'primary',
      action: 'confirm_merge',
      value: String(summary.prNumber),
    });
  } else {
    actions.push({
      id: 'doctor',
      label: 'Show full diagnosis',
      style: 'default',
      action: 'show_doctor',
      value: String(summary.prNumber),
    });
    actions.push({
      id: 'watch',
      label: 'Watch PR',
      style: 'default',
      action: 'watch_pr',
      value: String(summary.prNumber),
    });
  }

  return {
    title: `PR #${summary.prNumber} — ${summary.title}`,
    summary: summary.canMerge
      ? `Ready to merge (${summary.zone} zone)`
      : `Cannot merge${summary.blocker ? `: ${summary.blocker}` : ''}`,
    fields,
    actions,
  };
}

export interface TaskSummary {
  issueNumber: number;
  title: string;
  status: string;
  assignee?: string;
  risk?: string;
  labels?: string[];
}

export function buildTaskCard(task: TaskSummary): ChatCard {
  const fields: ChatCardField[] = [{ label: 'Status', value: task.status }];
  if (task.assignee) fields.push({ label: 'Assignee', value: task.assignee });
  if (task.risk) fields.push({ label: 'Risk', value: task.risk });

  return {
    title: `Task #${task.issueNumber} — ${task.title}`,
    summary: `Status: ${task.status}`,
    fields,
    actions: [
      {
        id: 'preview',
        label: 'Preview',
        style: 'default',
        action: 'preview_task',
        value: String(task.issueNumber),
      },
      {
        id: 'claim',
        label: 'Claim',
        style: 'primary',
        action: 'claim_task',
        value: String(task.issueNumber),
      },
    ],
  };
}

export function buildHandoffCard(handoff: Handoff): ChatCard {
  const fields: ChatCardField[] = [
    { label: 'From', value: handoff.from },
    { label: 'To', value: handoff.to },
    { label: 'Status', value: handoff.status },
  ];
  if (handoff.issueRef) fields.push({ label: 'Issue', value: handoff.issueRef });
  if (handoff.prRef) fields.push({ label: 'PR', value: handoff.prRef });

  const actions: ChatAction[] = [];
  if (handoff.status === 'open') {
    actions.push({
      id: 'accept',
      label: 'Accept',
      style: 'primary',
      action: 'accept_handoff',
      value: handoff.id,
    });
    actions.push({
      id: 'close',
      label: 'Close',
      style: 'default',
      action: 'close_handoff',
      value: handoff.id,
    });
  }

  return {
    title: `Handoff: ${handoff.id}`,
    summary: `${handoff.from} → ${handoff.to}: ${handoff.context}`,
    fields,
    actions,
  };
}

export function buildDecisionCard(decision: Decision): ChatCard {
  const fields: ChatCardField[] = [
    { label: 'Topic', value: decision.topic },
    { label: 'Decision', value: decision.decision },
    { label: 'Decided by', value: decision.decidedBy },
    { label: 'Status', value: decision.status },
  ];
  if (decision.rationale) fields.push({ label: 'Rationale', value: decision.rationale });

  return {
    title: `Decision: ${decision.id}`,
    summary: `${decision.topic}: ${decision.decision}`,
    fields,
    actions:
      decision.status === 'active'
        ? [
            {
              id: 'record',
              label: 'Record Alternative',
              style: 'default',
              action: 'record_decision',
              value: decision.id,
            },
          ]
        : [],
  };
}

export function buildWorkflowCard(preview: WorkflowPreview): ChatCard {
  const phaseNames = [...new Set(preview.steps.map((s) => s.phase))];
  const stepCount = preview.steps.length;
  const hasSideEffects = preview.steps.some((s) => s.sideEffects);

  const fields: ChatCardField[] = [
    { label: 'Phases', value: phaseNames.join(' → ') },
    { label: 'Steps', value: String(stepCount) },
    { label: 'Side effects', value: hasSideEffects ? 'Yes' : 'No' },
  ];
  if (preview.errors.length > 0) {
    fields.push({ label: 'Errors', value: preview.errors.join('; ') });
  }

  const actions: ChatAction[] = [];
  if (preview.errors.length === 0) {
    actions.push({
      id: 'execute',
      label: 'Execute',
      style: 'primary',
      action: 'execute_workflow',
      value: preview.correlationId,
    });
    actions.push({
      id: 'cancel',
      label: 'Cancel',
      style: 'danger',
      action: 'cancel',
      value: preview.correlationId,
    });
  }

  return {
    title: `Workflow: ${preview.name}`,
    summary: `${stepCount} steps across ${phaseNames.length} phases`,
    fields,
    actions,
  };
}

export function buildPlanCard(plan: ActionPlan, planId: string): ChatCard {
  const fields: ChatCardField[] = [
    { label: 'Goal', value: plan.goal },
    { label: 'Steps', value: String(plan.steps.length) },
    { label: 'Risk', value: plan.riskLevel },
  ];
  if (plan.riskExplanation) fields.push({ label: 'Risk note', value: plan.riskExplanation });

  return {
    title: `Plan: ${plan.goal}`,
    summary: `${plan.steps.length} steps, risk: ${plan.riskLevel}`,
    fields,
    actions: [
      { id: 'approve', label: 'Approve', style: 'primary', action: 'approve_plan', value: planId },
      { id: 'cancel', label: 'Cancel', style: 'danger', action: 'cancel', value: planId },
    ],
  };
}

export function toSlackBlocks(card: ChatCard): unknown[] {
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${card.title}*\n${card.summary}`,
      },
    },
  ];

  if (card.fields.length > 0) {
    const fieldTexts = card.fields.map((f) => `*${f.label}:* ${f.value}`).join('  |  ');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: fieldTexts,
      },
    });
  }

  if (card.actions.length > 0) {
    blocks.push({
      type: 'actions',
      elements: card.actions.map((a) => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: a.label,
        },
        action_id: `${a.action}:${a.value}`,
        style: a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : undefined,
      })),
    });
  }

  return blocks;
}

export function cardToText(card: ChatCard): string {
  const lines: string[] = [];
  lines.push(`${card.title}`);
  lines.push(card.summary);

  if (card.fields.length > 0) {
    for (const f of card.fields) {
      lines.push(`${f.label}: ${f.value}`);
    }
  }

  return lines.join('\n');
}
