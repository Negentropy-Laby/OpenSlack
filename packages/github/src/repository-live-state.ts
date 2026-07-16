import type { GitHubClient } from './client.js';
import type { PersistableRepositoryEvent, RepositoryIdentity } from './repository-event.js';

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_PULL_REQUESTS = 20;

export interface RepositoryReviewStateSummary {
  total: number;
  approvedObserved: number;
  changesRequestedObserved: number;
  commentedObserved: number;
  dismissedObserved: number;
  otherObserved: number;
  informational: true;
  authoritativeApproval: false;
}

export interface RepositoryCheckRunSnapshot {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface RepositoryCheckStateSummary {
  total: number;
  pending: number;
  successful: number;
  failed: number;
  neutral: number;
  runs: RepositoryCheckRunSnapshot[];
}

export interface RepositoryPullRequestLiveState {
  pullRequestNumber: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  headSha: string;
  baseSha: string;
  updatedAt: string;
  reviews: RepositoryReviewStateSummary;
  checks: RepositoryCheckStateSummary;
}

export interface RepositoryLiveStateProjection {
  schema: 'openslack.repository_live_state.v1';
  repository: RepositoryIdentity;
  fetchedAt: string;
  triggerHeadSha?: string;
  pullRequests: RepositoryPullRequestLiveState[];
  headChecks?: RepositoryCheckStateSummary;
  authority: {
    humanApproval: 'not_evaluated';
    mergeReadiness: 'not_evaluated';
  };
  informational: true;
}

export interface RepositoryLiveStateOptions {
  now?: () => Date;
  maxPages?: number;
  maxPullRequests?: number;
}

export class RepositoryLiveStateError extends Error {
  readonly code:
    | 'LIVE_STATE_NOT_APPLICABLE'
    | 'LIVE_STATE_NOT_FOUND'
    | 'LIVE_STATE_UNAVAILABLE'
    | 'LIVE_STATE_INCOMPLETE'
    | 'LIVE_STATE_INVALID';
  readonly retryable: boolean;

  constructor(code: RepositoryLiveStateError['code'], retryable: boolean, message: string) {
    super(message);
    this.name = 'RepositoryLiveStateError';
    this.code = code;
    this.retryable = retryable;
  }
}

export async function fetchRepositoryEventLiveState(
  client: GitHubClient,
  event: PersistableRepositoryEvent,
  options: RepositoryLiveStateOptions = {},
): Promise<RepositoryLiveStateProjection> {
  if (event.kind === 'issue' || event.kind === 'push') {
    throw new RepositoryLiveStateError(
      'LIVE_STATE_NOT_APPLICABLE',
      false,
      'Repository live-state refresh applies only to PR, review, and check events.',
    );
  }
  if (client.isDryRun) {
    throw new RepositoryLiveStateError(
      'LIVE_STATE_UNAVAILABLE',
      true,
      'Live GitHub evidence is unavailable in dry-run mode.',
    );
  }
  if (
    client.owner.toLocaleLowerCase('en-US') !== event.repository.owner.toLocaleLowerCase('en-US') ||
    client.repo.toLocaleLowerCase('en-US') !== event.repository.repo.toLocaleLowerCase('en-US')
  ) {
    throw new RepositoryLiveStateError(
      'LIVE_STATE_INVALID',
      false,
      'The live-state client is bound to a different repository.',
    );
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxPullRequests = options.maxPullRequests ?? DEFAULT_MAX_PULL_REQUESTS;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new TypeError('Repository live-state page limit is invalid.');
  }
  if (!Number.isSafeInteger(maxPullRequests) || maxPullRequests < 1 || maxPullRequests > 100) {
    throw new TypeError('Repository live-state pull-request limit is invalid.');
  }

  const pullRequestNumbers = eventPullRequestNumbers(event);
  if (pullRequestNumbers.length > maxPullRequests) {
    throw new RepositoryLiveStateError(
      'LIVE_STATE_INCOMPLETE',
      false,
      'The repository event references too many pull requests for a bounded refresh.',
    );
  }

  const pullRequests: RepositoryPullRequestLiveState[] = [];
  for (const pullRequestNumber of pullRequestNumbers) {
    pullRequests.push(await fetchPullRequestState(client, pullRequestNumber, maxPages));
  }

  const triggerHeadSha = eventHeadSha(event);
  const headChecks =
    pullRequests.length === 0 && triggerHeadSha
      ? summarizeChecks(await listChecks(client, triggerHeadSha, maxPages))
      : undefined;
  return {
    schema: 'openslack.repository_live_state.v1',
    repository: { ...event.repository },
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(triggerHeadSha ? { triggerHeadSha } : {}),
    pullRequests,
    ...(headChecks ? { headChecks } : {}),
    authority: {
      humanApproval: 'not_evaluated',
      mergeReadiness: 'not_evaluated',
    },
    informational: true,
  };
}

async function fetchPullRequestState(
  client: GitHubClient,
  pullRequestNumber: number,
  maxPages: number,
): Promise<RepositoryPullRequestLiveState> {
  try {
    const response = await client.octokit.pulls.get({
      owner: client.owner,
      repo: client.repo,
      pull_number: pullRequestNumber,
    });
    const pullRequest = response.data;
    if (
      !pullRequest ||
      typeof pullRequest.number !== 'number' ||
      typeof pullRequest.title !== 'string' ||
      typeof pullRequest.html_url !== 'string' ||
      typeof pullRequest.state !== 'string' ||
      typeof pullRequest.head?.sha !== 'string' ||
      typeof pullRequest.base?.sha !== 'string' ||
      typeof pullRequest.updated_at !== 'string'
    ) {
      throw new RepositoryLiveStateError(
        'LIVE_STATE_INVALID',
        false,
        'GitHub returned an invalid pull-request live-state response.',
      );
    }
    const [reviews, checks] = await Promise.all([
      listReviews(client, pullRequestNumber, maxPages),
      listChecks(client, pullRequest.head.sha, maxPages),
    ]);
    return {
      pullRequestNumber,
      title: pullRequest.title,
      url: pullRequest.html_url,
      state: pullRequest.state,
      draft: pullRequest.draft ?? false,
      merged: pullRequest.merged ?? false,
      headSha: pullRequest.head.sha,
      baseSha: pullRequest.base.sha,
      updatedAt: pullRequest.updated_at,
      reviews: summarizeReviews(reviews),
      checks: summarizeChecks(checks),
    };
  } catch (error) {
    if (error instanceof RepositoryLiveStateError) throw error;
    throw mapLiveStateError(error);
  }
}

async function listReviews(
  client: GitHubClient,
  pullRequestNumber: number,
  maxPages: number,
): Promise<Array<{ state: string }>> {
  const reviews: Array<{ state: string }> = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let data: Array<{ state: string }>;
    try {
      const response = await client.octokit.pulls.listReviews({
        owner: client.owner,
        repo: client.repo,
        pull_number: pullRequestNumber,
        per_page: PAGE_SIZE,
        page,
      });
      data = response.data.map((review) => ({ state: String(review.state) }));
    } catch (error) {
      throw mapLiveStateError(error);
    }
    reviews.push(...data);
    if (data.length < PAGE_SIZE) return reviews;
  }
  throw new RepositoryLiveStateError(
    'LIVE_STATE_INCOMPLETE',
    true,
    'GitHub review pagination exceeded the bounded evidence limit.',
  );
}

