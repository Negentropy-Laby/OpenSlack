import type { CollaborationEvent } from './types.js';
import { filterEvents } from './events.js';

export interface DigestGroup {
  label: string;
  events: CollaborationEvent[];
}

export interface DigestSummary {
  periodHours: number;
  totalEvents: number;
  groups: DigestGroup[];
  recommendedNext: CollaborationEvent[];
}

const COMPLETED_TYPES = new Set([
  'task.done',
  'pr.merge.completed',
  'operator.execution.completed',
  'pr.doctor.ready',
  'handoff.accepted',
  'decision.recorded',
  'pr.watch.completed',
]);

const BLOCKED_TYPES = new Set([
  'task.blocked',
  'pr.doctor.blocked',
  'pr.merge.blocked',
  'operator.plan.blocked',
  'operator.execution.failed',
  'governance.audit.failed',
]);

const GOVERNANCE_TYPES = new Set([
  'governance.audit.passed',
  'governance.audit.failed',
  'governance.direct_commit.explained',
  'governance.direct_commit.unexplained',
]);

function isCompleted(event: CollaborationEvent): boolean {
  return COMPLETED_TYPES.has(event.type);
}

function isBlocked(event: CollaborationEvent): boolean {
  return BLOCKED_TYPES.has(event.type);
}

function isGovernance(event: CollaborationEvent): boolean {
  return GOVERNANCE_TYPES.has(event.type);
}

function needsHuman(event: CollaborationEvent): boolean {
  if (event.nextAction && event.nextAction.owner === 'human') return true;
  if (event.type === 'chat.plan.confirmation_requested') return true;
  if (event.type === 'pr.merge.requested') return true;
  if (event.owner && event.owner.kind === 'human') {
    if (event.type === 'task.blocked' || event.type === 'task.claimed') return true;
  }
  return false;
}

function isAgentActivity(event: CollaborationEvent): boolean {
  return event.actor.kind === 'agent' && !isBlocked(event) && !isCompleted(event);
}

export function groupEvents(events: CollaborationEvent[]): DigestGroup[] {
  const completed = events.filter(isCompleted);
  const needsHumanEvents = events.filter((e) => needsHuman(e));
  const blocked = events.filter((e) => isBlocked(e) && !needsHuman(e));
  const agentActivity = events.filter(isAgentActivity);
  const governance = events.filter((e) => isGovernance(e) && !isBlocked(e));

  const groups: DigestGroup[] = [];

  if (completed.length > 0) {
    groups.push({ label: 'Completed', events: completed });
  }

  if (needsHumanEvents.length > 0) {
    groups.push({ label: 'Needs Human', events: needsHumanEvents });
  }

  if (blocked.length > 0) {
    groups.push({ label: 'Blocked', events: blocked });
  }

  if (agentActivity.length > 0) {
    groups.push({ label: 'Agent Activity', events: agentActivity });
  }

  if (governance.length > 0) {
    groups.push({ label: 'Governance', events: governance });
  }

  return groups;
}

export function getRecommendedNext(events: CollaborationEvent[]): CollaborationEvent[] {
  return events.filter((e) => e.nextAction !== undefined);
}

export function buildDigest(events: CollaborationEvent[], periodHours: number): DigestSummary {
  const groups = groupEvents(events);
  const recommendedNext = getRecommendedNext(events);

  return {
    periodHours,
    totalEvents: events.length,
    groups,
    recommendedNext,
  };
}

function formatDigestEvent(event: CollaborationEvent): string {
  const ts = event.timestamp.slice(11, 16);
  const obj = `${event.object.kind}:${event.object.id}`;
  return `  ${ts}  ${event.type.padEnd(30)}  ${obj.padEnd(20)}  ${event.summary}`;
}

function formatRecommended(event: CollaborationEvent): string {
  const obj = `${event.object.kind}:${event.object.id}`;
  const next = event.nextAction!;
  return `  • ${obj} — ${next.action}`;
}

export function renderDigest(digest: DigestSummary): string {
  const lines: string[] = [];

  lines.push('OpenSlack Digest');
  lines.push(`Period: last ${digest.periodHours}h  |  Events: ${digest.totalEvents}`);
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  if (digest.groups.length === 0) {
    lines.push('No activity in this period.');
    lines.push('');
    return lines.join('\n');
  }

  for (const group of digest.groups) {
    lines.push(`${group.label} (${group.events.length})`);
    lines.push('─'.repeat(50));
    for (const event of group.events) {
      lines.push(formatDigestEvent(event));
    }
    lines.push('');
  }

  if (digest.recommendedNext.length > 0) {
    lines.push('Recommended Next Actions');
    lines.push('─'.repeat(50));
    for (const event of digest.recommendedNext) {
      lines.push(formatRecommended(event));
    }
    lines.push('');
  }

  return lines.join('\n');
}

export { filterEvents };
