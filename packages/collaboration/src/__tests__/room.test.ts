import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRoomId, buildRoomView, renderRoom } from '../room.js';
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
      makeEvent({ type: 'pr.merge.requested', summary: 'Merge requested', object: { kind: 'pr', id: '42' }, nextAction: { owner: 'human', action: 'Review' } }),
      makeEvent({ type: 'task.created', summary: 'Other task', object: { kind: 'issue', id: '21' } }),
    ];

    const view = buildRoomView('pr:42', events);
    expect(view).toBeDefined();
    expect(view!.roomId).toBe('pr:42');
    expect(view!.recentEvents.length).toBe(2);
    expect(view!.nextAction).toBe('human — Review');
  });

  it('finds blockers in room view', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.blocked', summary: 'PR blocked', object: { kind: 'pr', id: '42' } }),
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
    recordDecision({ topic: 'PR 42 approach', decision: 'Use approach A', rationale: 'Better', decidedBy: 'team' });
    recordDecision({ topic: 'Something else', decision: 'Do B', rationale: 'OK', decidedBy: 'team' });

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
      makeEvent({ type: 'pr.doctor.blocked', summary: 'Tests failing', object: { kind: 'pr', id: '42' } }),
    ];

    const view = buildRoomView('pr:42', events);
    const output = renderRoom(view!);

    expect(output).toContain('Blockers');
    expect(output).toContain('Tests failing');
  });
});