async function listChecks(
  client: GitHubClient,
  headSha: string,
  maxPages: number,
): Promise<RepositoryCheckRunSnapshot[]> {
  const checks: RepositoryCheckRunSnapshot[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let runs: RepositoryCheckRunSnapshot[];
    try {
      const response = await client.octokit.checks.listForRef({
        owner: client.owner,
        repo: client.repo,
        ref: headSha,
        per_page: PAGE_SIZE,
        page,
      });
      runs = response.data.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url ?? '',
      }));
    } catch (error) {
      throw mapLiveStateError(error);
    }
    checks.push(...runs);
    if (runs.length < PAGE_SIZE) return checks;
  }
  throw new RepositoryLiveStateError(
    'LIVE_STATE_INCOMPLETE',
    true,
    'GitHub check pagination exceeded the bounded evidence limit.',
  );
}

function summarizeReviews(reviews: Array<{ state: string }>): RepositoryReviewStateSummary {
  const summary: RepositoryReviewStateSummary = {
    total: reviews.length,
    approvedObserved: 0,
    changesRequestedObserved: 0,
    commentedObserved: 0,
    dismissedObserved: 0,
    otherObserved: 0,
    informational: true,
    authoritativeApproval: false,
  };
  for (const review of reviews) {
    switch (review.state.toLocaleLowerCase('en-US')) {
      case 'approved':
        summary.approvedObserved += 1;
        break;
      case 'changes_requested':
        summary.changesRequestedObserved += 1;
        break;
      case 'commented':
        summary.commentedObserved += 1;
        break;
      case 'dismissed':
        summary.dismissedObserved += 1;
        break;
      default:
        summary.otherObserved += 1;
    }
  }
  return summary;
}

function summarizeChecks(checks: RepositoryCheckRunSnapshot[]): RepositoryCheckStateSummary {
  const summary: RepositoryCheckStateSummary = {
    total: checks.length,
    pending: 0,
    successful: 0,
    failed: 0,
    neutral: 0,
    runs: checks.map((check) => ({ ...check })),
  };
  for (const check of checks) {
    if (check.status !== 'completed' || check.conclusion === null) {
      summary.pending += 1;
      continue;
    }
    if (check.conclusion === 'success') {
      summary.successful += 1;
      continue;
    }
    if (
      check.conclusion === 'failure' ||
      check.conclusion === 'cancelled' ||
      check.conclusion === 'timed_out' ||
      check.conclusion === 'action_required' ||
      check.conclusion === 'startup_failure' ||
      check.conclusion === 'stale'
    ) {
      summary.failed += 1;
      continue;
    }
    summary.neutral += 1;
  }
  return summary;
}

function eventPullRequestNumbers(event: PersistableRepositoryEvent): number[] {
  let values: number[];
  switch (event.kind) {
    case 'pull_request':
    case 'pull_request_review':
      values = [event.pullRequestNumber];
      break;
    case 'check_run':
    case 'check_suite':
      values = event.pullRequestNumbers;
      break;
    case 'issue':
    case 'push':
      values = [];
      break;
  }
  return [...new Set(values)]
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

function eventHeadSha(event: PersistableRepositoryEvent): string | undefined {
  switch (event.kind) {
    case 'pull_request':
    case 'pull_request_review':
    case 'check_run':
    case 'check_suite':
      return event.headSha;
    case 'issue':
    case 'push':
      return undefined;
  }
}

function mapLiveStateError(error: unknown): RepositoryLiveStateError {
  const status = errorStatus(error);
  if (status === 404) {
    return new RepositoryLiveStateError(
      'LIVE_STATE_NOT_FOUND',
      false,
      'The referenced pull request or check state was not found.',
    );
  }
  const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  return new RepositoryLiveStateError(
    'LIVE_STATE_UNAVAILABLE',
    retryable,
    'GitHub live-state evidence could not be refreshed safely.',
  );
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
