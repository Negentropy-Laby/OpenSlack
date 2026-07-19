import type { CollaborationEvent } from './types.js';
import { filterEvents } from './events.js';
import { buildSourceLink } from './source-links.js';
import { listDecisions, type Decision } from './decision.js';
import { listHandoffs, type Handoff } from './handoff.js';
import { BLOCKER_TYPES } from './dashboard.js';

export interface RoomView {
  roomId: string;
  objectKind: string;
  objectId: string;
  sourceUrl?: string;
  recentEvents: CollaborationEvent[];
  blockers: CollaborationEvent[];
  owner?: string;
  nextAction?: string;
  linkedDecisions: Decision[];
  linkedHandoffs: Handoff[];
}

export function parseRoomId(roomId: string): { kind: string; id: string } | undefined {
  const match = roomId.match(/^(\w+):(.+)$/);
  if (!match) return undefined;
  return { kind: match[1], id: match[2] };
}

export function buildRoomView(
  roomId: string,
  allEvents: CollaborationEvent[],
): RoomView | undefined {
  const parsed = parseRoomId(roomId);
  if (!parsed) return undefined;

  const { kind, id } = parsed;
  const sourceUrl = buildSourceLink(kind, id);

  const objectEvents = filterEvents(allEvents, { objectKind: kind as never, objectId: id });

  const sortedEvents = objectEvents.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const recentEvents = sortedEvents.slice(0, 20);

  const blockers = sortedEvents.filter(
    (e) =>
      e.type === 'task.blocked' ||
      e.type === 'pr.doctor.blocked' ||
      e.type === 'pr.merge.blocked' ||
      e.type === 'operator.plan.blocked' ||
      e.type === 'operator.execution.failed' ||
      e.type === 'governance.audit.failed' ||
      e.type === 'workflow.blocked',
  );

  let owner: string | undefined;
  for (const event of sortedEvents) {
    if (event.owner) {
      owner = `${event.owner.kind}:${event.owner.id}`;
      break;
    }
  }

  let nextAction: string | undefined;
  for (const event of sortedEvents) {
    if (event.nextAction) {
      nextAction = `${event.nextAction.owner} — ${event.nextAction.action}`;
      break;
    }
  }

  const decisions = listDecisions();
  const linkedDecisions = decisions.filter((d) => {
    const text = `${d.topic} ${d.decision} ${d.rationale}`.toLowerCase();
    return (
      text.includes(id.toLowerCase()) ||
      (d.tags && d.tags.some((t) => t.toLowerCase().includes(id.toLowerCase())))
    );
  });

  const handoffs = listHandoffs();
  const linkedHandoffs = handoffs.filter(
    (h) =>
      (h.issueRef && h.issueRef === id && kind === 'issue') ||
      (h.prRef && h.prRef === id && kind === 'pr'),
  );

  return {
    roomId,
    objectKind: kind,
    objectId: id,
    sourceUrl,
    recentEvents,
    blockers,
    owner,
    nextAction,
    linkedDecisions,
    linkedHandoffs,
  };
}

export function renderRoom(view: RoomView): string {
  const lines: string[] = [];

  lines.push(`Room: ${view.roomId}`);
  lines.push('═'.repeat(50));
  lines.push('');

  if (view.sourceUrl) {
    lines.push(`Source: ${view.sourceUrl}`);
    lines.push('');
  }

  if (view.owner) {
    lines.push(`Owner: ${view.owner}`);
  }
  if (view.nextAction) {
    lines.push(`Next: ${view.nextAction}`);
  }
  if (view.owner || view.nextAction) {
    lines.push('');
  }

  if (view.blockers.length > 0) {
    lines.push(`Blockers (${view.blockers.length})`);
    lines.push('─'.repeat(40));
    for (const b of view.blockers.slice(0, 5)) {
      lines.push(`  • ${b.type} — ${b.summary}`);
    }
    lines.push('');
  }

  if (view.linkedHandoffs.length > 0) {
    lines.push(`Handoffs (${view.linkedHandoffs.length})`);
    lines.push('─'.repeat(40));
    for (const h of view.linkedHandoffs) {
      const icon = h.status === 'open' ? '○' : h.status === 'accepted' ? '◐' : '◉';
      const principalTag = h.principal ? ` (${h.principal.registry_id})` : '';
      lines.push(`  ${icon} ${h.id}: ${h.from} → ${h.to}${principalTag}`);
    }
    lines.push('');
  }

  if (view.linkedDecisions.length > 0) {
    lines.push(`Decisions (${view.linkedDecisions.length})`);
    lines.push('─'.repeat(40));
    for (const d of view.linkedDecisions) {
      const icon = d.status === 'active' ? '●' : '○';
      const principalTag = d.principal ? ` (${d.principal.registry_id})` : '';
      lines.push(`  ${icon} ${d.id}: ${d.decision}${principalTag}`);
    }
    lines.push('');
  }

  if (view.recentEvents.length > 0) {
    lines.push(`Recent Activity (${view.recentEvents.length})`);
    lines.push('─'.repeat(40));
    for (const e of view.recentEvents.slice(0, 10)) {
      const ts = e.timestamp.slice(11, 16);
      lines.push(`  ${ts}  ${e.type} — ${e.summary}`);
    }
    lines.push('');
  }

  if (
    view.blockers.length === 0 &&
    view.linkedHandoffs.length === 0 &&
    view.linkedDecisions.length === 0 &&
    view.recentEvents.length === 0
  ) {
    lines.push('No activity found for this room.');
    lines.push('');
  }

  return lines.join('\n');
}

