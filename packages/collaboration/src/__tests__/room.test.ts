import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseRoomId,
  buildRoomView,
  renderRoom,
  renderRoomPlain,
  renderRoomChat,
} from '../room.js';
import { recordEvent } from '../events.js';
import { createHandoff } from '../handoff.js';
import { recordDecision } from '../decision.js';
import type { CollaborationEvent } from '../types.js';

function makeEvent(partial: Partial<CollaborationEvent>): CollaborationEvent {
  return {
    id: 'test-id',
    schema: 'openslack.collaboration_event.v1' as const,
    timestamp: '2026-05-24T10:00:00Z',
    type: 'task.created',
    actor: { id: 'test-actor', kind: 'system' as const },
    object: { kind: 'pr' as const, id: '42' },
    source: { kind: 'openslack' as const, ref: 'test' },
    summary: 'Test event',
    visibility: 'local' as const,
    redacted: false,
    containsSensitiveData: false,
    ...partial,
  } as CollaborationEvent;
}

describe('room', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-room-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses room IDs', () => {
    expect(parseRoomId('pr:42')).toEqual({ kind: 'pr', id: '42' });
    expect(parseRoomId('issue:21')).toEqual({ kind: 'issue', id: '21' });
    expect(parseRoomId('module:operator')).toEqual({ kind: 'module', id: 'operator' });
    expect(parseRoomId('invalid')).toBeUndefined();
  });

  it('builds room view with events', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
      makeEvent({
        type: 'pr.merge.requested',
        summary: 'Merge requested',
        object: { kind: 'pr', id: '42' },
        nextAction: { owner: 'human', action: 'Review' },
      }),
      makeEvent({
        type: 'task.created',
        summary: 'Other task',
        object: { kind: 'issue', id: '21' },
      }),
    ];

    const view = buildRoomView('pr:42', events);
    expect(view).toBeDefined();
    expect(view!.roomId).toBe('pr:42');
    expect(view!.recentEvents.length).toBe(2);
    expect(view!.nextAction).toBe('human — Review');
  });

  it('finds blockers in room view', () => {
    const events = [
      makeEvent({
        type: 'pr.doctor.blocked',
        summary: 'PR blocked',
        object: { kind: 'pr', id: '42' },
      }),
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
    ];

    const view = buildRoomView('pr:42', events);
    expect(view!.blockers.length).toBe(1);
    expect(view!.blockers[0].type).toBe('pr.doctor.blocked');
  });

  it('finds linked handoffs', () => {
    createHandoff({ from: 'a', to: 'b', prRef: '42', context: 'Handoff for PR' });
    createHandoff({ from: 'c', to: 'd', issueRef: '21', context: 'Other handoff' });

    const view = buildRoomView('pr:42', []);
    expect(view!.linkedHandoffs.length).toBe(1);
    expect(view!.linkedHandoffs[0].prRef).toBe('42');
  });

  it('finds linked decisions', () => {
    recordDecision({
      topic: 'PR 42 approach',
      decision: 'Use approach A',
      rationale: 'Better',
      decidedBy: 'team',
    });
    recordDecision({
      topic: 'Something else',
      decision: 'Do B',
      rationale: 'OK',
      decidedBy: 'team',
    });

    const view = buildRoomView('pr:42', []);
    expect(view!.linkedDecisions.length).toBe(1);
    expect(view!.linkedDecisions[0].topic).toContain('42');
  });

  it('returns undefined for invalid room ID', () => {
    expect(buildRoomView('invalid', [])).toBeUndefined();
  });

  it('renders room view', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
    ];

    const view = buildRoomView('pr:42', events);
    const output = renderRoom(view!);

    expect(output).toContain('Room: pr:42');
    expect(output).toContain('Recent Activity');
    expect(output).toContain('pr.doctor.ready');
  });

  it('renders empty room', () => {
    const view = buildRoomView('pr:99', []);
    const output = renderRoom(view!);

    expect(output).toContain('Room: pr:99');
    expect(output).toContain('No activity found');
  });

  it('renders blockers section', () => {
    const events = [
      makeEvent({
        type: 'pr.doctor.blocked',
        summary: 'Tests failing',
        object: { kind: 'pr', id: '42' },
      }),
    ];

    const view = buildRoomView('pr:42', events);
    const output = renderRoom(view!);

    expect(output).toContain('Blockers');
    expect(output).toContain('Tests failing');
  });
});

