import { getClient, type GitHubClient } from './client.js';
import { parseHeartbeatMetadata } from './claim-lifecycle.js';
import { parseClaimMetadata, type ClaimMetadata } from './claims.js';

export interface RepairResult {
  action: string;
  issueNumber?: number;
  fixed: boolean;
  planned?: boolean;
  detail: string;
}

export interface RepairOptions {
  dryRun?: boolean;
}

type RepairClientFactory = typeof getClient;

export const REQUIRED_OPENSLACK_LABELS = [
  { name: 'openslack:task', color: '1f6feb', description: 'OpenSlack task (from EVOL or manual)' },
  { name: 'openslack:ready', color: '2da44e', description: 'Ready for agent claim' },
  { name: 'openslack:claimed', color: 'fbca04', description: 'Claimed by an agent' },
  { name: 'openslack:running', color: 'd29922', description: 'Agent is actively working' },
  { name: 'openslack:review', color: '8250df', description: 'PR submitted, awaiting review' },
  { name: 'openslack:done', color: '6e7781', description: 'Task completed' },
  { name: 'openslack:blocked', color: 'cf222e', description: 'Blocked, needs human attention' },
] as const;

const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_PAGES = 10;

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

async function listComments(client: GitHubClient, issueNumber: number) {
  const comments: Array<{ body?: string | null }> = [];
  for (let page = 1; page <= COMMENT_MAX_PAGES; page += 1) {
    const response = await client.octokit.issues.listComments({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      sort: 'created',
      direction: 'desc',
      per_page: COMMENT_PAGE_SIZE,
      page,
    });
    comments.push(...response.data);
    if (response.data.length < COMMENT_PAGE_SIZE) return comments;
  }
  throw new Error('Claim comment evidence exceeded the bounded read limit.');
}

function currentClaimEvidence(
  comments: Array<{ body?: string | null }>,
  issueNumber: number,
  claimRef: string,
): ClaimMetadata | null {
  const claims = comments
    .map((comment) => parseClaimMetadata(comment.body))
    .filter(
      (claim): claim is ClaimMetadata =>
        claim?.issue_number === issueNumber &&
        claim.claim_ref === claimRef &&
        Number.isFinite(Date.parse(claim.claimed_at)) &&
        Number.isFinite(Date.parse(claim.expires_at)),
    )
    .sort((left, right) => Date.parse(right.claimed_at) - Date.parse(left.claimed_at));
  if (claims.length === 0) return null;
  const newestTimestamp = claims[0].claimed_at;
  const newest = claims.filter((claim) => claim.claimed_at === newestTimestamp);
  if (new Set(newest.map((claim) => claim.agent_id)).size !== 1) return null;
  return newest[0];
}

