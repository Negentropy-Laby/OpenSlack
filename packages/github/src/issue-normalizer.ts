import type { GitHubWatchRepo } from './watch-config.js';
import {
  githubWebhookEventKey,
  repositoriesMatch,
  repositoryIdentityFromPayload,
  type IssueAction,
  type IssueRepositoryEvent,
} from './repository-event.js';

export interface NormalizedIssueEvent {
  action: string;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  body: string;
  senderLogin: string;
  deliveryId: string;
  updatedAt: string;
}

export type NormalizedIssueRepositoryEvent = NormalizedIssueEvent & IssueRepositoryEvent;

export function normalizeIssueEvent(
  payload: unknown,
  headers: Record<string, string | undefined>,
): NormalizedIssueRepositoryEvent | null {
  if (!payload || typeof payload !== 'object') return null;

  const p = payload as Record<string, unknown>;
  const issue = p.issue;
  const repo = p.repository;

  if (!issue || typeof issue !== 'object') return null;
  if (!repo || typeof repo !== 'object') return null;

  const i = issue as Record<string, unknown>;
  const rawAction = typeof p.action === 'string' ? p.action : '';
  const action = rawAction as IssueAction;
  const eventKey = githubWebhookEventKey('issues', action);
  if (!eventKey || !eventKey.startsWith('issues.')) return null;

  const repository = repositoryIdentityFromPayload(p);
  if (!repository) return null;
  const ownerLogin = repository.owner;
  const repoName = repository.repo;
  const issueNumber =
    typeof i.number === 'number' && Number.isSafeInteger(i.number) && i.number > 0
      ? i.number
      : null;
  const title = typeof i.title === 'string' && i.title.length > 0 ? i.title : null;
  const url = typeof i.html_url === 'string' && i.html_url.length > 0 ? i.html_url : null;
  const body = typeof i.body === 'string' ? i.body : '';
  const updatedAt =
    typeof i.updated_at === 'string' && Number.isFinite(Date.parse(i.updated_at))
      ? i.updated_at
      : null;
  if (issueNumber === null || !title || !url || !updatedAt) return null;

  const labels: string[] = [];
  if (Array.isArray(i.labels)) {
    for (const label of i.labels) {
      if (typeof label === 'object' && label !== null) {
        const name = (label as Record<string, unknown>).name;
        if (typeof name === 'string') labels.push(name);
      } else if (typeof label === 'string') {
        labels.push(label);
      }
    }
  }

  const sender =
    p.sender && typeof p.sender === 'object'
      ? (p.sender as Record<string, unknown>).login
      : undefined;
  const senderLogin = typeof sender === 'string' ? sender : '';

  const deliveryId = headers['x-github-delivery'] ?? '';

  return {
    kind: 'issue',
    eventKey: eventKey as IssueRepositoryEvent['eventKey'],
    action,
    repository,
    object: {
      kind: 'issue',
      id: `${repository.canonicalFullName}#${issueNumber}`,
      number: issueNumber,
    },
    source: 'webhook',
    observedAt: updatedAt,
    metadata: { informational: false, senderLogin },
    owner: ownerLogin,
    repo: repoName,
    issueNumber,
    title,
    url,
    labels,
    body,
    senderLogin,
    deliveryId,
    updatedAt,
  };
}

export function matchesRepoConfig(
  event: NormalizedIssueEvent,
  repoConfig: GitHubWatchRepo,
): boolean {
  if (!repositoriesMatch(event, repoConfig)) return false;

  const eventKey = githubWebhookEventKey('issues', event.action);
  if (!eventKey) return false;
  if (!repoConfig.events.includes(eventKey)) return false;

  if (repoConfig.labels) {
    const { include, exclude } = repoConfig.labels;
    if (include && include.length > 0) {
      const hasAny = include.some((label) => event.labels.includes(label));
      if (!hasAny) return false;
    }
    if (exclude && exclude.length > 0) {
      const hasExcluded = exclude.some((label) => event.labels.includes(label));
      if (hasExcluded) return false;
    }
  }

  return true;
}
