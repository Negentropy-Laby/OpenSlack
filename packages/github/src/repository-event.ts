export const GITHUB_WATCH_EVENT_KEYS = [
  'issues.opened',
  'issues.reopened',
  'issues.labeled',
  'push',
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
  'pull_request.closed',
  'pull_request.ready_for_review',
  'pull_request_review.submitted',
  'pull_request_review.dismissed',
  'check_run.completed',
  'check_suite.completed',
] as const;

export type GitHubWatchEventKey = (typeof GITHUB_WATCH_EVENT_KEYS)[number];

export const GITHUB_WEBHOOK_EVENT_NAMES = [
  'issues',
  'push',
  'pull_request',
  'pull_request_review',
  'check_run',
  'check_suite',
] as const;

export type GitHubWebhookEventName = (typeof GITHUB_WEBHOOK_EVENT_NAMES)[number];

export type IssueAction = 'opened' | 'reopened' | 'labeled';
export type PullRequestAction =
  | 'opened'
  | 'synchronize'
  | 'reopened'
  | 'closed'
  | 'ready_for_review';
export type PullRequestReviewAction = 'submitted' | 'dismissed';
export type CheckAction = 'completed';

const EVENT_KEY_SET: ReadonlySet<string> = new Set(GITHUB_WATCH_EVENT_KEYS);
const WEBHOOK_EVENT_NAME_SET: ReadonlySet<string> = new Set(GITHUB_WEBHOOK_EVENT_NAMES);

const WEBHOOK_ACTION_EVENT_KEYS = {
  issues: {
    opened: 'issues.opened',
    reopened: 'issues.reopened',
    labeled: 'issues.labeled',
  },
  pull_request: {
    opened: 'pull_request.opened',
    synchronize: 'pull_request.synchronize',
    reopened: 'pull_request.reopened',
    closed: 'pull_request.closed',
    ready_for_review: 'pull_request.ready_for_review',
  },
  pull_request_review: {
    submitted: 'pull_request_review.submitted',
    dismissed: 'pull_request_review.dismissed',
  },
  check_run: {
    completed: 'check_run.completed',
  },
  check_suite: {
    completed: 'check_suite.completed',
  },
} as const satisfies Record<
  Exclude<GitHubWebhookEventName, 'push'>,
  Record<string, GitHubWatchEventKey>
>;

export interface RepositoryIdentity {
  owner: string;
  repo: string;
  fullName: string;
  canonicalFullName: string;
}

export interface RepositoryEventObject {
  kind: 'issue' | 'push' | 'pull_request' | 'pull_request_review' | 'check_run' | 'check_suite';
  id: string;
  number?: number;
}

interface RepositoryEventMetadata {
  informational: boolean;
  senderLogin: string;
}

interface RepositoryEventBase<
  TKind extends RepositoryEventObject['kind'],
  TEventKey extends GitHubWatchEventKey,
  TAction extends string,
  TInformational extends boolean,
  TSource extends 'webhook' | 'poll' = 'webhook',
> {
  kind: TKind;
  eventKey: TEventKey;
  action: TAction;
  repository: RepositoryIdentity;
  object: RepositoryEventObject & { kind: TKind };
  source: TSource;
  deliveryId: string;
  observedAt: string;
  metadata: RepositoryEventMetadata & { informational: TInformational };
}

export interface IssueRepositoryEvent extends RepositoryEventBase<
  'issue',
  `issues.${IssueAction}`,
  IssueAction,
  false,
  'webhook' | 'poll'
> {
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  body: string;
  senderLogin: string;
  updatedAt: string;
}

export interface PushRepositoryEvent extends RepositoryEventBase<'push', 'push', 'push', false> {
  ref: string;
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
}

export interface PullRequestRepositoryEvent extends RepositoryEventBase<
  'pull_request',
  `pull_request.${PullRequestAction}`,
  PullRequestAction,
  true
