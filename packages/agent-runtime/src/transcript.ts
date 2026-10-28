import { existsSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { scanValue } from '@openslack/collaboration';
import type { AgentRunEvent } from './types.js';
import { createRunStore } from './run-store.js';
import { validateRunId } from './run-id.js';
import { withHarnessDescriptor } from './harness-read.js';

const RUNS_DIR_NAME = 'agents/runs';

function getRunDir(runId: string, rootDir?: string): string {
  return join(rootDir ?? process.cwd(), '.openslack.local', RUNS_DIR_NAME, runId);
}

function getTranscriptPath(runId: string, rootDir?: string): string {
  return join(getRunDir(runId, rootDir), 'transcript.jsonl');
}

export function appendTranscriptEvent(runId: string, event: AgentRunEvent, rootDir?: string): void {
  validateRunId(runId);

  const scan = scanValue(event, 'transcript');
  if (scan.found) {
    throw new Error(`Transcript event contains ${scan.name} at ${scan.path}. Refusing to persist.`);
  }

  createRunStore(rootDir, { sweepOrphans: false }).appendEvent(runId, event);
}

export function readTranscript(runId: string, rootDir?: string): AgentRunEvent[] {
  validateRunId(runId);
  const transcriptPath = getTranscriptPath(runId, rootDir);
  if (!existsSync(transcriptPath)) return [];

  const raw = readFileSync(transcriptPath, 'utf-8');
  return parseTranscriptEvents(raw);
}

/** Best-effort legacy parsing stays available; evidence consumers explicitly select strict parsing. */
export function parseTranscriptEvents(raw: string | Uint8Array, strict = false): AgentRunEvent[] {
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: strict }).decode(raw);
  const events: AgentRunEvent[] = [];
  for (const line of text.split('\n').filter(value => value.trim() !== '')) {
    try { events.push(parseLine(line, strict)); } catch (error) { if (strict) throw error; }
  }
  return events;
}

function parseLine(line: string, strict: boolean): AgentRunEvent {
  const row: unknown = JSON.parse(line);
  if (strict && (!row || typeof row !== 'object' || Array.isArray(row) || !('type' in row) ||
    !['start', 'progress', 'tool_call', 'tool_result', 'complete', 'fail', 'cancel'].includes(String(row.type)) ||
    !('data' in row) || !row.data || typeof row.data !== 'object' || Array.isArray(row.data))) {
    throw new Error('Transcript evidence event is malformed');
  }
  return row as AgentRunEvent;
}

/** Process a stable bounded JSONL descriptor incrementally, retaining at most one logical event. */
export function visitStrictTranscript(path: string, visit: (event: AgentRunEvent) => void, maxBytes = 64 * 1024 * 1024): void {
  withHarnessDescriptor(path, maxBytes, {}, fd => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const block = Buffer.alloc(64 * 1024);
    let pending = '';
    let read = 0;
    while (true) {
      const count = readSync(fd, block, 0, block.length, null);
      if (!count) break;
      read += count;
      if (read > maxBytes) throw new Error('Transcript evidence exceeds its bound');
      pending += decoder.decode(block.subarray(0, count), { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error('Transcript event exceeds its bound');
        if (line.trim()) visit(parseLine(line, true));
      }
      if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error('Transcript event exceeds its bound');
    }
    pending += decoder.decode();
    if (pending.length) throw new Error('Transcript evidence has an incomplete final record');
  });
}
