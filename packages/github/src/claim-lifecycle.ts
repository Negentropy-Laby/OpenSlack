import { issueClaimRef, parseTaskLinkMarker } from '@openslack/core';
import {
  getClient,
  parseGitHubRepoSpec,
  resolveGitHubRepoTarget,
  type GitHubClient,
  type GitHubClientOptions,
} from './client.js';
import { parseClaimMetadata, type ClaimMetadata } from './claims.js';
import {
  readClaimComments,
  ClaimEvidenceScanIncompleteError,
  type ClaimComment,
} from './claim-comments.js';
import { GitHubEvidenceUnavailableError } from './pr.js';
import { parseIssueTaskManifest } from './manifest.js';

export type ClaimLifecycleOperation = 'heartbeat' | 'review' | 'complete';
export type ClaimLifecycleOutcome = 'completed' | 'partial' | 'failed';
export type ClaimLifecyclePostconditionName =
  | 'claim_ref_present'
  | 'claim_ref_absent'
  | 'owner_matches'
  | 'heartbeat_recorded'
  | 'review_label_present'
  | 'pr_link_present'
  | 'pr_merged'
  | 'done_label_present';

export type ClaimLifecycleErrorCode =
  | 'CLAIM_INVALID_INPUT'
  | 'CLAIM_REF_NOT_FOUND'
  | 'CLAIM_LEASE_NOT_CURRENT'
  | 'CLAIM_OWNER_MISSING'
  | 'CLAIM_OWNER_MISMATCH'
  | 'CLAIM_API_UNAVAILABLE'
  | 'CLAIM_EVIDENCE_SCAN_INCOMPLETE'
  | 'CLAIM_TASK_LINK_INVALID'
  | 'CLAIM_TASK_LINK_MISMATCH'
  | 'CLAIM_REVIEW_EVIDENCE_REQUIRED'
  | 'CLAIM_RECONCILIATION_REQUIRED'
  | 'CLAIM_REQUEUE_RECONCILIATION_REQUIRED'
  | 'CLAIM_HEARTBEAT_WRITE_FAILED'
  | 'CLAIM_REVIEW_TRANSITION_FAILED'
  | 'CLAIM_COMPLETION_FAILED'
  | 'CLAIM_POSTCONDITION_FAILED'
  | 'CLAIM_PARTIAL_STATE';

export interface ClaimLifecyclePostcondition {
  name: ClaimLifecyclePostconditionName;
  satisfied: boolean;
}

export interface ClaimLifecycleResult {
  schema: 'openslack.claim_lifecycle.v1';
  operation: ClaimLifecycleOperation;
  outcome: ClaimLifecycleOutcome;
  issueNumber: number;
  claimRef: string;
  agentId: string;
  owner?: string;
  prUrl?: string;
  expiresAt?: string;
  ttlMinutes?: number;
  heartbeatMinutes?: number;
  nextHeartbeatAt?: string;
  postconditions: ClaimLifecyclePostcondition[];
  errorCode?: ClaimLifecycleErrorCode;
  recoveryCommand?: string;
  guidance?: string;
}

export interface HeartbeatClaimInput {
  issueNumber: number;
  agentId: string;
  ttlMinutes?: number;
  repository?: string;
}

export interface ReviewClaimInput {
  issueNumber: number;
  agentId: string;
  prUrl: string;
  repository?: string;
}

export type CompleteClaimInput = ReviewClaimInput;

export interface ClaimLifecycleDependencies {
  getClient(options?: GitHubClientOptions): Promise<GitHubClient>;
  now(): Date;
}

export interface HeartbeatMetadata {
  schema: 'openslack.heartbeat.v1';
  issue_number: number;
  agent_id: string;
  heartbeat_at: string;
  expires_at: string;
  claim_ref: string;
  ttl_minutes?: number;
  heartbeat_minutes?: number;
  next_heartbeat_at?: string;
  claim_id?: string;
}

export interface ClaimReviewMetadata {
  schema: 'openslack.claim_review.v1';
  issue_number: number;
  agent_id: string;
  claim_ref: string;
  pr_url: string;
  reviewed_at: string;
  claim_id?: string;
}

const DEFAULT_DEPENDENCIES: ClaimLifecycleDependencies = {
  getClient,
  now: () => new Date(),
};

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HEARTBEAT_RETRY_DEDUP_WINDOW_MS = 60_000;
const PRE_REVIEW_LABELS = [
  'openslack:ready',
  'openslack:claimed',
  'openslack:running',
  'openslack:blocked',
];
const PRE_COMPLETION_LABELS = [...PRE_REVIEW_LABELS, 'openslack:review'];

class ClaimLifecycleFailure extends Error {
  constructor(readonly code: ClaimLifecycleErrorCode) {
    super(code);
    this.name = 'ClaimLifecycleFailure';
  }
}

function validateCommonInput(issueNumber: number, agentId: string): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || !AGENT_ID_PATTERN.test(agentId)) {
    throw new ClaimLifecycleFailure('CLAIM_INVALID_INPUT');
  }
}

function normalizePullRequest(
  value: string,
  client: GitHubClient,
): { url: string; number: number } {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'github.com' ||
      Boolean(url.port || url.username || url.password) ||
      parts.length !== 4 ||
      parts[0].toLowerCase() !== client.owner.toLowerCase() ||
      parts[1].toLowerCase() !== client.repo.toLowerCase() ||
      parts[2] !== 'pull' ||
      !/^[1-9]\d*$/.test(parts[3]) ||
      !Number.isSafeInteger(Number(parts[3]))
    ) {
      throw new Error('invalid');
    }
    return {
      url: `https://github.com/${client.owner}/${client.repo}/pull/${parts[3]}`,
      number: Number(parts[3]),
    };
  } catch {
    throw new ClaimLifecycleFailure('CLAIM_INVALID_INPUT');
  }
}

function parseMarker<T>(body: string | null | undefined, marker: string): T | null {
  if (!body) return null;
  const pattern = new RegExp(`<!--\\s*${marker}\\s*([\\s\\S]*?)-->`);
  const match = body.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as T;
  } catch {
    return null;
  }
}

