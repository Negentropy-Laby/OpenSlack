import { getClient } from './client.js';

export interface IssueClaimResult {
  claimStatus: 'granted' | 'denied';
  issueNumber: number;
  claimRef: string;
  reason?: 'ALREADY_CLAIMED' | 'API_ERROR';
  lease?: { expiresAt: string; ttlMinutes: number };
}

export async function claimIssueTask(args: {
  issueNumber: number;
  agentId: string;
  ttlMinutes?: number;
  capabilities?: string[];
}): Promise<IssueClaimResult> {
  const client = await getClient();
  const ttlMinutes = args.ttlMinutes || 60;
  const ref = `refs/heads/openslack/claims/issue-${args.issueNumber}`;

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would claim issue #${args.issueNumber} via ref ${ref}`);
    return { claimStatus: 'granted', issueNumber: args.issueNumber, claimRef: ref, lease: { expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString(), ttlMinutes } };
  }

  // Step 1: Get main HEAD SHA
  const { data: refData } = await client.octokit.git.getRef({
    owner: client.owner,
    repo: client.repo,
    ref: `heads/${client.owner === 'wsman' && client.repo === 'OpenSlack' ? 'main' : 'main'}`,
  });
  const sha = refData.object.sha as string;

  // Step 2: Try to create claim ref (atomic)
  try {
    await client.octokit.git.createRef({
      owner: client.owner,
      repo: client.repo,
      ref,
      sha,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 422) {
      // Ref already exists — task already claimed
      return { claimStatus: 'denied', issueNumber: args.issueNumber, claimRef: ref, reason: 'ALREADY_CLAIMED' };
    }
    return { claimStatus: 'denied', issueNumber: args.issueNumber, claimRef: ref, reason: 'API_ERROR' };
  }

  // Step 3: Best-effort label update (non-atomic, recoverable)
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  try {
    const labelsToRemove = ['openslack:ready'];
    for (const label of labelsToRemove) {
      try {
        await client.octokit.issues.removeLabel({
          owner: client.owner, repo: client.repo, issue_number: args.issueNumber, name: label,
        });
      } catch { /* label may not exist */ }
    }

    const labelsToAdd = ['openslack:claimed'].filter(Boolean);
    await client.octokit.issues.addLabels({
      owner: client.owner, repo: client.repo, issue_number: args.issueNumber, labels: labelsToAdd,
    });

    const comment = [
      `**Claimed by:** \`${args.agentId}\``,
      `**Claim ref:** \`${ref}\``,
      `**Expires at:** ${expiresAt}`,
      `**TTL:** ${ttlMinutes} minutes`,
    ].join('\n');
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: args.issueNumber, body: comment,
    });
  } catch { /* best-effort labels — claim ref is authoritative */ }

  return {
    claimStatus: 'granted',
    issueNumber: args.issueNumber,
    claimRef: ref,
    lease: { expiresAt, ttlMinutes },
  };
}

export async function releaseIssueClaim(issueNumber: number): Promise<void> {
  const client = await getClient();
  const ref = `heads/openslack/claims/issue-${issueNumber}`;
  if (client.isDryRun) { console.log(`[DRY RUN] Would release claim ref ${ref}`); return; }

  try {
    await client.octokit.git.deleteRef({ owner: client.owner, repo: client.repo, ref });
  } catch { /* ref may already be deleted */ }

  // Best-effort label update
  try {
    await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: issueNumber, name: 'openslack:claimed' });
    await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: issueNumber, labels: ['openslack:done'] });
  } catch { /* best-effort */ }
}

export interface HeartbeatResult {
  success: boolean;
  reason?: 'CLAIM_NOT_FOUND' | 'AGENT_MISMATCH' | 'REF_DELETED' | 'API_ERROR';
  newExpiresAt?: string;
}

export interface ReleaseInput {
  issueNumber: number;
  agentId: string;
  force?: boolean;
}

