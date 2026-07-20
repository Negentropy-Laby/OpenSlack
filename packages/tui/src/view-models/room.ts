import type { RoomView } from '@openslack/collaboration';
import { sanitizeTerminalText } from '../sanitize.js';

export interface RoomViewModel {
  roomId: string;
  objectKind: string;
  objectId: string;
  sourceUrl: string;
  owner: string;
  nextAction: string;
  blockerCount: number;
  blockers: Array<{ type: string; summary: string; timestamp: string }>;
  handoffs: Array<{ id: string; from: string; to: string; status: string; context: string }>;
  decisions: Array<{ id: string; topic: string; decision: string; status: string }>;
  recentActivity: Array<{ time: string; type: string; summary: string; actor: string }>;
}

function formatAge(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function mapRoomToViewModel(view: RoomView): RoomViewModel {
  return {
    roomId: sanitizeTerminalText(view.roomId),
    objectKind: sanitizeTerminalText(view.objectKind),
    objectId: sanitizeTerminalText(view.objectId),
    sourceUrl: view.sourceUrl ? sanitizeTerminalText(view.sourceUrl) : '',
    owner: view.owner ? sanitizeTerminalText(view.owner) : '',
    nextAction: view.nextAction ? sanitizeTerminalText(view.nextAction) : '',
    blockerCount: view.blockers.length,
    blockers: view.blockers.slice(0, 5).map((b) => ({
      type: sanitizeTerminalText(b.type),
      summary: sanitizeTerminalText(b.summary),
      timestamp: formatAge(b.timestamp),
    })),
    handoffs: view.linkedHandoffs.map((h) => ({
      id: sanitizeTerminalText(h.id),
      from: sanitizeTerminalText(h.from),
      to: sanitizeTerminalText(h.to),
      status: sanitizeTerminalText(h.status),
      context: sanitizeTerminalText(h.context),
    })),
    decisions: view.linkedDecisions.map((d) => ({
      id: sanitizeTerminalText(d.id),
      topic: sanitizeTerminalText(d.topic),
      decision: sanitizeTerminalText(d.decision),
      status: sanitizeTerminalText(d.status),
    })),
    recentActivity: view.recentEvents.slice(0, 10).map((e) => ({
      time: e.timestamp.slice(11, 16),
      type: sanitizeTerminalText(e.type),
      summary: sanitizeTerminalText(e.summary),
      actor: sanitizeTerminalText(e.actor.id),
    })),
  };
}