export function parseHeartbeatMetadata(body: string | null | undefined): HeartbeatMetadata | null {
  const parsed = parseMarker<Partial<HeartbeatMetadata>>(body, 'openslack-heartbeat');
  if (
    parsed?.schema !== 'openslack.heartbeat.v1' ||
    !Number.isSafeInteger(parsed.issue_number) ||
    typeof parsed.agent_id !== 'string' ||
    typeof parsed.heartbeat_at !== 'string' ||
    typeof parsed.expires_at !== 'string' ||
    typeof parsed.claim_ref !== 'string' ||
    (parsed.claim_id !== undefined && typeof parsed.claim_id !== 'string') ||
    (parsed.ttl_minutes !== undefined && !Number.isSafeInteger(parsed.ttl_minutes)) ||
    (parsed.heartbeat_minutes !== undefined && !Number.isSafeInteger(parsed.heartbeat_minutes)) ||
    (parsed.next_heartbeat_at !== undefined && typeof parsed.next_heartbeat_at !== 'string')
  ) {
    return null;
  }
  return parsed as HeartbeatMetadata;
}

export function parseClaimReviewMetadata(
  body: string | null | undefined,
): ClaimReviewMetadata | null {
  const parsed = parseMarker<Partial<ClaimReviewMetadata>>(body, 'openslack-claim-review');
  if (
    parsed?.schema !== 'openslack.claim_review.v1' ||
    !Number.isSafeInteger(parsed.issue_number) ||
    typeof parsed.agent_id !== 'string' ||
    typeof parsed.claim_ref !== 'string' ||
    typeof parsed.pr_url !== 'string' ||
    typeof parsed.reviewed_at !== 'string' ||
    (parsed.claim_id !== undefined && typeof parsed.claim_id !== 'string')
  ) {
    return null;
  }
  return parsed as ClaimReviewMetadata;
}

function renderHeartbeatMetadata(metadata: HeartbeatMetadata): string {
  return `<!-- openslack-heartbeat\n${JSON.stringify(metadata, null, 2)}\n-->\n\nHeartbeat: lease extended to ${metadata.expires_at}`;
}

function renderClaimReviewMetadata(metadata: ClaimReviewMetadata): string {
  return `<!-- openslack-claim-review\n${JSON.stringify(metadata, null, 2)}\n-->\n\n**Draft PR created:** ${metadata.pr_url}`;
}

async function requireLiveClient(
  dependencies: ClaimLifecycleDependencies,
  repository?: string,
): Promise<GitHubClient> {
  if (repository !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ClaimLifecycleFailure('CLAIM_INVALID_INPUT');
  }
  const client = await dependencies.getClient({
    requireLive: true,
    ...(repository ? { repoFullName: repository } : {}),
  });
  if (client.isDryRun) throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
  return client;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

interface ObservedClaim extends ClaimMetadata {
  comment: ClaimComment;
}

function commentTime(comment: ClaimComment, fallback: string): number {
  return Date.parse(comment.created_at ?? fallback);
}

function followsClaim(comment: ClaimComment, timestamp: string, claim: ObservedClaim): boolean {
  const time = commentTime(comment, timestamp);
  const start = commentTime(claim.comment, claim.claimed_at);
  if (time !== start || !comment.created_at || !claim.comment.created_at) return time >= start;
  return (
    comment.id !== undefined && claim.comment.id !== undefined && comment.id > claim.comment.id
  );
}

export function resolveStrictClaim(
  comments: ClaimComment[],
  issueNumber: number,
  claimRef: string,
): ObservedClaim {
  const claims: ObservedClaim[] = [];
  const malformed: ClaimComment[] = [];
  for (const comment of comments) {
    if (!/^<!--\s*openslack-claim(?=\s|\{|-->|$)/mu.test(comment.body ?? '')) continue;
    const claim = parseClaimMetadata(comment.body);
    if (
      !claim ||
      claim.issue_number !== issueNumber ||
      claim.claim_ref !== claimRef ||
      !AGENT_ID_PATTERN.test(claim.agent_id) ||
      !Number.isFinite(commentTime(comment, claim.claimed_at)) ||
      !Number.isFinite(Date.parse(claim.claimed_at)) ||
      !Number.isFinite(Date.parse(claim.expires_at))
    ) {
      malformed.push(comment);
      continue;
    }
    claims.push({ ...claim, comment });
  }
  if (claims.length === 0)
    throw new ClaimLifecycleFailure(
      malformed.length > 0 ? 'CLAIM_POSTCONDITION_FAILED' : 'CLAIM_OWNER_MISSING',
    );
  claims.sort(
    (left, right) =>
      commentTime(right.comment, right.claimed_at) - commentTime(left.comment, left.claimed_at) ||
      (right.comment.id ?? 0) - (left.comment.id ?? 0),
  );
  const current = claims[0];
  const currentTime = Date.parse(current.comment.created_at ?? '');
  const unprovenOldRecord = malformed.some((comment) => {
    const time = Date.parse(comment.created_at ?? '');
    return !(
      time < currentTime ||
      (time === currentTime &&
        comment.id !== undefined &&
        current.comment.id !== undefined &&
        comment.id < current.comment.id)
    );
  });
  if (unprovenOldRecord) {
    throw new ClaimLifecycleFailure('CLAIM_POSTCONDITION_FAILED');
  }
  if (
    claims.some(
      (claim) =>
        commentTime(claim.comment, claim.claimed_at) ===
          commentTime(current.comment, current.claimed_at) &&
        Date.parse(claim.claimed_at) === Date.parse(current.claimed_at) &&
        !sameClaim(claim, current),
    )
  ) {
    throw new ClaimLifecycleFailure('CLAIM_OWNER_MISMATCH');
  }
  return current;
}

function sameClaim(left: ObservedClaim, right: ObservedClaim): boolean {
  return (
    left.agent_id === right.agent_id &&
    left.claim_id === right.claim_id &&
    (left.claim_id !== undefined || left.comment.id === right.comment.id) &&
    Date.parse(left.claimed_at) === Date.parse(right.claimed_at) &&
    left.expires_at === right.expires_at &&
    left.task_id === right.task_id &&
    left.principal.run_id === right.principal.run_id
  );
}

async function requireSameCurrentClaim(client: GitHubClient, claim: ObservedClaim): Promise<void> {
  const { comments } = await readClaimComments(client, claim.issue_number);
  const current = resolveStrictClaim(comments, claim.issue_number, claim.claim_ref);
  if (!sameClaim(claim, current)) {
    throw new ClaimLifecycleFailure('CLAIM_RECONCILIATION_REQUIRED');
  }
}

function claimLease(claim: ClaimMetadata): { ttlMinutes: number; heartbeatMinutes: number } {
  let ttlMinutes = claim.ttl_minutes;
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes! < 1 || ttlMinutes! > 480) {
    const duration = (Date.parse(claim.expires_at) - Date.parse(claim.claimed_at)) / 60_000;
    ttlMinutes = Number.isSafeInteger(duration) && duration >= 1 && duration <= 480 ? duration : 60;
  }
  const effectiveTtlMinutes = ttlMinutes ?? 60;
  const heartbeatMinutes =
    Number.isSafeInteger(claim.heartbeat_minutes) &&
    claim.heartbeat_minutes! >= 1 &&
    claim.heartbeat_minutes! <= 120
      ? claim.heartbeat_minutes!
      : Math.min(15, effectiveTtlMinutes);
  return { ttlMinutes: effectiveTtlMinutes, heartbeatMinutes };
}

function requireMatchingOwner(owner: string, agentId: string): void {
  if (owner !== agentId) throw new ClaimLifecycleFailure('CLAIM_OWNER_MISMATCH');
}

async function requireClaimRef(
  client: GitHubClient,
  issueNumber: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref: issueClaimRef(issueNumber),
      ...(signal ? { request: { signal } } : {}),
    });
  } catch (error) {
    if (statusOf(error) === 404) throw new ClaimLifecycleFailure('CLAIM_REF_NOT_FOUND');
    throw error;
  }
}

