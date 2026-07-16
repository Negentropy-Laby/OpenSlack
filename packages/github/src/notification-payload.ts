import type { NormalizedIssueEvent } from './issue-normalizer.js';
import {
  githubWebhookEventKey,
  repositoryEventStableKey,
  type GitHubWatchEventKey,
  type IssueRepositoryEvent,
  type PullRequestRepositoryEvent,
  type PullRequestReviewRepositoryEvent,
  type PersistableRepositoryEvent,
  type RepositoryEvent,
} from './repository-event.js';
import type { RepositoryLiveStateProjection } from './repository-live-state.js';

interface NotificationPayloadBase<
  TObjectKind extends 'issue' | 'push' | 'pull_request' | 'review' | 'check',
  TType extends string,
  TEventKey extends GitHubWatchEventKey,
  TInformational extends boolean,
> {
  schema: 'openslack.github_watch_notification.v1';
  type: TType;
  objectKind: TObjectKind;
  eventKey: TEventKey;
  eventStableKey: string;
  repo: string;
  objectId: string;
  title: string;
  url: string;
  nextAction: string;
  informational: TInformational;
  observedAt: string;
}

export interface IssueNotificationPayload extends NotificationPayloadBase<
  'issue',
  'openslack.issue.detected',
  IssueRepositoryEvent['eventKey'],
  false
> {
  issueNumber: number;
  labels: string[];
}

export interface PushNotificationPayload extends NotificationPayloadBase<
  'push',
  'openslack.push.detected',
  'push',
  false
> {
  ref: string;
  after: string;
  commitCount: number;
}

export interface PullRequestNotificationPayload extends NotificationPayloadBase<
  'pull_request',
  'openslack.pull_request.observed',
  PullRequestRepositoryEvent['eventKey'],
  true
> {
  pullRequestNumber: number;
  action: string;
  headSha: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  liveState?: RepositoryLiveStateProjection;
}

export interface ReviewNotificationPayload extends NotificationPayloadBase<
  'review',
  'openslack.pull_request_review.observed',
  PullRequestReviewRepositoryEvent['eventKey'],
  true
> {
  pullRequestNumber: number;
  reviewId: number;
  reviewState: string;
  reviewerLogin: string;
  headSha: string;
  liveState?: RepositoryLiveStateProjection;
}

export interface CheckNotificationPayload extends NotificationPayloadBase<
  'check',
  'openslack.check.observed',
  'check_run.completed' | 'check_suite.completed',
  true
> {
  checkKind: 'run' | 'suite';
  checkId: number;
  checkName: string;
  conclusion: string | null;
  headSha: string;
  pullRequestNumbers: number[];
  liveState?: RepositoryLiveStateProjection;
}

export type NotificationPayload =
  | IssueNotificationPayload
  | PushNotificationPayload
  | PullRequestNotificationPayload
  | ReviewNotificationPayload
  | CheckNotificationPayload;

