import type { CollaborationEvent, EventFilter } from './types.js';
import { filterEvents } from './events.js';
import { resolveAgentDisplayName } from './agent-resolve.js';

export interface ActivityGroup {
  label: string;
  events: CollaborationEvent[];
}

export function formatActivityEvent(event: CollaborationEvent): string {
  const parts: string[] = [];

  const ts = event.timestamp.slice(11, 16); // HH:MM
  const actorName = resolveAgentDisplayName(event.actor);
  parts.push(`${ts}  ${event.type}  (by ${actorName})`);

  if (event.object.id) {
    parts.push(`      Object: ${event.object.kind}:${event.object.id}`);
  }

  if (event.summary) {
    parts.push(`      ${event.summary}`);
  }

  if (event.owner) {
    const ownerName =
      event.owner.kind === 'agent' || event.owner.kind === 'human'
        ? resolveAgentDisplayName({ id: event.owner.id, kind: event.owner.kind })
        : `${event.owner.kind}:${event.owner.id}`;
    parts.push(`      Owner: ${ownerName}`);
  }

  if (event.nextAction) {
    parts.push(`      Next: ${event.nextAction.owner} — ${event.nextAction.action}`);
  }

  if (event.risk && event.risk !== 'none') {
    parts.push(`      Risk: ${event.risk}`);
  }

  if (event.source.ref) {
    parts.push(`      Source: ${event.source.kind} (${event.source.ref})`);
  }

  return parts.join('\n');
}

export function renderActivityFeed(events: CollaborationEvent[]): string {
  if (events.length === 0) {
    return 'No events found.';
  }

  const lines: string[] = [];
  lines.push('OpenSlack Activity');
  lines.push('══════════════════');
  lines.push('');

  for (const event of events) {
    lines.push(formatActivityEvent(event));
    lines.push('');
  }

  return lines.join('\n');
}

export function getRecentEvents(
  hours: number,
  allEvents: CollaborationEvent[],
): CollaborationEvent[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  return allEvents.filter((e) => new Date(e.timestamp) >= cutoff);
}

export { filterEvents, type EventFilter };
