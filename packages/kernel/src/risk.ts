import type { RiskZone, TaskRiskLevel } from './types.js';

export const RISK_ZONES = [
  'green',
  'yellow',
  'red',
  'black',
] as const satisfies readonly RiskZone[];
export const TASK_RISK_LEVELS = [
  'low',
  'medium',
  'high',
  'critical',
] as const satisfies readonly TaskRiskLevel[];

export function isRiskZone(value: unknown): value is RiskZone {
  return typeof value === 'string' && (RISK_ZONES as readonly string[]).includes(value);
}

export function isTaskRiskLevel(value: unknown): value is TaskRiskLevel {
  return typeof value === 'string' && (TASK_RISK_LEVELS as readonly string[]).includes(value);
}

export function taskRiskLevelToZone(level: TaskRiskLevel): RiskZone {
  if (level === 'critical') return 'black';
  if (level === 'high') return 'red';
  if (level === 'medium') return 'yellow';
  return 'green';
}

export function highestRiskZone(
  ...zones: ReadonlyArray<RiskZone | undefined>
): RiskZone | undefined {
  let highest: RiskZone | undefined;
  for (const zone of zones) {
    if (!zone) continue;
    if (!highest || RISK_ZONES.indexOf(zone) > RISK_ZONES.indexOf(highest)) highest = zone;
  }
  return highest;
}