export async function heartbeatIssueClaim(issueNumber: number, agentId: string, ttlMinutes: number = 60): Promise<HeartbeatResult> {
  const client = await getClient();
  const ref = `heads/openslack/claims/issue-${issueNumber}`;
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would heartbeat claim for issue #${issueNumber} by ${agentId}`);
    return { success: true, newExpiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString() };
  }

  // Verify claim ref exists
  try {
    await client.octokit.git.getRef({ owner: client.owner, repo: client.repo, ref });
  } catch {
    return { success: false, reason: 'REF_DELETED' };
  }

  // Verify agent ownership from claim comment
  try {
    const comments = await client.octokit.issues.listComments({
      owner: client.owner, repo: client.repo, issue_number: issueNumber,
      sort: 'created', direction: 'desc', per_page: 10,
    });
    const claimComment = comments.data.find((c) =>
      c.body?.includes('<!-- openslack-claim'),
    );
    if (claimComment) {
      const match = claimComment.body?.match(/"agent_id":\s*"([^"]+)"/);
      if (match && match[1] !== agentId) {
        return { success: false, reason: 'AGENT_MISMATCH' };
      }
    }
  } catch { /* best-effort ownership check */ }

  // Update heartbeat: post new comment with extended expiry
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  try {
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: issueNumber,
      body: `<!-- openslack-heartbeat\n${JSON.stringify({
        schema: 'openslack.heartbeat.v1',
        issue_number: issueNumber,
        agent_id: agentId,
        heartbeat_at: new Date().toISOString(),
        expires_at: expiresAt,
        claim_ref: `refs/heads/openslack/claims/issue-${issueNumber}`,
      }, null, 2)}\n-->\n\nHeartbeat: lease extended to ${expiresAt}`,
    });
  } catch { /* best-effort */ }

  return { success: true, newExpiresAt: expiresAt };
}

export async function expireIssueClaim(issueNumber: number): Promise<void> {
  const client = await getClient();
  const ref = `heads/openslack/claims/issue-${issueNumber}`;
  if (client.isDryRun) { console.log(`[DRY RUN] Would expire claim for issue #${issueNumber}`); return; }

  // Delete claim ref
  try {
    await client.octokit.git.deleteRef({ owner: client.owner, repo: client.repo, ref });
  } catch { /* ref may already be deleted */ }

  // Reset issue to ready
  try {
    const labelsToRemove = ['openslack:claimed', 'openslack:running'];
    for (const l of labelsToRemove) {
      try { await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: issueNumber, name: l }); } catch { /* ok */ }
    }
    await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: issueNumber, labels: ['openslack:ready'] });
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: issueNumber,
      body: 'Lease expired. Task returned to ready queue.',
    });
  } catch { /* best-effort */ }
}

export async function releaseIssueClaimWithOwner(input: ReleaseInput): Promise<{ success: boolean; reason?: string }> {
  const client = await getClient();
  const ref = `heads/openslack/claims/issue-${input.issueNumber}`;
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would release claim for issue #${input.issueNumber}`);
    return { success: true };
  }

  // Ownership check (unless forced)
  if (!input.force) {
    try {
      const { data: comments } = await client.octokit.issues.listComments({
        owner: client.owner, repo: client.repo, issue_number: input.issueNumber,
        sort: 'created', direction: 'desc', per_page: 10,
      });
      const claimComment = comments.find((c) => c.body?.includes('<!-- openslack-claim'));
      if (claimComment) {
        const match = claimComment.body?.match(/"agent_id":\s*"([^"]+)"/);
        if (match && match[1] !== input.agentId) {
          return { success: false, reason: `Claim owned by ${match[1]}, not ${input.agentId}` };
        }
      }
    } catch { /* best-effort — skip ownership check if comment missing */ }
  }

  // Delete ref
  try {
    await client.octokit.git.deleteRef({ owner: client.owner, repo: client.repo, ref });
  } catch { /* already deleted */ }

  // Move to done
  try {
    const labelsToRemove = ['openslack:claimed', 'openslack:running', 'openslack:review'];
    for (const l of labelsToRemove) {
      try { await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: input.issueNumber, name: l }); } catch { /* ok */ }
    }
    await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: input.issueNumber, labels: ['openslack:done'] });
  } catch { /* best-effort */ }

  return { success: true };
}

export async function moveIssueToReview(issueNumber: number, prUrl: string): Promise<void> {
  const client = await getClient();
  if (client.isDryRun) { console.log(`[DRY RUN] Would move issue #${issueNumber} to review`); return; }

  try {
    // Remove all non-review state labels
    const labelsToRemove = ['openslack:ready', 'openslack:claimed', 'openslack:running', 'openslack:blocked'];
    for (const l of labelsToRemove) {
      try { await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: issueNumber, name: l }); } catch { /* ok */ }
    }
    await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: issueNumber, labels: ['openslack:review'] });
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: issueNumber,
      body: `**Draft PR created:** ${prUrl}`,
    });
  } catch { /* best-effort */ }
}
