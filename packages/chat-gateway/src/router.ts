import {
  BUILTIN_ACTION_REGISTRY,
  resolveIntent,
  planActions,
  executePlan,
} from '@openslack/operator';
import type { ActionRegistryPort, LLMPlannerProviderRegistryPort } from '@openslack/operator';
import type { ChatMessage, ChatResponse, GatewayConfig } from './types.js';
import {
  verifyRequestSignature,
  mapActor,
  canExecuteSideEffects,
  buildDefaultActor,
  loadActorMappings,
} from './authz.js';
import { formatPlanAsMarkdown, formatResultAsMarkdown, formatError } from './formatter.js';
import { isDuplicate, markProcessed } from './interaction-store.js';
import { handleAction, parseActionText } from './actions.js';
import { createPendingPlan } from './plan-store.js';
import { recordEvent } from '@openslack/collaboration';
import { resolveAgentPrincipal } from '@openslack/runtime';

function providerFor(message: ChatMessage): 'slack' | 'webhook' {
  return message.channel.type === 'webhook' ? 'webhook' : 'slack';
}

export interface RouteContext {
  signature?: string;
  payload: string;
}

export interface ChatOperatorContext {
  readonly actionRegistry?: ActionRegistryPort;
  readonly llmProviderRegistry?: LLMPlannerProviderRegistryPort;
}

