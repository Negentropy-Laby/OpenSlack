import type { ActionPlan, ExecutionResult } from './types.js';

export function formatPlan(plan: ActionPlan): string {
  const lines: string[] = [];
  lines.push(`Goal: ${plan.goal}`);
  lines.push(`Intent: ${plan.intent.kind}`);
  lines.push(`Risk: ${plan.riskLevel}${plan.riskExplanation ? ` — ${plan.riskExplanation}` : ''}`);

  if (plan.missingParams.length > 0) {
    lines.push('');
    lines.push('Missing parameters:');
    for (const p of plan.missingParams) {
      lines.push(`  • ${p.name}: ${p.description}`);
    }
    return lines.join('\n');
  }

  if (plan.steps.length > 0) {
    lines.push('');
    lines.push('Steps:');
    for (const step of plan.steps) {
      const confirm = step.confirmationRequired ? ' [requires confirmation]' : '';
      lines.push(`  ${step.id}. ${step.description}${confirm}`);
      lines.push(`     → openslack ${step.command} ${step.args.join(' ')}`);
    }
  }

  if (plan.requiresConfirmation) {
    lines.push('');
    lines.push('This plan requires confirmation before execution.');
  }

  return lines.join('\n');
}

export function summarizeResults(result: ExecutionResult): string {
  const lines: string[] = [];
  lines.push(`Plan ID: ${result.planId}`);
  lines.push(`Status: ${result.status}`);
  lines.push('');

  if (result.steps.length > 0) {
    for (const step of result.steps) {
      const icon = step.status === 'success' ? '✓' : step.status === 'skipped' ? '⊘' : '✗';
      lines.push(`${icon} ${step.stepId}: ${step.status}`);
    }
    lines.push('');
  }

  lines.push(result.summary);

  if (result.nextActions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    for (const action of result.nextActions) {
      lines.push(`  • ${action}`);
    }
  }

  return lines.join('\n');
}
