import { getClient } from './client.js';
import {
  createIssueTaskSnapshot,
  type CanonicalIssueState,
  type IssueTaskSnapshot,
} from './issue-task-snapshot.js';

export interface IssueTask {
  issueNumber: number;
  issueNodeId: string;
  title: string;
  url: string;
  labels: string[];
  body: string;
  state?: CanonicalIssueState;
  updatedAt: string;
  snapshot: IssueTaskSnapshot;
}

export type IssueTaskLookupResult =
  | { status: 'found'; task: IssueTask }
  | { status: 'not_found' }
  | { status: 'pull_request' };

type IssueTaskClientFactory = typeof getClient;

function normalizeIssueState(state: unknown): CanonicalIssueState {
  if (state === 'open' || state === 'closed') return state;
  return 'unknown';
}

function normalizeIssueTask(data: {
  number: number;
  node_id: string;
  title: string;
  html_url: string;
  labels: Array<string | { name?: string | null }>;
  body?: string | null;
  state?: unknown;
  updated_at?: unknown;
}): IssueTask {
  if (typeof data.updated_at !== 'string' || !Number.isFinite(Date.parse(data.updated_at))) {
    throw new Error(`Issue #${data.number} is missing a valid updated_at timestamp.`);
  }
  const labels = data.labels.map((label) => (typeof label === 'string' ? label : label.name || ''));
  const state = normalizeIssueState(data.state);
  const task = {
    issueNumber: data.number,
    issueNodeId: data.node_id,
    title: data.title,
    url: data.html_url,
    labels,
    body: data.body || '',
    state,
    updatedAt: data.updated_at,
  };
  return { ...task, snapshot: createIssueTaskSnapshot(task) };
}

export async function createTaskIssue(
  title: string,
  body: string,
  labels: string[],
): Promise<{ issueNumber: number; url: string; nodeId: string; id?: number }> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would create task issue: "${title}" with labels: ${labels.join(',')}`);
    return { issueNumber: 0, url: '', nodeId: '' };
  }

  const { data } = await client.octokit.issues.create({
    owner: client.owner,
    repo: client.repo,
    title,
    body,
    labels,
  });

  return {
    issueNumber: data.number,
    url: data.html_url,
    nodeId: data.node_id,
    id: data.id,
  };
}

export async function queryReadyIssueTasks(
  options: {
    agentType?: string;
    capabilities?: string[];
    maxRisk?: string;
  } = {},
  getClientFn: IssueTaskClientFactory = getClient,
): Promise<IssueTask[]> {
  const client = await getClientFn();
  if (client.isDryRun) {
    console.log('[DRY RUN] Would query ready issue tasks');
    return [];
  }

  // Search for issues with openslack:task AND openslack:ready labels
  const q = [
    `repo:${client.owner}/${client.repo}`,
    'is:issue',
    'is:open',
    'label:openslack:task',
    'label:openslack:ready',
  ].join(' ');

  const { data } = await client.octokit.search.issuesAndPullRequests({
    q,
    per_page: 20,
    sort: 'created',
    order: 'asc',
  });

  const tasks: IssueTask[] = data.items.map((item) => normalizeIssueTask(item));

  // Local filter: agent type, capabilities, risk level
  return tasks.filter((t) => {
    if (options.agentType && t.labels.includes(`agent-type:${options.agentType}`) === false) {
      // If issue doesn't specify agent type, it matches any
      const hasTypeLabel = t.labels.some((l) => l.startsWith('agent-type:'));
      if (hasTypeLabel) return false;
    }
    if (options.maxRisk) {
      const riskOrder = ['low', 'medium', 'high', 'critical'];
      const taskRisk = t.labels.find((l) => l.startsWith('risk:'))?.replace('risk:', '') || 'low';
      if (riskOrder.indexOf(taskRisk) > riskOrder.indexOf(options.maxRisk)) return false;
    }
    if (options.capabilities?.length) {
      // Not filterable by labels alone — accept all, let agent self-filter
    }
    return true;
  });
}

export async function getIssueTaskByNumber(
  issueNumber: number,
  getClientFn: IssueTaskClientFactory = getClient,
): Promise<IssueTaskLookupResult> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('Issue number must be a positive integer.');
  }

  const client = await getClientFn({ requireLive: true });
  if (client.isDryRun)
    throw new Error('Live GitHub credentials are required for exact Issue lookup.');

  let data;
  try {
    ({ data } = await client.octokit.issues.get({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
    }));
  } catch (error) {
    if ((error as { status?: number }).status === 404) return { status: 'not_found' };
    throw error;
  }

  if (data.pull_request) return { status: 'pull_request' };

  return {
    status: 'found',
    task: normalizeIssueTask(data),
  };
}
