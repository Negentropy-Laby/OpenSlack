import type { CollaborationEvent } from './types.js';
import { readEvents } from './events.js';
import { listHandoffs } from './handoff.js';
import { listDecisions } from './decision.js';

export interface DashboardBlocker {
  object: string;
  summary: string;
  owner?: string;
  nextAction?: string;
  severity?: string;
}

export interface DashboardProjection {
  generatedAt: string;
  sinceHours: number;
  taskCounts: Record<string, number>;
  prCounts: Record<string, number>;
  blockerCount: number;
  blockers: DashboardBlocker[];
  openHandoffs: number;
  activeDecisions: number;
  recentEvents: CollaborationEvent[];
}

const BLOCKER_TYPES = new Set([
  'task.blocked',
  'pr.doctor.blocked',
  'pr.merge.blocked',
  'operator.plan.blocked',
  'operator.execution.failed',
  'governance.audit.failed',
  'workflow.blocked',
  'repair.failed',
]);

function objectRef(event: CollaborationEvent): string {
  return `${event.object.kind}:${event.object.id}`;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function buildDashboardProjection(options: {
  events?: CollaborationEvent[];
  sinceHours?: number;
} = {}): DashboardProjection {
  const sinceHours = options.sinceHours ?? 24;
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const events = (options.events ?? readEvents())
    .filter((event) => sinceHours <= 0 || new Date(event.timestamp) >= cutoff)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const taskCounts: Record<string, number> = {};
  const prCounts: Record<string, number> = {};
  const blockers: DashboardBlocker[] = [];

  for (const event of events) {
    if (event.object.kind === 'issue' || event.type.startsWith('task.')) increment(taskCounts, event.type);
    if (event.object.kind === 'pr' || event.type.startsWith('pr.')) increment(prCounts, event.type);
    if (BLOCKER_TYPES.has(event.type)) {
      blockers.push({
        object: objectRef(event),
        summary: event.summary,
        owner: event.owner ? `${event.owner.kind}:${event.owner.id}` : event.nextAction?.owner,
        nextAction: event.nextAction?.action,
        severity: event.severity,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sinceHours,
    taskCounts,
    prCounts,
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 20),
    openHandoffs: listHandoffs().filter((handoff) => handoff.status !== 'closed').length,
    activeDecisions: listDecisions().filter((decision) => decision.status === 'active').length,
    recentEvents: events.slice(0, 20),
  };
}

export function renderDashboardProjection(dashboard: DashboardProjection): string {
  const lines: string[] = [];
  lines.push('OpenSlack Team Dashboard');
  lines.push('========================');
  lines.push(`Window: ${dashboard.sinceHours > 0 ? `${dashboard.sinceHours}h` : 'all events'}`);
  lines.push(`Generated: ${dashboard.generatedAt}`);
  lines.push('');

  lines.push('Summary');
  lines.push(`- Blockers: ${dashboard.blockerCount}`);
  lines.push(`- Open handoffs: ${dashboard.openHandoffs}`);
  lines.push(`- Active decisions: ${dashboard.activeDecisions}`);
  lines.push('');

  lines.push('Tasks');
  const taskEntries = Object.entries(dashboard.taskCounts);
  if (taskEntries.length === 0) lines.push('- No task events.');
  else for (const [type, count] of taskEntries) lines.push(`- ${type}: ${count}`);
  lines.push('');

  lines.push('PRs');
  const prEntries = Object.entries(dashboard.prCounts);
  if (prEntries.length === 0) lines.push('- No PR events.');
  else for (const [type, count] of prEntries) lines.push(`- ${type}: ${count}`);
  lines.push('');

  lines.push('Blockers');
  if (dashboard.blockers.length === 0) {
    lines.push('- No blockers found.');
  } else {
    for (const blocker of dashboard.blockers) {
      lines.push(`- ${blocker.object}: ${blocker.summary}`);
      if (blocker.owner) lines.push(`  Owner: ${blocker.owner}`);
      if (blocker.nextAction) lines.push(`  Next: ${blocker.nextAction}`);
    }
  }
  lines.push('');

  lines.push('Recent Activity');
  if (dashboard.recentEvents.length === 0) {
    lines.push('- No recent activity.');
  } else {
    for (const event of dashboard.recentEvents.slice(0, 10)) {
      lines.push(`- ${event.timestamp.slice(0, 16)} ${event.type} ${objectRef(event)}: ${event.summary}`);
    }
  }

  return lines.join('\n');
}
