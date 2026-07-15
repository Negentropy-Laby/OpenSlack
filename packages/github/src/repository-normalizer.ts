import { normalizeIssueEvent } from './issue-normalizer.js';
import { normalizePushEvent } from './push-normalizer.js';
import {
  githubWebhookEventKey,
  repositoryIdentityFromPayload,
  type CheckRunRepositoryEvent,
  type CheckSuiteRepositoryEvent,
  type PullRequestAction,
  type PullRequestRepositoryEvent,
  type PullRequestReviewAction,
  type PullRequestReviewRepositoryEvent,
  type RepositoryEvent,
} from './repository-event.js';

type WebhookHeaders = Record<string, string | undefined>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredTimestamp(value: unknown): string | null {
  const timestamp = requiredString(value);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function requiredPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requiredBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' && value.length > 0 ? value : undefined;
}

function senderLogin(payload: Record<string, unknown>): string {
  const sender = asRecord(payload.sender);
  return typeof sender?.login === 'string' ? sender.login : '';
}

function pullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers = value
    .map((entry) => requiredPositiveInteger(asRecord(entry)?.number))
    .filter((number): number is number => number !== null);
  return [...new Set(numbers)].sort((left, right) => left - right);
}

export function normalizePullRequestEvent(
  payload: unknown,
  headers: WebhookHeaders,
): PullRequestRepositoryEvent | null {
  const root = asRecord(payload);
  if (!root) return null;

  const action = requiredString(root.action) as PullRequestAction | null;
  const eventKey = githubWebhookEventKey('pull_request', action ?? undefined);
  if (!action || !eventKey || !eventKey.startsWith('pull_request.')) return null;

  const repository = repositoryIdentityFromPayload(root);
  const pullRequest = asRecord(root.pull_request);
  const head = asRecord(pullRequest?.head);
  const base = asRecord(pullRequest?.base);
  const author = asRecord(pullRequest?.user);
  if (!repository || !pullRequest || !head || !base || !author) return null;

  const pullRequestNumber = requiredPositiveInteger(pullRequest.number);
  const title = requiredString(pullRequest.title);
  const url = requiredString(pullRequest.html_url);
  const state =
    pullRequest.state === 'open' || pullRequest.state === 'closed' ? pullRequest.state : null;
  const draft = requiredBoolean(pullRequest.draft);
  const merged = requiredBoolean(pullRequest.merged);
  const headSha = requiredString(head.sha);
  const baseSha = requiredString(base.sha);
  const authorLogin = requiredString(author.login);
  const updatedAt = requiredTimestamp(pullRequest.updated_at);
  if (
    pullRequestNumber === null ||
    !title ||
    !url ||
    !state ||
    draft === null ||
    merged === null ||
    !headSha ||
    !baseSha ||
    !authorLogin ||
    !updatedAt
  )
    return null;

  const actorLogin = senderLogin(root);
  return {
    kind: 'pull_request',
    eventKey: eventKey as PullRequestRepositoryEvent['eventKey'],
    action,
    repository,
    object: {
      kind: 'pull_request',
      id: `${repository.canonicalFullName}#${pullRequestNumber}`,
      number: pullRequestNumber,
    },
    source: 'webhook',
    deliveryId: headers['x-github-delivery'] ?? '',
    observedAt: updatedAt,
    metadata: { informational: true, senderLogin: actorLogin },
    pullRequestNumber,
    title,
    url,
    state,
    draft,
    merged,
    headSha,
    baseSha,
    authorLogin,
    updatedAt,
  };
}

export function normalizePullRequestReviewEvent(
  payload: unknown,
  headers: WebhookHeaders,
): PullRequestReviewRepositoryEvent | null {
  const root = asRecord(payload);
  if (!root) return null;

  const action = requiredString(root.action) as PullRequestReviewAction | null;
  const eventKey = githubWebhookEventKey('pull_request_review', action ?? undefined);
  if (!action || !eventKey || !eventKey.startsWith('pull_request_review.')) return null;

  const repository = repositoryIdentityFromPayload(root);
  const pullRequest = asRecord(root.pull_request);
  const head = asRecord(pullRequest?.head);
  const review = asRecord(root.review);
  const reviewer = asRecord(review?.user);
  if (!repository || !pullRequest || !head || !review || !reviewer) return null;

  const pullRequestNumber = requiredPositiveInteger(pullRequest.number);
  const pullRequestTitle = requiredString(pullRequest.title);
  const pullRequestUrl = requiredString(pullRequest.html_url);
  const headSha = requiredString(head.sha);
  const reviewId = requiredPositiveInteger(review.id);
  const reviewState = requiredString(review.state);
  const reviewUrl = requiredString(review.html_url);
  const reviewerLogin = requiredString(reviewer.login);
  const commitId = requiredString(review.commit_id);
  const submittedAt = requiredTimestamp(review.submitted_at);
  if (
    pullRequestNumber === null ||
    !pullRequestTitle ||
    !pullRequestUrl ||
    !headSha ||
    reviewId === null ||
    !reviewState ||
    !reviewUrl ||
    !reviewerLogin ||
    !commitId ||
    !submittedAt
  )
    return null;

  return {
    kind: 'pull_request_review',
    eventKey: eventKey as PullRequestReviewRepositoryEvent['eventKey'],
    action,
    repository,
    object: {
      kind: 'pull_request_review',
      id: `${repository.canonicalFullName}#${pullRequestNumber}:review:${reviewId}`,
      number: pullRequestNumber,
    },
    source: 'webhook',
    deliveryId: headers['x-github-delivery'] ?? '',
    observedAt: submittedAt,
    metadata: { informational: true, senderLogin: senderLogin(root) },
    pullRequestNumber,
    pullRequestTitle,
    pullRequestUrl,
    headSha,
    reviewId,
    reviewState,
    reviewUrl,
    reviewerLogin,
    commitId,
    submittedAt,
  };
}

