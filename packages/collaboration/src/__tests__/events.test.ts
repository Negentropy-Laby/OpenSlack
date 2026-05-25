import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import type { CollaborationEventType } from '../types.js';
import {
  validateEvent,
  createEvent,
  appendEvent,
  recordEvent,
  readEvents,
  filterEvents,
  getEventsPathForTesting,
  getEventsDirForTesting,
} from '../events.js';
import type { CollaborationEvent } from '../types.js';

describe('events', () => {
  let eventPath: string;

  beforeEach(() => {
    eventPath = getEventsPathForTesting();
    // Clear the events file
    if (existsSync(eventPath)) {
      writeFileSync(eventPath, '', 'utf-8');
    }
  });

  afterEach(() => {
    if (existsSync(eventPath)) {
      writeFileSync(eventPath, '', 'utf-8');
    }
  });

  function makeEvent(partial: Partial<CollaborationEvent> = {}): Omit<CollaborationEvent, 'id' | 'timestamp' | 'schema'> {
    const base = {
      type: 'pr.doctor.ready' as CollaborationEventType,
      actor: { id: 'test', kind: 'system' as const },
      object: { kind: 'pr' as const, id: '42' },
      source: { kind: 'prms' as const, ref: 'doctor' },
      summary: 'PR #42 is ready to merge',
      visibility: 'local' as const,
      redacted: false,
      containsSensitiveData: false,
    };
    return { ...base, ...partial } as Omit<CollaborationEvent, 'id' | 'timestamp' | 'schema'>;
  }

  it('validates a correct event', () => {
    const event = createEvent(makeEvent());
    const result = validateEvent(event);
    expect(result.valid).toBe(true);
  });

  it('validates repair events', () => {
    const event = createEvent(makeEvent({
      type: 'repair.previewed',
      object: { kind: 'workspace', id: 'github:labels' },
      source: { kind: 'github', ref: 'github.repair.labels' },
      summary: 'Previewed GitHub label repair',
    }));
    expect(validateEvent(event).valid).toBe(true);
  });

  it('rejects event with wrong schema', () => {
    const result = validateEvent({ schema: 'wrong.schema' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Schema');
  });

  it('rejects event with missing id', () => {
    const result = validateEvent({ schema: 'openslack.collaboration_event.v1' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('id');
  });

  it('rejects event with unknown type', () => {
    const event = makeEvent({ type: 'unknown.type' as never });
    expect(() => createEvent(event)).toThrow('Unknown event type');
  });

  it('rejects event with missing actor', () => {
    const base = { ...makeEvent(), schema: 'openslack.collaboration_event.v1', id: 'test', timestamp: new Date().toISOString() } as Record<string, unknown>;
    delete base.actor;
    const result = validateEvent(base);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('actor');
  });

  it('rejects event with missing object', () => {
    const base = { ...makeEvent(), schema: 'openslack.collaboration_event.v1', id: 'test', timestamp: new Date().toISOString() } as Record<string, unknown>;
    delete base.object;
    const result = validateEvent(base);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('object');
  });

  it('rejects event with missing summary', () => {
    const base = { ...makeEvent(), schema: 'openslack.collaboration_event.v1', id: 'test', timestamp: new Date().toISOString() } as Record<string, unknown>;
    delete base.summary;
    const result = validateEvent(base);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('summary');
  });

  it('rejects event with containsSensitiveData: true', () => {
    const base = { ...makeEvent(), schema: 'openslack.collaboration_event.v1', id: 'test', timestamp: new Date().toISOString() } as Record<string, unknown>;
    base.containsSensitiveData = true;
    const result = validateEvent(base);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('containsSensitiveData');
  });

  it('rejects event with missing visibility', () => {
    const base = { ...makeEvent(), schema: 'openslack.collaboration_event.v1', id: 'test', timestamp: new Date().toISOString() } as Record<string, unknown>;
    delete base.visibility;
    const result = validateEvent(base);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('visibility');
  });

  it('creates an event with auto-generated id and timestamp', () => {
    const event = createEvent(makeEvent());
    expect(event.id).toMatch(/^EV-\d{8}-[A-Z0-9]{8}$/);
    expect(event.timestamp).toBeDefined();
    expect(event.schema).toBe('openslack.collaboration_event.v1');
  });

  it('appends and reads events', () => {
    const event1 = createEvent(makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready' }));
    const event2 = createEvent(makeEvent({ type: 'pr.doctor.blocked', summary: 'PR blocked' }));

    appendEvent(event1);
    appendEvent(event2);

    const events = readEvents();
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe('PR ready');
    expect(events[1].summary).toBe('PR blocked');
  });

  it('recordEvent creates and appends in one call', () => {
    const event = recordEvent(makeEvent({ summary: 'Recorded event' }));
    expect(event.summary).toBe('Recorded event');

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Recorded event');
  });

  it('filters events by type', () => {
    recordEvent(makeEvent({ type: 'pr.doctor.ready' }));
    recordEvent(makeEvent({ type: 'pr.doctor.blocked' }));
    recordEvent(makeEvent({ type: 'operator.plan.created' as CollaborationEventType }));

    const events = readEvents();
    const filtered = filterEvents(events, { type: 'pr.doctor.ready' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe('pr.doctor.ready');
  });

  it('filters events by object id', () => {
    recordEvent(makeEvent({ object: { kind: 'pr', id: '42' } }));
    recordEvent(makeEvent({ object: { kind: 'pr', id: '43' } }));

    const events = readEvents();
    const filtered = filterEvents(events, { objectId: '42' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].object.id).toBe('42');
  });

  it('filters events by actor kind', () => {
    recordEvent(makeEvent({ actor: { id: 'U123', kind: 'human' } }));
    recordEvent(makeEvent({ actor: { id: 'bot', kind: 'agent' } }));

    const events = readEvents();
    const filtered = filterEvents(events, { actorKind: 'agent' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].actor.kind).toBe('agent');
  });

  it('filters events by time range', () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // Manually write events with specific timestamps
    const event1: CollaborationEvent = {
      ...createEvent(makeEvent()),
      timestamp: twoHoursAgo.toISOString(),
    };
    const event2: CollaborationEvent = {
      ...createEvent(makeEvent()),
      timestamp: oneHourAgo.toISOString(),
    };

    appendEvent(event1);
    appendEvent(event2);

    const events = readEvents();
    const filtered = filterEvents(events, { since: new Date(now.getTime() - 90 * 60 * 1000) });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].timestamp).toBe(oneHourAgo.toISOString());
  });

  it('filters events by correlation id', () => {
    recordEvent(makeEvent({ correlationId: 'corr-123' }));
    recordEvent(makeEvent({ correlationId: 'corr-456' }));

    const events = readEvents();
    const filtered = filterEvents(events, { correlationId: 'corr-123' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].correlationId).toBe('corr-123');
  });

  it('skips malformed lines when reading', () => {
    const dir = getEventsDirForTesting();
    writeFileSync(eventPath, '{"valid": true}\nnot-json\n', 'utf-8');

    const events = readEvents();
    // Only the malformed line should be skipped
    // The valid JSON doesn't match the schema, so it's also skipped
    expect(events).toHaveLength(0);
  });
});