async function claimRefIsAbsent(client: GitHubClient, issueNumber: number): Promise<boolean> {
  try {
    await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref: issueClaimRef(issueNumber),
    });
    return false;
  } catch (error) {
    if (statusOf(error) === 404) return true;
    throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
  }
}

async function issueLabels(
  client: GitHubClient,
  issueNumber: number,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const response = await client.octokit.issues.get({
    owner: client.owner,
    repo: client.repo,
    issue_number: issueNumber,
    ...(signal ? { request: { signal } } : {}),
  });
  return new Set(
    response.data.labels
      .map((label) => (typeof label === 'string' ? label : label.name))
      .filter((label): label is string => Boolean(label)),
  );
}

function reviewLabelsComplete(labels: ReadonlySet<string>): boolean {
  // Claim projection repair can re-add "claimed" while the review is active.
  return (
    labels.has('openslack:review') &&
    !labels.has('openslack:done') &&
    PRE_REVIEW_LABELS.every((label) => label === 'openslack:claimed' || !labels.has(label))
  );
}

function reviewEvidencePresent(
  comments: ClaimComment[],
  input: ReviewClaimInput,
  claim: ObservedClaim,
  prUrl: string,
  client: GitHubClient,
): boolean {
  return comments.some((comment) => {
    const metadata = parseClaimReviewMetadata(comment.body);
    if (
      metadata?.issue_number !== input.issueNumber ||
      metadata.agent_id !== input.agentId ||
      metadata.claim_ref !== claim.claim_ref
    )
      return false;
    try {
      if (normalizePullRequest(metadata.pr_url, client).url !== prUrl) return false;
    } catch {
      return false;
    }
    return (
      metadata.claim_id === claim.claim_id &&
      (claim.claim_id !== undefined || followsClaim(comment, metadata.reviewed_at, claim))
    );
  });
}

function claimHeartbeat(comment: ClaimComment, claim: ObservedClaim) {
  const receipt = parseHeartbeatMetadata(comment.body);
  if (
    receipt?.issue_number !== claim.issue_number ||
    receipt.agent_id !== claim.agent_id ||
    receipt.claim_ref !== claim.claim_ref ||
    receipt.claim_id !== claim.claim_id ||
    (claim.claim_id === undefined && !followsClaim(comment, receipt.heartbeat_at, claim))
  )
    return;
  const time = commentTime(comment, receipt.heartbeat_at);
  const duration = Date.parse(receipt.expires_at) - Date.parse(receipt.heartbeat_at);
  const minutes = duration / 60_000;
  if (!Number.isFinite(time) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 480)
    return;
  return { receipt, time, expiry: time + duration, minutes };
}

export function effectiveClaimExpiry(
  comments: ClaimComment[],
  claim: ObservedClaim,
  now: number,
): string | null {
  const heartbeats = comments
    .map((comment) => claimHeartbeat(comment, claim))
    .filter((heartbeat) => heartbeat !== undefined && heartbeat.time <= now)
    .sort((left, right) => right!.time - left!.time);
  if (heartbeats.length === 0) {
    const duration = Date.parse(claim.expires_at) - Date.parse(claim.claimed_at);
    return new Date(commentTime(claim.comment, claim.claimed_at) + duration).toISOString();
  }
  const latest = heartbeats[0]!;
  const expiries = new Set(
    heartbeats.filter((item) => item!.time === latest.time).map((item) => item!.expiry),
  );
  return expiries.size === 1 ? new Date(latest.expiry).toISOString() : null;
}

export interface ClaimReviewIssue {
  code: ClaimLifecycleErrorCode;
  reason: string;
  recommendation: string;
  owner: 'agent' | 'github_admin';
}

function reviewIssue(
  code: ClaimLifecycleErrorCode,
  detail: string,
  recommendation: string,
  owner: ClaimReviewIssue['owner'] = 'agent',
): ClaimReviewIssue {
  return { code, reason: `${code}: ${detail}`, recommendation, owner };
}

