import { issueClaimRef, isFullGitObjectId, isValidCleanupBranch } from '@openslack/core';
import { getClient, type GitHubClient, type GitHubClientOptions } from './client.js';

export interface BranchOpenPR {
  number: number;
  headRef: string;
  baseRef: string;
  headRepoFullName?: string;
  baseRepoFullName: string;
}

export interface CleanupRepositoryEvidence {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
}
export interface CleanupPREvidence {
  prNumber: number;
  merged?: boolean;
  baseRef: string;
  headRef?: string;
  headSha?: string;
  headRepoFullName?: string;
  baseRepoFullName?: string;
  body?: string;
  headRepoId?: string;
  baseRepoId?: string;
  prNodeId?: string;
  repositoryEvidence?: CleanupRepositoryEvidence;
}
const repositoryEvidence = new WeakMap<CleanupRepositoryEvidence, GitHubClient['octokit']>();
function reuseRepository(
  client: GitHubClient,
  evidence: CleanupRepositoryEvidence,
): CleanupRepositoryEvidence {
  if (
    repositoryEvidence.get(evidence) !== client.octokit ||
    evidence.fullName.toLowerCase() !== `${client.owner}/${client.repo}`.toLowerCase()
  )
    invalid();
  return evidence;
}

/** Only the fields needed by cleanup; no files, reviews, checks, or workflow trees. */
export async function getCleanupPREvidence(
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<CleanupPREvidence> {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) invalid();
  const client = await liveClient(options);
  const [repository, response] = await Promise.all([
    client.octokit.repos.get({
      owner: client.owner,
      repo: client.repo,
      request: { signal: options?.signal },
    }),
    client.octokit.pulls.get({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      request: { signal: options?.signal },
    }),
  ]);
  assertActive(options);
  const repo = repository.data,
    pr = response.data;
  if (
    !Number.isSafeInteger(repo.id) ||
    repo.id < 1 ||
    repo.full_name?.toLowerCase() !== `${client.owner}/${client.repo}`.toLowerCase() ||
    !isValidCleanupBranch(repo.default_branch) ||
    pr.number !== prNumber ||
    typeof pr.merged !== 'boolean' ||
    !pr.node_id ||
    !pr.head ||
    !pr.base ||
    typeof pr.head.ref !== 'string' ||
    typeof pr.head.sha !== 'string' ||
    typeof pr.base.ref !== 'string' ||
    !pr.base.repo?.full_name ||
    String(pr.base.repo.id) !== String(repo.id)
  )
    invalid();
  const evidence = Object.freeze({
    id: String(repo.id),
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
  });
  repositoryEvidence.set(evidence, client.octokit);
  return {
    prNumber,
    merged: pr.merged,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepoFullName: pr.head.repo?.full_name,
    baseRepoFullName: pr.base.repo.full_name,
    body: pr.body ?? '',
    headRepoId: pr.head.repo ? String(pr.head.repo.id) : undefined,
    baseRepoId: String(pr.base.repo.id),
    prNodeId: pr.node_id,
    repositoryEvidence: evidence,
  };
}

function invalid(): never {
  throw new Error('GITHUB_BRANCH_EVIDENCE_INVALID');
}

function assertActive(options?: GitHubClientOptions): void {
  options?.signal?.throwIfAborted();
}

async function liveClient(options?: GitHubClientOptions): Promise<GitHubClient> {
  assertActive(options);
  const client = await getClient(options);
  if (client.isDryRun) throw new Error('GITHUB_BRANCH_EVIDENCE_REQUIRES_LIVE');
  assertActive(options);
  return client;
}

function pageLimit(options?: GitHubClientOptions): number {
  const limit = options?.evidenceLimits?.maxPages ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) invalid();
  return limit;
}

async function defaultBranch(client: GitHubClient, options?: GitHubClientOptions): Promise<string> {
  assertActive(options);
  const { data } = await client.octokit.repos.get({
    owner: client.owner,
    repo: client.repo,
    request: { signal: options?.signal },
  });
  if (
    data.full_name?.toLowerCase() !== `${client.owner}/${client.repo}`.toLowerCase() ||
    typeof data.default_branch !== 'string' ||
    !data.default_branch
  )
    invalid();
  return data.default_branch;
}

/** A missing repository/default branch is unknown evidence, never a permissive default. */
export async function getDefaultBranch(
  options?: GitHubClientOptions,
  evidence?: CleanupRepositoryEvidence,
): Promise<string> {
  const client = await liveClient(options);
  return evidence
    ? reuseRepository(client, evidence).defaultBranch
    : defaultBranch(client, options);
}

