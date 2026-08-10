import { randomUUID } from 'node:crypto';
import { isRiskZone, type AgentPrincipal, type RiskZone } from '@openslack/kernel';
import { getClient, type GitHubClient } from './client.js';
import {
  createIssueTaskSnapshot,
  issueTaskSnapshotMatches,
  type IssueTaskSnapshot,
  type IssueTaskSnapshotInput,
} from './issue-task-snapshot.js';

type ClaimClientFactory = typeof getClient;

export interface ClaimProjection {
  status: 'synchronized' | 'repair_required';
  recoveryCommand?: 'openslack github repair claims --apply';
}

export type IssueClaimResult =
  | {
      claimStatus: 'granted';
      issueNumber: number;
      claimRef: string;
      taskSnapshotSha256: string;
      lease: {
        expiresAt: string;
        ttlMinutes: number;
        heartbeatMinutes: number;
        nextHeartbeatAt: string;
      };
      projection: ClaimProjection;
    }
  | {
      claimStatus: 'denied';
      issueNumber: number;
      claimRef: string;
      reason: 'ALREADY_CLAIMED' | 'STALE_CANDIDATE' | 'RECONCILIATION_REQUIRED' | 'API_ERROR';
    };

export interface ClaimMetadata {
  schema: 'openslack.claim.v1';
  issue_number: number;
  agent_id: string;
  claim_ref: string;
  claimed_at: string;
  expires_at: string;
  principal: {
    registry_id: string;
    run_id: string;
    provider: AgentPrincipal['provider'];
  };
  claim_id?: string;
  task_snapshot_sha256?: string;
  task_id?: string;
  task_updated_at?: string;
  risk_zone?: RiskZone;
  ttl_minutes?: number;
  heartbeat_minutes?: number;
  next_heartbeat_at?: string;
}

interface CurrentClaimMetadata extends ClaimMetadata {
  claim_id: string;
  task_snapshot_sha256: string;
  task_id: string;
  task_updated_at: string;
  risk_zone: RiskZone;
  ttl_minutes: number;
  heartbeat_minutes: number;
  next_heartbeat_at: string;
}

const CLAIM_COMMENT_PAGE_SIZE = 100;
const CLAIM_COMMENT_MAX_PAGES = 10;
const CLAIM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RECOVERY_COMMAND = 'openslack github repair claims --apply' as const;

function principalMetadata(principal: AgentPrincipal): ClaimMetadata['principal'] {
  return {
    registry_id: principal.registry_id,
    run_id: principal.run_id,
    provider: principal.provider,
  };
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function apiClaimRef(issueNumber: number): string {
  return `heads/openslack/claims/issue-${issueNumber}`;
}

function canonicalClaimRef(issueNumber: number): string {
  return `refs/${apiClaimRef(issueNumber)}`;
}

function labelsOf(issue: { labels: Array<string | { name?: string | null }> }): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name || ''));
}

function snapshotInputOf(issue: {
  number: number;
  node_id: string;
  state?: unknown;
  labels: Array<string | { name?: string | null }>;
  body?: string | null;
  updated_at?: unknown;
}): IssueTaskSnapshotInput {
  return {
    issueNumber: issue.number,
    issueNodeId: issue.node_id,
    state: issue.state === 'open' || issue.state === 'closed' ? issue.state : 'unknown',
    labels: labelsOf(issue),
    body: issue.body || '',
    updatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : '',
  };
}

async function listClaimComments(client: GitHubClient, issueNumber: number) {
  const comments: Array<{ body?: string | null }> = [];
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
  throw new Error('Claim comment evidence exceeded the bounded read limit.');
}

async function claimRefExists(client: GitHubClient, issueNumber: number): Promise<boolean> {
  try {
    await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref: apiClaimRef(issueNumber),
    });
    return true;
  } catch (error) {
    if (statusOf(error) === 404) return false;
    throw error;
  }
}