export async function checkTaskClaimReview(
  prNumber: number,
  body: string | undefined,
  options?: GitHubClientOptions,
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaimReviewIssue | undefined> {
  const link = parseTaskLinkMarker(body);
  if (link.state === 'ABSENT') return;
  if (link.state === 'INVALID') {
    return reviewIssue(
      'CLAIM_TASK_LINK_INVALID',
      'The PR task link is invalid or ambiguous.',
      'Correct the task link using the authorized task publication flow.',
    );
  }

  const { issue_number: issueNumber, agent_id: agentId, claim_ref: claimRef } = link.metadata;
  let client: GitHubClient | undefined;
  try {
    client = await dependencies.getClient({ ...options, requireLive: true });
    if (client.isDryRun) throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
    options?.signal?.throwIfAborted();
    await requireClaimRef(client, issueNumber, options?.signal);
    const { comments, serverTime } = await readClaimComments(client, issueNumber, options?.signal);
    const claim = resolveStrictClaim(comments, issueNumber, claimRef);
    requireMatchingOwner(claim.agent_id, agentId);
    if (claim.task_id !== undefined && claim.task_id !== link.metadata.task_id) {
      return reviewIssue(
        'CLAIM_TASK_LINK_MISMATCH',
        `The PR does not match the current task for issue #${issueNumber}.`,
        'Verify the current task and correct the link on this PR through authorized task publication.',
      );
    }
    const repository = `${client.owner}/${client.repo}`;
    const prUrl = `https://github.com/${repository}/pull/${prNumber}`;
    const input = { issueNumber, agentId, prUrl, repository };
    const labels = await issueLabels(client, issueNumber, options?.signal);
    if (labels.has('openslack:done')) {
      return reviewIssue(
        'CLAIM_REQUEUE_RECONCILIATION_REQUIRED',
        `Issue #${issueNumber} is marked done and still has a claim.`,
        requeueGuidance,
        'github_admin',
      );
    }
    const now = serverTime ?? dependencies.now().getTime();
    const expiry = effectiveClaimExpiry(comments, claim, now);
    if (expiry === null || commentTime(claim.comment, claim.claimed_at) > now) {
      return reviewIssue(
        'CLAIM_LEASE_NOT_CURRENT',
        `Issue #${issueNumber} has ambiguous lease evidence.`,
        'Reconcile the current claim and heartbeat evidence before re-running pr doctor.',
        'github_admin',
      );
    }
    if (!(Date.parse(expiry) > now)) {
      return reviewIssue(
        'CLAIM_LEASE_NOT_CURRENT',
        `The claim lease for issue #${issueNumber} has expired.`,
        `Have the current owner renew it: ${heartbeatRecoveryCommand(input, claimLease(claim).ttlMinutes)}`,
      );
    }
    if (!reviewEvidencePresent(comments, input, claim, prUrl, client)) {
      return reviewIssue(
        'CLAIM_REVIEW_EVIDENCE_REQUIRED',
        `Issue #${issueNumber} has no current review record for PR #${prNumber}.`,
        `Record the review transition: ${recoveryCommand('review', input)}`,
      );
    }
    if (!reviewLabelsComplete(labels)) {
      return reviewIssue(
        'CLAIM_REVIEW_TRANSITION_FAILED',
        `Issue #${issueNumber} has incomplete review labels.`,
        `Complete the review transition: ${recoveryCommand('review', input)}`,
      );
    }
  } catch (error) {
    const repository = client ? `${client.owner}/${client.repo}` : options?.repoFullName;
    const code = failureCode(error);
    if (code === 'CLAIM_REF_NOT_FOUND' && client && repository) {
      const prUrl = `https://github.com/${repository}/pull/${prNumber}`;
      return reviewIssue(
        code,
        `Issue #${issueNumber} has no live claim in ${repository}.`,
        `Verify the Issue is still open and eligible. Reclaim it through agent tick in ${repository} with the authorized agent, verify this existing PR, then run ${recoveryCommand('review', { issueNumber, agentId, prUrl, repository })}.`,
      );
    }
    if (code !== 'CLAIM_API_UNAVAILABLE' && code !== 'CLAIM_EVIDENCE_SCAN_INCOMPLETE') {
      return reviewIssue(
        code,
        `Issue #${issueNumber} has inconsistent claim evidence.`,
        'Have a repository administrator reconcile the current claim and re-run pr doctor.',
        'github_admin',
      );
    }
    let target = client ?? parseGitHubRepoSpec(repository);
    if (!target) {
      try {
        target = resolveGitHubRepoTarget(options);
      } catch {
        /* No verified repository target. */
      }
    }
    throw new GitHubEvidenceUnavailableError({
      operation: 'task claim review evidence',
      owner: target?.owner ?? 'unknown',
      repo: target?.repo ?? 'unknown',
      prNumber,
      status: statusOf(error),
      causeMessage:
        code === 'CLAIM_EVIDENCE_SCAN_INCOMPLETE'
          ? 'CLAIM_EVIDENCE_SCAN_INCOMPLETE: GitHub comment pagination did not finish within the evidence budget. Retry the full read.'
          : 'Refresh live claim evidence and retry.',
    });
  }
}

export async function resolveTaskPublicationId(
  input: { issueNumber: number; agentId: string; taskId: string },
  options: GitHubClientOptions = {},
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  validateCommonInput(input.issueNumber, input.agentId);
  const client = await dependencies.getClient({ ...options, requireLive: true });
  if (client.isDryRun) throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
  await requireClaimRef(client, input.issueNumber, options.signal);
  const { comments, serverTime } = await readClaimComments(
    client,
    input.issueNumber,
    options.signal,
  );
  const claim = resolveStrictClaim(
    comments,
    input.issueNumber,
    issueClaimRef(input.issueNumber, 'canonical'),
  );
  requireMatchingOwner(claim.agent_id, input.agentId);
  const now = serverTime ?? dependencies.now().getTime();
  const expiry = effectiveClaimExpiry(comments, claim, now);
  if (
    expiry === null ||
    commentTime(claim.comment, claim.claimed_at) > now ||
    !(Date.parse(expiry) > now)
  )
    throw new ClaimLifecycleFailure('CLAIM_LEASE_NOT_CURRENT');
  const { data } = await client.octokit.issues.get({
    owner: client.owner,
    repo: client.repo,
    issue_number: input.issueNumber,
    ...(options.signal ? { request: { signal: options.signal } } : {}),
  });
  if (
    data.labels.some(
      (label) => (typeof label === 'string' ? label : label.name) === 'openslack:done',
    )
  ) {
    throw new ClaimLifecycleFailure('CLAIM_REQUEUE_RECONCILIATION_REQUIRED');
  }
  const parsed = parseIssueTaskManifest(data.body ?? '');
  if (data.pull_request || data.state !== 'open' || !parsed.valid || !parsed.manifest) {
    throw new ClaimLifecycleFailure('CLAIM_TASK_LINK_MISMATCH');
  }
  const taskId = parsed.manifest.task_id;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(taskId) ||
    (claim.task_id !== undefined && claim.task_id !== taskId) ||
    (input.taskId !== taskId && input.taskId !== `ISSUE-${input.issueNumber}`)
  ) {
    throw new ClaimLifecycleFailure('CLAIM_TASK_LINK_MISMATCH');
  }
  return taskId;
}

