import type { Decision } from '@openslack/collaboration';
import { sanitizeTerminalText } from '../sanitize.js';

export interface DecisionListItemViewModel {
  id: string;
  topic: string;
  decision: string;
  status: string;
  decidedBy: string;
  age: string;
}

export interface DecisionListViewModel {
  title: string;
  totalCount: number;
  activeCount: number;
  items: DecisionListItemViewModel[];
}

export interface DecisionDetailViewModel {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  consequences: string[];
  decidedBy: string;
  createdAt: string;
  status: string;
  supersededBy?: string;
  supersededAt?: string;
  tags: string[];
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

export function mapDecisionListToViewModel(decisions: Decision[]): DecisionListViewModel {
  const s = sanitizeTerminalText;
  const sorted = [...decisions].sort((a, b) => {
    // Active first, then by date descending
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return {
    title: 'Decisions',
    totalCount: decisions.length,
    activeCount: decisions.filter((d) => d.status === 'active').length,
    items: sorted.map((d) => ({
      id: s(d.id),
      topic: s(d.topic),
      decision: s(d.decision),
      status: d.status,
      decidedBy: s(d.decidedBy),
      age: formatAge(d.createdAt),
    })),
  };
}

export function mapDecisionToViewModel(decision: Decision): DecisionDetailViewModel {
  const s = sanitizeTerminalText;

  return {
    id: s(decision.id),
    topic: s(decision.topic),
    decision: s(decision.decision),
    rationale: s(decision.rationale),
    alternatives: (decision.alternatives || []).map(s),
    consequences: (decision.consequences || []).map(s),
    decidedBy: s(decision.decidedBy),
    createdAt: decision.createdAt,
    status: decision.status,
    supersededBy: decision.supersededBy ? s(decision.supersededBy) : undefined,
    supersededAt: decision.supersededAt,
    tags: (decision.tags || []).map(s),
  };
}
