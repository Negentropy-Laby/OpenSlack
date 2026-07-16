import { BUILTIN_ACTION_REGISTRY, planActions, executePlan } from '@openslack/operator';
import type { ActionRegistryPort } from '@openslack/operator';
import type { ChatMessage, ChatResponse } from './types.js';
import { loadPendingPlan, validatePlan, deletePendingPlan, isActionAllowed } from './plan-store.js';
import { formatResultAsMarkdown, formatError } from './formatter.js';
import { buildPRCard, cardToText, toSlackBlocks, buildHandoffCard, buildDecisionCard, buildWorkflowCard } from './cards.js';
import { summarizePRForChat, formatPRChatSummary } from '@openslack/pr';
import { recordEvent, acceptHandoff, closeHandoff, getHandoff, getDecision } from '@openslack/collaboration';
import { resolveAgentPrincipal } from '@openslack/runtime';

interface ActionContext {
  message: ChatMessage;
}

function chatProvider(message: ChatMessage): 'slack' | 'webhook' {
  return message.channel.type === 'webhook' ? 'webhook' : 'slack';
}

function parseActionText(text: string): { action: string; value: string } | null {
  const match = text.match(/^action:([^:]+):(.+)$/);
  if (!match) return null;
  return { action: match[1], value: match[2] };
}

