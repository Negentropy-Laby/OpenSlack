import { getClient } from './client.js';
import type { GitHubClientOptions } from './client.js';
import { assertCanonicalPRBase } from './pr-base-policy.js';

const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 75;
const EVIDENCE_TIMEOUT_MS = 8_000;

export class GitHubEvidenceUnavailableError extends Error {
  readonly code = 'GITHUB_EVIDENCE_UNAVAILABLE';
  readonly operation: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber?: number;
  readonly status?: number;
  readonly causeMessage: string;

  constructor(input: {
    operation: string;
    owner: string;
    repo: string;
    prNumber?: number;
    status?: number;
    causeMessage: string;
  }) {
    const target =
      input.prNumber === undefined
        ? `${input.owner}/${input.repo}`
        : `${input.owner}/${input.repo} PR #${input.prNumber}`;
    super(
      `GITHUB_EVIDENCE_UNAVAILABLE: ${input.operation} failed for ${target}. ${input.causeMessage}`,
    );
    this.name = 'GitHubEvidenceUnavailableError';
    this.operation = input.operation;
    this.owner = input.owner;
    this.repo = input.repo;
    this.prNumber = input.prNumber;
    this.status = input.status;
    this.causeMessage = input.causeMessage;
  }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return errorStatus(error) === 404;
}

