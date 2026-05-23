import { planActions, executePlan } from '@openslack/operator';
import type { ChatMessage, ChatResponse } from './types.js';
import { loadPendingPlan, validatePlan, deletePendingPlan, isActionAllowed } from './plan-store.js';
import { formatResultAsMarkdown, formatError } from './formatter.js';
import { buildPRCard, cardToText, toSlackBlocks } from './cards.js';
import { summarizePRForChat, formatPRChatSummary } from '@openslack/pr';

interface ActionContext {
  message: ChatMessage;
}

function parseActionText(text: string): { action: string; value: string } | null {
  const match = text.match(/^action:([^:]+):(.+)$/);
  if (!match) return null;
  return { action: match[1], value: match[2] };
}

async function runPRDoctor(prNumber: string): Promise<{ output: string; status: 'success' | 'failed' }> {
  const plan = planActions({
    kind: 'pr_doctor',
    slots: { prNumber: Number(prNumber) },
    confidence: 1,
  });

  const result = await executePlan(plan, { dryRun: false });
  const stepResult = result.steps[0];
  return {
    output: stepResult?.output || result.summary,
    status: result.status === 'success' ? 'success' : 'failed',
  };
}

async function runPRMerge(prNumber: string): Promise<{ output: string; status: 'success' | 'failed' }> {
  const plan = planActions({
    kind: 'pr_merge',
    slots: { prNumber: Number(prNumber) },
    confidence: 1,
  });

  const result = await executePlan(plan, {
    dryRun: false,
    confirmStep: async () => true, // Already confirmed via plan store
  });
  const stepResult = result.steps.find((s) => s.stepId === 's2');
  return {
    output: stepResult?.output || result.summary,
    status: result.status === 'success' ? 'success' : 'failed',
  };
}

async function runPRWatch(prNumber: string): Promise<{ output: string; status: 'success' | 'failed' }> {
  const plan = planActions({
    kind: 'pr_watch',
    slots: { prNumber: Number(prNumber) },
    confidence: 1,
  });

  const result = await executePlan(plan, { dryRun: false });
  const stepResult = result.steps[0];
  return {
    output: stepResult?.output || result.summary,
    status: result.status === 'success' ? 'success' : 'failed',
  };
}

function isReadyToMerge(doctorOutput: string): boolean {
  return doctorOutput.includes('READY_TO_MERGE') || doctorOutput.includes('Ready to merge');
}

async function handleShowDoctor(prNumber: string): Promise<ChatResponse> {
  const { output, status } = await runPRDoctor(prNumber);

  if (status !== 'success') {
    return formatError(`Failed to run PR doctor: ${output}`);
  }

  return { text: `*PR #${prNumber} Doctor Report*\n\n${output.slice(0, 1500)}${output.length > 1500 ? '...' : ''}` };
}

async function handleWatchPR(prNumber: string): Promise<ChatResponse> {
  const { output, status } = await runPRWatch(prNumber);

  if (status !== 'success') {
    return formatError(`Failed to watch PR: ${output}`);
  }

  return { text: `*Watching PR #${prNumber}*\n\n${output.slice(0, 1500)}${output.length > 1500 ? '...' : ''}` };
}

async function handleConfirmMerge(planId: string, message: ChatMessage): Promise<ChatResponse> {
  const plan = loadPendingPlan(planId);
  if (!plan) {
    return formatError('Plan not found or already expired. Please request again.');
  }

  if (!isActionAllowed(plan.action)) {
    deletePendingPlan(planId);
    return formatError('Invalid action type.');
  }

  const validation = validatePlan(
    plan,
    message.user.id,
    message.channel.id,
    message.threadId,
  );

  if (!validation.valid) {
    return formatError(validation.reason || 'Plan validation failed.');
  }

  // Step 1: Re-run PR doctor before merge
  const prNumber = plan.value;
  const { output: doctorOutput, status: doctorStatus } = await runPRDoctor(prNumber);

  if (doctorStatus !== 'success') {
    deletePendingPlan(planId);
    return formatError(`PR doctor failed. Merge blocked.\n\n${doctorOutput.slice(0, 800)}`);
  }

  if (!isReadyToMerge(doctorOutput)) {
    deletePendingPlan(planId);
    return {
      text: `🚫 *Merge blocked* — PR #${prNumber} is no longer ready.\n\n${doctorOutput.slice(0, 800)}\n\n_This can happen if checks failed or approval was withdrawn after the plan was created._`,
    };
  }

  // Step 2: Execute merge
  const { output: mergeOutput, status: mergeStatus } = await runPRMerge(prNumber);
  deletePendingPlan(planId);

  if (mergeStatus !== 'success') {
    return formatError(`Merge failed:\n\n${mergeOutput.slice(0, 800)}`);
  }

  return {
    text: `✅ *PR #${prNumber} merged*\n\n${mergeOutput.slice(0, 800)}`,
  };
}

async function handleCancel(planId: string): Promise<ChatResponse> {
  deletePendingPlan(planId);
  return { text: 'Cancelled.' };
}

export async function handleAction(message: ChatMessage): Promise<ChatResponse | null> {
  const parsed = parseActionText(message.text);
  if (!parsed) return null;

  const { action, value } = parsed;

  switch (action) {
    case 'show_doctor':
      return handleShowDoctor(value);
    case 'watch_pr':
      return handleWatchPR(value);
    case 'confirm_merge':
      return handleConfirmMerge(value, message);
    case 'cancel':
      return handleCancel(value);
    default:
      return null;
  }
}

export { parseActionText };