describe('renderRoomPlain', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-plain-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders room ID in uppercase header', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomPlain(view!);
    expect(output).toContain('ROOM: pr:42');
  });

  it('renders owner', () => {
    const events = [
      makeEvent({
        type: 'pr.doctor.ready',
        summary: 'PR ready',
        object: { kind: 'pr', id: '42' },
        owner: { id: 'alice', kind: 'human' },
      }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomPlain(view!);
    expect(output).toContain('Owner: human:alice');
  });

  it('renders next action', () => {
    const events = [
      makeEvent({
        type: 'pr.merge.requested',
        summary: 'Merge requested',
        object: { kind: 'pr', id: '42' },
        nextAction: { owner: 'human', action: 'Review the PR' },
      }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomPlain(view!);
    expect(output).toContain('Next action: human');
  });

  it('renders blockers with [BLOCKER] tag', () => {
    const events = [
      makeEvent({
        type: 'pr.doctor.blocked',
        summary: 'Tests failing',
        object: { kind: 'pr', id: '42' },
      }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomPlain(view!);
    expect(output).toContain('BLOCKERS (1)');
    expect(output).toContain('[BLOCKER]');
    expect(output).toContain('pr.doctor.blocked');
    expect(output).toContain('Tests failing');
  });

  it('renders handoffs with status', () => {
    createHandoff({ from: 'alice', to: 'bob', prRef: '42', context: 'Review PR 42' });
    const view = buildRoomView('pr:42', []);
    const output = renderRoomPlain(view!);
    expect(output).toContain('HANDOFFS (1)');
    expect(output).toContain('[OPEN]');
    expect(output).toContain('alice -> bob');
  });

  it('renders decisions with status', () => {
    recordDecision({
      topic: 'PR 42 approach',
      decision: 'Use approach A',
      rationale: 'Better',
      decidedBy: 'team',
    });
    const view = buildRoomView('pr:42', []);
    const output = renderRoomPlain(view!);
    expect(output).toContain('DECISIONS (1)');
    expect(output).toContain('[ACTIVE]');
  });

  it('renders recent events with blocker tag', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
      makeEvent({
        type: 'pr.doctor.blocked',
        summary: 'Blocked',
        object: { kind: 'pr', id: '42' },
      }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomPlain(view!);
    expect(output).toContain('RECENT EVENTS');
    expect(output).toContain('[BLOCKER]');
  });

  it('renders NO ACTIVITY for empty room', () => {
    const view = buildRoomView('pr:99', []);
    const output = renderRoomPlain(view!);
    expect(output).toContain('NO ACTIVITY');
  });

  it('renders source URL when available', () => {
    const events = [
      makeEvent({ type: 'task.created', summary: 'Created', object: { kind: 'issue', id: '21' } }),
    ];
    const view = buildRoomView('issue:21', events);
    const output = renderRoomPlain(view!);
    expect(output).toContain('Source:');
  });
});

describe('renderRoomChat', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-chat-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders room ID with bold markdown', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomChat(view!);
    expect(output).toContain('*Room: pr:42*');
  });

  it('renders summary stats line', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomChat(view!);
    expect(output).toContain('Events: 1');
    expect(output).toContain('Blockers: 0');
    expect(output).toContain('Handoffs: 0');
    expect(output).toContain('Decisions: 0');
  });

  it('renders owner with backtick formatting', () => {
    const events = [
      makeEvent({
        type: 'pr.doctor.ready',
        summary: 'PR ready',
        object: { kind: 'pr', id: '42' },
        owner: { id: 'alice', kind: 'human' },
      }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomChat(view!);
    expect(output).toContain('Owner: `human:alice`');
  });

  it('renders source URL in italics', () => {
    const events = [
      makeEvent({ type: 'task.created', summary: 'Created', object: { kind: 'issue', id: '21' } }),
    ];
    const view = buildRoomView('issue:21', events);
    const output = renderRoomChat(view!);
    expect(output).toContain('_Source:');
  });

  it('renders blockers with warning emoji', () => {
    const events = [
      makeEvent({
        type: 'pr.doctor.blocked',
        summary: 'Tests failing',
        object: { kind: 'pr', id: '42' },
      }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomChat(view!);
    expect(output).toContain('*Blockers:*');
    expect(output).toContain(':warning:');
    expect(output).toContain('Tests failing');
  });

  it('renders handoffs with circle icons', () => {
    createHandoff({ from: 'alice', to: 'bob', prRef: '42', context: 'Review PR' });
    const view = buildRoomView('pr:42', []);
    const output = renderRoomChat(view!);
    expect(output).toContain('*Handoffs:*');
    expect(output).toContain(':white_circle:');
    expect(output).toContain('alice -> bob');
  });

  it('renders decisions with circle icons', () => {
    recordDecision({
      topic: 'PR 42 approach',
      decision: 'Use approach A',
      rationale: 'Better',
      decidedBy: 'team',
    });
    const view = buildRoomView('pr:42', []);
    const output = renderRoomChat(view!);
    expect(output).toContain('*Decisions:*');
    expect(output).toContain(':large_green_circle:');
  });

  it('renders recent events in code backticks', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready', object: { kind: 'pr', id: '42' } }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomChat(view!);
    expect(output).toContain('*Recent:*');
    expect(output).toContain('`pr.doctor.ready`');
  });

  it('renders no activity message in italics for empty room', () => {
    const view = buildRoomView('pr:99', []);
    const output = renderRoomChat(view!);
    expect(output).toContain('_No activity found for this room._');
  });

  it('renders next action', () => {
    const events = [
      makeEvent({
        type: 'pr.merge.requested',
        summary: 'Merge requested',
        object: { kind: 'pr', id: '42' },
        nextAction: { owner: 'human', action: 'Review the PR' },
      }),
    ];
    const view = buildRoomView('pr:42', events);
    const output = renderRoomChat(view!);
    expect(output).toContain('Next:');
    expect(output).toContain('Review the PR');
  });
});