/** Both classic protection and effective rules must be readable; 404 is not unprotected. */
export async function isBranchProtected(
  branch: string,
  options?: GitHubClientOptions,
): Promise<boolean> {
  if (!isValidCleanupBranch(branch)) invalid();
  const client = await liveClient(options);
  const { data } = await client.octokit.repos.getBranch({
    owner: client.owner,
    repo: client.repo,
    branch,
    request: { signal: options?.signal },
  });
  if (data.name !== branch || typeof data.protected !== 'boolean') invalid();
  if (data.protected) return true;
  const limit = pageLimit(options);
  for (let page = 1; page <= limit; page++) {
    assertActive(options);
    const response = await client.octokit.request(
      'GET /repos/{owner}/{repo}/rules/branches/{branch}',
      {
        owner: client.owner,
        repo: client.repo,
        branch,
        per_page: 100,
        page,
        request: { signal: options?.signal },
      },
    );
    if (!Array.isArray(response.data)) invalid();
    if (response.data.length > 0) return true;
    if (!response.headers.link?.includes('rel="next"')) return false;
  }
  throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
}

/** Page both server-filtered dependency sets; reject partial evidence and deduplicate their union. */
export async function listOpenPRsForBranch(
  branch: string,
  options?: GitHubClientOptions,
): Promise<BranchOpenPR[]> {
  if (!isValidCleanupBranch(branch)) invalid();
  const client = await liveClient(options);
  const fullName = `${client.owner}/${client.repo}`.toLowerCase();
  const found = new Map<number, BranchOpenPR>();
  const limit = pageLimit(options);
  for (const filter of [{ head: `${client.owner}:${branch}` }, { base: branch }]) {
    let complete = false;
    for (let page = 1; page <= limit; page++) {
      assertActive(options);
      const response = await client.octokit.pulls.list({
        ...filter,
        owner: client.owner,
        repo: client.repo,
        state: 'open',
        per_page: 100,
        page,
        request: { signal: options?.signal },
      });
      if (!Array.isArray(response.data)) invalid();
      for (const pr of response.data) {
        if (
          !Number.isSafeInteger(pr.number) ||
          pr.number < 1 ||
          pr.state !== 'open' ||
          !pr.head?.ref ||
          !pr.base?.ref ||
          pr.base.repo?.full_name?.toLowerCase() !== fullName
        )
          invalid();
        // Deleted fork repositories may have null head.repo; relevant head evidence remains unknown.
        if (pr.head.ref === branch && !pr.head.repo?.full_name) invalid();
        if (
          pr.base.ref === branch ||
          (pr.head.ref === branch && pr.head.repo?.full_name.toLowerCase() === fullName)
        ) {
          const match: BranchOpenPR = {
            number: pr.number,
            headRef: pr.head.ref,
            baseRef: pr.base.ref,
            headRepoFullName: pr.head.repo?.full_name,
            baseRepoFullName: pr.base.repo.full_name,
          };
          const earlier = found.get(pr.number);
          if (
            earlier &&
            (earlier.headRef !== match.headRef ||
              earlier.baseRef !== match.baseRef ||
              earlier.headRepoFullName?.toLowerCase() !== match.headRepoFullName?.toLowerCase() ||
              earlier.baseRepoFullName.toLowerCase() !== match.baseRepoFullName.toLowerCase())
          )
            invalid();
          found.set(pr.number, match);
        }
      }
      if (response.data.length < 100 && !response.headers.link?.includes('rel="next"')) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
  }
  return [...found.values()];
}

/** A claim 404 is absent only while the same client can read repository and Git ref evidence. */
export async function claimRefPresent(
  issueNumber: number,
  options?: GitHubClientOptions,
  evidence?: CleanupRepositoryEvidence,
): Promise<boolean> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) invalid();
  const client = await liveClient(options);
  const branch = evidence
    ? reuseRepository(client, evidence).defaultBranch
    : await defaultBranch(client, options);
  const readRef = async (ref: string) => {
    assertActive(options);
    const { data } = await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref,
      request: { signal: options?.signal },
    });
    if (data.ref !== `refs/${ref}` || !isFullGitObjectId((data.object?.sha ?? '').toLowerCase()))
      invalid();
  };
  await readRef(`heads/${branch}`);
  try {
    await readRef(issueClaimRef(issueNumber));
    return true;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'status' in error && error.status === 404))
      throw error;
    await readRef(`heads/${branch}`);
    return false;
  }
}