> {
  pullRequestNumber: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  headSha: string;
  baseSha: string;
  authorLogin: string;
  updatedAt: string;
}

export interface PullRequestReviewRepositoryEvent extends RepositoryEventBase<
  'pull_request_review',
  `pull_request_review.${PullRequestReviewAction}`,
  PullRequestReviewAction,
  true
> {
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  headSha: string;
  reviewId: number;
  reviewState: string;
  reviewUrl: string;
  reviewerLogin: string;
  commitId: string;
  submittedAt: string;
}

export interface CheckRunRepositoryEvent extends RepositoryEventBase<
  'check_run',
  'check_run.completed',
  CheckAction,
  true
> {
  checkRunId: number;
  name: string;
  url: string;
  status: 'completed';
  conclusion: string | null;
  headSha: string;
  completedAt: string;
  pullRequestNumbers: number[];
}

export interface CheckSuiteRepositoryEvent extends RepositoryEventBase<
  'check_suite',
  'check_suite.completed',
  CheckAction,
  true
> {
  checkSuiteId: number;
  status: 'completed';
  conclusion: string | null;
  headSha: string;
  headBranch: string | null;
  updatedAt: string;
  pullRequestNumbers: number[];
}

export type RepositoryEvent =
  | IssueRepositoryEvent
  | PushRepositoryEvent
  | PullRequestRepositoryEvent
  | PullRequestReviewRepositoryEvent
  | CheckRunRepositoryEvent
  | CheckSuiteRepositoryEvent;

interface PersistableRepositoryEventBase<
  TKind extends RepositoryEvent['kind'],
  TEventKey extends GitHubWatchEventKey,
  TAction extends string,
  TSource extends 'webhook' | 'poll' = 'webhook',
> {
  schema: 'openslack.repository_event.v1';
  kind: TKind;
  eventKey: TEventKey;
  action: TAction;
  repository: RepositoryIdentity;
  object: RepositoryEventObject & { kind: TKind };
  source: TSource;
  deliveryId: string;
  stableKey: string;
  observedAt: string;
  metadata: Pick<RepositoryEventMetadata, 'informational'>;
}

export type PersistableRepositoryEvent =
  | (PersistableRepositoryEventBase<
      'issue',
      `issues.${IssueAction}`,
      IssueAction,
      'webhook' | 'poll'
    > & {
      issueNumber: number;
      updatedAt: string;
    })
  | (PersistableRepositoryEventBase<'push', 'push', 'push'> & {
      ref: string;
      before: string;
      after: string;
    })
  | (PersistableRepositoryEventBase<
      'pull_request',
      `pull_request.${PullRequestAction}`,
      PullRequestAction
    > & {
      pullRequestNumber: number;
      headSha: string;
      baseSha: string;
      updatedAt: string;
    })
  | (PersistableRepositoryEventBase<
      'pull_request_review',
      `pull_request_review.${PullRequestReviewAction}`,
      PullRequestReviewAction
    > & {
      pullRequestNumber: number;
      reviewId: number;
      headSha: string;
      commitId: string;
      submittedAt: string;
    })
  | (PersistableRepositoryEventBase<'check_run', 'check_run.completed', CheckAction> & {
      checkRunId: number;
      headSha: string;
      completedAt: string;
      pullRequestNumbers: number[];
    })
  | (PersistableRepositoryEventBase<'check_suite', 'check_suite.completed', CheckAction> & {
      checkSuiteId: number;
      headSha: string;
      updatedAt: string;
      pullRequestNumbers: number[];
    });

export function isGitHubWatchEventKey(value: unknown): value is GitHubWatchEventKey {
  return typeof value === 'string' && EVENT_KEY_SET.has(value);
}

export function isGitHubWebhookEventName(value: unknown): value is GitHubWebhookEventName {
  return typeof value === 'string' && WEBHOOK_EVENT_NAME_SET.has(value);
}

