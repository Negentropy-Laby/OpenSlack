import type { ExecutionResult, ActionPlan } from '@openslack/operator';
import type { ChatResponse } from './types.js';

export function formatPlanAsMarkdown(plan: ActionPlan): string {
  const lines: string[] = [];
  lines.push(`*${plan.goal}*`);
  lines.push(`Risk: ${plan.riskLevel.toUpperCase()}`);

  if (plan.riskExplanation) {
    lines.push(`⚠️ ${plan.riskExplanation}`);
  }

  if (plan.missingParams.length > 0) {
    lines.push('');
    lines.push('*Missing information:*');
    for (const p of plan.missingParams) {
      lines.push(`• ${p.description}`);
    }
    return lines.join('\n');
  }

  if (plan.steps.length > 0) {
    lines.push('');
    lines.push('*Steps:*');
    for (const step of plan.steps) {
      const icon = step.confirmationRequired ? '⚠️' : '•';
      lines.push(`${icon} ${step.description}`);
    }
  }

  return lines.join('\n');
}

export function formatResultAsMarkdown(result: ExecutionResult): ChatResponse {
  const lines: string[] = [];

  const icon = result.status === 'success' ? '✅' : result.status === 'blocked' ? '🚫' : '❌';
  lines.push(`${icon} *${result.status.toUpperCase()}*`);
  lines.push('');
  lines.push(result.summary);

  if (result.nextActions.length > 0) {
    lines.push('');
    lines.push('*Next:*');
    for (const action of result.nextActions) {
      lines.push(`• ${action}`);
    }
  }

  return { text: lines.join('\n') };
}

export function formatError(error: string): ChatResponse {
  return { text: `❌ Error: ${error}` };
}
