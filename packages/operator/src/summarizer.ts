import type { ActionPlan, ExecutionResult } from './types.js';

function redactPotentialSecrets(value: string): string {
  return value
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[redacted secret]')
    .replace(
      /-----BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY-----[\s\S]*?-----END \1 PRIVATE KEY-----/g,
      '[redacted private key]',
    );
}

function formatOutputSnippet(output: string): string[] {
  const redacted = redactPotentialSecrets(output).trim();
  if (!redacted) return [];

  const maxChars = 1200;
  const snippet =
    redacted.length > maxChars
      ? `${redacted.slice(0, maxChars)}\n... [output truncated]`
      : redacted;
  return snippet.split(/\r?\n/).map((line) => `    ${line}`);
}

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

  if (plan.workflowRecommendation) {
    lines.push('');
    lines.push('Workflow recommendation:');
    lines.push(`  Decision: ${plan.workflowRecommendation.decision}`);
    lines.push(`  Reason: ${plan.workflowRecommendation.reason}`);
    lines.push(`  Confidence: ${(plan.workflowRecommendation.confidence * 100).toFixed(0)}%`);
    if (plan.workflowRecommendation.suggestedPattern) {
      lines.push(`  Suggested pattern: ${plan.workflowRecommendation.suggestedPattern}`);
    }
    lines.push(`  Next: ${plan.workflowRecommendation.nextAction}`);
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
      if (step.status === 'failed' && step.output) {
        const outputLines = formatOutputSnippet(step.output);
        if (outputLines.length > 0) {
          lines.push('  Output:');
          lines.push(...outputLines);
        }
      }
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
