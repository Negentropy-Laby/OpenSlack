import { inferWorkflowPatternId } from '@openslack/core';
import type { RiskLevel, WorkflowRecommendation } from './types.js';

const WORKFLOW_TRIGGER_PATTERNS = [
  /\buse (a )?workflow\b/i,
  /\bultracode\b/i,
  /\bdeep (audit|review|research|verification)\b/i,
  /\bworkflow\s+(to|for|that)\b/i,
];

const HIGH_FANOUT_PATTERNS = [
  /\bevery\b/i,
  /\ball\b/i,
  /\bacross\b/i,
  /\bcodebase\b/i,
  /\bmigration\b/i,
  /\brefactor\b/i,
  /\broot[- ]cause\b/i,
  /\bscan\b/i,
  /\btriage\b/i,
  /\bgovernance\b/i,
  /\bopen prs?\b/i,
  /\blong[- ]running\b/i,
  /\bend[- ]to[- ]end\b/i,
  /\bresearch\b/i,
  /\bverify\b/i,
  /\bverification\b/i,
  /\baudit\b/i,
  /\bindependent\b/i,
  /\bmultiple\b/i,
  /\bmany\b/i,
  /\bpackages?\//i,
  /\bprs?\b/i,
  /\bissues?\b/i,
  /\bendpoints?\b/i,
  /多个|全部|所有|批量|迁移|重构|审查|验证|研究|排查|根因/i,
];

const SIMPLE_TASK_PATTERNS = [
  /\bsingle[- ]file\b/i,
  /\bone file\b/i,
  /\btypo\b/i,
  /\bsmall docs?\b/i,
  /\bquick check\b/i,
  /\bstatus\b/i,
  /\bdoctor\b/i,
  /\bhelp\b/i,
  /单文件|错别字|小改|状态|帮助/i,
];

export interface WorkflowRecommendationOptions {
  allowDraft?: boolean;
}

function riskForQuery(query: string): RiskLevel {
  const q = query.toLowerCase();
  if (q.includes('merge') || q.includes('write') || q.includes('fix') || q.includes('implement') || q.includes('migration')) {
    return 'medium';
  }
  if (q.includes('audit') || q.includes('review') || q.includes('research') || q.includes('triage')) return 'low';
  return 'none';
}

export function recommendWorkflowForQuery(
  query: string,
  options: WorkflowRecommendationOptions = {},
): WorkflowRecommendation {
  const trimmed = query.trim();
  const explicitWorkflow = WORKFLOW_TRIGGER_PATTERNS.some((pattern) => pattern.test(trimmed));
  const highFanoutHits = HIGH_FANOUT_PATTERNS.filter((pattern) => pattern.test(trimmed)).length;
  const simpleHits = SIMPLE_TASK_PATTERNS.filter((pattern) => pattern.test(trimmed)).length;
  const suggestedPattern = inferWorkflowPatternId(trimmed);
  const risk = riskForQuery(trimmed);

  if (/\bultracode\b/i.test(trimmed)) {
    return {
      decision: 'workflow_draft_required',
      reason: 'This looks like a workflow task: ultracode requests create a workflow draft with no permission bypass.',
      confidence: 0.95,
      suggestedPattern: suggestedPattern ?? 'fanout-synthesize',
      risk,
      nextAction: `Generate workflow draft: openslack collaboration workflow generate --prompt "${trimmed.replace(/"/g, '\\"')}"`,
    };
  }

  if (explicitWorkflow && (options.allowDraft || suggestedPattern || highFanoutHits > 0)) {
    return {
      decision: options.allowDraft ? 'workflow_draft_required' : 'workflow_recommended',
      reason: 'This looks like a workflow task: the request explicitly asks for workflow orchestration and has enough scope to benefit from it.',
      confidence: 0.9,
      suggestedPattern: suggestedPattern ?? 'fanout-synthesize',
      risk,
      nextAction: `Generate workflow draft: openslack collaboration workflow generate --prompt "${trimmed.replace(/"/g, '\\"')}"`,
    };
  }

  if (highFanoutHits >= 2) {
    return {
      decision: 'workflow_recommended',
      reason: 'This looks like a workflow task: multiple targets, long-running scan, or independent verification signals were detected.',
      confidence: Math.min(0.85, 0.55 + highFanoutHits * 0.1),
      suggestedPattern: suggestedPattern ?? 'fanout-synthesize',
      risk,
      nextAction: `Generate workflow draft: openslack collaboration workflow generate --prompt "${trimmed.replace(/"/g, '\\"')}"`,
    };
  }

  return {
    decision: 'workflow_not_needed',
    reason: simpleHits > 0
      ? 'The request looks like a small direct operator task; a workflow would add orchestration cost without clear value.'
      : 'No strong fan-out, long-running, or independent-verification signal was found.',
    confidence: simpleHits > 0 ? 0.8 : 0.6,
    risk,
    nextAction: 'Use openslack ask or a direct module command.',
  };
}