export function githubWebhookEventKey(
  eventName: string | undefined,
  action: string | undefined,
): GitHubWatchEventKey | null {
  if (eventName === 'push') return action === undefined || action === '' ? 'push' : null;
  if (!isGitHubWebhookEventName(eventName) || eventName === 'push' || !action) return null;

  const actionMap = WEBHOOK_ACTION_EVENT_KEYS[eventName];
  return Object.hasOwn(actionMap, action) ? actionMap[action as keyof typeof actionMap] : null;
}

const GITHUB_OWNER_PATTERN = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;

function isGitHubOwner(value: string): boolean {
  return GITHUB_OWNER_PATTERN.test(value);
}

function isGitHubRepositoryName(value: string): boolean {
  return value !== '.' && value !== '..' && GITHUB_REPOSITORY_PATTERN.test(value);
}

export function canonicalizeRepositoryName(owner: string, repo: string): RepositoryIdentity | null {
  const normalizedOwner = owner.trim();
  const normalizedRepo = repo.trim();
  if (!isGitHubOwner(normalizedOwner) || !isGitHubRepositoryName(normalizedRepo)) return null;

  const fullName = `${normalizedOwner}/${normalizedRepo}`;
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    fullName,
    canonicalFullName: fullName.toLocaleLowerCase('en-US'),
  };
}

export function repositoriesMatch(
  left: Pick<RepositoryIdentity, 'owner' | 'repo'>,
  right: Pick<RepositoryIdentity, 'owner' | 'repo'>,
): boolean {
  const canonicalLeft = canonicalizeRepositoryName(left.owner, left.repo);
  const canonicalRight = canonicalizeRepositoryName(right.owner, right.repo);
  return (
    canonicalLeft !== null &&
    canonicalRight !== null &&
    canonicalLeft.canonicalFullName === canonicalRight.canonicalFullName
  );
}

