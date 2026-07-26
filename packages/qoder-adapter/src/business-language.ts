const BUSINESS_LABELS = Object.freeze({
  blocker: '阻塞项',
  handoff: '责任移交',
  decision: '管理决策',
  workflow: '执行流程',
  issue: '工作项',
  pr: '正式交付',
  approval: '人工治理节点',
  notification: '提醒链路',
} as const);

export type BusinessLanguageTerm = keyof typeof BUSINESS_LABELS;

export function businessLabel(term: BusinessLanguageTerm): string {
  return BUSINESS_LABELS[term];
}

export function describeFreshness(
  observedAt: string | undefined,
  generatedAt: string,
): 'current_snapshot' | 'recorded_snapshot' | 'unknown' {
  if (!observedAt) return 'unknown';
  return observedAt === generatedAt ? 'current_snapshot' : 'recorded_snapshot';
}

export function summarizeCount(noun: BusinessLanguageTerm, count: number): string {
  return `${BUSINESS_LABELS[noun]}：${count}`;
}
