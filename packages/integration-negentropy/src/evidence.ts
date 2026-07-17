import { buildProfileSyncStatus, readEvents } from '@openslack/collaboration';
import { loadPRReviewPolicy } from '@openslack/pr';
import { listWorkflowRuns } from '@openslack/workflows';
import { sha256Canonical } from './canonical.js';
import type { NegentropyEvidenceProjection } from './types.js';

export interface CollectNegentropyEvidenceOptions {
  readonly workspaceRoot: string;
  readonly now?: () => Date;
}

function counts(values: readonly string[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const value of [...values].sort()) result[value] = (result[value] ?? 0) + 1;
  return Object.freeze(result);
}

function latest(values: readonly string[]): string | undefined {
  return [...values].filter(Boolean).sort().at(-1);
}

export async function collectNegentropyEvidence(
  options: CollectNegentropyEvidenceOptions,
): Promise<NegentropyEvidenceProjection> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const workflowRuns = await listWorkflowRuns({ rootDir: options.workspaceRoot });
  const events = readEvents(options.workspaceRoot);
  const prmsEvents = events.filter(
    (event) => event.source.kind === 'prms' || event.type.startsWith('pr.'),
  );
  const profile = buildProfileSyncStatus({ rootDir: options.workspaceRoot });
  const policy = loadPRReviewPolicy(options.workspaceRoot);

  const withoutHash = {
    schema: 'openslack.negentropy.evidence.v1' as const,
    observedAt,
    workflow: {
      totalRuns: workflowRuns.length,
      statusCounts: counts(workflowRuns.map((run) => run.status)),
      ...(latest(workflowRuns.map((run) => run.updatedAt)) === undefined
        ? {}
        : { latestUpdatedAt: latest(workflowRuns.map((run) => run.updatedAt)) }),
    },
    prms: {
      totalEvents: prmsEvents.length,
      eventTypeCounts: counts(prmsEvents.map((event) => event.type)),
      ...(latest(prmsEvents.map((event) => event.timestamp)) === undefined
        ? {}
        : { latestEventAt: latest(prmsEvents.map((event) => event.timestamp)) }),
      policy: {
        noAutoApproval: policy.no_auto_approval,
        noSelfReview: policy.no_self_review,
        redZoneHumanRequired: policy.red_zone_human_required,
        blackZoneNeverMerge: policy.black_zone_never_merge,
      },
    },
    profileSync: {
      state: profile.state,
      postsSynced: profile.postsSynced,
      failureCount: profile.failures.length,
      isOutOfDate: profile.isOutOfDate,
      ...(profile.lastSyncDate === undefined ? {} : { lastSyncDate: profile.lastSyncDate }),
      ...(profile.lastSourceSha === undefined ? {} : { lastSourceSha: profile.lastSourceSha }),
    },
    collaboration: {
      totalEvents: events.length,
      eventTypeCounts: counts(events.map((event) => event.type)),
      ...(latest(events.map((event) => event.timestamp)) === undefined
        ? {}
        : { latestEventAt: latest(events.map((event) => event.timestamp)) }),
    },
  };
  return Object.freeze({
    ...withoutHash,
    hash: sha256Canonical(withoutHash),
  });
}
