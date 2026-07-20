import type { DashboardProjection } from '@openslack/collaboration';
import { sanitizeTerminalText } from '../sanitize.js';

export interface DashboardViewModel {
  title: string;
  generatedAt: string;
  summary: {
    blockers: number;
    handoffs: number;
    decisions: number;
  };
  blockers: Array<{
    object: string;
    summary: string;
    owner?: string;
    nextAction?: string;
    severity?: string;
  }>;
  handoffs: Array<{
    id: string;
    from: string;
    to: string;
    status: string;
    context: string;
    age: string;
  }>;
  decisions: Array<{
    id: string;
    topic: string;
    status: string;
    decidedBy: string;
  }>;
  recentActivity: Array<{
    time: string;
    type: string;
    summary: string;
    actor: string;
  }>;
}

function formatAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const hours = Math.floor((now - created) / 3600000);
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function mapDashboardToViewModel(projection: DashboardProjection): DashboardViewModel {
  const s = sanitizeTerminalText;

  return {
    title: 'OpenSlack Team Dashboard',
    generatedAt: projection.generatedAt,
    summary: {
      blockers: projection.blockerCount,
      handoffs: projection.openHandoffs,
      decisions: projection.activeDecisions,
    },
    blockers: projection.blockers.map((b) => ({
      object: s(b.object),
      summary: s(b.summary),
      owner: b.owner ? s(b.owner) : undefined,
      nextAction: b.nextAction ? s(b.nextAction) : undefined,
      severity: b.severity ? s(b.severity) : undefined,
    })),
    handoffs: projection.openHandoffDetails.map((h) => ({
      id: s(h.id),
      from: s(h.from),
      to: s(h.to),
      status: h.status,
      context: s(h.context),
      age: formatAge(h.createdAt),
    })),
    decisions: projection.activeDecisionDetails.map((d) => ({
      id: s(d.id),
      topic: s(d.topic),
      status: d.status,
      decidedBy: s(d.decidedBy),
    })),
    recentActivity: projection.recentEvents.map((e) => ({
      time: new Date(e.timestamp).toLocaleTimeString(),
      type: e.type,
      summary: s(e.summary),
      actor: s(e.actor.id),
    })),
  };
}