async function rollbackClaimRef(client: GitHubClient, issueNumber: number): Promise<boolean> {
  try {
    await client.octokit.git.deleteRef({
      owner: client.owner,
      repo: client.repo,
      ref: apiClaimRef(issueNumber),
    });
  } catch {
    // The exact absence check below is the rollback authority.
  }
  try {
    return !(await claimRefExists(client, issueNumber));
  } catch {
    return false;
  }
}

async function projectClaimLabels(
  client: GitHubClient,
  issueNumber: number,
): Promise<ClaimProjection> {
  let mutationFailed = false;
  try {
    await client.octokit.issues.removeLabel({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      name: 'openslack:ready',
    });
  } catch (error) {
    if (statusOf(error) !== 404) mutationFailed = true;
  }
  try {
    await client.octokit.issues.addLabels({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      labels: ['openslack:claimed'],
    });
  } catch {
    mutationFailed = true;
  }
  try {
    const response = await client.octokit.issues.get({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
    });
    const labels = new Set(labelsOf(response.data));
    if (!mutationFailed && labels.has('openslack:claimed') && !labels.has('openslack:ready')) {
      return { status: 'synchronized' };
    }
  } catch {
    // A missing readback makes the non-authoritative projection uncertain.
  }
  return { status: 'repair_required', recoveryCommand: RECOVERY_COMMAND };
}

export function renderClaimComment(metadata: ClaimMetadata, ttlMinutes: number): string {
  const lines = [
    `<!-- openslack-claim`,
    JSON.stringify(metadata, null, 2),
    `-->`,
    '',
    `**Claimed by:** \`${metadata.agent_id}\``,
    `**Claim ref:** \`${metadata.claim_ref}\``,
    `**Expires at:** ${metadata.expires_at}`,
    `**TTL:** ${ttlMinutes} minutes`,
  ];
  if (metadata.next_heartbeat_at) lines.push(`**Next heartbeat:** ${metadata.next_heartbeat_at}`);
  lines.push(
    `**Principal:** \`${metadata.principal.registry_id}\` run=\`${metadata.principal.run_id}\` provider=\`${metadata.principal.provider}\``,
  );
  return lines.join('\n');
}

export function parseClaimMetadata(body: string | null | undefined): ClaimMetadata | null {
  if (!body) return null;
  const match = body.match(/<!--\s*openslack-claim\s*([\s\S]*?)-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as Partial<ClaimMetadata>;
    if (
      parsed.schema !== 'openslack.claim.v1' ||
      !Number.isSafeInteger(parsed.issue_number) ||
      typeof parsed.agent_id !== 'string' ||
      typeof parsed.claim_ref !== 'string' ||
      typeof parsed.claimed_at !== 'string' ||
      typeof parsed.expires_at !== 'string' ||
      !parsed.principal ||
      typeof parsed.principal.registry_id !== 'string' ||
      typeof parsed.principal.run_id !== 'string' ||
      typeof parsed.principal.provider !== 'string'
    ) {
      return null;
    }
    const currentFields = [
      parsed.claim_id,
      parsed.task_snapshot_sha256,
      parsed.task_id,
      parsed.task_updated_at,
      parsed.risk_zone,
      parsed.ttl_minutes,
      parsed.heartbeat_minutes,
      parsed.next_heartbeat_at,
    ];
    const hasCurrentEvidence = currentFields.some((value) => value !== undefined);
    if (
      hasCurrentEvidence &&
      (typeof parsed.claim_id !== 'string' ||
        !CLAIM_ID_PATTERN.test(parsed.claim_id) ||
        !SHA256_PATTERN.test(parsed.task_snapshot_sha256 ?? '') ||
        typeof parsed.task_id !== 'string' ||
        parsed.task_id.length === 0 ||
        typeof parsed.task_updated_at !== 'string' ||
        !Number.isFinite(Date.parse(parsed.task_updated_at)) ||
        !isRiskZone(parsed.risk_zone) ||
        !Number.isSafeInteger(parsed.ttl_minutes) ||
        parsed.ttl_minutes! < 1 ||
        parsed.ttl_minutes! > 480 ||
        !Number.isSafeInteger(parsed.heartbeat_minutes) ||
        parsed.heartbeat_minutes! < 1 ||
        parsed.heartbeat_minutes! > 120 ||
        typeof parsed.next_heartbeat_at !== 'string' ||
        !Number.isFinite(Date.parse(parsed.next_heartbeat_at)))
    ) {
      return null;
    }
    return parsed as ClaimMetadata;
  } catch {
    return null;
  }
}

