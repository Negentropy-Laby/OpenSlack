import { getClient } from './client.js';

export interface RepairResult {
  action: string;
  issueNumber?: number;
  fixed: boolean;
  detail: string;
}

export async function repairExpiredClaims(): Promise<RepairResult[]> {
  const client = await getClient();
  const results: RepairResult[] = [];
  if (client.isDryRun) { results.push({ action: 'repairExpiredClaims', fixed: false, detail: 'Dry-run mode' }); return results; }

  try {
    // List all claim refs
    const { data: refs } = await client.octokit.git.listMatchingRefs({
      owner: client.owner, repo: client.repo, ref: 'heads/openslack/claims',
    });

    const now = new Date();
    for (const ref of refs) {
      const match = ref.ref.match(/issue-(\d+)$/);
      if (!match) continue;
      const issueNumber = parseInt(match[1], 10);

      // Check most recent claim comment for expiry
      try {
        const { data: comments } = await client.octokit.issues.listComments({
          owner: client.owner, repo: client.repo, issue_number: issueNumber,
          sort: 'created', direction: 'desc', per_page: 5,
        });
        const claimComment = comments.find((c) => c.body?.includes('<!-- openslack-claim'));
        if (claimComment) {
          const expiresMatch = claimComment.body?.match(/"expires_at":\s*"([^"]+)"/);
          if (expiresMatch && new Date(expiresMatch[1]) < now) {
            // Expired — delete ref, reset to ready
            try { await client.octokit.git.deleteRef({ owner: client.owner, repo: client.repo, ref: `heads/openslack/claims/issue-${issueNumber}` }); } catch { /* ok */ }
            const labelsToRemove = ['openslack:claimed', 'openslack:running'];
            for (const l of labelsToRemove) {
              try { await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: issueNumber, name: l }); } catch { /* ok */ }
            }
            try { await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: issueNumber, labels: ['openslack:ready'] }); } catch { /* ok */ }
            results.push({ action: 'expireClaim', issueNumber, fixed: true, detail: `Claim expired, issue returned to ready` });
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* no claims refs found */ }

  return results;
}

export async function repairLabels(): Promise<RepairResult[]> {
  const client = await getClient();
  const results: RepairResult[] = [];
  if (client.isDryRun) { results.push({ action: 'repairLabels', fixed: false, detail: 'Dry-run mode' }); return results; }

  const requiredLabels = [
    { name: 'openslack:task', color: '1f6feb', description: 'OpenSlack task (from EVOL or manual)' },
    { name: 'openslack:ready', color: '2da44e', description: 'Ready for agent claim' },
    { name: 'openslack:claimed', color: 'fbca04', description: 'Claimed by an agent' },
    { name: 'openslack:running', color: 'd29922', description: 'Agent is actively working' },
    { name: 'openslack:review', color: '8250df', description: 'PR submitted, awaiting review' },
    { name: 'openslack:done', color: '6e7781', description: 'Task completed' },
    { name: 'openslack:blocked', color: 'cf222e', description: 'Blocked, needs human attention' },
  ];

  for (const label of requiredLabels) {
    try {
      await client.octokit.issues.createLabel({
        owner: client.owner, repo: client.repo, name: label.name, color: label.color, description: label.description,
      });
      results.push({ action: 'createLabel', fixed: true, detail: `Created label: ${label.name}` });
    } catch (e) {
      if ((e as { status?: number }).status === 422) {
        // Already exists — skip
      } else {
        results.push({ action: 'createLabel', fixed: false, detail: `Failed to create ${label.name}: ${(e as Error).message}` });
      }
    }
  }

  return results;
}
