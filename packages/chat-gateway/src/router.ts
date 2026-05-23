import { parseIntent, planActions, executePlan } from '@openslack/operator';
import type { ExecutionResult } from '@openslack/operator';
import type { ChatMessage, ChatResponse, GatewayConfig } from './types.js';
import { verifyRequestSignature, mapActor, canExecuteSideEffects, buildDefaultActor } from './authz.js';
import { formatPlanAsMarkdown, formatResultAsMarkdown, formatError } from './formatter.js';
import { isDuplicate, markProcessed } from './interaction-store.js';

export interface RouteContext {
  signature?: string;
  payload: string;
}

export async function routeMessage(
  message: ChatMessage,
  config: GatewayConfig,
  context: RouteContext,
): Promise<ChatResponse> {
  // 1. Idempotency check
  if (isDuplicate(message.id, message.text, message.user.id, message.channel.id)) {
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
  const actor = mapActor(message, []); // TODO: load from actorMappingPath
  const resolvedActor = actor ?? buildDefaultActor(message);

  // 4. Parse intent
  const intent = parseIntent(message.text);

  if (intent.kind === 'unknown') {
    return {
      text: `I don't understand that. Try: status, PR #N doctor, merge PR #N, create task.`,
    };
  }

  // 5. Plan actions
  const plan = planActions(intent);

  // 6. Handle missing params
  if (plan.missingParams.length > 0) {
    markProcessed(message.id, message.text, message.user.id, message.channel.id);
    return { text: formatPlanAsMarkdown(plan) };
  }

  // 7. Side-effect policy check
  if (plan.sideEffects && !canExecuteSideEffects(actor, config)) {
    markProcessed(message.id, message.text, message.user.id, message.channel.id);
    return {
      text: formatPlanAsMarkdown(plan) + '\n\n⚠️ This action has side effects. Unmapped actors are read-only.',
    };
  }

  // 8. Return plan if high-risk (requires explicit confirmation in chat)
  if (plan.requiresConfirmation && plan.riskLevel === 'high') {
    markProcessed(message.id, message.text, message.user.id, message.channel.id);
    return {
      text: formatPlanAsMarkdown(plan) + '\n\nReply with the plan ID to confirm execution.',
    };
  }

  // 9. Execute
  const result = await executePlan(plan, { dryRun: false });
  markProcessed(message.id, message.text, message.user.id, message.channel.id);

  return formatResultAsMarkdown(result);
}
