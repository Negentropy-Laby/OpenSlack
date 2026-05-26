import type { Intent } from './types.js';
import type { ConversationTurn } from './conversation-store.js';

const AFFIRMATIONS = new Set([
  'yes', 'y', 'ok', 'okay', 'do it', 'go ahead', 'proceed', 'confirm', 'sure',
  '好的', '确认', '执行', '合并', 'merge it', '继续', 'yes do it', 'go for it',
]);

const NEGATIONS = new Set([
  'no', 'n', 'nope', 'cancel', 'stop', 'abort', 'never mind',
  '取消', '不要', '停止', '算了',
]);

export type ContextResolution =
  | { type: 'confirm_last_plan'; planId?: string }
  | { type: 'cancel_last_plan'; planId?: string }
  | { type: 'resolve_slots'; resolved: Record<string, string | number> }
  | { type: 'none' };

export function resolveContext(
  currentIntent: Intent,
  history: ConversationTurn[],
  pendingPlanId?: string,
  currentMessage?: string,
): ContextResolution {
  // Check affirmation/negation against the CURRENT message first
  if (currentMessage) {
    const normalized = currentMessage.toLowerCase().trim();
    if (AFFIRMATIONS.has(normalized)) {
      return { type: 'confirm_last_plan', planId: pendingPlanId };
    }
    if (NEGATIONS.has(normalized)) {
      return { type: 'cancel_last_plan', planId: pendingPlanId };
    }
  }

  if (history.length === 0) return { type: 'none' };

  // Fallback: check last user message in history (for callers that don't pass currentMessage)
  if (!currentMessage) {
    const lastUserMessage = history.filter((t) => t.role === 'user').pop();
    if (lastUserMessage) {
      const lastUserContent = lastUserMessage.content.toLowerCase().trim();
      if (AFFIRMATIONS.has(lastUserContent)) {
        return { type: 'confirm_last_plan', planId: pendingPlanId };
      }
      if (NEGATIONS.has(lastUserContent)) {
        return { type: 'cancel_last_plan', planId: pendingPlanId };
      }
    }
  }

  // Resolve missing slots from conversation history
  const resolved: Record<string, string | number> = {};
  const missingKeys = Object.entries(currentIntent.slots)
    .filter(([, v]) => v === undefined || v === null || v === '' ||
      (Array.isArray(v) && v.length === 0))
    .map(([k]) => k);

  if (missingKeys.length === 0) return { type: 'none' };

  // Scan history in reverse for slot values
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!turn.intent) continue;

    for (const key of missingKeys) {
      if (resolved[key] !== undefined) continue;
      const historicalValue = turn.intent.slots[key];
      if (historicalValue !== undefined && historicalValue !== null && historicalValue !== '' &&
          !(Array.isArray(historicalValue) && historicalValue.length === 0)) {
        if (typeof historicalValue === 'string' || typeof historicalValue === 'number') {
          resolved[key] = historicalValue;
        }
      }
    }

    if (Object.keys(resolved).length === missingKeys.length) break;
  }

  if (Object.keys(resolved).length === 0) return { type: 'none' };
  return { type: 'resolve_slots', resolved };
}

export function extractSlotsFromMessage(text: string): Record<string, string | number> {
  const slots: Record<string, string | number> = {};

  // Bare number → could be PR or issue
  const bareNum = text.match(/^#?(\d+)$/);
  if (bareNum) {
    slots.prNumber = Number(bareNum[1]);
    slots.issueNumber = Number(bareNum[1]);
    return slots;
  }

  // Explicit PR number
  const prNum = text.match(/pr\s*#?(\d+)/i);
  if (prNum) slots.prNumber = Number(prNum[1]);

  // Explicit issue number
  const issueNum = text.match(/issue\s*#?(\d+)/i);
  if (issueNum) slots.issueNumber = Number(issueNum[1]);

  // Agent ID
  const agentId = text.match(/--agent-id\s+(\S+)/i);
  if (agentId) slots.agentId = agentId[1];

  return slots;
}
