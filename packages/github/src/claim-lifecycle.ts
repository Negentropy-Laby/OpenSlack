import { getClient, type GitHubClient, type GitHubClientOptions } from './client.js';
import { parseClaimMetadata } from './claims.js';

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
  | 'CLAIM_OWNER_MISSING'
  | 'CLAIM_OWNER_MISMATCH'
  | 'CLAIM_API_UNAVAILABLE'
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
  postconditions: ClaimLifecyclePostcondition[];
  errorCode?: ClaimLifecycleErrorCode;
  recoveryCommand?: string;
}

export interface HeartbeatClaimInput {
  issueNumber: number;
  agentId: string;
  ttlMinutes?: number;
}

export interface ReviewClaimInput {
  issueNumber: number;
  agentId: string;
  prUrl: string;
}

export type CompleteClaimInput = ReviewClaimInput;

export interface ClaimLifecycleDependencies {
  getClient(options?: GitHubClientOptions): Promise<GitHubClient>;
  now(): Date;
}

interface HeartbeatMetadata {
  schema: 'openslack.heartbeat.v1';
  issue_number: number;
  agent_id: string;
  heartbeat_at: string;
  expires_at: string;
  claim_ref: string;
}

export interface ClaimReviewMetadata {
  schema: 'openslack.claim_review.v1';
  issue_number: number;
  agent_id: string;
  claim_ref: string;
  pr_url: string;
  reviewed_at: string;
}

const DEFAULT_DEPENDENCIES: ClaimLifecycleDependencies = {
  getClient,
  now: () => new Date(),
};

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CLAIM_COMMENT_PAGE_SIZE = 100;
const CLAIM_COMMENT_MAX_PAGES = 10;
const HEARTBEAT_RETRY_DEDUP_WINDOW_MS = 60_000;

class ClaimLifecycleFailure extends Error {
  constructor(readonly code: ClaimLifecycleErrorCode) {
    super(code);
    this.name = 'ClaimLifecycleFailure';
  }
}

function canonicalClaimRef(issueNumber: number): string {
  return `refs/heads/openslack/claims/issue-${issueNumber}`;
}

function apiClaimRef(issueNumber: number): string {
  return `heads/openslack/claims/issue-${issueNumber}`;
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
      parts.length !== 4 ||
      parts[0].toLowerCase() !== client.owner.toLowerCase() ||
      parts[1].toLowerCase() !== client.repo.toLowerCase() ||
      parts[2] !== 'pull' ||
      !/^\d+$/.test(parts[3])
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
    typeof parsed.claim_ref !== 'string'
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
    typeof parsed.reviewed_at !== 'string'
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

async function requireLiveClient(dependencies: ClaimLifecycleDependencies): Promise<GitHubClient> {
  const client = await dependencies.getClient({ requireLive: true });
  if (client.isDryRun) throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
  return client;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

async function listClaimComments(client: GitHubClient, issueNumber: number) {
  const comments = [];
  for (let page = 1; page <= CLAIM_COMMENT_MAX_PAGES; page += 1) {
    const response = await client.octokit.issues.listComments({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      sort: 'created',
      direction: 'desc',
      per_page: CLAIM_COMMENT_PAGE_SIZE,
      page,
    });
    comments.push(...response.data);
    if (response.data.length < CLAIM_COMMENT_PAGE_SIZE) return comments;
  }
  throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
}

function resolveStrictOwner(
  comments: Array<{ body?: string | null }>,
  issueNumber: number,
  claimRef: string,
): string {
  const claimOwners = new Set<string>();
  const heartbeatOwners = new Set<string>();
  for (const comment of comments) {
    const claim = parseClaimMetadata(comment.body);
    if (
      claim?.issue_number === issueNumber &&
      claim.claim_ref === claimRef &&
      AGENT_ID_PATTERN.test(claim.agent_id)
    ) {
      claimOwners.add(claim.agent_id);
    }
    const heartbeat = parseHeartbeatMetadata(comment.body);
    if (
      heartbeat?.issue_number === issueNumber &&
      heartbeat.claim_ref === claimRef &&
      AGENT_ID_PATTERN.test(heartbeat.agent_id)
    ) {
      heartbeatOwners.add(heartbeat.agent_id);
    }
  }
  // The original claim marker is authoritative. Heartbeats preserve owner
  // continuity only for legacy/truncated histories where no claim marker is
  // available; a conflicting heartbeat cannot override a real claim.
  const owners = claimOwners.size > 0 ? claimOwners : heartbeatOwners;
  if (owners.size === 0) throw new ClaimLifecycleFailure('CLAIM_OWNER_MISSING');
  if (owners.size !== 1) throw new ClaimLifecycleFailure('CLAIM_OWNER_MISMATCH');
  return [...owners][0];
}

function requireMatchingOwner(owner: string, agentId: string): void {
  if (owner !== agentId) throw new ClaimLifecycleFailure('CLAIM_OWNER_MISMATCH');
}

async function requireClaimRef(client: GitHubClient, issueNumber: number): Promise<void> {
  try {
    await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref: apiClaimRef(issueNumber),
    });
  } catch (error) {
    if (statusOf(error) === 404) throw new ClaimLifecycleFailure('CLAIM_REF_NOT_FOUND');
    throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
  }
}