export function createNotificationPayload(event: NormalizedIssueEvent): IssueNotificationPayload;
export function createNotificationPayload(event: RepositoryEvent): NotificationPayload;
export function createNotificationPayload(
  event: RepositoryEvent | NormalizedIssueEvent,
): NotificationPayload {
  if (!('kind' in event)) return createLegacyIssueNotificationPayload(event);

  const common = {
    schema: 'openslack.github_watch_notification.v1' as const,
    eventStableKey: repositoryEventStableKey(event),
    repo: event.repository.fullName,
    objectId: event.object.id,
    observedAt: event.observedAt,
  };

  switch (event.kind) {
    case 'issue':
      return {
        ...common,
        type: 'openslack.issue.detected',
        objectKind: 'issue',
        eventKey: event.eventKey,
        issueNumber: event.issueNumber,
        title: event.title,
        url: event.url,
        labels: [...event.labels],
        informational: event.metadata.informational,
        nextAction: 'openslack agent tick --agent-id <id> --source github-issues',
      };
    case 'push':
      return {
        ...common,
        type: 'openslack.push.detected',
        objectKind: 'push',
        eventKey: event.eventKey,
        title: `Push to ${event.ref}`,
        url: `https://github.com/${event.repository.fullName}/commit/${event.after}`,
        informational: event.metadata.informational,
        nextAction: 'openslack collaboration activity',
        ref: event.ref,
        after: event.after,
        commitCount: event.commits.length,
      };
    case 'pull_request':
      return {
        ...common,
        type: 'openslack.pull_request.observed',
        objectKind: 'pull_request',
        eventKey: event.eventKey,
        title: event.title,
        url: event.url,
        informational: event.metadata.informational,
        nextAction: `openslack pr doctor ${event.pullRequestNumber} --repo ${event.repository.fullName}`,
        pullRequestNumber: event.pullRequestNumber,
        action: event.action,
        headSha: event.headSha,
        state: event.state,
        draft: event.draft,
        merged: event.merged,
      };
    case 'pull_request_review':
      return {
        ...common,
        type: 'openslack.pull_request_review.observed',
        objectKind: 'review',
        eventKey: event.eventKey,
        title: event.pullRequestTitle,
        url: event.reviewUrl || event.pullRequestUrl,
        nextAction: `openslack pr doctor ${event.pullRequestNumber} --repo ${event.repository.fullName}`,
        informational: true,
        pullRequestNumber: event.pullRequestNumber,
        reviewId: event.reviewId,
        reviewState: event.reviewState,
        reviewerLogin: event.reviewerLogin,
        headSha: event.headSha,
      };
    case 'check_run':
      return {
        ...common,
        type: 'openslack.check.observed',
        objectKind: 'check',
        eventKey: event.eventKey,
        title: event.name,
        url: event.url,
        informational: event.metadata.informational,
        nextAction: checkNextAction(event.repository.fullName, event.pullRequestNumbers),
        checkKind: 'run',
        checkId: event.checkRunId,
        checkName: event.name,
        conclusion: event.conclusion,
        headSha: event.headSha,
        pullRequestNumbers: [...event.pullRequestNumbers],
      };
    case 'check_suite':
      return {
        ...common,
        type: 'openslack.check.observed',
        objectKind: 'check',
        eventKey: event.eventKey,
        title: 'Check suite completed',
        url: `https://github.com/${event.repository.fullName}/commit/${event.headSha}/checks`,
        informational: event.metadata.informational,
        nextAction: checkNextAction(event.repository.fullName, event.pullRequestNumbers),
        checkKind: 'suite',
        checkId: event.checkSuiteId,
        checkName: 'check suite',
        conclusion: event.conclusion,
        headSha: event.headSha,
        pullRequestNumbers: [...event.pullRequestNumbers],
      };
  }
}

