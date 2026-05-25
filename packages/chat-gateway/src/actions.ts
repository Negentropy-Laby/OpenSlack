import { planActions, executePlan } from '@openslack/operator';
import type { ChatMessage, ChatResponse } from './types.js';
import { loadPendingPlan, validatePlan, deletePendingPlan, isActionAllowed } from './plan-store.js';
import { formatResultAsMarkdown, formatError } from './formatter.js';
import { buildPRCard, cardToText, toSlackBlocks } from './cards.js';
import { summarizePRForChat, formatPRChatSummary } from '@openslack/pr';
import { recordEvent } from '@openslack/collaboration';
import { resolveAgentPrincipal } from '@openslack/runtime';

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

function resolveActionAgentAuth(agentId: string | undefined, provider: 'slack' | 'webhook'): Parameters<typeof executePlan>[1] {
  if (!agentId) return {};
  const resolved = resolveAgentPrincipal({ root: process.cwd(), agentId, provider });
  if ('error' in resolved) {
    throw new Error(resolved.error);
  }
  return { principal: resolved.principal, snapshot: resolved.snapshot };
}

async function runPRMerge(prNumber: string, agentId: string | undefined, provider: 'slack' | 'webhook'): Promise<{ output: string; status: 'success' | 'failed' }> {
  const plan = planActions({
    kind: 'pr_merge',
    slots: { prNumber: Number(prNumber) },
    confidence: 1,
  });

  const result = await executePlan(plan, {
    dryRun: false,
    ...resolveActionAgentAuth(agentId, provider),
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
    try {
      recordEvent({
        type: 'operator.plan.blocked',
        actor: { id: message.user.id, kind: 'chat', provider: message.channel.type === 'webhook' ? 'webhook' : 'slack' },
        object: { kind: 'plan', id: planId },
        source: { kind: 'chat', ref: message.channel.id },
        summary: validation.reason || 'Plan validation failed',
        visibility: 'chat',
        redacted: false,
        containsSensitiveData: false,
      });
    } catch {
      // best-effort event recording
    }
    return formatError(validation.reason || 'Plan validation failed.');
  }

  // Step 1: Re-run PR doctor before merge
  const prNumber = plan.value;
  const provider = message.channel.type === 'webhook' ? 'webhook' : 'slack';
  const { output: doctorOutput, status: doctorStatus } = await runPRDoctor(prNumber);

  if (doctorStatus !== 'success') {
    deletePendingPlan(planId);
    return formatError(`PR doctor failed. Merge blocked.\n\n${doctorOutput.slice(0, 800)}`);
  }

  if (!isReadyToMerge(doctorOutput)) {
    deletePendingPlan(planId);
    try {
      recordEvent({
        type: 'pr.merge.blocked',
        actor: { id: message.user.id, kind: 'chat', provider: message.channel.type === 'webhook' ? 'webhook' : 'slack' },
        object: { kind: 'pr', id: prNumber },
        source: { kind: 'chat', ref: planId },
        summary: `Chat-confirmed merge blocked by PR doctor for PR #${prNumber}`,
        visibility: 'chat',
        redacted: false,
        containsSensitiveData: false,
        risk: 'high',
        nextAction: { owner: 'human', action: `Run openslack pr doctor ${prNumber}` },
      });
    } catch {
      // best-effort event recording
    }
    return {
      text: `🚫 *Merge blocked* — PR #${prNumber} is no longer ready.\n\n${doctorOutput.slice(0, 800)}\n\n_This can happen if checks failed or approval was withdrawn after the plan was created._`,
    };
  }

  // Step 2: Execute merge
  let mergeOutput: string;
  let mergeStatus: 'success' | 'failed';
  try {
    const result = await runPRMerge(prNumber, plan.agentId, provider);
    mergeOutput = result.output;
    mergeStatus = result.status;
  } catch (err) {
    deletePendingPlan(planId);
    return formatError(`Authorization failed:\n\n${(err as Error).message}`);
  }
  deletePendingPlan(planId);

  if (mergeStatus !== 'success') {
    try {
      recordEvent({
        type: 'pr.merge.blocked',
        actor: { id: message.user.id, kind: 'chat', provider: message.channel.type === 'webhook' ? 'webhook' : 'slack' },
        object: { kind: 'pr', id: prNumber },
        source: { kind: 'chat', ref: planId },
        summary: `Chat-confirmed merge failed for PR #${prNumber}`,
        visibility: 'chat',
        redacted: false,
        containsSensitiveData: false,
        risk: 'high',
      });
    } catch {
      // best-effort event recording
    }
    return formatError(`Merge failed:\n\n${mergeOutput.slice(0, 800)}`);
  }

  try {
    recordEvent({
      type: 'chat.plan.confirmed',
      actor: { id: message.user.id, kind: 'chat', provider: message.channel.type === 'webhook' ? 'webhook' : 'slack' },
      object: { kind: 'plan', id: planId },
      source: { kind: 'chat', ref: message.channel.id },
      summary: `Chat plan confirmed for PR #${prNumber}; GitHub approval was still enforced by PRMS`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
      risk: 'high',
    });
    recordEvent({
      type: 'pr.merge.completed',
      actor: { id: message.user.id, kind: 'chat', provider: message.channel.type === 'webhook' ? 'webhook' : 'slack' },
      object: { kind: 'pr', id: prNumber },
      source: { kind: 'chat', ref: planId },
      summary: `PR #${prNumber} merged after PRMS re-check`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
      risk: 'high',
    });
  } catch {
    // best-effort event recording
  }

  return {
    text: `✅ *PR #${prNumber} merged*\n\n${mergeOutput.slice(0, 800)}`,
  };
}

async function handleCancel(planId: string): Promise<ChatResponse> {
  deletePendingPlan(planId);
  try {
    recordEvent({
      type: 'chat.plan.cancelled',
      actor: { id: 'chat', kind: 'chat', provider: 'webhook' },
      object: { kind: 'plan', id: planId },
      source: { kind: 'chat', ref: 'action:cancel' },
      summary: `Chat plan cancelled: ${planId}`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
    });
  } catch {
    // best-effort event recording
  }
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