function isRetryableEvidenceError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return status >= 500 || status === 429;
  const message = errorMessage(error);
  return /ECONNRESET|ETIMEDOUT|timeout|network|socket hang up/i.test(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${EVIDENCE_TIMEOUT_MS}ms`));
    }, EVIDENCE_TIMEOUT_MS);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withRetry<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(operationName, operation);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS - 1 || !isRetryableEvidenceError(error)) break;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

function strictEvidenceUnavailable(
  operation: string,
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number | undefined,
  error: unknown,
): never {
  throw new GitHubEvidenceUnavailableError({
    operation,
    owner: client.owner,
    repo: client.repo,
    prNumber,
    status: errorStatus(error),
    causeMessage: errorMessage(error),
  });
}

async function graphqlRequest<T>(
  client: Awaited<ReturnType<typeof getClient>>,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const graphql = client.octokit.graphql as unknown as (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<T>;
  return withTimeout('GitHub GraphQL request', () => graphql(query, variables));
}

function normalizeGraphQLState(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

async function listPRFilesRest(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
): Promise<Array<{ filename: string; previous_filename?: string; patch?: string }>> {
  const files: Array<{ filename: string; previous_filename?: string; patch?: string }> = [];
  for (let page = 1; ; page += 1) {
    const { data } = await client.octokit.pulls.listFiles({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    files.push(...data);
    if (data.length < 100) break;
  }
  return files;
}

async function listPRReviewsRest(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
): Promise<
  Array<{
    user?: { login?: string | null } | null;
    state: string;
    body?: string | null;
    submitted_at?: string | null;
    commit_id?: string | null;
  }>
> {
  const reviews: Array<{
    user?: { login?: string | null } | null;
    state: string;
    body?: string | null;
    submitted_at?: string | null;
    commit_id?: string | null;
  }> = [];
  for (let page = 1; ; page += 1) {
    const { data } = await client.octokit.pulls.listReviews({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    reviews.push(...data);
    if (data.length < 100) break;
  }
  return reviews;
}

async function listPRChecksRest(
  client: Awaited<ReturnType<typeof getClient>>,
  ref: string,
): Promise<Array<{ name: string; status: string; conclusion: string | null }>> {
  const runs: Array<{ name: string; status: string; conclusion: string | null }> = [];
  for (let page = 1; ; page += 1) {
    const { data } = await client.octokit.checks.listForRef({
      owner: client.owner,
      repo: client.repo,
      ref,
      per_page: 100,
      page,
    });
    const checkRuns = data.check_runs || [];
    runs.push(...checkRuns);
    if (checkRuns.length < 100) break;
  }
  return runs;
}

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
  assertCanonicalPRBase(base);
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
  submittedAt?: string;
  commitOid?: string;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface GraphQLPullRequestResponse {
  repository?: {
    pullRequest?: {
      number: number;
      title: string;
      body?: string | null;
      state: string;
      isDraft: boolean;
      headRefName: string;
      headRefOid: string;
      baseRefName: string;
      baseRefOid: string;
      author?: { login?: string | null } | null;
      mergeable?: string | null;
      merged: boolean;
      url: string;
      createdAt: string;
      updatedAt: string;
    } | null;
  } | null;
}

interface GraphQLFilesResponse {
  repository?: {
    pullRequest?: {
      files?: {
        nodes?: Array<{ path: string } | null> | null;
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
      } | null;
    } | null;
  } | null;
}

interface GraphQLReviewsResponse {
  repository?: {
    pullRequest?: {
      reviews?: {
        nodes?: Array<{
          author?: { login?: string | null } | null;
          state: string;
          body?: string | null;
          submittedAt?: string | null;
          commit?: { oid?: string | null } | null;
        } | null> | null;
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
      } | null;
    } | null;
  } | null;
}

interface GraphQLChecksResponse {
  repository?: {
    pullRequest?: {
      commits?: {
        nodes?: Array<{
          commit?: {
            statusCheckRollup?: {
              contexts?: {
                nodes?: Array<{
                  __typename: string;
                  name?: string | null;
                  status?: string | null;
                  conclusion?: string | null;
                  context?: string | null;
                  state?: string | null;
                } | null> | null;
              } | null;
            } | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

interface GraphQLBlobResponse {
  repository?: {
    object?: {
      text?: string | null;
    } | null;
  } | null;
}

function graphqlMergeableToBoolean(value: string | null | undefined): boolean | null {
  if (value === 'MERGEABLE') return true;
  if (value === 'CONFLICTING') return false;
  return null;
}

async function getPRGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
): Promise<PRDetail | null> {
  const response = await graphqlRequest<GraphQLPullRequestResponse>(
    client,
    `
      query OpenSlackPrDetail($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            number
            title
            body
            state
            isDraft
            headRefName
            headRefOid
            baseRefName
            baseRefOid
            author { login }
            mergeable
            merged
            url
            createdAt
            updatedAt
          }
        }
      }
    `,
    { owner: client.owner, repo: client.repo, number: prNumber },
  );
  const pr = response.repository?.pullRequest;
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    state: normalizeGraphQLState(pr.state),
    draft: pr.isDraft,
    head: { ref: pr.headRefName, sha: pr.headRefOid },
    base: { ref: pr.baseRefName, sha: pr.baseRefOid },
    user: { login: pr.author?.login || 'unknown' },
    mergeable: graphqlMergeableToBoolean(pr.mergeable),
    mergeable_state: normalizeGraphQLState(pr.mergeable),
    merged: pr.merged,
    url: pr.url,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

async function listPRFilesGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
): Promise<string[]> {
  const files: string[] = [];
  let after: string | null = null;
  do {
    const response: GraphQLFilesResponse = await graphqlRequest<GraphQLFilesResponse>(
      client,
      `
        query OpenSlackPrFiles($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              files(first: 100, after: $after) {
                nodes { path }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      `,
      { owner: client.owner, repo: client.repo, number: prNumber, after },
    );
    const connection:
      | NonNullable<
          NonNullable<NonNullable<GraphQLFilesResponse['repository']>['pullRequest']>['files']
        >
      | null
      | undefined = response.repository?.pullRequest?.files;
    for (const node of connection?.nodes ?? []) {
      if (node?.path) files.push(node.path);
    }
    after = connection?.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
  } while (after);
  return files;
}

async function getPRReviewsGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
): Promise<PRReview[]> {
  const reviews: PRReview[] = [];
  let after: string | null = null;
  do {
    const response: GraphQLReviewsResponse = await graphqlRequest<GraphQLReviewsResponse>(
      client,
      `
        query OpenSlackPrReviews($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $after) {
                nodes {
                  author { login }
                  state
                  body
                  submittedAt
                  commit { oid }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      `,
      { owner: client.owner, repo: client.repo, number: prNumber, after },
    );
    const connection:
      | NonNullable<
          NonNullable<NonNullable<GraphQLReviewsResponse['repository']>['pullRequest']>['reviews']
        >
      | null
      | undefined = response.repository?.pullRequest?.reviews;
    for (const node of connection?.nodes ?? []) {
      reviews.push({
        user: { login: node?.author?.login || 'unknown' },
        state: node?.state ?? 'UNKNOWN',
        body: node?.body || '',
        submittedAt: node?.submittedAt ?? undefined,
        commitOid: node?.commit?.oid ?? undefined,
      });
    }
    after = connection?.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
  } while (after);
  return reviews;
}

async function getPRChecksGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
): Promise<PRCheckRun[]> {
  const response = await graphqlRequest<GraphQLChecksResponse>(
    client,
    `
      query OpenSlackPrChecks($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    contexts(first: 100) {
                      nodes {
                        __typename
                        ... on CheckRun {
                          name
                          status
                          conclusion
                        }
                        ... on StatusContext {
                          context
                          state
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { owner: client.owner, repo: client.repo, number: prNumber },
  );
  const contexts =
    response.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
      ?.nodes ?? [];
  return contexts
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .map((node) => {
      if (node.__typename === 'StatusContext') {
        const state = normalizeGraphQLState(node.state);
        return {
          name: node.context || 'status',
          status: state === 'pending' ? 'in_progress' : 'completed',
          conclusion: state === 'pending' ? null : state,
        };
      }
      return {
        name: node.name || 'check',
        status: normalizeGraphQLState(node.status),
        conclusion: node.conclusion ? normalizeGraphQLState(node.conclusion) : null,
      };
    });
}

async function getCODEOWNERSGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  ref: string,
): Promise<string | null> {
  const response = await graphqlRequest<GraphQLBlobResponse>(
    client,
    `
      query OpenSlackCodeowners($owner: String!, $repo: String!, $expression: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $expression) {
            ... on Blob { text }
          }
        }
      }
    `,
    { owner: client.owner, repo: client.repo, expression: `${ref}:.github/CODEOWNERS` },
  );
  return response.repository?.object?.text ?? null;
}

export async function getPR(
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<PRDetail | null> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch PR #${prNumber} from ${client.owner}/${client.repo}`);
    return null;
  }
  try {
    const { data } = await withRetry('fetch pull request', () =>
      client.octokit.pulls.get({
        owner: client.owner,
        repo: client.repo,
        pull_number: prNumber,
      }),
    );
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
  } catch (error) {
    try {
      return await getPRGraphQL(client, prNumber);
    } catch (fallbackError) {
      if (options?.strictEvidence) {
        strictEvidenceUnavailable('fetch pull request', client, prNumber, fallbackError);
      }
    }
    if (options?.strictEvidence) {
      strictEvidenceUnavailable('fetch pull request', client, prNumber, error);
    }
    return null;
  }
}

export async function listPRFiles(
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<string[]> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would list files for PR #${prNumber}`);
    return [];
  }
  try {
    const data = await withRetry('list pull request files', () =>
      listPRFilesRest(client, prNumber),
    );
    return [
      ...new Set(
        data.flatMap((file) =>
          [file.filename, file.previous_filename].filter(
            (path): path is string => typeof path === 'string' && path.length > 0,
          ),
        ),
      ),
    ];
  } catch (error) {
    try {
      return await listPRFilesGraphQL(client, prNumber);
    } catch (fallbackError) {
      if (options?.strictEvidence) {
        strictEvidenceUnavailable('list pull request files', client, prNumber, fallbackError);
      }
    }
    if (options?.strictEvidence) {
      strictEvidenceUnavailable('list pull request files', client, prNumber, error);
    }
    return [];
  }
}

export interface PRFilePatch {
  filename: string;
  patch: string;
}

export async function getPRFilePatches(
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<PRFilePatch[]> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would list file patches for PR #${prNumber}`);
    return [];
  }
  try {
    const data = await withRetry('list pull request file patches', () =>
      listPRFilesRest(client, prNumber),
    );
    return data
      .filter((f): f is typeof f & { patch: string } => typeof f.patch === 'string')
      .map((f) => ({ filename: f.filename, patch: f.patch }));
  } catch (error) {
    if (options?.strictEvidence) {
      strictEvidenceUnavailable('list pull request file patches', client, prNumber, error);
    }
    return [];
  }
}

export async function getPRChecks(
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<PRCheckRun[]> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch checks for PR #${prNumber}`);
    return [];
  }
  try {
    const pr = await getPR(prNumber, options);
    if (!pr) return [];
    const data = await withRetry('fetch pull request checks', () =>
      listPRChecksRest(client, pr.head.sha),
    );
    return data.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
    }));
  } catch (error) {
    try {
      return await getPRChecksGraphQL(client, prNumber);
    } catch (fallbackError) {
      if (options?.strictEvidence) {
        strictEvidenceUnavailable('fetch pull request checks', client, prNumber, fallbackError);
      }
    }
    if (options?.strictEvidence) {
      strictEvidenceUnavailable('fetch pull request checks', client, prNumber, error);
    }
    return [];
  }
}