export async function routeMessage(
  message: ChatMessage,
  config: GatewayConfig,
  context: RouteContext,
  operatorContext: ChatOperatorContext = {},
): Promise<ChatResponse> {
  const actionRegistry = operatorContext.actionRegistry ?? BUILTIN_ACTION_REGISTRY;
  try {
    recordEvent({
      type: 'chat.message.received',
      actor: { id: message.user.id, kind: 'chat', provider: providerFor(message) },
      object: { kind: 'plan', id: message.id },
      source: { kind: 'chat', ref: message.channel.id },
      summary: `Chat message received from ${message.user.id}`,
      visibility: 'chat',
      redacted: false,
      containsSensitiveData: false,
    });
  } catch {
    // best-effort event recording
  }

  // 1. Idempotency check
  if (isDuplicate(message.id, message.text, message.user.id, message.channel.id)) {
    try {
      recordEvent({
        type: 'chat.message.duplicate_dropped',
        actor: { id: message.user.id, kind: 'chat', provider: providerFor(message) },
        object: { kind: 'plan', id: message.id },
        source: { kind: 'chat', ref: message.channel.id },
        summary: `Duplicate chat message dropped`,
        visibility: 'chat',
        redacted: false,
        containsSensitiveData: false,
      });
    } catch {
      // best-effort event recording
    }
    return { text: '' }; // Silently drop duplicates
  }

  // 2. Request signature verification
  if (config.webhookSecret && context.signature) {
    const valid = verifyRequestSignature(context.payload, context.signature, config.webhookSecret);
    if (!valid) {
      return formatError('Request signature verification failed');
    }
  }

  // 3. Actor mapping
  const actor = mapActor(message, loadActorMappings(config.actorMappingPath));
  const resolvedActor = actor ?? buildDefaultActor(message);
  let agentAuth: Parameters<typeof executePlan>[1] = {};
  try {
    if (actor?.agentId) {
      const resolved = resolveAgentPrincipal({
        root: process.cwd(),
        agentId: actor.agentId,
        provider: providerFor(message),
      });
      if ('error' in resolved) {
        return formatError(`Authorization failed: ${resolved.error}`);
      }
      agentAuth = { principal: resolved.principal, snapshot: resolved.snapshot };
    }
  } catch (err) {
    return formatError(`Authorization failed: ${(err as Error).message}`);
  }

  // 3.5 Handle button actions (after authz, before intent parsing)
  const parsedAction = parseActionText(message.text);
  if (parsedAction) {
    // Side-effecting actions require a mapped actor with write permission
    const sideEffectActions = new Set([
      'accept_handoff',
      'close_handoff',
      'confirm_merge',
      'execute_workflow',
      'approve_plan',
      'claim_task',
      'cancel',
    ]);
    if (sideEffectActions.has(parsedAction.action) && !canExecuteSideEffects(actor, config)) {
      markProcessed(message.id, message.text, message.user.id, message.channel.id);
      return {
        text: '⚠️ This action requires a mapped chat user with write permission. Contact your workspace admin.',
      };
    }

    const actionResult = await handleAction(message, actionRegistry);
    if (actionResult) {
      markProcessed(message.id, message.text, message.user.id, message.channel.id);
      return actionResult;
    }
  }

  // 4. Resolve intent (keyword-first, optional LLM fallback)
  const { intent, fallbackReason } = await resolveIntent(message.text, {
    actionRegistry,
    ...(operatorContext.llmProviderRegistry === undefined
      ? {}
      : { providerRegistry: operatorContext.llmProviderRegistry }),
  });
  const fallbackPrefix = fallbackReason ? `⚠️ ${fallbackReason}\n\n` : '';

  if (intent.kind === 'unknown') {
    return {
      text:
        fallbackPrefix +
        `I don't understand that. Try: status, PR #N doctor, merge PR #N, create task.`,
    };
  }

  // 5. Plan actions
  const plan = planActions(intent, actionRegistry);

  // 6. Handle missing params
  if (plan.missingParams.length > 0) {
    markProcessed(message.id, message.text, message.user.id, message.channel.id);
    return { text: fallbackPrefix + formatPlanAsMarkdown(plan) };
  }

  // 7. Side-effect policy check
  if (plan.sideEffects && !canExecuteSideEffects(actor, config)) {
    markProcessed(message.id, message.text, message.user.id, message.channel.id);
    try {
      recordEvent({
        type: 'operator.plan.blocked',
        actor: {
          id: resolvedActor.id,
          kind: actor ? 'human' : 'chat',
          provider: providerFor(message),
        },
        object: { kind: 'plan', id: plan.goal },
        source: { kind: 'chat', ref: message.channel.id },
        summary: `Chat plan blocked by read-only actor policy: ${plan.goal}`,
        visibility: 'chat',
        redacted: false,
        containsSensitiveData: false,
        risk: plan.riskLevel,
        nextAction: {
          owner: 'human',
          action: 'Map this chat user to an OpenSlack role with write permission',
        },
      });
    } catch {
      // best-effort event recording
    }
    return {
      text:
        fallbackPrefix +
        formatPlanAsMarkdown(plan) +
        '\n\n⚠️ This action has side effects. Unmapped actors are read-only. Add this user to the actor mapping with a write role to continue.',
    };
  }

  // 8. High-risk plans: create pending plan and request confirmation
  if (plan.requiresConfirmation && plan.riskLevel === 'high') {
    markProcessed(message.id, message.text, message.user.id, message.channel.id);

    const prNumber = String(plan.intent.slots.prNumber || '');
    const pending = createPendingPlan({
      actorId: message.user.id,
      channelId: message.channel.id,
      threadId: message.threadId,
      action: 'confirm_merge',
      value: prNumber,
      riskLevel: plan.riskLevel,
      agentId: actor?.agentId,
    });

    const lines: string[] = [];
    lines.push(formatPlanAsMarkdown(plan));
    lines.push('');
    lines.push(`*Confirm to proceed:*`);
    lines.push(`Plan ID: \`${pending.planId}\``);
    lines.push('');
    lines.push(`Click **Confirm merge** to proceed, or **Cancel** to discard.`);
    lines.push('');
    lines.push(
      '_Slack confirmation is not a GitHub approval. This will re-run PR doctor before merging._',
    );

    try {
      recordEvent({
        type: 'chat.plan.confirmation_requested',
        actor: {
          id: resolvedActor.id,
          kind: actor ? 'human' : 'chat',
          provider: providerFor(message),
        },
        object: { kind: 'plan', id: pending.planId },
        source: { kind: 'chat', ref: message.channel.id },
        summary: `Chat confirmation requested for ${plan.goal}`,
        visibility: 'chat',
        redacted: false,
        containsSensitiveData: false,
        risk: plan.riskLevel,
        nextAction: { owner: 'human', action: `Confirm or cancel plan ${pending.planId}` },
      });
    } catch {
      // best-effort event recording
    }

    return { text: fallbackPrefix + lines.join('\n') };
  }

  // 9. Execute
  const result = await executePlan(plan, { dryRun: false, ...agentAuth }, actionRegistry);
  markProcessed(message.id, message.text, message.user.id, message.channel.id);

  return { text: fallbackPrefix + formatResultAsMarkdown(result).text };
}
