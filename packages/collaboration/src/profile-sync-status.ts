import { readEvents, filterEvents } from './events.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncStatus {
  state: 'synced' | 'pending' | 'failed' | 'never';
  lastSyncDate?: string;
  lastPrUrl?: string;
  lastPrNumber?: number;
  lastSourceSha?: string;
  postsSynced: number;
  pendingPR?: { number: number; url: string; branch: string; createdAt: string };
  failures: Array<{ date: string; issueUrl?: string; error: string }>;
  isOutOfDate: boolean;
}

export interface ProfileSyncStatusOptions {
  rootDir?: string;
  targetRepo?: string;
  targetPath?: string;
  marker?: string;
}

// ── Status Builder ────────────────────────────────────────────────────────────

export function buildProfileSyncStatus(options?: ProfileSyncStatusOptions): ProfileSyncStatus {
  const events = readEvents(options?.rootDir);

  const completedEvents = filterEvents(events, { type: 'profile_sync.completed' });
  const failedEvents = filterEvents(events, { type: 'profile_sync.failed' });
  const triggeredEvents = filterEvents(events, { type: 'profile_sync.triggered' });
  const mergedEvents = filterEvents(events, { type: 'pr.merge.completed' });

  // Find last completed event matching options
  const targetRepo = options?.targetRepo;
  const targetPath = options?.targetPath;
  const marker = options?.marker;

  const matchingCompleted = completedEvents.filter((e) => {
    if (targetRepo && e.metadata?.targetRepo !== targetRepo) return false;
    if (targetPath && e.metadata?.targetPath !== targetPath) return false;
    if (marker && e.metadata?.marker !== marker) return false;
    return true;
  });

  const lastCompleted = matchingCompleted.length > 0
    ? matchingCompleted[matchingCompleted.length - 1]
    : null;

  // Find last triggered event (for out-of-date check)
  const matchingTriggered = triggeredEvents.filter((e) => {
    const meta = e.metadata as Record<string, unknown> | undefined;
    if (targetRepo && meta?.targetRepo !== targetRepo) return false;
    return true;
  });
  const lastTriggered = matchingTriggered.length > 0
    ? matchingTriggered[matchingTriggered.length - 1]
    : null;

  // Find failures
  const failures = failedEvents
    .filter((e) => {
      if (targetRepo && e.metadata?.targetRepo !== targetRepo) return false;
      return true;
    })
    .map((e) => ({
      date: e.timestamp,
      issueUrl: e.metadata?.issueUrl as string | undefined,
      error: (e.metadata?.error as string) || 'Unknown error',
    }));

  // Determine state
  let state: ProfileSyncStatus['state'] = 'never';
  let lastSyncDate: string | undefined;
  let lastPrUrl: string | undefined;
  let lastPrNumber: number | undefined;
  let lastSourceSha: string | undefined;
  let postsSynced = 0;

  if (lastCompleted) {
    const metadata = lastCompleted.metadata as Record<string, unknown> | undefined;
    lastSyncDate = lastCompleted.timestamp;
    lastPrUrl = metadata?.prUrl as string | undefined;
    lastPrNumber = metadata?.prNumber as number | undefined;
    lastSourceSha = metadata?.sourceSha as string | undefined;
    postsSynced = (metadata?.postsIncluded as Array<unknown> | undefined)?.length ?? 0;

    // Check if the completed PR was actually merged
    const wasMerged = mergedEvents.some((e) => {
      const mergedPrUrl = (e.metadata?.prUrl as string) || '';
      return mergedPrUrl && mergedPrUrl === lastPrUrl;
    });

    state = wasMerged ? 'synced' : 'pending';

    // If there are newer failures after the last sync, show failed
    const newerFailures = failures.filter((f) =>
      lastSyncDate ? f.date > lastSyncDate : true,
    );
    if (newerFailures.length > 0) {
      state = 'failed';
    }
  }

  // Check if out of date: last triggered event is newer than last sync
  let isOutOfDate = false;
  if (lastTriggered && lastSyncDate) {
    isOutOfDate = lastTriggered.timestamp > lastSyncDate;
  } else if (lastTriggered && !lastSyncDate) {
    isOutOfDate = true;
  }

  // If state is synced but there's a newer trigger, show pending
  if (state === 'synced' && isOutOfDate) {
    state = 'pending';
  }

  return {
    state,
    lastSyncDate,
    lastPrUrl,
    lastPrNumber,
    lastSourceSha,
    postsSynced,
    failures,
    isOutOfDate,
  };
}
