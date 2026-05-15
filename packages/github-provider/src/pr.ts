import { getClient } from './client.js';

export interface CreatePRResult {
  url: string;
  number: number;
  nodeId: string;
}

export async function createDraftPR(
  head: string,
  base: string = 'main',
  title: string,
  body: string,
): Promise<CreatePRResult> {
  const client = await getClient();
  if (client.isDryRun) {
    const dryResult = {
      url: `https://github.com/${client.owner}/${client.repo}/pull/DRY_RUN`,
      number: 0,
      nodeId: 'DRY_RUN',
    };
    console.log(`[DRY RUN] Would create draft PR in ${client.owner}/${client.repo}: "${title}"`);
    return dryResult;
  }

  const { data } = await client.octokit.pulls.create({
    owner: client.owner,
    repo: client.repo,
    title,
    body,
    head,
    base,
    draft: true,
  });

  return {
    url: data.html_url,
    number: data.number,
    nodeId: data.node_id,
  };
}

export async function commentOnPR(
  prNumber: number,
  body: string,
): Promise<void> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would comment on PR #${prNumber} in ${client.owner}/${client.repo}`);
    return;
  }

  await client.octokit.issues.createComment({
    owner: client.owner,
    repo: client.repo,
    issue_number: prNumber,
    body,
  });
}
