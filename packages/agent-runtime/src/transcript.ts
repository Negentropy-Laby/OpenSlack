import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { scanValue } from '@openslack/collaboration';
import type { AgentRunEvent } from './types.js';
import { validateRunId } from './run-store.js';

const RUNS_DIR_NAME = 'agents/runs';

function getRunDir(runId: string, rootDir?: string): string {
  return join(rootDir ?? process.cwd(), '.openslack.local', RUNS_DIR_NAME, runId);
}

function getTranscriptPath(runId: string, rootDir?: string): string {
  return join(getRunDir(runId, rootDir), 'transcript.jsonl');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function appendTranscriptEvent(runId: string, event: AgentRunEvent, rootDir?: string): void {
  validateRunId(runId);

  const scan = scanValue(event, 'transcript');
  if (scan.found) {
    throw new Error(`Transcript event contains ${scan.name} at ${scan.path}. Refusing to persist.`);
  }

  const transcriptPath = getTranscriptPath(runId, rootDir);
  ensureDir(dirname(transcriptPath));

  appendFileSync(transcriptPath, JSON.stringify(event) + '\n', 'utf-8');
}

export function readTranscript(runId: string, rootDir?: string): AgentRunEvent[] {
  validateRunId(runId);
  const transcriptPath = getTranscriptPath(runId, rootDir);
  if (!existsSync(transcriptPath)) return [];

  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  const events: AgentRunEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AgentRunEvent);
    } catch {
      // Skip malformed lines — don't fail the entire transcript
    }
  }

  return events;
}
