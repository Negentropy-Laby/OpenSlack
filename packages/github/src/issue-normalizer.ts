import type { GitHubWatchRepo } from './watch-config.js';

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

export function normalizeIssueEvent(
  payload: unknown,
  headers: Record<string, string | undefined>,
): NormalizedIssueEvent | null {
  if (!payload || typeof payload !== 'object') return null;

  const p = payload as Record<string, unknown>;
  const issue = p.issue;
  const repo = p.repository;

  if (!issue || typeof issue !== 'object') return null;
  if (!repo || typeof repo !== 'object') return null;

  const i = issue as Record<string, unknown>;
  const r = repo as Record<string, unknown>;

  const action = typeof p.action === 'string' ? p.action : '';
  if (!['opened', 'reopened', 'labeled', 'unlabeled', 'closed', 'edited'].includes(action)) return null;

  const owner = typeof (r as Record<string, unknown>).owner === 'object'
    ? ((r as Record<string, unknown>).owner as Record<string, unknown>)?.login
    : undefined;
  const ownerLogin = typeof owner === 'string' ? owner : '';
  const repoName = typeof r.name === 'string' ? r.name : '';
  const issueNumber = typeof i.number === 'number' ? i.number : 0;
  const title = typeof i.title === 'string' ? i.title : '';
  const url = typeof i.html_url === 'string' ? i.html_url : '';
  const body = typeof i.body === 'string' ? i.body : '';
  const updatedAt = typeof i.updated_at === 'string' ? i.updated_at : new Date().toISOString();

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

  const sender = p.sender && typeof p.sender === 'object'
    ? (p.sender as Record<string, unknown>).login
    : undefined;
  const senderLogin = typeof sender === 'string' ? sender : '';

  const deliveryId = headers['x-github-delivery'] ?? '';

  return {
    action,
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

export function matchesRepoConfig(event: NormalizedIssueEvent, repoConfig: GitHubWatchRepo): boolean {
  if (event.owner !== repoConfig.owner || event.repo !== repoConfig.repo) return false;

  const eventKey = `issues.${event.action}`;
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