export function createPersistedNotificationPayload(
  event: PersistableRepositoryEvent,
  liveState?: RepositoryLiveStateProjection,
): NotificationPayload {
  const common = {
    schema: 'openslack.github_watch_notification.v1' as const,
    eventStableKey: event.stableKey,
    repo: event.repository.fullName,
    objectId: event.object.id,
    observedAt: event.observedAt,
  };
  const pullRequest = liveState?.pullRequests.find(
    (candidate) => candidate.pullRequestNumber === event.object.number,
  );

  switch (event.kind) {
    case 'issue':
      return {
        ...common,
        type: 'openslack.issue.detected',
        objectKind: 'issue',
        eventKey: event.eventKey,
        issueNumber: event.issueNumber,
        title: `Issue #${event.issueNumber} observed`,
        url: `https://github.com/${event.repository.fullName}/issues/${event.issueNumber}`,
        labels: [],
        informational: false,
        nextAction: 'openslack agent tick --agent-id <id> --source github-issues',
      };
    case 'push':
      return {
        ...common,
        type: 'openslack.push.detected',
        objectKind: 'push',
        eventKey: event.eventKey,
        title: `Push to ${event.ref}`,
        url: `https://github.com/${event.repository.fullName}/commit/${event.after}`,
        informational: false,
        nextAction: 'openslack collaboration activity',
        ref: event.ref,
        after: event.after,
        commitCount: 0,
      };
    case 'pull_request':
      return {
        ...common,
        type: 'openslack.pull_request.observed',
        objectKind: 'pull_request',
        eventKey: event.eventKey,
        title: pullRequest?.title ?? `Pull request #${event.pullRequestNumber}`,
        url:
          pullRequest?.url ??
          `https://github.com/${event.repository.fullName}/pull/${event.pullRequestNumber}`,
        informational: true,
        nextAction: `openslack pr doctor ${event.pullRequestNumber} --repo ${event.repository.fullName}`,
        pullRequestNumber: event.pullRequestNumber,
        action: event.action,
        headSha: pullRequest?.headSha ?? event.headSha,
        state: normalizePullRequestState(pullRequest?.state),
        draft: pullRequest?.draft ?? false,
        merged: pullRequest?.merged ?? false,
        ...(liveState ? { liveState } : {}),
      };
    case 'pull_request_review':
      return {
        ...common,
        type: 'openslack.pull_request_review.observed',
        objectKind: 'review',
        eventKey: event.eventKey,
        title: pullRequest?.title ?? `Pull request #${event.pullRequestNumber}`,
        url:
          pullRequest?.url ??
          `https://github.com/${event.repository.fullName}/pull/${event.pullRequestNumber}`,
        informational: true,
        nextAction: `openslack pr doctor ${event.pullRequestNumber} --repo ${event.repository.fullName}`,
        pullRequestNumber: event.pullRequestNumber,
        reviewId: event.reviewId,
        reviewState: 'observed',
        reviewerLogin: 'GitHub',
        headSha: pullRequest?.headSha ?? event.headSha,
        ...(liveState ? { liveState } : {}),
      };
    case 'check_run': {
      const check = findCheckRun(liveState, event.checkRunId);
      return {
        ...common,
        type: 'openslack.check.observed',
        objectKind: 'check',
        eventKey: event.eventKey,
        title: check?.name ?? 'Check run completed',
        url:
          check?.url ||
          `https://github.com/${event.repository.fullName}/commit/${event.headSha}/checks`,
        informational: true,
        nextAction: checkNextAction(event.repository.fullName, event.pullRequestNumbers),
        checkKind: 'run',
        checkId: event.checkRunId,
        checkName: check?.name ?? 'check run',
        conclusion: check?.conclusion ?? null,
        headSha: pullRequest?.headSha ?? event.headSha,
        pullRequestNumbers: [...event.pullRequestNumbers],
        ...(liveState ? { liveState } : {}),
      };
    }
    case 'check_suite':
      return {
        ...common,
        type: 'openslack.check.observed',
        objectKind: 'check',
        eventKey: event.eventKey,
        title: 'Check suite completed',
        url: `https://github.com/${event.repository.fullName}/commit/${event.headSha}/checks`,
        informational: true,
        nextAction: checkNextAction(event.repository.fullName, event.pullRequestNumbers),
        checkKind: 'suite',
        checkId: event.checkSuiteId,
        checkName: 'check suite',
        conclusion: summarizeSuiteConclusion(liveState),
        headSha: pullRequest?.headSha ?? event.headSha,
        pullRequestNumbers: [...event.pullRequestNumbers],
        ...(liveState ? { liveState } : {}),
      };
  }
}

export function attachRepositoryLiveState(
  payload: NotificationPayload,
  liveState: RepositoryLiveStateProjection,
): NotificationPayload {
  if (payload.repo.toLocaleLowerCase('en-US') !== liveState.repository.canonicalFullName) {
    throw new TypeError('Notification and repository live-state identities do not match.');
  }
  if (payload.objectKind === 'issue' || payload.objectKind === 'push') return payload;

  const pullRequest =
    payload.objectKind === 'pull_request' || payload.objectKind === 'review'
      ? liveState.pullRequests.find(
          (candidate) => candidate.pullRequestNumber === payload.pullRequestNumber,
        )
      : liveState.pullRequests[0];
  switch (payload.objectKind) {
    case 'pull_request':
      return {
        ...payload,
        ...(pullRequest
          ? {
              title: pullRequest.title,
              url: pullRequest.url,
              headSha: pullRequest.headSha,
              state: normalizePullRequestState(pullRequest.state),
              draft: pullRequest.draft,
              merged: pullRequest.merged,
            }
          : {}),
        informational: true,
        liveState,
      };
    case 'review':
      return {
        ...payload,
        ...(pullRequest
          ? {
              title: pullRequest.title,
              url: pullRequest.url,
              headSha: pullRequest.headSha,
            }
          : {}),
        informational: true,
        liveState,
      };
    case 'check': {
      const check =
        payload.checkKind === 'run' ? findCheckRun(liveState, payload.checkId) : undefined;
      return {
        ...payload,
        ...(check
          ? {
              title: check.name,
              url: check.url || payload.url,
              checkName: check.name,
              conclusion: check.conclusion,
            }
          : {}),
        ...(pullRequest ? { headSha: pullRequest.headSha } : {}),
        informational: true,
        liveState,
      };
    }
  }
}

