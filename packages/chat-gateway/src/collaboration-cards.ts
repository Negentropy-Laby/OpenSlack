import type { ChatCard, ChatCardField } from './cards.js';

export interface DashboardCardData {
  sinceHours: number;
  blockerCount: number;
  openHandoffs: number;
  activeDecisions: number;
  blockers: Array<{ object: string; summary: string; owner?: string }>;
}

export interface DigestGroupData {
  label: string;
  count: number;
  items: string[];
}

export interface DigestCardData {
  sinceHours: number;
  totalEvents: number;
  groups: DigestGroupData[];
}

export interface RoomCardData {
  roomId: string;
  eventCount: number;
  blockerCount: number;
  handoffCount: number;
  decisionCount: number;
  blockers: Array<{ object: string; summary: string }>;
}

export interface ActivityCardData {
  eventCount: number;
  sinceHours: number;
  events: Array<{ type: string; object: string; summary: string }>;
}

export function buildDashboardCard(data: DashboardCardData): ChatCard {
  const fields: ChatCardField[] = [
    { label: 'Window', value: `${data.sinceHours}h` },
    { label: 'Blockers', value: String(data.blockerCount) },
    { label: 'Open handoffs', value: String(data.openHandoffs) },
    { label: 'Active decisions', value: String(data.activeDecisions) },
  ];

  return {
    title: 'OpenSlack Team Dashboard',
    summary: data.blockerCount > 0
      ? `${data.blockerCount} blocker(s) in the last ${data.sinceHours}h`
      : `No blockers in the last ${data.sinceHours}h`,
    fields,
    actions: [],
  };
}

export function buildDigestCard(data: DigestCardData): ChatCard {
  const fields: ChatCardField[] = data.groups.map((g) => ({
    label: g.label,
    value: `${g.count} event(s)`,
  }));

  return {
    title: 'Collaboration Digest',
    summary: `${data.totalEvents} events in ${data.sinceHours}h across ${data.groups.length} groups`,
    fields,
    actions: [],
  };
}

export function buildRoomCard(data: RoomCardData): ChatCard {
  const fields: ChatCardField[] = [
    { label: 'Room', value: data.roomId },
    { label: 'Events', value: String(data.eventCount) },
    { label: 'Blockers', value: String(data.blockerCount) },
    { label: 'Handoffs', value: String(data.handoffCount) },
    { label: 'Decisions', value: String(data.decisionCount) },
  ];

  return {
    title: `Room: ${data.roomId}`,
    summary: data.blockerCount > 0
      ? `${data.blockerCount} active blocker(s)`
      : `${data.eventCount} events, no blockers`,
    fields,
    actions: [],
  };
}

export function buildActivityCard(data: ActivityCardData): ChatCard {
  const topEvents = data.events.slice(0, 5);
  const fields: ChatCardField[] = topEvents.map((e) => ({
    label: e.type,
    value: e.summary.slice(0, 80),
  }));

  return {
    title: 'Collaboration Activity',
    summary: `${data.eventCount} events in the last ${data.sinceHours}h`,
    fields,
    actions: [],
  };
}
