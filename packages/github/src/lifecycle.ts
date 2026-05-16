import { getClient } from './client.js';

interface MarkOptions {
  issueNumber: number;
  runId?: string;
  worktreePath?: string;
  reason?: string;
  requestedHumanAction?: string;
  result?: string;
}

function eventComment(type: string, issueNumber: number, details: Record<string, unknown>): string {
  const event = { schema: 'openslack.issue_event.v1', event_id: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type, issue_number: issueNumber, timestamp: new Date().toISOString(), details };
  return `<!-- openslack-event\n${JSON.stringify(event, null, 2)}\n-->\n\nOpenSlack: ${type.replace(/_/g, ' ')}.`;
}

export async function markIssueRunning(opts: MarkOptions): Promise<void> {
  const client = await getClient();
  const labelsToRemove = ['openslack:ready', 'openslack:claimed', 'openslack:blocked'];
  if (client.isDryRun) { console.log(`[DRY RUN] markIssueRunning #${opts.issueNumber}`); return; }
  for (const l of labelsToRemove) {
    try { await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: opts.issueNumber, name: l }); } catch { /* ok */ }
  }
  try { await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: opts.issueNumber, labels: ['openslack:running'] }); } catch { /* ok */ }
  try {
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: opts.issueNumber,
      body: eventComment('task_running', opts.issueNumber, { run_id: opts.runId, worktree_path: opts.worktreePath }),
    });
  } catch { /* ok */ }
}

export async function markIssueBlocked(opts: MarkOptions): Promise<void> {
  const client = await getClient();
  const labelsToRemove = ['openslack:ready', 'openslack:claimed', 'openslack:running', 'openslack:review'];
  if (client.isDryRun) { console.log(`[DRY RUN] markIssueBlocked #${opts.issueNumber}`); return; }
  for (const l of labelsToRemove) {
    try { await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: opts.issueNumber, name: l }); } catch { /* ok */ }
  }
  try { await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: opts.issueNumber, labels: ['openslack:blocked'] }); } catch { /* ok */ }
  try {
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: opts.issueNumber,
      body: eventComment('task_blocked', opts.issueNumber, { reason: opts.reason, requested_human_action: opts.requestedHumanAction }),
    });
  } catch { /* ok */ }
}

export async function markIssueDone(opts: MarkOptions): Promise<void> {
  const client = await getClient();
  const labelsToRemove = ['openslack:ready', 'openslack:claimed', 'openslack:running', 'openslack:review', 'openslack:blocked'];
  if (client.isDryRun) { console.log(`[DRY RUN] markIssueDone #${opts.issueNumber}`); return; }
  for (const l of labelsToRemove) {
    try { await client.octokit.issues.removeLabel({ owner: client.owner, repo: client.repo, issue_number: opts.issueNumber, name: l }); } catch { /* ok */ }
  }
  try { await client.octokit.issues.addLabels({ owner: client.owner, repo: client.repo, issue_number: opts.issueNumber, labels: ['openslack:done'] }); } catch { /* ok */ }
  try {
    await client.octokit.issues.createComment({
      owner: client.owner, repo: client.repo, issue_number: opts.issueNumber,
      body: eventComment('task_done', opts.issueNumber, { result: opts.result }),
    });
  } catch { /* ok */ }
}