async function claimRefIsAbsent(client: GitHubClient, issueNumber: number): Promise<boolean> {
  try {
    await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref: apiClaimRef(issueNumber),
    });
    return false;
  } catch (error) {
    if (statusOf(error) === 404) return true;
    throw new ClaimLifecycleFailure('CLAIM_API_UNAVAILABLE');
  }
}

async function issueLabels(client: GitHubClient, issueNumber: number): Promise<Set<string>> {
  const response = await client.octokit.issues.get({
    owner: client.owner,
    repo: client.repo,
    issue_number: issueNumber,
  });
  return new Set(
    response.data.labels
      .map((label) => (typeof label === 'string' ? label : label.name))
      .filter((label): label is string => Boolean(label)),
  );
}

function reviewEvidencePresent(
  comments: Array<{ body?: string | null }>,
  input: ReviewClaimInput,
  claimRef: string,
  prUrl: string,
): boolean {
  return comments.some((comment) => {
    const metadata = parseClaimReviewMetadata(comment.body);
    return (
      metadata?.issue_number === input.issueNumber &&
      metadata.agent_id === input.agentId &&
      metadata.claim_ref === claimRef &&
      metadata.pr_url === prUrl
    );
  });
}

function findRecentMatchingHeartbeat(
  comments: Array<{ body?: string | null }>,
  input: HeartbeatClaimInput,
  claimRef: string,
  ttlMinutes: number,
  now: Date,
): HeartbeatMetadata | undefined {
  const nowMs = now.getTime();
  const expectedLeaseMs = ttlMinutes * 60_000;
  for (const comment of comments) {
    const metadata = parseHeartbeatMetadata(comment.body);
    if (
      metadata?.issue_number !== input.issueNumber ||
      metadata.agent_id !== input.agentId ||
      metadata.claim_ref !== claimRef
    ) {
      continue;
    }
    const heartbeatMs = Date.parse(metadata.heartbeat_at);
    const expiresMs = Date.parse(metadata.expires_at);
    if (
      Number.isFinite(heartbeatMs) &&
      Number.isFinite(expiresMs) &&
      nowMs >= heartbeatMs &&
      nowMs - heartbeatMs <= HEARTBEAT_RETRY_DEDUP_WINDOW_MS &&
      expiresMs - heartbeatMs === expectedLeaseMs &&
      expiresMs > nowMs
    ) {
      return metadata;
    }
  }
  return undefined;
}

function recoveryCommand(operation: ClaimLifecycleOperation, input: ReviewClaimInput): string {
  return `openslack github claim ${operation} --issue-number ${input.issueNumber} --agent-id ${input.agentId} --pr-url ${input.prUrl}`;
}

function heartbeatRecoveryCommand(input: HeartbeatClaimInput, ttlMinutes: number): string {
  return `openslack github claim heartbeat --issue-number ${input.issueNumber} --agent-id ${input.agentId} --ttl-minutes ${ttlMinutes}`;
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
    postconditions?: ClaimLifecyclePostcondition[];
    recoveryCommand?: string;
  } = {},
): ClaimLifecycleResult {
  return {
    schema: 'openslack.claim_lifecycle.v1',
    operation,
    outcome: options.outcome ?? 'failed',
    issueNumber: input.issueNumber,
    claimRef: canonicalClaimRef(input.issueNumber),
    agentId: input.agentId,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.prUrl ? { prUrl: options.prUrl } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    postconditions: options.postconditions ?? [],
    errorCode: code,
    ...(options.recoveryCommand ? { recoveryCommand: options.recoveryCommand } : {}),
  };
}

function failureCode(error: unknown): ClaimLifecycleErrorCode {
  return error instanceof ClaimLifecycleFailure ? error.code : 'CLAIM_API_UNAVAILABLE';
}