function findRecentMatchingHeartbeat(
  comments: ClaimComment[],
  claim: ObservedClaim,
  ttlMinutes: number,
  now: number,
) {
  return comments
    .map((comment) => claimHeartbeat(comment, claim))
    .filter(
      (heartbeat) =>
        heartbeat !== undefined &&
        heartbeat.minutes === ttlMinutes &&
        heartbeat.time <= now &&
        now - heartbeat.time <= HEARTBEAT_RETRY_DEDUP_WINDOW_MS,
    )
    .sort((left, right) => right!.time - left!.time)[0];
}

const requeueGuidance =
  'A repository administrator must verify the intentional requeue and current claim, then remove the stale openslack:done label before retrying.';
const reconcileGuidance =
  'A repository administrator must reconcile the merged PR and current claim with its owner. Preserve the newer claim and use its own PR for completion.';

function recoveryCommand(operation: ClaimLifecycleOperation, input: ReviewClaimInput): string {
  return `openslack github claim ${operation} --issue-number ${input.issueNumber} --agent-id ${input.agentId} --pr-url ${input.prUrl}${input.repository ? ` --repo ${input.repository}` : ''}`;
}

function heartbeatRecoveryCommand(input: HeartbeatClaimInput, ttlMinutes: number): string {
  return `openslack github claim heartbeat --issue-number ${input.issueNumber} --agent-id ${input.agentId} --ttl-minutes ${ttlMinutes}${input.repository ? ` --repo ${input.repository}` : ''}`;
}

function failedResult(
  operation: ClaimLifecycleOperation,
  input: HeartbeatClaimInput | ReviewClaimInput,
  code: ClaimLifecycleErrorCode,
  options: {
    outcome?: ClaimLifecycleOutcome;
    owner?: string;
    prUrl?: string;
    expiresAt?: string;
    ttlMinutes?: number;
    heartbeatMinutes?: number;
    nextHeartbeatAt?: string;
    postconditions?: ClaimLifecyclePostcondition[];
    recoveryCommand?: string;
    guidance?: string;
  } = {},
): ClaimLifecycleResult {
  return {
    schema: 'openslack.claim_lifecycle.v1',
    operation,
    outcome: options.outcome ?? 'failed',
    issueNumber: input.issueNumber,
    // Invalid input has no claim target; keep the structured failure contract.
    claimRef:
      Number.isSafeInteger(input.issueNumber) && input.issueNumber > 0
        ? issueClaimRef(input.issueNumber, 'canonical')
        : '',
    agentId: input.agentId,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.prUrl ? { prUrl: options.prUrl } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.ttlMinutes ? { ttlMinutes: options.ttlMinutes } : {}),
    ...(options.heartbeatMinutes ? { heartbeatMinutes: options.heartbeatMinutes } : {}),
    ...(options.nextHeartbeatAt ? { nextHeartbeatAt: options.nextHeartbeatAt } : {}),
    postconditions: options.postconditions ?? [],
    errorCode: code,
    ...(options.recoveryCommand ? { recoveryCommand: options.recoveryCommand } : {}),
    ...(options.guidance ? { guidance: options.guidance } : {}),
  };
}

function failureCode(error: unknown): ClaimLifecycleErrorCode {
  if (error instanceof ClaimEvidenceScanIncompleteError) return 'CLAIM_EVIDENCE_SCAN_INCOMPLETE';
  return error instanceof ClaimLifecycleFailure ? error.code : 'CLAIM_API_UNAVAILABLE';
}

