import type { CollaborationEvent, EventFilter, RiskLevel } from './types.js';
import { readEvents } from './events.js';
import { listHandoffs } from './handoff.js';
import { listDecisions } from './decision.js';
import type { Handoff } from './handoff.js';
import type { Decision } from './decision.js';
import { resolveAgentDisplayName } from './agent-resolve.js';

export interface DashboardBlocker {
  object: string;
  summary: string;
  owner?: string;
  nextAction?: string;
  severity?: string;
}

export interface DashboardOptions {
  sinceHours?: number;
  filters?: Partial<EventFilter>;
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
  openHandoffDetails: Handoff[];
  activeDecisionDetails: Decision[];
  appliedFilters: Partial<EventFilter>;
}

export const BLOCKER_TYPES = new Set([
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

export function buildDashboardProjection(
  options: DashboardOptions & { events?: CollaborationEvent[] } = {},
): DashboardProjection {
  const sinceHours = options.sinceHours ?? 24;
  const filters = options.filters ?? {};
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const events = (options.events ?? readEvents())
    .filter((event) => sinceHours <= 0 || new Date(event.timestamp) >= cutoff)
    .filter((event) => {
      if (filters.actorId && event.actor.id !== filters.actorId) return false;
      if (filters.actorKind && event.actor.kind !== filters.actorKind) return false;
      if (filters.objectKind && event.object.kind !== filters.objectKind) return false;
      if (filters.sourceKind && event.source.kind !== filters.sourceKind) return false;
      if (filters.risk && event.risk !== filters.risk) return false;
      if (filters.severity && event.severity !== filters.severity) return false;
      if (filters.type) {
        const types = Array.isArray(filters.type) ? filters.type : [filters.type];
        if (!types.includes(event.type)) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const blockerOnly = filters.severity === 'critical' || Boolean(filters.type &&
    (Array.isArray(filters.type) ? filters.type : [filters.type]).some((t) => BLOCKER_TYPES.has(t as string)));

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

  const allHandoffs = listHandoffs().filter((h) => h.status !== 'closed');
  const allDecisions = listDecisions().filter((d) => d.status === 'active');

  return {
    generatedAt: new Date().toISOString(),
    sinceHours,
    taskCounts,
    prCounts,
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 20),
    openHandoffs: allHandoffs.length,
    activeDecisions: allDecisions.length,
    recentEvents: events.slice(0, 20),
    openHandoffDetails: allHandoffs.slice(0, 10),
    activeDecisionDetails: allDecisions.slice(0, 10),
    appliedFilters: filters,
  };
}

export function renderDashboardProjection(dashboard: DashboardProjection): string {
  const lines: string[] = [];
  lines.push('OpenSlack Team Dashboard');
  lines.push('========================');
  lines.push(`Window: ${dashboard.sinceHours > 0 ? `${dashboard.sinceHours}h` : 'all events'}`);
  lines.push(`Generated: ${dashboard.generatedAt}`);

  const filterEntries = Object.entries(dashboard.appliedFilters);
  if (filterEntries.length > 0) {
    lines.push('Filters: ' + filterEntries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(', '));
  }
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

  if (dashboard.openHandoffDetails.length > 0) {
    lines.push('Open Handoffs');
    for (const h of dashboard.openHandoffDetails) {
      const age = Math.round((Date.now() - new Date(h.createdAt).getTime()) / (60 * 60 * 1000));
      lines.push(`- ${h.id}: ${h.from} → ${h.to} — ${h.context} (${age}h ago)`);
    }
    lines.push('');
  }

  if (dashboard.activeDecisionDetails.length > 0) {
    lines.push('Active Decisions');
    for (const d of dashboard.activeDecisionDetails) {
      lines.push(`- ${d.id}: ${d.topic} — ${d.decision} (by ${d.decidedBy})`);
    }
    lines.push('');
  }

  lines.push('Recent Activity');
  if (dashboard.recentEvents.length === 0) {
    lines.push('- No recent activity.');
  } else {
    for (const event of dashboard.recentEvents.slice(0, 10)) {
      const principalTag = event.metadata?.principal
        ? ` [${(event.metadata.principal as { registry_id: string }).registry_id}]`
        : '';
      const actorName = resolveAgentDisplayName(event.actor);
      lines.push(`- ${event.timestamp.slice(0, 16)} ${event.type} ${objectRef(event)}: ${event.summary} (by ${actorName})${principalTag}`);
    }
  }

  const isEmpty = taskEntries.length === 0 && prEntries.length === 0
    && dashboard.blockers.length === 0 && dashboard.recentEvents.length === 0;
  if (isEmpty) {
    lines.push('');
    lines.push('Getting Started');
    lines.push('No events recorded yet. Try these commands:');
    lines.push('  openslack pr doctor <n>          — Check a PR');
    lines.push('  openslack collaboration handoff create --from <you> --to <them> --context "..."');
    lines.push('                                   — Create a handoff');
    lines.push('  openslack status                 — See system overview');
  }

  return lines.join('\n');
}

export function renderDashboardMarkdown(dashboard: DashboardProjection): string {
  const lines: string[] = [];

  lines.push('# OpenSlack Team Dashboard');
  lines.push('');
  lines.push(`> **Window:** ${dashboard.sinceHours > 0 ? `${dashboard.sinceHours}h` : 'all events'} | **Generated:** ${dashboard.generatedAt}`);

  const filterEntries = Object.entries(dashboard.appliedFilters);
  if (filterEntries.length > 0) {
    lines.push(`> **Filters:** ${filterEntries.map(([k, v]) => `\`${k}=${Array.isArray(v) ? v.join(',') : v}\``).join(', ')}`);
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Blockers | ${dashboard.blockerCount} |`);
  lines.push(`| Open handoffs | ${dashboard.openHandoffs} |`);
  lines.push(`| Active decisions | ${dashboard.activeDecisions} |`);
  lines.push('');

  const taskEntries = Object.entries(dashboard.taskCounts);
  if (taskEntries.length > 0) {
    lines.push('## Tasks');
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    for (const [type, count] of taskEntries) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push('');
  }

  const prEntries = Object.entries(dashboard.prCounts);
  if (prEntries.length > 0) {
    lines.push('## PRs');
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|-----|-------|');
    for (const [type, count] of prEntries) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push('');
  }

  lines.push('## Blockers');
  lines.push('');
  if (dashboard.blockers.length === 0) {
    lines.push('*No blockers found.*');
  } else {
    for (const blocker of dashboard.blockers) {
      const severity = blocker.severity ? ` **[${blocker.severity}]**` : '';
      lines.push(`- **${blocker.object}**${severity}: ${blocker.summary}`);
      if (blocker.owner) lines.push(`  - Owner: \`${blocker.owner}\``);
      if (blocker.nextAction) lines.push(`  - Next: ${blocker.nextAction}`);
    }
  }
  lines.push('');

  if (dashboard.openHandoffDetails.length > 0) {
    lines.push('## Open Handoffs');
    lines.push('');
    lines.push('| ID | From | To | Context | Age |');
    lines.push('|----|------|----|---------|-----|');
    for (const h of dashboard.openHandoffDetails) {
      const age = Math.round((Date.now() - new Date(h.createdAt).getTime()) / (60 * 60 * 1000));
      lines.push(`| ${h.id} | ${h.from} | ${h.to} | ${h.context} | ${age}h |`);
    }
    lines.push('');
  }

  if (dashboard.activeDecisionDetails.length > 0) {
    lines.push('## Active Decisions');
    lines.push('');
    lines.push('| ID | Topic | Decision | By |');
    lines.push('|----|-------|----------|----|');
    for (const d of dashboard.activeDecisionDetails) {
      lines.push(`| ${d.id} | ${d.topic} | ${d.decision} | ${d.decidedBy} |`);
    }
    lines.push('');
  }

  lines.push('## Recent Activity');
  lines.push('');
  if (dashboard.recentEvents.length === 0) {
    lines.push('*No recent activity.*');
  } else {
    lines.push('| Time | Type | Object | Summary | Actor |');
    lines.push('|------|------|--------|---------|-------|');
    for (const event of dashboard.recentEvents.slice(0, 10)) {
      const actorName = resolveAgentDisplayName(event.actor);
      lines.push(`| ${event.timestamp.slice(0, 16)} | ${event.type} | ${objectRef(event)} | ${event.summary} | ${actorName} |`);
    }
  }

  const isEmpty = taskEntries.length === 0 && prEntries.length === 0
    && dashboard.blockers.length === 0 && dashboard.recentEvents.length === 0;
  if (isEmpty) {
    lines.push('');
    lines.push('## Getting Started');
    lines.push('');
    lines.push('No events recorded yet. Try these commands:');
    lines.push('');
    lines.push('```bash');
    lines.push('openslack pr doctor <n>          # Check a PR');
    lines.push('openslack collaboration handoff create --from <you> --to <them> --context "..."  # Create a handoff');
    lines.push('openslack status                 # See system overview');
    lines.push('```');
  }

  lines.push('');
  return lines.join('\n');
}