async function runPRDoctor(
  prNumber: string,
  registry: ActionRegistryPort,
): Promise<{ output: string; status: 'success' | 'failed' }> {
  const plan = planActions({
    kind: 'pr_doctor',
    slots: { prNumber: Number(prNumber) },
    confidence: 1,
  }, registry);

  const result = await executePlan(plan, { dryRun: false }, registry);
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

async function runPRMerge(
  prNumber: string,
  agentId: string | undefined,
  provider: 'slack' | 'webhook',
  registry: ActionRegistryPort,
): Promise<{ output: string; status: 'success' | 'failed' }> {
  const plan = planActions({
    kind: 'pr_merge',
    slots: { prNumber: Number(prNumber) },
    confidence: 1,
  }, registry);

  const result = await executePlan(
    plan,
    {
      dryRun: false,
      ...resolveActionAgentAuth(agentId, provider),
      confirmStep: async () => true, // Already confirmed via plan store
    },
    registry,
  );
  const stepResult = result.steps.find((s) => s.stepId === 's2');
  return {
    output: stepResult?.output || result.summary,
    status: result.status === 'success' ? 'success' : 'failed',
  };
}

async function runPRWatch(
  prNumber: string,
  registry: ActionRegistryPort,
): Promise<{ output: string; status: 'success' | 'failed' }> {
  const plan = planActions({
    kind: 'pr_watch',
    slots: { prNumber: Number(prNumber) },
    confidence: 1,
  }, registry);

  const result = await executePlan(plan, { dryRun: false }, registry);
  const stepResult = result.steps[0];
  return {
    output: stepResult?.output || result.summary,
    status: result.status === 'success' ? 'success' : 'failed',
  };
}

function isReadyToMerge(doctorOutput: string): boolean {
  return doctorOutput.includes('READY_TO_MERGE') || doctorOutput.includes('Ready to merge');
}

async function handleShowDoctor(
  prNumber: string,
  registry: ActionRegistryPort,
): Promise<ChatResponse> {
  const { output, status } = await runPRDoctor(prNumber, registry);

  if (status !== 'success') {
    return formatError(`Failed to run PR doctor: ${output}`);
  }

  return { text: `*PR #${prNumber} Doctor Report*\n\n${output.slice(0, 1500)}${output.length > 1500 ? '...' : ''}` };
}

async function handleWatchPR(
  prNumber: string,
  registry: ActionRegistryPort,
): Promise<ChatResponse> {
  const { output, status } = await runPRWatch(prNumber, registry);

  if (status !== 'success') {
    return formatError(`Failed to watch PR: ${output}`);
  }

  return { text: `*Watching PR #${prNumber}*\n\n${output.slice(0, 1500)}${output.length > 1500 ? '...' : ''}` };
}

async function handleConfirmMerge(
  planId: string,
  message: ChatMessage,
  registry: ActionRegistryPort,
): Promise<ChatResponse> {
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
  const { output: doctorOutput, status: doctorStatus } = await runPRDoctor(prNumber, registry);

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
    const result = await runPRMerge(prNumber, plan.agentId, provider, registry);
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

async function validatePendingChatPlan(planId: string, message: ChatMessage): Promise<{
  plan?: NonNullable<ReturnType<typeof loadPendingPlan>>;
  error?: ChatResponse;
}> {
  const plan = loadPendingPlan(planId);
  if (!plan) {
    return { error: formatError(`Plan not found or expired: ${planId}`) };
  }

  const validation = validatePlan(plan, message.user.id, message.channel.id, message.threadId);
  if (!validation.valid) {
    try {
      recordEvent({
        type: 'operator.plan.blocked',
        actor: { id: message.user.id, kind: 'chat', provider: chatProvider(message) },
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
    return { error: formatError(validation.reason || 'Plan validation failed.') };
  }

  return { plan };
}

async function handleCancel(planId: string, message: ChatMessage): Promise<ChatResponse> {
  const validation = await validatePendingChatPlan(planId, message);
  if (validation.error) return validation.error;

  deletePendingPlan(planId);
  try {
    recordEvent({
      type: 'chat.plan.cancelled',
      actor: { id: message.user.id, kind: 'chat', provider: chatProvider(message) },
      object: { kind: 'plan', id: planId },
      source: { kind: 'chat', ref: message.channel.id },
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

async function handleAcceptHandoff(handoffId: string, message: ChatMessage): Promise<ChatResponse> {
  const handoff = getHandoff(handoffId);
  if (!handoff) {
    return formatError(`Handoff not found: ${handoffId}`);
  }
  if (handoff.status !== 'open') {
    return formatError(`Handoff ${handoffId} is not open (status: ${handoff.status})`);
  }

  const accepted = acceptHandoff(handoffId);
  if (!accepted) {
    return formatError(`Failed to accept handoff: ${handoffId}`);
  }
  try {
    recordEvent({
      type: 'handoff.accepted',
      actor: { id: message.user.id, kind: 'chat', provider: chatProvider(message) },
      object: { kind: 'handoff', id: handoffId },
      source: { kind: 'chat', ref: message.channel.id },
      summary: `Handoff ${handoffId} accepted by ${message.user.id}`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
    });
  } catch { /* best-effort */ }

  const card = buildHandoffCard(accepted);
  return { text: cardToText(card) };
}

async function handleCloseHandoff(handoffId: string, message: ChatMessage): Promise<ChatResponse> {
  const handoff = getHandoff(handoffId);
  if (!handoff) {
    return formatError(`Handoff not found: ${handoffId}`);
  }

  const closed = closeHandoff(handoffId);
  if (!closed) {
    return formatError(`Failed to close handoff: ${handoffId}`);
  }
  try {
    recordEvent({
      type: 'handoff.closed',
      actor: { id: message.user.id, kind: 'chat', provider: chatProvider(message) },
      object: { kind: 'handoff', id: handoffId },
      source: { kind: 'chat', ref: message.channel.id },
      summary: `Handoff ${handoffId} closed by ${message.user.id}`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
    });
  } catch { /* best-effort */ }

  const card = buildHandoffCard(closed);
  return { text: cardToText(card) };
}

async function handleRecordDecision(decisionId: string, _message: ChatMessage): Promise<ChatResponse> {
  const decision = getDecision(decisionId);
  if (!decision) {
    return formatError(`Decision not found: ${decisionId}`);
  }
  const card = buildDecisionCard(decision);
  return { text: cardToText(card) };
}

async function handleExecuteWorkflow(correlationId: string, message: ChatMessage): Promise<ChatResponse> {
  const plan = loadPendingPlan(correlationId);
  if (plan) {
    const validation = validatePlan(plan, message.user.id, message.channel.id, message.threadId);
    if (!validation.valid) {
      deletePendingPlan(correlationId);
      return formatError(validation.reason || 'Workflow plan validation failed.');
    }
  }

  try {
    recordEvent({
      type: 'workflow.started',
      actor: { id: message.user.id, kind: 'chat', provider: chatProvider(message) },
      object: { kind: 'workflow', id: correlationId },
      source: { kind: 'chat', ref: message.channel.id },
      summary: `Workflow ${correlationId} confirmed via chat`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
    });
  } catch { /* best-effort */ }

  if (plan) deletePendingPlan(correlationId);
  return { text: `Workflow ${correlationId} confirmed. Use \`openslack workflow run ${correlationId}\` to execute.` };
}

async function handlePreviewTask(issueNumber: string): Promise<ChatResponse> {
  return { text: `Task #${issueNumber} preview not yet available in chat. Use: \`openslack task show ${issueNumber}\`` };
}

async function handleClaimTask(issueNumber: string, message: ChatMessage): Promise<ChatResponse> {
  return { text: `Task #${issueNumber} claim not yet available in chat. Use: \`openslack task claim ${issueNumber}\`` };
}

async function handleApprovePlan(planId: string, message: ChatMessage): Promise<ChatResponse> {
  const validation = await validatePendingChatPlan(planId, message);
  if (validation.error) return validation.error;

  const plan = validation.plan;
  if (plan?.action !== 'approve_plan') {
    return formatError(`Plan ${planId} cannot be approved with this chat action. Use the specific action for ${plan?.action ?? 'this plan'} or the CLI approval command.`);
  }

  try {
    recordEvent({
      type: 'chat.plan.confirmed',
      actor: { id: message.user.id, kind: 'chat', provider: chatProvider(message) },
      object: { kind: 'plan', id: planId },
      source: { kind: 'chat', ref: message.channel.id },
      summary: `Plan ${planId} confirmation requested via chat`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
    });
  } catch { /* best-effort */ }
  return { text: `Plan ${planId} confirmed in chat. Chat confirmation does not execute this plan; run the CLI approval command shown by the Operator to execute it.` };
}

export async function handleAction(
  message: ChatMessage,
  registry: ActionRegistryPort = BUILTIN_ACTION_REGISTRY,
): Promise<ChatResponse | null> {
  const parsed = parseActionText(message.text);
  if (!parsed) return null;

  const { action, value } = parsed;

  switch (action) {
    case 'show_doctor':
      return handleShowDoctor(value, registry);
    case 'watch_pr':
      return handleWatchPR(value, registry);
    case 'confirm_merge':
      return handleConfirmMerge(value, message, registry);
    case 'cancel':
      return handleCancel(value, message);
    case 'accept_handoff':
      return handleAcceptHandoff(value, message);
    case 'close_handoff':
      return handleCloseHandoff(value, message);
    case 'record_decision':
      return handleRecordDecision(value, message);
    case 'execute_workflow':
      return handleExecuteWorkflow(value, message);
    case 'preview_task':
      return handlePreviewTask(value);
    case 'claim_task':
      return handleClaimTask(value, message);
    case 'approve_plan':
      return handleApprovePlan(value, message);
    default:
      return null;
  }
}

export { parseActionText };
