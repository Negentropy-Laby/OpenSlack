export type WorkflowPatternId =
  | 'classify-and-act'
  | 'fanout-synthesize'
  | 'adversarial-verification'
  | 'generate-filter'
  | 'tournament'
  | 'loop-until-done'
  | 'model-router';

export function inferWorkflowPatternId(query: string): WorkflowPatternId | undefined {
  const q = query.toLowerCase();
  if (q.includes('tournament') || q.includes('compete') || q.includes('compare') || q.includes('alternative')) {
    return 'tournament';
  }
  if (q.includes('classify') || q.includes('triage') || q.includes('分流') || q.includes('分类')) {
    return 'classify-and-act';
  }
  if (q.includes('verify') || q.includes('review') || q.includes('audit') || q.includes('验证') || q.includes('审查')) {
    return 'adversarial-verification';
  }
  if (q.includes('generate') || q.includes('filter') || q.includes('dedupe') || q.includes('生成') || q.includes('筛选') || q.includes('去重')) {
    return 'generate-filter';
  }
  if (q.includes('loop') || q.includes('until') || q.includes('repeat') || q.includes('循环') || q.includes('直到')) {
    return 'loop-until-done';
  }
  if (q.includes('model') || q.includes('routing') || q.includes('模型') || q.includes('路由')) {
    return 'model-router';
  }
  if (q.includes('research') || q.includes('codebase') || q.includes('every') || q.includes('all') || q.includes('研究') || q.includes('全部') || q.includes('所有')) {
    return 'fanout-synthesize';
  }
  return undefined;
}