export function renderRoomPlain(view: RoomView): string {
  const lines: string[] = [];

  lines.push(`ROOM: ${view.roomId}`);
  lines.push('');

  if (view.sourceUrl) {
    lines.push(`Source: ${view.sourceUrl}`);
  }

  if (view.owner) {
    lines.push(`Owner: ${view.owner}`);
  }

  if (view.nextAction) {
    lines.push(`Next action: ${view.nextAction}`);
  }
  lines.push('');

  if (view.blockers.length > 0) {
    lines.push(`BLOCKERS (${view.blockers.length})`);
    for (const b of view.blockers.slice(0, 10)) {
      const nextAction = b.nextAction?.action ? ` -> ${b.nextAction.action}` : '';
      lines.push(`  [BLOCKER] ${b.type}: ${b.summary}${nextAction}`);
    }
    lines.push('');
  }

  if (view.linkedHandoffs.length > 0) {
    lines.push(`HANDOFFS (${view.linkedHandoffs.length})`);
    for (const h of view.linkedHandoffs) {
      lines.push(`  [${h.status.toUpperCase()}] ${h.id}: ${h.from} -> ${h.to} - ${h.context}`);
    }
    lines.push('');
  }

  if (view.linkedDecisions.length > 0) {
    lines.push(`DECISIONS (${view.linkedDecisions.length})`);
    for (const d of view.linkedDecisions) {
      lines.push(`  [${d.status.toUpperCase()}] ${d.id}: ${d.topic} - ${d.decision}`);
    }
    lines.push('');
  }

  if (view.recentEvents.length > 0) {
    lines.push(`RECENT EVENTS (${view.recentEvents.length})`);
    for (const e of view.recentEvents.slice(0, 15)) {
      const ts = e.timestamp.slice(0, 16);
      const blockerTag = BLOCKER_TYPES.has(e.type) ? ' [BLOCKER]' : '';
      lines.push(`  ${ts} ${e.type}${blockerTag}: ${e.summary}`);
    }
    lines.push('');
  }

  if (
    view.blockers.length === 0 &&
    view.linkedHandoffs.length === 0 &&
    view.linkedDecisions.length === 0 &&
    view.recentEvents.length === 0
  ) {
    lines.push('NO ACTIVITY');
    lines.push('');
  }

  return lines.join('\n');
}

export function renderRoomChat(view: RoomView): string {
  const lines: string[] = [];

  lines.push(`*Room: ${view.roomId}*`);
  lines.push('');

  if (view.sourceUrl) {
    lines.push(`_Source: ${view.sourceUrl}_`);
  }

  if (view.owner) {
    lines.push(`Owner: \`${view.owner}\``);
  }

  if (view.nextAction) {
    lines.push(`Next: ${view.nextAction}`);
  }
  lines.push('');

  lines.push(
    `Events: ${view.recentEvents.length} | Blockers: ${view.blockers.length} | Handoffs: ${view.linkedHandoffs.length} | Decisions: ${view.linkedDecisions.length}`,
  );
  lines.push('');

  if (view.blockers.length > 0) {
    lines.push('*Blockers:*');
    for (const b of view.blockers.slice(0, 5)) {
      lines.push(`  :warning: ${b.type} - ${b.summary}`);
    }
    lines.push('');
  }

  if (view.linkedHandoffs.length > 0) {
    lines.push('*Handoffs:*');
    for (const h of view.linkedHandoffs) {
      const icon =
        h.status === 'open'
          ? ':white_circle:'
          : h.status === 'accepted'
            ? ':large_orange_circle:'
            : ':large_green_circle:';
      lines.push(`  ${icon} ${h.id}: ${h.from} -> ${h.to}`);
    }
    lines.push('');
  }

  if (view.linkedDecisions.length > 0) {
    lines.push('*Decisions:*');
    for (const d of view.linkedDecisions) {
      const icon = d.status === 'active' ? ':large_green_circle:' : ':white_circle:';
      lines.push(`  ${icon} ${d.id}: ${d.decision}`);
    }
    lines.push('');
  }

  if (view.recentEvents.length > 0) {
    lines.push('*Recent:*');
    for (const e of view.recentEvents.slice(0, 5)) {
      lines.push(`  \`${e.type}\` ${e.summary}`);
    }
  }

  if (
    view.blockers.length === 0 &&
    view.linkedHandoffs.length === 0 &&
    view.linkedDecisions.length === 0 &&
    view.recentEvents.length === 0
  ) {
    lines.push('_No activity found for this room._');
  }

  return lines.join('\n');
}
