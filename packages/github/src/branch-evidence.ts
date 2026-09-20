import { getClient, type GitHubClient, type GitHubClientOptions } from './client.js';

export interface BranchOpenPR {
  number: number;
  headRef: string;
  baseRef: string;
  headRepoFullName?: string;
  baseRepoFullName: string;
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
export async function getDefaultBranch(options?: GitHubClientOptions): Promise<string> {
  return defaultBranch(await liveClient(options), options);
}

/** Both classic protection and effective rules must be readable; 404 is not unprotected. */
export async function isBranchProtected(
  branch: string,
  options?: GitHubClientOptions,
): Promise<boolean> {
  if (!branch) invalid();
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

/** Inspect all open PR pages, including PRs targeting this branch, not just sourced from it. */
export async function listOpenPRsForBranch(
  branch: string,
  options?: GitHubClientOptions,
): Promise<BranchOpenPR[]> {
  if (!branch) invalid();
  const client = await liveClient(options);
  const fullName = `${client.owner}/${client.repo}`.toLowerCase();
  const found = new Map<number, BranchOpenPR>();
  const limit = pageLimit(options);
  for (let page = 1; page <= limit; page++) {
    assertActive(options);
    const response = await client.octokit.pulls.list({
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
        found.set(pr.number, {
          number: pr.number,
          headRef: pr.head.ref,
          baseRef: pr.base.ref,
          headRepoFullName: pr.head.repo?.full_name,
          baseRepoFullName: pr.base.repo.full_name,
        });
      }
    }
    if (response.data.length < 100 && !response.headers.link?.includes('rel="next"'))
      return [...found.values()];
  }
  throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
}

/** A claim 404 is absent only while the same client can read repository and Git ref evidence. */
export async function claimRefPresent(
  issueNumber: number,
  options?: GitHubClientOptions,
): Promise<boolean> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) invalid();
  const client = await liveClient(options);
  const branch = await defaultBranch(client, options);
  const readRef = async (ref: string) => {
    assertActive(options);
    const { data } = await client.octokit.git.getRef({
      owner: client.owner,
      repo: client.repo,
      ref,
      request: { signal: options?.signal },
    });
    if (data.ref !== `refs/${ref}` || !/^[a-f0-9]{40}$/i.test(data.object?.sha ?? '')) invalid();
  };
  await readRef(`heads/${branch}`);
  try {
    await readRef(`heads/openslack/claims/issue-${issueNumber}`);
    return true;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'status' in error && error.status === 404))
      throw error;
    await readRef(`heads/${branch}`);
    return false;
  }
}