export async function heartbeatClaim(
  input: HeartbeatClaimInput,
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaimLifecycleResult> {
  let owner: string | undefined;
  try {
    validateCommonInput(input.issueNumber, input.agentId);
    const claimRef = issueClaimRef(input.issueNumber, 'canonical');
    if (
      input.ttlMinutes !== undefined &&
      (!Number.isSafeInteger(input.ttlMinutes) || input.ttlMinutes < 1 || input.ttlMinutes > 480)
    ) {
      throw new ClaimLifecycleFailure('CLAIM_INVALID_INPUT');
    }
    const client = await requireLiveClient(dependencies, input.repository);
    await requireClaimRef(client, input.issueNumber);
    const { comments, serverTime } = await readClaimComments(client, input.issueNumber);
    const claim = resolveStrictClaim(comments, input.issueNumber, claimRef);
    owner = claim.agent_id;
    requireMatchingOwner(owner, input.agentId);
    const originalLease = claimLease(claim);
    const ttlMinutes = input.ttlMinutes ?? originalLease.ttlMinutes;
    const heartbeatMinutes = originalLease.heartbeatMinutes;

    const now = new Date(serverTime ?? dependencies.now().getTime());
    const recent = findRecentMatchingHeartbeat(comments, claim, ttlMinutes, now.getTime());
    const existingHeartbeat = recent?.receipt;
    if (existingHeartbeat) {
      const nextHeartbeatAt =
        existingHeartbeat.next_heartbeat_at ??
        new Date(
          Math.min(
            Date.parse(existingHeartbeat.heartbeat_at) + heartbeatMinutes * 60_000,
            Date.parse(existingHeartbeat.expires_at),
          ),
        ).toISOString();
      return {
        schema: 'openslack.claim_lifecycle.v1',
        operation: 'heartbeat',
        outcome: 'completed',
        issueNumber: input.issueNumber,
        claimRef,
        agentId: input.agentId,
        owner,
        expiresAt: existingHeartbeat.expires_at,
        ttlMinutes,
        heartbeatMinutes,
        nextHeartbeatAt,
        postconditions: [
          { name: 'claim_ref_present', satisfied: true },
          { name: 'owner_matches', satisfied: true },
          { name: 'heartbeat_recorded', satisfied: true },
        ],
      };
    }
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
    const nextHeartbeatAt = new Date(
      Math.min(now.getTime() + heartbeatMinutes * 60_000, Date.parse(expiresAt)),
    ).toISOString();
    const body = renderHeartbeatMetadata({
      schema: 'openslack.heartbeat.v1',
      issue_number: input.issueNumber,
      agent_id: input.agentId,
      heartbeat_at: now.toISOString(),
      expires_at: expiresAt,
      claim_ref: claimRef,
      claim_id: claim.claim_id,
      ttl_minutes: ttlMinutes,
      heartbeat_minutes: heartbeatMinutes,
      next_heartbeat_at: nextHeartbeatAt,
    });
    let commentId: number;
    try {
      const created = await client.octokit.issues.createComment({
        owner: client.owner,
        repo: client.repo,
        issue_number: input.issueNumber,
        body,
      });
      commentId = created.data.id;
    } catch {
      return failedResult('heartbeat', input, 'CLAIM_HEARTBEAT_WRITE_FAILED', {
        outcome: 'partial',
        owner,
        expiresAt,
        ttlMinutes,
        heartbeatMinutes,
        nextHeartbeatAt,
        postconditions: [
          { name: 'claim_ref_present', satisfied: true },
          { name: 'owner_matches', satisfied: true },
          { name: 'heartbeat_recorded', satisfied: false },
        ],
        recoveryCommand: heartbeatRecoveryCommand(input, ttlMinutes),
      });
    }
    try {
      const recorded = await client.octokit.issues.getComment({
        owner: client.owner,
        repo: client.repo,
        comment_id: commentId,
      });
      const metadata = parseHeartbeatMetadata(recorded.data.body);
      if (
        metadata?.issue_number !== input.issueNumber ||
        metadata.agent_id !== input.agentId ||
        metadata.claim_ref !== claimRef ||
        metadata.claim_id !== claim.claim_id ||
        metadata.expires_at !== expiresAt ||
        metadata.ttl_minutes !== ttlMinutes ||
        metadata.heartbeat_minutes !== heartbeatMinutes ||
        metadata.next_heartbeat_at !== nextHeartbeatAt
      ) {
        throw new ClaimLifecycleFailure('CLAIM_POSTCONDITION_FAILED');
      }
    } catch {
      return failedResult('heartbeat', input, 'CLAIM_POSTCONDITION_FAILED', {
        outcome: 'partial',
        owner,
        expiresAt,
        ttlMinutes,
        heartbeatMinutes,
        nextHeartbeatAt,
        postconditions: [
          { name: 'claim_ref_present', satisfied: true },
          { name: 'owner_matches', satisfied: true },
          { name: 'heartbeat_recorded', satisfied: false },
        ],
        recoveryCommand: heartbeatRecoveryCommand(input, ttlMinutes),
      });
    }
    return {
      schema: 'openslack.claim_lifecycle.v1',
      operation: 'heartbeat',
      outcome: 'completed',
      issueNumber: input.issueNumber,
      claimRef,
      agentId: input.agentId,
      owner,
      expiresAt,
      ttlMinutes,
      heartbeatMinutes,
      nextHeartbeatAt,
      postconditions: [
        { name: 'claim_ref_present', satisfied: true },
        { name: 'owner_matches', satisfied: true },
        { name: 'heartbeat_recorded', satisfied: true },
      ],
    };
  } catch (error) {
    return failedResult('heartbeat', input, failureCode(error), { owner });
  }
}

function verifyClaimPullLink(
  body: string | null | undefined,
  input: ReviewClaimInput,
  claim: ObservedClaim,
) {
  const link = parseTaskLinkMarker(body);
  if (link.state === 'INVALID') throw new ClaimLifecycleFailure('CLAIM_TASK_LINK_INVALID');
  if (
    link.state === 'VALID' &&
    (link.metadata.issue_number !== input.issueNumber ||
      link.metadata.agent_id !== input.agentId ||
      link.metadata.claim_ref !== claim.claim_ref ||
      (claim.task_id !== undefined && link.metadata.task_id !== claim.task_id))
  ) {
    throw new ClaimLifecycleFailure('CLAIM_TASK_LINK_MISMATCH');
  }
}

function mergedUnderClaim(mergedAt: string | null | undefined, claim: ObservedClaim): boolean {
  const mergeTime = Date.parse(mergedAt ?? '');
  const claimed = commentTime(claim.comment, claim.claimed_at);
  // Two separate GitHub resources with the same second have no provable ordering.
  return claim.comment.created_at ? mergeTime > claimed : mergeTime >= claimed;
}

async function verifiedRecovery(
  operation: 'review' | 'complete',
  client: GitHubClient,
  claim: ObservedClaim,
  input: ReviewClaimInput,
): Promise<Pick<ClaimLifecycleResult, 'recoveryCommand' | 'guidance'>> {
  try {
    await requireSameCurrentClaim(client, claim);
    if (operation === 'review') await requireClaimRef(client, input.issueNumber);
    return { recoveryCommand: recoveryCommand(operation, input) };
  } catch (error) {
    return {
      guidance:
        failureCode(error) === 'CLAIM_RECONCILIATION_REQUIRED'
          ? reconcileGuidance
          : 'Verify the current claim generation and lifecycle state before retrying.',
    };
  }
}

export async function reviewClaim(
  input: ReviewClaimInput,
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaimLifecycleResult> {
  let owner: string | undefined;
  let prUrl: string | undefined;
  try {
    validateCommonInput(input.issueNumber, input.agentId);
    const claimRef = issueClaimRef(input.issueNumber, 'canonical');
    const client = await requireLiveClient(dependencies, input.repository);
    const pullRequest = normalizePullRequest(input.prUrl, client);
    prUrl = pullRequest.url;
    const target = { owner: client.owner, repo: client.repo };
    await requireClaimRef(client, input.issueNumber);
    const { comments, serverTime } = await readClaimComments(client, input.issueNumber);
    const claim = resolveStrictClaim(comments, input.issueNumber, claimRef);
    owner = claim.agent_id;
    requireMatchingOwner(owner, input.agentId);
    const { data: pull } = await client.octokit.pulls.get({
      ...target,
      pull_number: pullRequest.number,
    });
    if (pull.merged && !mergedUnderClaim(pull.merged_at, claim)) {
      return failedResult('review', input, 'CLAIM_RECONCILIATION_REQUIRED', {
        owner,
        prUrl,
        postconditions: [{ name: 'pr_merged', satisfied: true }],
        guidance: reconcileGuidance,
      });
    }
    verifyClaimPullLink(pull.body, input, claim);
    const initialLabels = await issueLabels(client, input.issueNumber);
    if (initialLabels.has('openslack:done')) {
      return failedResult('review', input, 'CLAIM_REQUEUE_RECONCILIATION_REQUIRED', {
        owner,
        prUrl,
        postconditions: [{ name: 'done_label_present', satisfied: true }],
        guidance: requeueGuidance,
      });
    }
    const reviewAlreadyRecorded = reviewEvidencePresent(comments, input, claim, prUrl, client);
    await requireSameCurrentClaim(client, claim);

    let mutationFailed = false;
    const issue = { ...target, issue_number: input.issueNumber };
    for (const label of PRE_REVIEW_LABELS.filter((entry) => initialLabels.has(entry))) {
      try {
        await client.octokit.issues.removeLabel({ ...issue, name: label });
      } catch (error) {
        if (statusOf(error) !== 404) mutationFailed = true;
      }
    }
    try {
      if (!initialLabels.has('openslack:review')) {
        await client.octokit.issues.addLabels({ ...issue, labels: ['openslack:review'] });
      }
      if (!reviewAlreadyRecorded) {
        await client.octokit.issues.createComment({
          ...issue,
          body: renderClaimReviewMetadata({
            schema: 'openslack.claim_review.v1',
            issue_number: input.issueNumber,
            agent_id: input.agentId,
            claim_ref: claimRef,
            pr_url: prUrl,
            reviewed_at: new Date(serverTime ?? dependencies.now().getTime()).toISOString(),
            claim_id: claim.claim_id,
          }),
        });
      }
    } catch {
      mutationFailed = true;
    }

    const postconditions: ClaimLifecyclePostcondition[] = [];
    const recoveryInput = { ...input, prUrl };
    const attemptedWrite =
      !initialLabels.has('openslack:review') ||
      !reviewAlreadyRecorded ||
      PRE_REVIEW_LABELS.some((label) => initialLabels.has(label));
    try {
      const labels = await issueLabels(client, input.issueNumber);
      const reviewLabelPresent = reviewLabelsComplete(labels);
      postconditions.push({ name: 'review_label_present', satisfied: reviewLabelPresent });
      const { comments: updated } = await readClaimComments(client, input.issueNumber);
      const current = resolveStrictClaim(updated, input.issueNumber, claimRef);
      const ownerMatches = sameClaim(claim, current);
      const prLinkPresent =
        ownerMatches && reviewEvidencePresent(updated, input, current, prUrl, client);
      const refPresent = !(await claimRefIsAbsent(client, input.issueNumber));
      postconditions.push(
        { name: 'claim_ref_present', satisfied: refPresent },
        { name: 'owner_matches', satisfied: ownerMatches },
        { name: 'pr_link_present', satisfied: prLinkPresent },
      );
      if (!refPresent || !ownerMatches)
        throw new ClaimLifecycleFailure('CLAIM_RECONCILIATION_REQUIRED');
      if (!reviewLabelPresent || !prLinkPresent || mutationFailed) {
        throw new ClaimLifecycleFailure('CLAIM_REVIEW_TRANSITION_FAILED');
      }
    } catch (error) {
      const code = failureCode(error);
      return failedResult(
        'review',
        input,
        attemptedWrite && code === 'CLAIM_API_UNAVAILABLE' ? 'CLAIM_PARTIAL_STATE' : code,
        {
          outcome: attemptedWrite ? 'partial' : 'failed',
          owner,
          prUrl,
          postconditions,
          ...(code === 'CLAIM_RECONCILIATION_REQUIRED'
            ? { guidance: reconcileGuidance }
            : attemptedWrite
              ? await verifiedRecovery('review', client, claim, recoveryInput)
              : {}),
        },
      );
    }
    return {
      schema: 'openslack.claim_lifecycle.v1',
      operation: 'review',
      outcome: 'completed',
      issueNumber: input.issueNumber,
      claimRef,
      agentId: input.agentId,
      owner,
      prUrl,
      postconditions,
    };
  } catch (error) {
    const code = failureCode(error);
    return failedResult('review', input, code, {
      owner,
      prUrl,
      ...(code === 'CLAIM_RECONCILIATION_REQUIRED' ? { guidance: reconcileGuidance } : {}),
    });
  }
}

export async function completeClaim(
  input: CompleteClaimInput,
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaimLifecycleResult> {
  let owner: string | undefined;
  let prUrl: string | undefined;
  const facts = new Map<ClaimLifecyclePostconditionName, boolean>();
  const postconditions = () => [...facts].map(([name, satisfied]) => ({ name, satisfied }));
  try {
    validateCommonInput(input.issueNumber, input.agentId);
    const claimRef = issueClaimRef(input.issueNumber, 'canonical');
    const client = await requireLiveClient(dependencies, input.repository);
    const pullRequest = normalizePullRequest(input.prUrl, client);
    prUrl = pullRequest.url;
    const target = { owner: client.owner, repo: client.repo };
    const { comments } = await readClaimComments(client, input.issueNumber);
    const claim = resolveStrictClaim(comments, input.issueNumber, claimRef);
    owner = claim.agent_id;
    const { data: pull } = await client.octokit.pulls.get({
      ...target,
      pull_number: pullRequest.number,
    });
    facts.set('pr_merged', pull.merged);
    if (!pull.merged) throw new ClaimLifecycleFailure('CLAIM_POSTCONDITION_FAILED');
    if (!mergedUnderClaim(pull.merged_at, claim)) {
      throw new ClaimLifecycleFailure('CLAIM_RECONCILIATION_REQUIRED');
    }
    facts.set('owner_matches', owner === input.agentId);
    requireMatchingOwner(owner, input.agentId);
    verifyClaimPullLink(pull.body, input, claim);
    const prLinkPresent = reviewEvidencePresent(comments, input, claim, prUrl, client);
    facts.set('pr_link_present', prLinkPresent);
    if (!prLinkPresent) throw new ClaimLifecycleFailure('CLAIM_POSTCONDITION_FAILED');

    const initialRefAbsent = await claimRefIsAbsent(client, input.issueNumber);
    const initialLabels = await issueLabels(client, input.issueNumber);
    facts.set('claim_ref_absent', initialRefAbsent);
    facts.set('done_label_present', initialLabels.has('openslack:done'));
    const active = PRE_COMPLETION_LABELS.filter((label) => initialLabels.has(label));
    if (!initialRefAbsent || !initialLabels.has('openslack:done') || active.length > 0) {
      await requireSameCurrentClaim(client, claim);
      let attemptedWrite = false;
      try {
        const issue = { ...target, issue_number: input.issueNumber };
        for (const name of active) {
          attemptedWrite = true;
          try {
            await client.octokit.issues.removeLabel({ ...issue, name });
          } catch (error) {
            if (statusOf(error) !== 404) throw error;
          }
        }
        if (!initialLabels.has('openslack:done')) {
          await requireSameCurrentClaim(client, claim);
          facts.delete('done_label_present');
          attemptedWrite = true;
          const { data } = await client.octokit.issues.addLabels({
            ...issue,
            labels: ['openslack:done'],
          });
          if (Array.isArray(data))
            facts.set(
              'done_label_present',
              data.some((label) => label.name === 'openslack:done'),
            );
        }
        if (!initialRefAbsent) {
          await requireSameCurrentClaim(client, claim);
          facts.delete('claim_ref_absent');
          attemptedWrite = true;
          try {
            await client.octokit.git.deleteRef({
              ...target,
              ref: issueClaimRef(input.issueNumber),
            });
          } catch (error) {
            if (statusOf(error) !== 404) throw error;
          }
        }

        facts.set('claim_ref_absent', await claimRefIsAbsent(client, input.issueNumber));
        const labels = await issueLabels(client, input.issueNumber);
        facts.set('done_label_present', labels.has('openslack:done'));
        if (
          !facts.get('claim_ref_absent') ||
          !facts.get('done_label_present') ||
          PRE_COMPLETION_LABELS.some((label) => labels.has(label))
        ) {
          throw new ClaimLifecycleFailure('CLAIM_COMPLETION_FAILED');
        }
      } catch (error) {
        if (!attemptedWrite) throw error;
        const code = failureCode(error);
        if (code === 'CLAIM_RECONCILIATION_REQUIRED') facts.set('owner_matches', false);
        return failedResult(
          'complete',
          input,
          code === 'CLAIM_API_UNAVAILABLE' ? 'CLAIM_PARTIAL_STATE' : code,
          {
            outcome: 'partial',
            owner,
            prUrl,
            postconditions: postconditions(),
            ...(code === 'CLAIM_RECONCILIATION_REQUIRED'
              ? { guidance: reconcileGuidance }
              : await verifiedRecovery('complete', client, claim, { ...input, prUrl })),
          },
        );
      }
    }
    return {
      schema: 'openslack.claim_lifecycle.v1',
      operation: 'complete',
      outcome: 'completed',
      issueNumber: input.issueNumber,
      claimRef,
      agentId: input.agentId,
      owner,
      prUrl,
      postconditions: postconditions(),
    };
  } catch (error) {
    const code = failureCode(error);
    if (code === 'CLAIM_RECONCILIATION_REQUIRED') facts.delete('owner_matches');
    return failedResult('complete', input, code, {
      owner,
      prUrl,
      postconditions: postconditions(),
      ...(code === 'CLAIM_RECONCILIATION_REQUIRED' ? { guidance: reconcileGuidance } : {}),
    });
  }
}

export function renderClaimLifecycleResult(result: ClaimLifecycleResult): string {
  const status = result.outcome === 'completed' ? 'PASS' : result.outcome.toUpperCase();
  const lines = [
    `${status}: claim ${result.operation} for issue #${result.issueNumber}`,
    `Claim ref: ${result.claimRef}`,
    `Agent: ${result.agentId}`,
  ];
  if (result.owner) lines.push(`Owner: ${result.owner}`);
  if (result.prUrl) lines.push(`PR: ${result.prUrl}`);
  if (result.expiresAt) lines.push(`Expires: ${result.expiresAt}`);
  if (result.ttlMinutes) lines.push(`TTL: ${result.ttlMinutes} minutes`);
  if (result.heartbeatMinutes) lines.push(`Heartbeat interval: ${result.heartbeatMinutes} minutes`);
  if (result.nextHeartbeatAt) lines.push(`Next heartbeat: ${result.nextHeartbeatAt}`);
  for (const postcondition of result.postconditions) {
    lines.push(`- ${postcondition.satisfied ? 'PASS' : 'FAIL'} ${postcondition.name}`);
  }
  if (result.errorCode) lines.push(`Error: ${result.errorCode}`);
  if (result.recoveryCommand) lines.push(`Recovery: ${result.recoveryCommand}`);
  if (result.guidance) lines.push(`Guidance: ${result.guidance}`);
  return lines.join('\n');
}
