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

export interface PRDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string };
  mergeable: boolean | null;
  mergeable_state: string;
  merged: boolean;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface PRCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PRReview {
  user: { login: string };
  state: string;
  body: string;
}

export async function getPR(prNumber: number): Promise<PRDetail | null> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch PR #${prNumber} from ${client.owner}/${client.repo}`);
    return null;
  }
  try {
    const { data } = await client.octokit.pulls.get({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body || '',
      state: data.state,
      draft: data.draft ?? false,
      head: { ref: data.head.ref, sha: data.head.sha },
      base: { ref: data.base.ref, sha: data.base.sha },
      user: { login: data.user?.login || 'unknown' },
      mergeable: data.mergeable,
      mergeable_state: data.mergeable_state,
      merged: data.merged,
      url: data.html_url,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  } catch {
    return null;
  }
}

export async function listPRFiles(prNumber: number): Promise<string[]> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would list files for PR #${prNumber}`);
    return [];
  }
  try {
    const { data } = await client.octokit.pulls.listFiles({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
    });
    return data.map((f) => f.filename);
  } catch {
    return [];
  }
}

export async function getPRChecks(prNumber: number): Promise<PRCheckRun[]> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch checks for PR #${prNumber}`);
    return [];
  }
  try {
    const pr = await getPR(prNumber);
    if (!pr) return [];
    const { data } = await client.octokit.checks.listForRef({
      owner: client.owner,
      repo: client.repo,
      ref: pr.head.sha,
    });
    return (data.check_runs || []).map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
    }));
  } catch {
    return [];
  }
}

export async function getPRReviews(prNumber: number): Promise<PRReview[]> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch reviews for PR #${prNumber}`);
    return [];
  }
  try {
    const { data } = await client.octokit.pulls.listReviews({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
    });
    return data.map((r) => ({
      user: { login: r.user?.login || 'unknown' },
      state: r.state,
      body: r.body || '',
    }));
  } catch {
    return [];
  }
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
