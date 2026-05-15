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

export async function moveIssueToReview(issueNumber: number, prUrl: string): Promise<void> {
  const client = await getClient();
  if (client.isDryRun) { console.log(`[DRY RUN] Would move issue #${issueNumber} to review`); return; }

  try {
    await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: issueNumber, name: 'openslack:running' });
    await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: issueNumber, labels: ['openslack:review'] });
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: issueNumber,
      body: `**Draft PR created:** ${prUrl}`,
    });
  } catch { /* best-effort */ }
}
