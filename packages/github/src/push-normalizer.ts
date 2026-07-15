import type { GitHubWatchRepo } from './watch-config.js';
import {
  repositoriesMatch,
  repositoryIdentityFromPayload,
  type PushRepositoryEvent,
} from './repository-event.js';

export interface NormalizedPushEvent {
  ref: string;
  owner: string;
  repo: string;
  before: string;
  after: string;
  pusher: string;
  commits: Array<{
    id: string;
    message: string;
    added: string[];
    modified: string[];
    removed: string[];
    timestamp: string;
  }>;
  deliveryId: string;
}

export type NormalizedPushRepositoryEvent = NormalizedPushEvent & PushRepositoryEvent;

export function normalizePushEvent(
  payload: unknown,
  headers: Record<string, string | undefined>,
): NormalizedPushRepositoryEvent | null {
  if (!payload || typeof payload !== 'object') return null;

  const p = payload as Record<string, unknown>;
  const repo = p.repository;

  if (!repo || typeof repo !== 'object') return null;

  const ref = typeof p.ref === 'string' ? p.ref : '';
  if (!ref.startsWith('refs/heads/')) return null;

  const repository = repositoryIdentityFromPayload(p);
  if (!repository) return null;
  const ownerLogin = repository.owner;
  const repoName = repository.repo;

  const before = typeof p.before === 'string' ? p.before : '';
  const after = typeof p.after === 'string' ? p.after : '';
  if (!before || !after) return null;

  const pusherObj =
    p.pusher && typeof p.pusher === 'object'
      ? (p.pusher as Record<string, unknown>).name
      : undefined;
  const pusherName = typeof pusherObj === 'string' ? pusherObj : '';

  const commits: NormalizedPushEvent['commits'] = [];
  if (Array.isArray(p.commits)) {
    for (const commit of p.commits) {
      if (!commit || typeof commit !== 'object') continue;
      const c = commit as Record<string, unknown>;
      const id = typeof c.id === 'string' ? c.id : '';
      const message = typeof c.message === 'string' ? c.message : '';
      const timestamp =
        typeof c.timestamp === 'string' && Number.isFinite(Date.parse(c.timestamp))
          ? c.timestamp
          : '';
      if (!id || !timestamp) continue;

      const added: string[] = Array.isArray(c.added)
        ? c.added.filter((s): s is string => typeof s === 'string')
        : [];
      const modified: string[] = Array.isArray(c.modified)
        ? c.modified.filter((s): s is string => typeof s === 'string')
        : [];
      const removed: string[] = Array.isArray(c.removed)
        ? c.removed.filter((s): s is string => typeof s === 'string')
        : [];

      commits.push({ id, message, added, modified, removed, timestamp });
    }
  }

  const deliveryId = headers['x-github-delivery'] ?? '';

  // Filter to only commits that touch posts/ directory
  const relevantCommits = commits.filter((c) =>
    [...c.added, ...c.modified, ...c.removed].some((path) => path.startsWith('posts/')),
  );

  if (relevantCommits.length === 0) return null;

  return {
    kind: 'push',
    eventKey: 'push',
    action: 'push',
    repository,
    object: {
      kind: 'push',
      id: `${repository.canonicalFullName}@${after}`,
    },
    source: 'webhook',
    observedAt: relevantCommits[relevantCommits.length - 1]!.timestamp,
    metadata: { informational: false, senderLogin: pusherName },
    ref,
    owner: ownerLogin,
    repo: repoName,
    before,
    after,
    pusher: pusherName,
    commits: relevantCommits,
    deliveryId,
  };
}

export function matchesPushRepoConfig(
  event: NormalizedPushEvent,
  repoConfig: GitHubWatchRepo,
): boolean {
  if (!repositoriesMatch(event, repoConfig)) return false;
  if (!repoConfig.events.includes('push')) return false;
  return true;
}