export function canonicalWatchRouteKey(
  repository: Pick<RepositoryIdentity, 'owner' | 'repo'>,
  route: { sink: string; name?: string; channel?: string },
): string | null {
  const canonicalRepository = canonicalizeRepositoryName(repository.owner, repository.repo);
  const sink = route.sink.trim().toLocaleLowerCase('en-US');
  if (!canonicalRepository || !sink) return null;

  const name = route.name?.trim().toLocaleLowerCase('en-US') ?? '';
  const channel = route.channel?.trim().toLocaleLowerCase('en-US') ?? '';
  return [
    canonicalRepository.canonicalFullName,
    sink,
    `name=${encodeURIComponent(name)}`,
    `channel=${encodeURIComponent(channel)}`,
  ].join('|');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function repositoryIdentityFromPayload(payload: unknown): RepositoryIdentity | null {
  const root = asRecord(payload);
  const repository = asRecord(root?.repository);
  if (!repository) return null;

  const ownerRecord = asRecord(repository.owner);
  const payloadOwner =
    typeof ownerRecord?.login === 'string'
      ? ownerRecord.login
      : typeof ownerRecord?.name === 'string'
        ? ownerRecord.name
        : '';
  const payloadRepo = typeof repository.name === 'string' ? repository.name : '';
  const payloadIdentity = canonicalizeRepositoryName(payloadOwner, payloadRepo);

  if (typeof repository.full_name !== 'string') return payloadIdentity;
  const fullNameParts = repository.full_name.split('/');
  if (fullNameParts.length !== 2) return null;
  const fullNameIdentity = canonicalizeRepositoryName(fullNameParts[0]!, fullNameParts[1]!);
  if (!fullNameIdentity) return null;

  if (payloadIdentity && payloadIdentity.canonicalFullName !== fullNameIdentity.canonicalFullName) {
    return null;
  }
  return fullNameIdentity;
}

export function repositoryEventStableKey(event: RepositoryEvent): string {
  const prefix = `github:${event.eventKey}:${event.repository.canonicalFullName}`;
  switch (event.kind) {
    case 'issue':
      return `${prefix}:issue:${event.issueNumber}:${event.updatedAt}`;
    case 'push':
      return `${prefix}:${event.ref}:${event.after}`;
    case 'pull_request':
      return `${prefix}:pr:${event.pullRequestNumber}:${event.headSha}:${event.updatedAt}`;
    case 'pull_request_review':
      return `${prefix}:pr:${event.pullRequestNumber}:review:${event.reviewId}:${event.commitId}`;
    case 'check_run':
      return `${prefix}:check-run:${event.checkRunId}:${event.headSha}:${event.completedAt}`;
    case 'check_suite':
      return `${prefix}:check-suite:${event.checkSuiteId}:${event.headSha}:${event.updatedAt}`;
  }
}

type PersistableBaseFor<TEvent extends RepositoryEvent> = {
  schema: 'openslack.repository_event.v1';
  eventKey: TEvent['eventKey'];
  repository: RepositoryIdentity;
  object: TEvent['object'];
  source: TEvent['source'];
  deliveryId: string;
  stableKey: string;
  observedAt: string;
  metadata: Pick<RepositoryEventMetadata, 'informational'>;
};

function persistableBase<TEvent extends RepositoryEvent>(
  event: TEvent,
): PersistableBaseFor<TEvent> {
  const object = {
    kind: event.object.kind,
    id: event.object.id,
    ...(event.object.number === undefined ? {} : { number: event.object.number }),
  } as TEvent['object'];
  const informational = event.kind === 'issue' || event.kind === 'push' ? false : true;
  return {
    schema: 'openslack.repository_event.v1',
    eventKey: event.eventKey,
    repository: {
      owner: event.repository.owner,
      repo: event.repository.repo,
      fullName: event.repository.fullName,
      canonicalFullName: event.repository.canonicalFullName,
    },
    object,
    source: event.source,
    deliveryId: event.deliveryId,
    stableKey: repositoryEventStableKey(event),
    observedAt: event.observedAt,
    metadata: {
      informational,
    },
  };
}

export function toPersistableRepositoryEvent(event: RepositoryEvent): PersistableRepositoryEvent {
  switch (event.kind) {
    case 'issue':
      return {
        ...persistableBase(event),
        kind: event.kind,
        action: event.action,
        issueNumber: event.issueNumber,
        updatedAt: event.updatedAt,
      };
    case 'push':
      return {
        ...persistableBase(event),
        kind: event.kind,
        action: event.action,
        ref: event.ref,
        before: event.before,
        after: event.after,
      };
    case 'pull_request':
      return {
        ...persistableBase(event),
        kind: event.kind,
        action: event.action,
        pullRequestNumber: event.pullRequestNumber,
        headSha: event.headSha,
        baseSha: event.baseSha,
        updatedAt: event.updatedAt,
      };
    case 'pull_request_review':
      return {
        ...persistableBase(event),
        kind: event.kind,
        action: event.action,
        pullRequestNumber: event.pullRequestNumber,
        reviewId: event.reviewId,
        headSha: event.headSha,
        commitId: event.commitId,
        submittedAt: event.submittedAt,
      };
    case 'check_run':
      return {
        ...persistableBase(event),
        kind: event.kind,
        action: event.action,
        checkRunId: event.checkRunId,
        headSha: event.headSha,
        completedAt: event.completedAt,
        pullRequestNumbers: persistablePullRequestNumbers(event.pullRequestNumbers),
      };
    case 'check_suite':
      return {
        ...persistableBase(event),
        kind: event.kind,
        action: event.action,
        checkSuiteId: event.checkSuiteId,
        headSha: event.headSha,
        updatedAt: event.updatedAt,
        pullRequestNumbers: persistablePullRequestNumbers(event.pullRequestNumbers),
      };
  }
}

function persistablePullRequestNumbers(values: number[]): number[] {
  return values.filter(
    (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  );
}
