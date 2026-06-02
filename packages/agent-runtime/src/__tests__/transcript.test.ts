import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTranscriptEvent, readTranscript } from '../transcript.js';
import type { AgentRunEvent } from '../types.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-transcript-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('transcript', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('appends events to transcript.jsonl', () => {
    const event: AgentRunEvent = {
      timestamp: new Date().toISOString(),
      type: 'start',
      data: { prompt: 'Hello' },
    };

    appendTranscriptEvent('RUN-20260101-TEST1234', event, root);

    const transcriptPath = join(
      root,
      '.openslack.local',
      'agents/runs',
      'RUN-20260101-TEST1234',
      'transcript.jsonl',
    );
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('start');
    expect(parsed.data.prompt).toBe('Hello');
  });

  it('reads transcript events in order', () => {
    const events: AgentRunEvent[] = [
      { timestamp: '2026-01-01T00:00:00Z', type: 'start', data: {} },
      { timestamp: '2026-01-01T00:00:01Z', type: 'tool_call', data: { tool: 'Read' } },
      { timestamp: '2026-01-01T00:00:02Z', type: 'complete', data: {} },
    ];

    for (const event of events) {
      appendTranscriptEvent('RUN-20260101-TEST1234', event, root);
    }

    const read = readTranscript('RUN-20260101-TEST1234', root);
    expect(read.length).toBe(3);
    expect(read[0].type).toBe('start');
    expect(read[1].type).toBe('tool_call');
    expect(read[2].type).toBe('complete');
  });

  it('returns empty array for nonexistent transcript', () => {
    const read = readTranscript('RUN-20260101-NONEXIST', root);
    expect(read).toEqual([]);
  });

  it('skips malformed lines without failing', () => {
    const validEvent: AgentRunEvent = {
      timestamp: '2026-01-01T00:00:00Z',
      type: 'start',
      data: {},
    };
    appendTranscriptEvent('RUN-20260101-TEST1234', validEvent, root);

    // Manually append a malformed line
    const transcriptPath = join(
      root,
      '.openslack.local',
      'agents/runs',
      'RUN-20260101-TEST1234',
      'transcript.jsonl',
    );
    appendFileSync(transcriptPath, 'this-is-not-json\n', 'utf-8');

    const validEvent2: AgentRunEvent = {
      timestamp: '2026-01-01T00:00:01Z',
      type: 'complete',
      data: {},
    };
    appendTranscriptEvent('RUN-20260101-TEST1234', validEvent2, root);

    const read = readTranscript('RUN-20260101-TEST1234', root);
    expect(read.length).toBe(2);
    expect(read[0].type).toBe('start');
    expect(read[1].type).toBe('complete');
  });
});
