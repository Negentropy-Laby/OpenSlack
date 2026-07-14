import { getClient } from './client.js';
import type { AgentPrincipal } from '@openslack/kernel';

export interface IssueClaimResult {
  claimStatus: 'granted' | 'denied';
  issueNumber: number;
  claimRef: string;
  reason?: 'ALREADY_CLAIMED' | 'API_ERROR';
  lease?: { expiresAt: string; ttlMinutes: number };
}

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
}

function principalMetadata(principal: AgentPrincipal): ClaimMetadata['principal'] {
  return {
    registry_id: principal.registry_id,
    run_id: principal.run_id,
    provider: principal.provider,
  };
}

export function renderClaimComment(metadata: ClaimMetadata, ttlMinutes: number): string {
  return [
    `<!-- openslack-claim`,
    JSON.stringify(metadata, null, 2),
    `-->`,
    '',
    `**Claimed by:** \`${metadata.agent_id}\``,
    `**Claim ref:** \`${metadata.claim_ref}\``,
    `**Expires at:** ${metadata.expires_at}`,
    `**TTL:** ${ttlMinutes} minutes`,
    `**Principal:** \`${metadata.principal.registry_id}\` run=\`${metadata.principal.run_id}\` provider=\`${metadata.principal.provider}\``,
  ].join('\n');
}

export function parseClaimMetadata(body: string | null | undefined): ClaimMetadata | null {
  if (!body) return null;
  const match = body.match(/<!--\s*openslack-claim\s*([\s\S]*?)-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as ClaimMetadata;
    if (parsed?.schema !== 'openslack.claim.v1' || typeof parsed.agent_id !== 'string') return null;
    return parsed;
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

export async function claimIssueTask(args: {
  issueNumber: number;
  agentId: string;
  ttlMinutes?: number;
  capabilities?: string[];
  principal: AgentPrincipal;
  owner?: string;
  repo?: string;
}): Promise<IssueClaimResult> {
  const client = await getClient();
  const _owner = args.owner ?? client.owner;
  const _repo = args.repo ?? client.repo;
  const ttlMinutes = args.ttlMinutes || 60;
  const ref = `refs/heads/openslack/claims/issue-${args.issueNumber}`;

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would claim issue #${args.issueNumber} via ref ${ref}`);
    return {
      claimStatus: 'granted',
      issueNumber: args.issueNumber,
      claimRef: ref,
      lease: { expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString(), ttlMinutes },
    };
  }

  // Step 1: Get main HEAD SHA
  const { data: refData } = await client.octokit.git.getRef({
    owner: _owner,
    repo: _repo,
    ref: `heads/main`,
  });
  const sha = refData.object.sha as string;

  // Step 2: Try to create claim ref (atomic)
  try {
    await client.octokit.git.createRef({
      owner: _owner,
      repo: _repo,
      ref,
      sha,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 422) {
      // Ref already exists — task already claimed
      return {
        claimStatus: 'denied',
        issueNumber: args.issueNumber,
        claimRef: ref,
        reason: 'ALREADY_CLAIMED',
      };
    }
    return {
      claimStatus: 'denied',
      issueNumber: args.issueNumber,
      claimRef: ref,
      reason: 'API_ERROR',
    };
  }

  // Step 3: Best-effort label update (non-atomic, recoverable)
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  try {
    const labelsToRemove = ['openslack:ready'];
    for (const label of labelsToRemove) {
      try {
        await client.octokit.issues.removeLabel({
          owner: _owner,
          repo: _repo,
          issue_number: args.issueNumber,
          name: label,
        });
      } catch {
        /* label may not exist */
      }
    }

    const labelsToAdd = ['openslack:claimed'].filter(Boolean);
    await client.octokit.issues.addLabels({
      owner: _owner,
      repo: _repo,
      issue_number: args.issueNumber,
      labels: labelsToAdd,
    });

    const comment = renderClaimComment(
      {
        schema: 'openslack.claim.v1',
        issue_number: args.issueNumber,
        agent_id: args.agentId,
        claim_ref: ref,
        claimed_at: new Date().toISOString(),
        expires_at: expiresAt,
        principal: principalMetadata(args.principal),
      },
      ttlMinutes,
    );
    await client.octokit.issues.createComment({
      owner: _owner,
      repo: _repo,
      issue_number: args.issueNumber,
      body: comment,
    });
  } catch {
    /* best-effort labels — claim ref is authoritative */
  }

  return {
    claimStatus: 'granted',
    issueNumber: args.issueNumber,
    claimRef: ref,
    lease: { expiresAt, ttlMinutes },
  };
}

export async function expireIssueClaim(issueNumber: number): Promise<void> {
  const client = await getClient();
  const ref = `heads/openslack/claims/issue-${issueNumber}`;
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would expire claim for issue #${issueNumber}`);
    return;
  }

  // Delete claim ref
  try {
    await client.octokit.git.deleteRef({ owner: client.owner, repo: client.repo, ref });
  } catch {
    /* ref may already be deleted */
  }

  // Reset issue to ready
  try {
    const labelsToRemove = ['openslack:claimed', 'openslack:running'];
    for (const l of labelsToRemove) {
      try {
        await client.octokit.issues.removeLabel({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          name: l,
        });
      } catch {
        /* ok */
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
    /* best-effort */
  }
}