function createLegacyIssueNotificationPayload(
  event: NormalizedIssueEvent,
): IssueNotificationPayload {
  const eventKey = githubWebhookEventKey('issues', event.action);
  if (!eventKey || !eventKey.startsWith('issues.')) {
    throw new TypeError(`Unsupported issue action: ${event.action}`);
  }
  const repo = `${event.owner}/${event.repo}`;
  return {
    schema: 'openslack.github_watch_notification.v1',
    type: 'openslack.issue.detected',
    objectKind: 'issue',
    eventKey: eventKey as IssueRepositoryEvent['eventKey'],
    eventStableKey: `github:${eventKey}:${repo.toLocaleLowerCase('en-US')}:issue:${event.issueNumber}:${event.updatedAt}`,
    repo,
    objectId: `${repo.toLocaleLowerCase('en-US')}#${event.issueNumber}`,
    title: event.title,
    url: event.url,
    nextAction: 'openslack agent tick --agent-id <id> --source github-issues',
    informational: false,
    observedAt: event.updatedAt,
    issueNumber: event.issueNumber,
    labels: [...event.labels],
  };
}

function checkNextAction(repo: string, pullRequestNumbers: number[]): string {
  const number = pullRequestNumbers[0];
  return number === undefined
    ? 'openslack pr queue'
    : `openslack pr doctor ${number} --repo ${repo}`;
}

export function formatNotification(payload: NotificationPayload): string {
  const prefix = `[GitHub Watch] ${payload.repo}`;
  switch (payload.objectKind) {
    case 'issue':
      return [
        `${prefix}#${payload.issueNumber}: ${payload.title}`,
        payload.url,
        `Labels: ${payload.labels.join(', ') || '(none)'}`,
        `Next: ${payload.nextAction}`,
      ].join('\n');
    case 'push':
      return [
        `${prefix}: ${payload.title} (${payload.commitCount} relevant commit(s))`,
        payload.url,
        `Next: ${payload.nextAction}`,
      ].join('\n');
    case 'pull_request':
      return [
        `${prefix}#${payload.pullRequestNumber}: PR ${payload.action} — ${payload.title}`,
        formatLiveState(payload.liveState),
        payload.url,
        `Next: ${payload.nextAction}`,
      ]
        .filter(Boolean)
        .join('\n');
    case 'review':
      return [
        `${prefix}#${payload.pullRequestNumber}: review ${payload.eventKey.split('.').at(-1)} by ${payload.reviewerLogin}`,
        `${payload.reviewState} (informational only)`,
        formatLiveState(payload.liveState),
        payload.url,
        `Next: ${payload.nextAction}`,
      ]
        .filter(Boolean)
        .join('\n');
    case 'check':
      return [
        `${prefix}: ${payload.checkName} completed — ${payload.conclusion ?? 'no conclusion'}`,
        formatLiveState(payload.liveState),
        payload.url,
        `Next: ${payload.nextAction}`,
      ]
        .filter(Boolean)
        .join('\n');
  }
}

function normalizePullRequestState(
  state: string | undefined,
): PullRequestNotificationPayload['state'] {
  return state?.toLocaleLowerCase('en-US') === 'closed' ? 'closed' : 'open';
}

function findCheckRun(liveState: RepositoryLiveStateProjection | undefined, checkId: number) {
  if (!liveState) return undefined;
  for (const pullRequest of liveState.pullRequests) {
    const match = pullRequest.checks.runs.find((run) => run.id === checkId);
    if (match) return match;
  }
  return liveState.headChecks?.runs.find((run) => run.id === checkId);
}

function summarizeSuiteConclusion(
  liveState: RepositoryLiveStateProjection | undefined,
): string | null {
  const summaries = liveState
    ? [
        ...liveState.pullRequests.map((pullRequest) => pullRequest.checks),
        ...(liveState.headChecks ? [liveState.headChecks] : []),
      ]
    : [];
  if (summaries.some((summary) => summary.failed > 0)) return 'failure';
  if (summaries.some((summary) => summary.pending > 0)) return null;
  if (summaries.some((summary) => summary.successful > 0)) return 'success';
  return null;
}

function formatLiveState(liveState: RepositoryLiveStateProjection | undefined): string {
  if (!liveState) return '';
  const pullRequest = liveState.pullRequests[0];
  if (!pullRequest) {
    const checks = liveState.headChecks;
    return checks
      ? `Live checks: ${checks.successful} successful, ${checks.failed} failed, ${checks.pending} pending; approval and merge readiness not evaluated`
      : 'Live state refreshed; approval and merge readiness not evaluated';
  }
  return `Live PR: ${pullRequest.state}, ${pullRequest.checks.successful} checks successful, ${pullRequest.checks.failed} failed, ${pullRequest.checks.pending} pending, ${pullRequest.reviews.total} review observations; approval and merge readiness not evaluated`;
}
