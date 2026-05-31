import type { ProfileSyncJob } from './profile-sync-queue.js';
import { runProfileSync } from './profile-sync-run.js';
import { dequeueProfileSyncJob, markJobComplete, markJobFailed } from './profile-sync-queue.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncWorkerOptions {
  intervalMs?: number;
  recordEvent?: (event: {
    type: string;
    actor: { id: string; kind: string; provider: string };
    object: { kind: string; id: string; url?: string };
    source: { kind: string; ref: string };
    summary: string;
    visibility: string;
    redacted: boolean;
    containsSensitiveData: boolean;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown> | unknown;
}

// ── Worker ────────────────────────────────────────────────────────────────────

export class ProfileSyncWorker {
  private intervalMs: number;
  private recordEvent: ProfileSyncWorkerOptions['recordEvent'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: ProfileSyncWorkerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.recordEvent = options.recordEvent;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Process one job immediately
    void this.processNext();

    // Then poll
    this.timer = setInterval(() => {
      void this.processNext();
    }, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processNext(): Promise<void> {
    const job = dequeueProfileSyncJob();
    if (!job) return;

    await this.processJob(job);
  }

  async processJob(job: ProfileSyncJob): Promise<void> {
    const correlationId = job.id;

    // Record started event
    if (this.recordEvent) {
      try {
        await this.recordEvent({
          type: 'profile_sync.started',
          actor: { id: 'profile-sync-worker', kind: 'system', provider: 'github' },
          object: { kind: 'job', id: job.id },
          source: { kind: 'github', ref: 'profile-sync.worker' },
          summary: `Started processing profile-sync job ${job.id}`,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
          metadata: {
            sourceRepo: job.sourceRepo,
            sourceSha: job.sourceSha,
            targetRepo: job.targetRepo,
            marker: job.marker,
            correlationId,
          },
        });
      } catch {
        // best-effort
      }
    }

    try {
      const result = await runProfileSync({
        config: job.config,
        runId: job.id,
        sourceSha: job.sourceSha,
        recordEvent: this.recordEvent,
      });

      if (result.status === 'completed') {
        markJobComplete(job.id);
      } else {
        markJobFailed(job.id);
      }
    } catch (err: unknown) {
      markJobFailed(job.id);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ProfileSyncWorker] Job ${job.id} failed: ${msg}`);
    }
  }
}
