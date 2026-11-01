import { decodeStrictJSON } from '@openslack/core';
import type { AgentRunEvent } from './types.js';

export const RUN_TRANSCRIPT_EVENT_MAX_BYTES = 16 * 1024 * 1024;
export const RUN_TRANSCRIPT_EVENT_TYPES = Object.freeze(['start', 'progress', 'tool_call', 'tool_result', 'complete', 'fail', 'cancel'] as const);

export function parseTranscriptLine(line: string, strict: boolean): AgentRunEvent {
  const row: unknown = strict ? decodeStrictJSON(line, RUN_TRANSCRIPT_EVENT_MAX_BYTES) : JSON.parse(line);
  if (strict && (!row || typeof row !== 'object' || Array.isArray(row) || !('type' in row) ||
    !RUN_TRANSCRIPT_EVENT_TYPES.includes(row.type as AgentRunEvent['type']) || !('data' in row) || !row.data || typeof row.data !== 'object' || Array.isArray(row.data))) {
    throw new Error('Transcript evidence event is malformed');
  }
  return row as AgentRunEvent;
}

/** Canonical writer/repair evidence also needs a real durable timestamp. Legacy
 * strict shape readers retain their original acceptance contract. */
export function parseDurableTranscriptLine(line: string): AgentRunEvent {
  const event = parseTranscriptLine(line, true);
  if (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('Transcript evidence timestamp is malformed');
  return event;
}