function effectiveExpiry(
  comments: Array<{ body?: string | null }>,
  claim: ClaimMetadata,
  now: number,
): string | null {
  const claimTime = Date.parse(claim.claimed_at);
  const heartbeats = comments
    .map((comment) => parseHeartbeatMetadata(comment.body))
    .filter((heartbeat) => {
      if (
        heartbeat?.issue_number !== claim.issue_number ||
        heartbeat.agent_id !== claim.agent_id ||
        heartbeat.claim_ref !== claim.claim_ref
      ) {
        return false;
      }
      const heartbeatTime = Date.parse(heartbeat.heartbeat_at);
      const expiryTime = Date.parse(heartbeat.expires_at);
      const duration = (expiryTime - heartbeatTime) / 60_000;
      return (
        Number.isFinite(heartbeatTime) &&
        Number.isFinite(expiryTime) &&
        heartbeatTime >= claimTime &&
        heartbeatTime <= now &&
        expiryTime > heartbeatTime &&
        Number.isSafeInteger(duration) &&
        duration >= 1 &&
        duration <= 480
      );
    })
    .sort((left, right) => Date.parse(right!.heartbeat_at) - Date.parse(left!.heartbeat_at));
  if (heartbeats.length === 0) return claim.expires_at;
  const latestTimestamp = heartbeats[0]!.heartbeat_at;
  const latest = heartbeats.filter((heartbeat) => heartbeat!.heartbeat_at === latestTimestamp);
  const expiries = new Set(latest.map((heartbeat) => heartbeat!.expires_at));
  return expiries.size === 1 ? latest[0]!.expires_at : null;
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

async function setClaimedProjection(client: GitHubClient, issueNumber: number): Promise<boolean> {
  let failed = false;
  try {
    await client.octokit.issues.removeLabel({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      name: 'openslack:ready',
    });
  } catch (error) {
    if (statusOf(error) !== 404) failed = true;
  }
  try {
    await client.octokit.issues.addLabels({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      labels: ['openslack:claimed'],
    });
  } catch {
    failed = true;
  }
  try {
    const labels = await issueLabels(client, issueNumber);
    return !failed && labels.has('openslack:claimed') && !labels.has('openslack:ready');
  } catch {
    return false;
  }
}

async function setReadyProjection(client: GitHubClient, issueNumber: number): Promise<boolean> {
  let failed = false;
  for (const label of ['openslack:claimed', 'openslack:running']) {
    try {
      await client.octokit.issues.removeLabel({
        owner: client.owner,
        repo: client.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      if (statusOf(error) !== 404) failed = true;
    }
  }
  try {
    await client.octokit.issues.addLabels({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      labels: ['openslack:ready'],
    });
  } catch {
    failed = true;
  }
  try {
    const labels = await issueLabels(client, issueNumber);
    return !failed && labels.has('openslack:ready') && !labels.has('openslack:claimed');
  } catch {
    return false;
  }
}

async function deleteClaimRef(client: GitHubClient, issueNumber: number): Promise<boolean> {
  const ref = `heads/openslack/claims/issue-${issueNumber}`;
  try {
    await client.octokit.git.deleteRef({ owner: client.owner, repo: client.repo, ref });
  } catch (error) {
    if (statusOf(error) !== 404) {
      // The exact readback below decides whether cleanup succeeded.
    }
  }
  try {
    await client.octokit.git.getRef({ owner: client.owner, repo: client.repo, ref });
    return false;
  } catch (error) {
    return statusOf(error) === 404;
  }
}

async function claimRefExists(client: GitHubClient, issueNumber: number): Promise<boolean> {
  try {
    await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref: `heads/openslack/claims/issue-${issueNumber}`,
    });
    return true;
  } catch (error) {
    if (statusOf(error) === 404) return false;
    throw error;
  }
}

export async function repairExpiredClaims(
  options: RepairOptions = {},
  getClientFn: RepairClientFactory = getClient,
): Promise<RepairResult[]> {
  const client = await getClientFn();
  if (client.isDryRun) {
    return [
      {
        action: 'repairExpiredClaims',
        fixed: false,
        planned: true,
        detail: 'Dry-run mode',
      },
    ];
  }

  let refs;
  try {
    ({ data: refs } = await client.octokit.git.listMatchingRefs({
      owner: client.owner,
      repo: client.repo,
      ref: 'heads/openslack/claims',
    }));
  } catch {
    return [
      {
        action: 'reconcileClaim',
        fixed: false,
        detail: 'Unable to enumerate claim refs; reconciliation required',
      },
    ];
  }

  const results: RepairResult[] = [];
  const now = Date.now();
  for (const ref of refs) {
    const match = ref.ref.match(/issue-(\d+)$/u);
    if (!match) continue;
    const issueNumber = Number(match[1]);
    const claimRef = `refs/heads/openslack/claims/issue-${issueNumber}`;
    try {
      const comments = await listComments(client, issueNumber);
      const claim = currentClaimEvidence(comments, issueNumber, claimRef);
      if (!claim) {
        results.push({
          action: 'reconcileClaim',
          issueNumber,
          fixed: false,
          detail: 'Claim ref has no unambiguous owner evidence; labels were not changed',
        });
        continue;
      }
      const expiresAt = effectiveExpiry(comments, claim, now);
      if (!expiresAt) {
        results.push({
          action: 'reconcileClaim',
          issueNumber,
          fixed: false,
          detail: 'Latest heartbeat evidence is ambiguous; labels were not changed',
        });
        continue;
      }
      if (Date.parse(expiresAt) <= now) {
        if (options.dryRun) {
          results.push({
            action: 'expireClaim',
            issueNumber,
            fixed: false,
            planned: true,
            detail: `Would expire claim owned by ${claim.agent_id}`,
          });
          continue;
        }
        if (!(await deleteClaimRef(client, issueNumber))) {
          results.push({
            action: 'reconcileClaim',
            issueNumber,
            fixed: false,
            detail: 'Expired claim ref cleanup could not be proven; labels were not changed',
          });
          continue;
        }
        const synchronized = await setReadyProjection(client, issueNumber);
        results.push({
          action: 'expireClaim',
          issueNumber,
          fixed: synchronized,
          detail: synchronized
            ? `Claim expired using latest heartbeat; issue returned to ready`
            : `Claim ref expired but ready-label projection requires repair`,
        });
        continue;
      }
      if (options.dryRun) {
        results.push({
          action: 'repairClaimProjection',
          issueNumber,
          fixed: false,
          planned: true,
          detail: `Would synchronize active claim labels for ${claim.agent_id}`,
        });
        continue;
      }
      if (!(await claimRefExists(client, issueNumber))) {
        results.push({
          action: 'reconcileClaim',
          issueNumber,
          fixed: false,
          detail: 'Claim ref disappeared before projection repair; labels were not changed',
        });
        continue;
      }
      const synchronized = await setClaimedProjection(client, issueNumber);
      results.push({
        action: 'repairClaimProjection',
        issueNumber,
        fixed: synchronized,
        detail: synchronized
          ? `Active claim labels synchronized for ${claim.agent_id}`
          : `Active claim owner is known but label projection still requires repair`,
      });
    } catch {
      results.push({
        action: 'reconcileClaim',
        issueNumber,
        fixed: false,
        detail: 'Claim evidence could not be read; reconciliation required',
      });
    }
  }
  return results;
}

export async function repairLabels(options: RepairOptions = {}): Promise<RepairResult[]> {
  const client = await getClient();
  if (client.isDryRun) {
    return [{ action: 'repairLabels', fixed: false, planned: true, detail: 'Dry-run mode' }];
  }
  const results: RepairResult[] = [];
  for (const label of REQUIRED_OPENSLACK_LABELS) {
    if (options.dryRun) {
      results.push({
        action: 'createLabel',
        fixed: false,
        planned: true,
        detail: `Would ensure label exists: ${label.name}`,
      });
      continue;
    }
    try {
      await client.octokit.issues.createLabel({
        owner: client.owner,
        repo: client.repo,
        name: label.name,
        color: label.color,
        description: label.description,
      });
      results.push({ action: 'createLabel', fixed: true, detail: `Created label: ${label.name}` });
    } catch (error) {
      if (statusOf(error) !== 422) {
        results.push({
          action: 'createLabel',
          fixed: false,
          detail: `Failed to create ${label.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  return results;
}