export function normalizeCheckRunEvent(
  payload: unknown,
  headers: WebhookHeaders,
): CheckRunRepositoryEvent | null {
  const root = asRecord(payload);
  if (
    !root ||
    githubWebhookEventKey('check_run', requiredString(root.action) ?? undefined) !==
      'check_run.completed'
  ) {
    return null;
  }

  const repository = repositoryIdentityFromPayload(root);
  const checkRun = asRecord(root.check_run);
  if (!repository || !checkRun || checkRun.status !== 'completed') return null;

  const checkRunId = requiredPositiveInteger(checkRun.id);
  const name = requiredString(checkRun.name);
  const url = requiredString(checkRun.html_url);
  const conclusion = nullableString(checkRun.conclusion);
  const headSha = requiredString(checkRun.head_sha);
  const completedAt = requiredTimestamp(checkRun.completed_at);
  if (checkRunId === null || !name || !url || conclusion === undefined || !headSha || !completedAt)
    return null;

  return {
    kind: 'check_run',
    eventKey: 'check_run.completed',
    action: 'completed',
    repository,
    object: {
      kind: 'check_run',
      id: `${repository.canonicalFullName}:check-run:${checkRunId}`,
    },
    source: 'webhook',
    deliveryId: headers['x-github-delivery'] ?? '',
    observedAt: completedAt,
    metadata: { informational: true, senderLogin: senderLogin(root) },
    checkRunId,
    name,
    url,
    status: 'completed',
    conclusion,
    headSha,
    completedAt,
    pullRequestNumbers: pullRequestNumbers(checkRun.pull_requests),
  };
}

export function normalizeCheckSuiteEvent(
  payload: unknown,
  headers: WebhookHeaders,
): CheckSuiteRepositoryEvent | null {
  const root = asRecord(payload);
  if (
    !root ||
    githubWebhookEventKey('check_suite', requiredString(root.action) ?? undefined) !==
      'check_suite.completed'
  ) {
    return null;
  }

  const repository = repositoryIdentityFromPayload(root);
  const checkSuite = asRecord(root.check_suite);
  if (!repository || !checkSuite || checkSuite.status !== 'completed') return null;

  const checkSuiteId = requiredPositiveInteger(checkSuite.id);
  const conclusion = nullableString(checkSuite.conclusion);
  const headSha = requiredString(checkSuite.head_sha);
  const headBranch = nullableString(checkSuite.head_branch);
  const updatedAt = requiredTimestamp(checkSuite.updated_at);
  if (
    checkSuiteId === null ||
    conclusion === undefined ||
    headBranch === undefined ||
    !headSha ||
    !updatedAt
  )
    return null;

  return {
    kind: 'check_suite',
    eventKey: 'check_suite.completed',
    action: 'completed',
    repository,
    object: {
      kind: 'check_suite',
      id: `${repository.canonicalFullName}:check-suite:${checkSuiteId}`,
    },
    source: 'webhook',
    deliveryId: headers['x-github-delivery'] ?? '',
    observedAt: updatedAt,
    metadata: { informational: true, senderLogin: senderLogin(root) },
    checkSuiteId,
    status: 'completed',
    conclusion,
    headSha,
    headBranch,
    updatedAt,
    pullRequestNumbers: pullRequestNumbers(checkSuite.pull_requests),
  };
}

export function normalizeRepositoryEvent(
  eventName: string | undefined,
  payload: unknown,
  headers: WebhookHeaders,
): RepositoryEvent | null {
  const root = asRecord(payload);
  const action = typeof root?.action === 'string' ? root.action : undefined;
  const eventKey = githubWebhookEventKey(eventName, action);
  if (!eventKey) return null;

  let event: RepositoryEvent | null;
  switch (eventName) {
    case 'issues':
      event = normalizeIssueEvent(payload, headers);
      break;
    case 'push':
      event = normalizePushEvent(payload, headers);
      break;
    case 'pull_request':
      event = normalizePullRequestEvent(payload, headers);
      break;
    case 'pull_request_review':
      event = normalizePullRequestReviewEvent(payload, headers);
      break;
    case 'check_run':
      event = normalizeCheckRunEvent(payload, headers);
      break;
    case 'check_suite':
      event = normalizeCheckSuiteEvent(payload, headers);
      break;
    default:
      return null;
  }

  return event;
}