export async function getPRReviews(
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<PRReview[]> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch reviews for PR #${prNumber}`);
    return [];
  }
  try {
    const data = await withRetry('fetch pull request reviews', () =>
      listPRReviewsRest(client, prNumber),
    );
    return data.map((r) => ({
      user: { login: r.user?.login || 'unknown' },
      state: r.state,
      body: r.body || '',
      submittedAt: r.submitted_at ?? undefined,
      commitOid: r.commit_id ?? undefined,
    }));
  } catch (error) {
    try {
      return await getPRReviewsGraphQL(client, prNumber);
    } catch (fallbackError) {
      if (options?.strictEvidence) {
        strictEvidenceUnavailable('fetch pull request reviews', client, prNumber, fallbackError);
      }
    }
    if (options?.strictEvidence) {
      strictEvidenceUnavailable('fetch pull request reviews', client, prNumber, error);
    }
    return [];
  }
}

export async function getRepositoryTree(
  treeSha: string,
  options?: GitHubClientOptions,
): Promise<GitTreeEntry[]> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch recursive Git tree ${treeSha}`);
    return [];
  }
  try {
    const { data } = await withRetry('fetch repository tree', () =>
      client.octokit.git.getTree({
        owner: client.owner,
        repo: client.repo,
        tree_sha: treeSha,
        recursive: 'true',
      }),
    );
    if (data.truncated) {
      throw new Error(`Recursive Git tree ${treeSha} was truncated.`);
    }
    return data.tree.flatMap((entry) =>
      entry.path && entry.mode && entry.type && entry.sha
        ? [{ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha }]
        : [],
    );
  } catch (error) {
    // Workflow evidence must never be synthesized from placeholder empty trees.
    // Unlike generic PR metadata, a missing tree changes the trust decision.
    strictEvidenceUnavailable('fetch repository tree', client, undefined, error);
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

export async function updatePRBody(
  prNumber: number,
  body: string,
  options?: GitHubClientOptions,
): Promise<void> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would update PR #${prNumber} body`);
    return;
  }
  await client.octokit.pulls.update({
    owner: client.owner,
    repo: client.repo,
    pull_number: prNumber,
    body,
  });
}

export async function getCODEOWNERS(
  ref: string,
  options?: GitHubClientOptions,
): Promise<string | null> {
  const client = await getClient(options);
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch CODEOWNERS from ${client.owner}/${client.repo}@${ref}`);
    return null;
  }
  try {
    const { data } = await withRetry('fetch CODEOWNERS', () =>
      client.octokit.repos.getContent({
        owner: client.owner,
        repo: client.repo,
        path: '.github/CODEOWNERS',
        ref,
      }),
    );
    if ('content' in data && typeof data.content === 'string') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch (error) {
    if (isNotFound(error)) return null;
    try {
      return await getCODEOWNERSGraphQL(client, ref);
    } catch (fallbackError) {
      if (isNotFound(fallbackError)) return null;
      if (options?.strictEvidence) {
        strictEvidenceUnavailable('fetch CODEOWNERS', client, undefined, fallbackError);
      }
    }
    if (options?.strictEvidence) {
      strictEvidenceUnavailable('fetch CODEOWNERS', client, undefined, error);
    }
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
