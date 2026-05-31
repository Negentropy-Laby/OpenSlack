import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileSyncConfig } from './profile-sync-config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncJob {
  id: string;
  deliveryId: string;
  sourceRepo: string;
  sourceSha: string;
  targetRepo: string;
  marker: string;
  config: ProfileSyncConfig;
  enqueuedAt: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

// ── Queue ─────────────────────────────────────────────────────────────────────

function getQueueDir(): string {
  const dir = join(process.cwd(), '.openslack.local', 'daemon');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getQueuePath(): string {
  return join(getQueueDir(), 'profile-sync-queue.jsonl');
}

function getDedupePath(): string {
  return join(getQueueDir(), 'profile-sync-dedupe.jsonl');
}

function generateJobId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PSQ-${ts}-${rand}`;
}

function buildDedupeKey(job: Omit<ProfileSyncJob, 'id' | 'enqueuedAt' | 'status'>): string {
  return `${job.deliveryId}:${job.sourceRepo}:${job.sourceSha}:${job.targetRepo}:${job.marker}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function enqueueProfileSyncJob(
  jobData: Omit<ProfileSyncJob, 'id' | 'enqueuedAt' | 'status'>,
): ProfileSyncJob | null {
  const dedupeKey = buildDedupeKey(jobData);

  // Check dedupe
  if (isDuplicate(dedupeKey)) {
    return null;
  }

  const job: ProfileSyncJob = {
    ...jobData,
    id: generateJobId(),
    enqueuedAt: new Date().toISOString(),
    status: 'pending',
  };

  // Record dedupe
  recordDedupe(dedupeKey);

  // Append to queue
  const path = getQueuePath();
  const line = JSON.stringify(job) + '\n';
  appendFileSync(path, line, 'utf-8');

  return job;
}

export function dequeueProfileSyncJob(): ProfileSyncJob | null {
  const path = getQueuePath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  let pendingJob: ProfileSyncJob | null = null;
  const remaining: string[] = [];

  for (const line of lines) {
    try {
      const job = JSON.parse(line) as ProfileSyncJob;
      if (!pendingJob && job.status === 'pending') {
        pendingJob = job;
        pendingJob.status = 'processing';
        remaining.push(JSON.stringify(pendingJob));
      } else {
        remaining.push(line);
      }
    } catch {
      remaining.push(line);
    }
  }

  if (pendingJob) {
    writeFileSync(path, remaining.join('\n') + '\n', 'utf-8');
  }

  return pendingJob;
}

export function listPendingJobs(): ProfileSyncJob[] {
  const path = getQueuePath();
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  const jobs: ProfileSyncJob[] = [];
  for (const line of lines) {
    try {
      const job = JSON.parse(line) as ProfileSyncJob;
      if (job.status === 'pending') {
        jobs.push(job);
      }
    } catch {
      // skip malformed
    }
  }

  return jobs;
}

export function markJobComplete(jobId: string): void {
  const path = getQueuePath();
  if (!existsSync(path)) return;

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  const updated = lines.map((line) => {
    try {
      const job = JSON.parse(line) as ProfileSyncJob;
      if (job.id === jobId) {
        job.status = 'completed';
        return JSON.stringify(job);
      }
      return line;
    } catch {
      return line;
    }
  });

  writeFileSync(path, updated.join('\n') + '\n', 'utf-8');
}

export function markJobFailed(jobId: string): void {
  const path = getQueuePath();
  if (!existsSync(path)) return;

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  const updated = lines.map((line) => {
    try {
      const job = JSON.parse(line) as ProfileSyncJob;
      if (job.id === jobId) {
        job.status = 'failed';
        return JSON.stringify(job);
      }
      return line;
    } catch {
      return line;
    }
  });

  writeFileSync(path, updated.join('\n') + '\n', 'utf-8');
}

export function isDuplicate(dedupeKey: string): boolean {
  const path = getDedupePath();
  if (!existsSync(path)) return false;

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { key: string; timestamp: string };
      if (entry.key === dedupeKey) return true;
    } catch {
      // skip malformed
    }
  }

  return false;
}

export function recordDedupe(dedupeKey: string): void {
  const path = getDedupePath();
  const entry = { key: dedupeKey, timestamp: new Date().toISOString() };
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
}
