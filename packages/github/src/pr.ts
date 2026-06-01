import { getClient } from './client.js';
import type { GitHubClientOptions } from './client.js';

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
  options?: GitHubClientOptions,
): Promise<CreatePRResult> {
  const client = await getClient(options);
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

export interface OpenPRSummary {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  updatedAt: string;
  url: string;
  branch: string;
}

export async function listOpenPRs(
  limit = 20,
  owner?: string,
  repo?: string,
  options?: GitHubClientOptions,
): Promise<OpenPRSummary[]> {
  const client = await getClient(options);
  const targetOwner = owner ?? client.owner;
  const targetRepo = repo ?? client.repo;
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would list open PRs from ${targetOwner}/${targetRepo}`);
    return [];
  }

  const { data } = await client.octokit.pulls.list({
    owner: targetOwner,
    repo: targetRepo,
    state: 'open',
    per_page: limit,
    sort: 'updated',
    direction: 'desc',
  });

  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login || 'unknown',
    draft: pr.draft ?? false,
    updatedAt: pr.updated_at,
    url: pr.html_url,
    branch: pr.head.ref,
  }));
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

export async function getPR(prNumber: number, options?: GitHubClientOptions): Promise<PRDetail | null> {
  const client = await getClient(options);
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

export async function listPRFiles(prNumber: number, options?: GitHubClientOptions): Promise<string[]> {
  const client = await getClient(options);
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

export interface PRFilePatch {
  filename: string;
  patch: string;
}

export async function getPRFilePatches(prNumber: number, options?: GitHubClientOptions): Promise<PRFilePatch[]> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would list file patches for PR #${prNumber}`);
    return [];
  }
  try {
    const { data } = await client.octokit.pulls.listFiles({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
    });
    return data
      .filter((f): f is typeof f & { patch: string } => typeof f.patch === 'string')
      .map((f) => ({ filename: f.filename, patch: f.patch }));
  } catch {
    return [];
  }
}

export async function getPRChecks(prNumber: number, options?: GitHubClientOptions): Promise<PRCheckRun[]> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch checks for PR #${prNumber}`);
    return [];
  }
  try {
    const pr = await getPR(prNumber, options);
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

export async function getPRReviews(prNumber: number, options?: GitHubClientOptions): Promise<PRReview[]> {
  const client = await getClient(options);
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
  options?: GitHubClientOptions,
): Promise<void> {
  const client = await getClient(options);
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

export async function getCODEOWNERS(ref: string, options?: GitHubClientOptions): Promise<string | null> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch CODEOWNERS from ${client.owner}/${client.repo}@${ref}`);
    return null;
  }
  try {
    const { data } = await client.octokit.repos.getContent({
      owner: client.owner,
      repo: client.repo,
      path: '.github/CODEOWNERS',
      ref,
    });
    if ('content' in data && typeof data.content === 'string') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

export interface MergePRResult {
  merged: boolean;
  sha?: string;
  message: string;
}

export async function mergePR(
  prNumber: number,
  options: {
    method?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
    commitMessage?: string;
  } = {},
  clientOptions?: GitHubClientOptions,
): Promise<MergePRResult> {
  const client = await getClient(clientOptions);
  if (client.isDryRun) {
    console.log(
      `[DRY RUN] Would merge PR #${prNumber} in ${client.owner}/${client.repo} via ${options.method || 'merge'}`,
    );
    return { merged: true, message: '[DRY RUN] Merge simulated.' };
  }
  try {
    const { data } = await client.octokit.pulls.merge({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      merge_method: options.method || 'merge',
      commit_title: options.commitTitle,
      commit_message: options.commitMessage,
    });
    return {
      merged: data.merged,
      sha: data.sha,
      message: data.merged ? 'PR merged successfully.' : 'PR merge was not successful.',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { merged: false, message: `Merge failed: ${msg}` };
  }
}