function parseLegacyClaimOwner(body: string | null | undefined): string | null {
  if (!body) return null;
  const jsonMatch = body.match(/"agent_id":\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  const markdownMatch = body.match(/\*\*Claimed by:\*\*\s*`([^`]+)`/);
  return markdownMatch?.[1] ?? null;
}

export function resolveClaimOwnerFromComments(
  comments: Array<{ body?: string | null }>,
): { agentId: string; structured: boolean } | null {
  for (const comment of comments) {
    const metadata = parseClaimMetadata(comment.body);
    if (metadata) return { agentId: metadata.agent_id, structured: true };
  }
  for (const comment of comments) {
    const agentId = parseLegacyClaimOwner(comment.body);
    if (agentId) return { agentId, structured: false };
  }
  return null;
}

function claimEvidenceMatches(
  actual: ClaimMetadata | null,
  expected: CurrentClaimMetadata,
): boolean {
  return (
    actual?.claim_id === expected.claim_id &&
    actual.issue_number === expected.issue_number &&
    actual.agent_id === expected.agent_id &&
    actual.claim_ref === expected.claim_ref &&
    actual.task_snapshot_sha256 === expected.task_snapshot_sha256 &&
    actual.task_id === expected.task_id &&
    actual.task_updated_at === expected.task_updated_at &&
    actual.risk_zone === expected.risk_zone &&
    actual.ttl_minutes === expected.ttl_minutes &&
    actual.heartbeat_minutes === expected.heartbeat_minutes &&
    actual.next_heartbeat_at === expected.next_heartbeat_at
  );
}

async function confirmClaimEvidence(
  client: GitHubClient,
  issueNumber: number,
  expected: CurrentClaimMetadata,
  commentId?: number,
): Promise<boolean> {
  if (commentId !== undefined) {
    try {
      const response = await client.octokit.issues.getComment({
        owner: client.owner,
        repo: client.repo,
        comment_id: commentId,
      });
      if (claimEvidenceMatches(parseClaimMetadata(response.data.body), expected)) return true;
    } catch {
      // Resolve an ambiguous response from the bounded issue comment ledger.
    }
  }
  try {
    const comments = await listClaimComments(client, issueNumber);
    return comments.some((comment) =>
      claimEvidenceMatches(parseClaimMetadata(comment.body), expected),
    );
  } catch {
    return false;
  }
}

async function reconcileExistingClaimProjection(
  client: GitHubClient,
  issueNumber: number,
): Promise<void> {
  try {
    const claimRef = canonicalClaimRef(issueNumber);
    const claims = (await listClaimComments(client, issueNumber))
      .map((comment) => parseClaimMetadata(comment.body))
      .filter(
        (claim): claim is ClaimMetadata =>
          claim?.issue_number === issueNumber &&
          claim.claim_ref === claimRef &&
          Number.isFinite(Date.parse(claim.claimed_at)),
      )
      .sort((left, right) => Date.parse(right.claimed_at) - Date.parse(left.claimed_at));
    const newestTimestamp = claims[0]?.claimed_at;
    const owners = new Set(
      claims.filter((claim) => claim.claimed_at === newestTimestamp).map((claim) => claim.agent_id),
    );
    if (owners.size === 1) await projectClaimLabels(client, issueNumber);
  } catch {
    // An existing ref remains authoritative; never fabricate missing owner evidence.
  }
}

export async function claimIssueTask(
  args: {
    issueNumber: number;
    agentId: string;
    taskId: string;
    taskSnapshot: IssueTaskSnapshot;
    riskZone: RiskZone;
    ttlMinutes?: number;
    heartbeatMinutes?: number;
    capabilities?: string[];
    principal: AgentPrincipal;
    owner?: string;
    repo?: string;
  },
  getClientFn: ClaimClientFactory = getClient,
): Promise<IssueClaimResult> {
  if (!Number.isSafeInteger(args.issueNumber) || args.issueNumber <= 0) {
    throw new Error('Issue number must be a positive integer.');
  }
  if (
    !args.taskId ||
    args.taskSnapshot.issueNumber !== args.issueNumber ||
    !SHA256_PATTERN.test(args.taskSnapshot.sha256) ||
    !isRiskZone(args.riskZone)
  ) {
    throw new Error('Claim requires a matching canonical task snapshot and task ID.');
  }
  const ttlMinutes = args.ttlMinutes ?? 60;
  const heartbeatMinutes = args.heartbeatMinutes ?? Math.min(15, ttlMinutes);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 480) {
    throw new Error('Claim TTL must be an integer between 1 and 480 minutes.');
  }
  if (!Number.isInteger(heartbeatMinutes) || heartbeatMinutes < 1 || heartbeatMinutes > 120) {
    throw new Error('Claim heartbeat must be an integer between 1 and 120 minutes.');
  }

  const client = await getClientFn();
  const owner = args.owner ?? client.owner;
  const repo = args.repo ?? client.repo;
  const scopedClient = { ...client, owner, repo };
  const ref = canonicalClaimRef(args.issueNumber);
  const claimedAt = new Date();
  const expiresAt = new Date(claimedAt.getTime() + ttlMinutes * 60_000).toISOString();
  const nextHeartbeatAt = new Date(
    Math.min(claimedAt.getTime() + heartbeatMinutes * 60_000, Date.parse(expiresAt)),
  ).toISOString();

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would claim issue #${args.issueNumber} via ref ${ref}`);
    return {
      claimStatus: 'granted',
      issueNumber: args.issueNumber,
      claimRef: ref,
      taskSnapshotSha256: args.taskSnapshot.sha256,
      lease: { expiresAt, ttlMinutes, heartbeatMinutes, nextHeartbeatAt },
      projection: { status: 'synchronized' },
    };
  }

  let refData;
  try {
    ({ data: refData } = await scopedClient.octokit.git.getRef({
      owner,
      repo,
      ref: 'heads/main',
    }));
  } catch {
    return {
      claimStatus: 'denied',
      issueNumber: args.issueNumber,
      claimRef: ref,
      reason: 'API_ERROR',
    };
  }
  try {
    await scopedClient.octokit.git.createRef({
      owner,
      repo,
      ref,
      sha: refData.object.sha,
    });
  } catch (error) {
    if (statusOf(error) === 422) {
      try {
        if (await claimRefExists(scopedClient, args.issueNumber)) {
          await reconcileExistingClaimProjection(scopedClient, args.issueNumber);
          return {
            claimStatus: 'denied',
            issueNumber: args.issueNumber,
            claimRef: ref,
            reason: 'ALREADY_CLAIMED',
          };
        }
      } catch {
        // An unresolvable 422 is an API failure, never evidence of another owner.
      }
    }
    return {
      claimStatus: 'denied',
      issueNumber: args.issueNumber,
      claimRef: ref,
      reason: 'API_ERROR',
    };
  }

  let currentSnapshot: IssueTaskSnapshotInput;
  try {
    const response = await scopedClient.octokit.issues.get({
      owner,
      repo,
      issue_number: args.issueNumber,
    });
    currentSnapshot = snapshotInputOf(response.data);
  } catch {
    const rolledBack = await rollbackClaimRef(scopedClient, args.issueNumber);
    return {
      claimStatus: 'denied',
      issueNumber: args.issueNumber,
      claimRef: ref,
      reason: rolledBack ? 'API_ERROR' : 'RECONCILIATION_REQUIRED',
    };
  }
  let snapshotMatches = false;
  try {
    snapshotMatches = issueTaskSnapshotMatches(args.taskSnapshot, currentSnapshot);
  } catch {
    // A malformed or incomplete readback is a stale candidate, never a reason
    // to leave the tentative authority ref behind.
  }
  if (!snapshotMatches) {
    const rolledBack = await rollbackClaimRef(scopedClient, args.issueNumber);
    return {
      claimStatus: 'denied',
      issueNumber: args.issueNumber,
      claimRef: ref,
      reason: rolledBack ? 'STALE_CANDIDATE' : 'RECONCILIATION_REQUIRED',
    };
  }

  const metadata: CurrentClaimMetadata = {
    schema: 'openslack.claim.v1',
    claim_id: randomUUID(),
    issue_number: args.issueNumber,
    agent_id: args.agentId,
    claim_ref: ref,
    claimed_at: claimedAt.toISOString(),
    expires_at: expiresAt,
    task_snapshot_sha256: args.taskSnapshot.sha256,
    task_id: args.taskId,
    task_updated_at: args.taskSnapshot.updatedAt,
    risk_zone: args.riskZone,
    ttl_minutes: ttlMinutes,
    heartbeat_minutes: heartbeatMinutes,
    next_heartbeat_at: nextHeartbeatAt,
    principal: principalMetadata(args.principal),
  };

  let commentId: number | undefined;
  try {
    const response = await scopedClient.octokit.issues.createComment({
      owner,
      repo,
      issue_number: args.issueNumber,
      body: renderClaimComment(metadata, ttlMinutes),
    });
    if (Number.isSafeInteger(response.data.id)) commentId = response.data.id;
  } catch {
    // A response loss is resolved by reading back claim_id from the comment ledger.
  }
  if (!(await confirmClaimEvidence(scopedClient, args.issueNumber, metadata, commentId))) {
    const rolledBack = await rollbackClaimRef(scopedClient, args.issueNumber);
    return {
      claimStatus: 'denied',
      issueNumber: args.issueNumber,
      claimRef: ref,
      reason: rolledBack ? 'API_ERROR' : 'RECONCILIATION_REQUIRED',
    };
  }
  try {
    if (!(await claimRefExists(scopedClient, args.issueNumber))) {
      return {
        claimStatus: 'denied',
        issueNumber: args.issueNumber,
        claimRef: ref,
        reason: 'RECONCILIATION_REQUIRED',
      };
    }
  } catch {
    return {
      claimStatus: 'denied',
      issueNumber: args.issueNumber,
      claimRef: ref,
      reason: 'RECONCILIATION_REQUIRED',
    };
  }

  return {
    claimStatus: 'granted',
    issueNumber: args.issueNumber,
    claimRef: ref,
    taskSnapshotSha256: args.taskSnapshot.sha256,
    lease: { expiresAt, ttlMinutes, heartbeatMinutes, nextHeartbeatAt },
    projection: await projectClaimLabels(scopedClient, args.issueNumber),
  };
}

export async function expireIssueClaim(issueNumber: number): Promise<void> {
  const client = await getClient();
  const ref = apiClaimRef(issueNumber);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would expire claim for issue #${issueNumber}`);
    return;
  }
  try {
    await client.octokit.git.deleteRef({ owner: client.owner, repo: client.repo, ref });
  } catch {
    // An exact repair pass can reconcile a partially expired claim.
  }
  try {
    for (const label of ['openslack:claimed', 'openslack:running']) {
      try {
        await client.octokit.issues.removeLabel({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch {
        // Projection repair is idempotent.
      }
    }
    await client.octokit.issues.addLabels({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      labels: ['openslack:ready'],
    });
    await client.octokit.issues.createComment({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      body: 'Lease expired. Task returned to ready queue.',
    });
  } catch {
    // The claim ref remains the authority; repair can restore labels.
  }
}

export { createIssueTaskSnapshot };