export async function heartbeatClaim(
  input: HeartbeatClaimInput,
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaimLifecycleResult> {
  const ttlMinutes = input.ttlMinutes ?? 60;
  const claimRef = canonicalClaimRef(input.issueNumber);
  let owner: string | undefined;
  try {
    validateCommonInput(input.issueNumber, input.agentId);
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 120) {
      throw new ClaimLifecycleFailure('CLAIM_INVALID_INPUT');
    }
    const client = await requireLiveClient(dependencies);
    await requireClaimRef(client, input.issueNumber);
    const comments = await listClaimComments(client, input.issueNumber);
    owner = resolveStrictOwner(comments, input.issueNumber, claimRef);
    requireMatchingOwner(owner, input.agentId);

    const now = dependencies.now();
    const existingHeartbeat = findRecentMatchingHeartbeat(
      comments,
      input,
      claimRef,
      ttlMinutes,
      now,
    );
    if (existingHeartbeat) {
      return {
        schema: 'openslack.claim_lifecycle.v1',
        operation: 'heartbeat',
        outcome: 'completed',
        issueNumber: input.issueNumber,
        claimRef,
        agentId: input.agentId,
        owner,
        expiresAt: existingHeartbeat.expires_at,
        postconditions: [
          { name: 'claim_ref_present', satisfied: true },
          { name: 'owner_matches', satisfied: true },
          { name: 'heartbeat_recorded', satisfied: true },
        ],
      };
    }
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
    const body = renderHeartbeatMetadata({
      schema: 'openslack.heartbeat.v1',
      issue_number: input.issueNumber,
      agent_id: input.agentId,
      heartbeat_at: now.toISOString(),
      expires_at: expiresAt,
      claim_ref: claimRef,
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
        metadata.expires_at !== expiresAt
      ) {
        throw new ClaimLifecycleFailure('CLAIM_POSTCONDITION_FAILED');
      }
    } catch {
      return failedResult('heartbeat', input, 'CLAIM_POSTCONDITION_FAILED', {
        outcome: 'partial',
        owner,
        expiresAt,
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

export async function reviewClaim(
  input: ReviewClaimInput,
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaimLifecycleResult> {
  const claimRef = canonicalClaimRef(input.issueNumber);
  let owner: string | undefined;
  let prUrl: string | undefined;
  try {
    validateCommonInput(input.issueNumber, input.agentId);
    const client = await requireLiveClient(dependencies);
    prUrl = normalizePullRequest(input.prUrl, client).url;
    await requireClaimRef(client, input.issueNumber);
    const comments = await listClaimComments(client, input.issueNumber);
    owner = resolveStrictOwner(comments, input.issueNumber, claimRef);
    requireMatchingOwner(owner, input.agentId);
    const reviewAlreadyRecorded = reviewEvidencePresent(comments, input, claimRef, prUrl);

    let mutationFailed = false;
    for (const label of [
      'openslack:ready',
      'openslack:claimed',
      'openslack:running',
      'openslack:blocked',
    ]) {
      try {
        await client.octokit.issues.removeLabel({
          owner: client.owner,
          repo: client.repo,
          issue_number: input.issueNumber,
          name: label,
        });
      } catch (error) {
        if (statusOf(error) !== 404) mutationFailed = true;
      }
    }
    try {
      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: input.issueNumber,
        labels: ['openslack:review'],
      });
    } catch {
      mutationFailed = true;
    }
    if (!reviewAlreadyRecorded) {
      try {
        await client.octokit.issues.createComment({
          owner: client.owner,
          repo: client.repo,
          issue_number: input.issueNumber,
          body: renderClaimReviewMetadata({
            schema: 'openslack.claim_review.v1',
            issue_number: input.issueNumber,
            agent_id: input.agentId,
            claim_ref: claimRef,
            pr_url: prUrl,
            reviewed_at: dependencies.now().toISOString(),
          }),
        });
      } catch {
        mutationFailed = true;
      }
    }

    let labels: Set<string>;
    let updatedComments: Array<{ body?: string | null }>;
    try {
      labels = await issueLabels(client, input.issueNumber);
      updatedComments = await listClaimComments(client, input.issueNumber);
    } catch {
      return failedResult('review', input, 'CLAIM_PARTIAL_STATE', {
        outcome: 'partial',
        owner,
        prUrl,
        postconditions: [
          { name: 'claim_ref_present', satisfied: true },
          { name: 'owner_matches', satisfied: true },
          { name: 'review_label_present', satisfied: false },
          { name: 'pr_link_present', satisfied: false },
        ],
        recoveryCommand: recoveryCommand('review', { ...input, prUrl }),
      });
    }
    const reviewLabelPresent = labels.has('openslack:review');
    const prLinkPresent = reviewEvidencePresent(updatedComments, input, claimRef, prUrl);
    const postconditions: ClaimLifecyclePostcondition[] = [
      { name: 'claim_ref_present', satisfied: true },
      { name: 'owner_matches', satisfied: true },
      { name: 'review_label_present', satisfied: reviewLabelPresent },
      { name: 'pr_link_present', satisfied: prLinkPresent },
    ];
    if (!reviewLabelPresent || !prLinkPresent || mutationFailed) {
      return failedResult('review', input, 'CLAIM_REVIEW_TRANSITION_FAILED', {
        outcome: 'partial',
        owner,
        prUrl,
        postconditions,
        recoveryCommand: recoveryCommand('review', { ...input, prUrl }),
      });
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
    return failedResult('review', input, failureCode(error), { owner, prUrl });
  }
}

export async function completeClaim(
  input: CompleteClaimInput,
  dependencies: ClaimLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaimLifecycleResult> {
  const claimRef = canonicalClaimRef(input.issueNumber);
  let owner: string | undefined;
  let prUrl: string | undefined;
  try {
    validateCommonInput(input.issueNumber, input.agentId);
    const client = await requireLiveClient(dependencies);
    const pullRequest = normalizePullRequest(input.prUrl, client);
    prUrl = pullRequest.url;
    const comments = await listClaimComments(client, input.issueNumber);
    owner = resolveStrictOwner(comments, input.issueNumber, claimRef);
    requireMatchingOwner(owner, input.agentId);
    if (!reviewEvidencePresent(comments, input, claimRef, prUrl)) {
      throw new ClaimLifecycleFailure('CLAIM_POSTCONDITION_FAILED');
    }
    try {
      const pull = await client.octokit.pulls.get({
        owner: client.owner,
        repo: client.repo,
        pull_number: pullRequest.number,
      });
      if (!pull.data.merged) {
        return failedResult('complete', input, 'CLAIM_POSTCONDITION_FAILED', {
          owner,
          prUrl,
          postconditions: [
            { name: 'owner_matches', satisfied: true },
            { name: 'pr_link_present', satisfied: true },
            { name: 'pr_merged', satisfied: false },
          ],
        });
      }
    } catch (error) {
      return failedResult(
        'complete',
        input,
        statusOf(error) === 404 ? 'CLAIM_POSTCONDITION_FAILED' : 'CLAIM_API_UNAVAILABLE',
        {
          owner,
          prUrl,
          postconditions: [
            { name: 'owner_matches', satisfied: true },
            { name: 'pr_link_present', satisfied: true },
            { name: 'pr_merged', satisfied: false },
          ],
        },
      );
    }

    let mutationFailed = false;
    for (const label of ['openslack:claimed', 'openslack:running', 'openslack:review']) {
      try {
        await client.octokit.issues.removeLabel({
          owner: client.owner,
          repo: client.repo,
          issue_number: input.issueNumber,
          name: label,
        });
      } catch (error) {
        if (statusOf(error) !== 404) mutationFailed = true;
      }
    }
    try {
      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: input.issueNumber,
        labels: ['openslack:done'],
      });
    } catch {
      mutationFailed = true;
    }
    try {
      await client.octokit.git.deleteRef({
        owner: client.owner,
        repo: client.repo,
        ref: apiClaimRef(input.issueNumber),
      });
    } catch (error) {
      if (statusOf(error) !== 404) mutationFailed = true;
    }

    let refAbsent: boolean;
    let labels: Set<string>;
    try {
      refAbsent = await claimRefIsAbsent(client, input.issueNumber);
      labels = await issueLabels(client, input.issueNumber);
    } catch {
      return failedResult('complete', input, 'CLAIM_PARTIAL_STATE', {
        outcome: 'partial',
        owner,
        prUrl,
        postconditions: [
          { name: 'owner_matches', satisfied: true },
          { name: 'pr_link_present', satisfied: true },
          { name: 'pr_merged', satisfied: true },
          { name: 'claim_ref_absent', satisfied: false },
          { name: 'done_label_present', satisfied: false },
        ],
        recoveryCommand: recoveryCommand('complete', { ...input, prUrl }),
      });
    }
    const doneLabelPresent = labels.has('openslack:done');
    const postconditions: ClaimLifecyclePostcondition[] = [
      { name: 'owner_matches', satisfied: true },
      { name: 'pr_link_present', satisfied: true },
      { name: 'pr_merged', satisfied: true },
      { name: 'claim_ref_absent', satisfied: refAbsent },
      { name: 'done_label_present', satisfied: doneLabelPresent },
    ];
    if (!refAbsent || !doneLabelPresent || mutationFailed) {
      return failedResult('complete', input, 'CLAIM_COMPLETION_FAILED', {
        outcome: 'partial',
        owner,
        prUrl,
        postconditions,
        recoveryCommand: recoveryCommand('complete', { ...input, prUrl }),
      });
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
      postconditions,
    };
  } catch (error) {
    return failedResult('complete', input, failureCode(error), { owner, prUrl });
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
  for (const postcondition of result.postconditions) {
    lines.push(`- ${postcondition.satisfied ? 'PASS' : 'FAIL'} ${postcondition.name}`);
  }
  if (result.errorCode) lines.push(`Error: ${result.errorCode}`);
  if (result.recoveryCommand) lines.push(`Recovery: ${result.recoveryCommand}`);
  return lines.join('\n');
}
