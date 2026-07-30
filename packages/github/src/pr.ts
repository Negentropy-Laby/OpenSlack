import { getClient } from './client.js';
import type { GitHubClientOptions } from './client.js';
import { assertCanonicalPRBase } from './pr-base-policy.js';

const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 75;
const EVIDENCE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_EVIDENCE_PAGES = 10;
const DEFAULT_MAX_EVIDENCE_ITEMS = 1_000;
const DEFAULT_MAX_TREE_ENTRIES = 100_000;
const DEFAULT_MAX_CODEOWNERS_BYTES = 256 * 1024;

function evidenceLimit(
  options: GitHubClientOptions | undefined,
  key: keyof NonNullable<GitHubClientOptions['evidenceLimits']>,
  fallback: number,
): number {
  const value = options?.evidenceLimits?.[key] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`GITHUB_EVIDENCE_LIMIT_INVALID: ${key}`);
  }
  return value;
}

function codeownersByteLimit(options?: GitHubClientOptions): number {
  const value = options?.evidenceLimits?.maxCodeownersBytes ?? DEFAULT_MAX_CODEOWNERS_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > 4 * 1024 * 1024) {
    throw new Error('GITHUB_EVIDENCE_LIMIT_INVALID: maxCodeownersBytes');
  }
  return value;
}

function abortError(): Error {
  const error = new Error('GitHub evidence request aborted.');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

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
  if (error instanceof Error && error.name === 'AbortError') return false;
  const status = errorStatus(error);
  if (status !== undefined) return status >= 500 || status === 429;
  const message = errorMessage(error);
  return /ECONNRESET|ETIMEDOUT|timeout|network|socket hang up/i.test(message);
}

function isEvidenceBoundaryError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    /GITHUB_EVIDENCE_(?:ABORTED|LIMIT_INVALID|CODEOWNERS_INVALID|(?:PAGES|FILES|REVIEWS|CHECKS|PATCHES|TREE|CODEOWNERS_BYTES)_LIMIT_EXCEEDED)/.test(
      errorMessage(error),
    )
  );
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(abortError());
      },
      { once: true },
    );
  });
}

async function withTimeout<T>(
  operationName: string,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  assertNotAborted(parentSignal);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason ?? abortError());
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`${operationName} timed out after ${EVIDENCE_TIMEOUT_MS}ms`));
      reject(new Error(`${operationName} timed out after ${EVIDENCE_TIMEOUT_MS}ms`));
    }, EVIDENCE_TIMEOUT_MS);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([operation(controller.signal), timeout, aborted]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

async function withRetry<T>(
  operationName: string,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    assertNotAborted(signal);
    try {
      return await withTimeout(operationName, operation, signal);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS - 1 || !isRetryableEvidenceError(error)) break;
      await sleep(RETRY_DELAY_MS, signal);
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
  options?: GitHubClientOptions,
): Promise<T> {
  const graphql = client.octokit.graphql as unknown as (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<T>;
  return withTimeout(
    'GitHub GraphQL request',
    (signal) => graphql(query, { ...variables, request: { signal } }),
    options?.signal,
  );
}

function normalizeGraphQLState(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

async function listPRFilesRest(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<Array<{ filename: string; previous_filename?: string; patch?: string }>> {
  const files: Array<{ filename: string; previous_filename?: string; patch?: string }> = [];
  const maxPages = evidenceLimit(options, 'maxPages', DEFAULT_MAX_EVIDENCE_PAGES);
  const maxFiles = evidenceLimit(options, 'maxFiles', DEFAULT_MAX_EVIDENCE_ITEMS);
  for (let page = 1; page <= maxPages; page += 1) {
    assertNotAborted(options?.signal);
    const { data } = await client.octokit.pulls.listFiles({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      per_page: 100,
      page,
      request: { signal: options?.signal },
    });
    files.push(...data);
    if (files.length > maxFiles) throw new Error('GITHUB_EVIDENCE_FILES_LIMIT_EXCEEDED');
    if (data.length < 100) break;
    if (page === maxPages) throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
  }
  return files;
}

async function listPRReviewsRest(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
  options?: GitHubClientOptions,
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
  const maxPages = evidenceLimit(options, 'maxPages', DEFAULT_MAX_EVIDENCE_PAGES);
  const maxReviews = evidenceLimit(options, 'maxReviews', DEFAULT_MAX_EVIDENCE_ITEMS);
  for (let page = 1; page <= maxPages; page += 1) {
    assertNotAborted(options?.signal);
    const { data } = await client.octokit.pulls.listReviews({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      per_page: 100,
      page,
      request: { signal: options?.signal },
    });
    reviews.push(...data);
    if (reviews.length > maxReviews) throw new Error('GITHUB_EVIDENCE_REVIEWS_LIMIT_EXCEEDED');
    if (data.length < 100) break;
    if (page === maxPages) throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
  }
  return reviews;
}

async function listPRChecksRest(
  client: Awaited<ReturnType<typeof getClient>>,
  ref: string,
  options?: GitHubClientOptions,
): Promise<Array<{ name: string; status: string; conclusion: string | null }>> {
  const runs: Array<{ name: string; status: string; conclusion: string | null }> = [];
  const maxPages = evidenceLimit(options, 'maxPages', DEFAULT_MAX_EVIDENCE_PAGES);
  const maxChecks = evidenceLimit(options, 'maxChecks', DEFAULT_MAX_EVIDENCE_ITEMS);
  for (let page = 1; page <= maxPages; page += 1) {
    assertNotAborted(options?.signal);
    const { data } = await client.octokit.checks.listForRef({
      owner: client.owner,
      repo: client.repo,
      ref,
      per_page: 100,
      page,
      request: { signal: options?.signal },
    });
    const checkRuns = data.check_runs || [];
    runs.push(...checkRuns);
    if (runs.length > maxChecks) throw new Error('GITHUB_EVIDENCE_CHECKS_LIMIT_EXCEEDED');
    if (checkRuns.length < 100) break;
    if (page === maxPages) throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
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

interface GraphQLCheckContextNode {
  __typename: string;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  context?: string | null;
  state?: string | null;
}

interface GraphQLCheckContextsConnection {
  nodes?: Array<GraphQLCheckContextNode | null> | null;
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

interface GraphQLChecksResponse {
  repository?: {
    pullRequest?: {
      commits?: {
        nodes?: Array<{
          commit?: {
            statusCheckRollup?: {
              contexts?: GraphQLCheckContextsConnection | null;
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
  options?: GitHubClientOptions,
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
    options,
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
  options?: GitHubClientOptions,
): Promise<string[]> {
  const files: string[] = [];
  let after: string | null = null;
  let pages = 0;
  const maxPages = evidenceLimit(options, 'maxPages', DEFAULT_MAX_EVIDENCE_PAGES);
  const maxFiles = evidenceLimit(options, 'maxFiles', DEFAULT_MAX_EVIDENCE_ITEMS);
  do {
    assertNotAborted(options?.signal);
    pages += 1;
    if (pages > maxPages) throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
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
      options,
    );
    const connection:
      | NonNullable<
          NonNullable<NonNullable<GraphQLFilesResponse['repository']>['pullRequest']>['files']
        >
      | null
      | undefined = response.repository?.pullRequest?.files;
    for (const node of connection?.nodes ?? []) {
      if (node?.path) files.push(node.path);
      if (files.length > maxFiles) throw new Error('GITHUB_EVIDENCE_FILES_LIMIT_EXCEEDED');
    }
    after = connection?.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
  } while (after);
  return files;
}

async function getPRReviewsGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<PRReview[]> {
  const reviews: PRReview[] = [];
  let after: string | null = null;
  let pages = 0;
  const maxPages = evidenceLimit(options, 'maxPages', DEFAULT_MAX_EVIDENCE_PAGES);
  const maxReviews = evidenceLimit(options, 'maxReviews', DEFAULT_MAX_EVIDENCE_ITEMS);
  do {
    assertNotAborted(options?.signal);
    pages += 1;
    if (pages > maxPages) throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
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
      options,
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
      if (reviews.length > maxReviews) throw new Error('GITHUB_EVIDENCE_REVIEWS_LIMIT_EXCEEDED');
    }
    after = connection?.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
  } while (after);
  return reviews;
}

async function getPRChecksGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<PRCheckRun[]> {
  const checks: PRCheckRun[] = [];
  let after: string | null = null;
  let pages = 0;
  const maxPages = evidenceLimit(options, 'maxPages', DEFAULT_MAX_EVIDENCE_PAGES);
  const maxChecks = evidenceLimit(options, 'maxChecks', DEFAULT_MAX_EVIDENCE_ITEMS);
  do {
    assertNotAborted(options?.signal);
    pages += 1;
    if (pages > maxPages) throw new Error('GITHUB_EVIDENCE_PAGES_LIMIT_EXCEEDED');
    const response: GraphQLChecksResponse = await graphqlRequest<GraphQLChecksResponse>(
      client,
      `
        query OpenSlackPrChecks(
          $owner: String!
          $repo: String!
          $number: Int!
          $after: String
        ) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              commits(last: 1) {
                nodes {
                  commit {
                    statusCheckRollup {
                      contexts(first: 100, after: $after) {
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
                        pageInfo { hasNextPage endCursor }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner: client.owner, repo: client.repo, number: prNumber, after },
      options,
    );
    const connection: GraphQLCheckContextsConnection | null | undefined =
      response.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    for (const node of connection?.nodes ?? []) {
      if (!node) continue;
      if (node.__typename === 'StatusContext') {
        const state = normalizeGraphQLState(node.state);
        checks.push({
          name: node.context || 'status',
          status: state === 'pending' ? 'in_progress' : 'completed',
          conclusion: state === 'pending' ? null : state,
        });
      } else {
        checks.push({
          name: node.name || 'check',
          status: normalizeGraphQLState(node.status),
          conclusion: node.conclusion ? normalizeGraphQLState(node.conclusion) : null,
        });
      }
      if (checks.length > maxChecks) throw new Error('GITHUB_EVIDENCE_CHECKS_LIMIT_EXCEEDED');
    }
    after = connection?.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
  } while (after);
  return checks;
}

async function getCODEOWNERSGraphQL(
  client: Awaited<ReturnType<typeof getClient>>,
  ref: string,
  options?: GitHubClientOptions,
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
    options,
  );
  const content = response.repository?.object?.text ?? null;
  return content === null ? null : assertCodeownersText(content, options);
}

function assertCodeownersText(content: string, options?: GitHubClientOptions): string {
  if (Buffer.byteLength(content, 'utf8') > codeownersByteLimit(options)) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_BYTES_LIMIT_EXCEEDED');
  }
  return content;
}

function decodeCodeownersBase64(content: string, options?: GitHubClientOptions): string {
  const maxBytes = codeownersByteLimit(options);
  const maxEncodedBytes = Math.ceil(maxBytes / 3) * 4 + 4;
  if (content.length > maxEncodedBytes * 2 + 1_024) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_BYTES_LIMIT_EXCEEDED');
  }
  const normalized = content.replace(/\s/g, '');
  if (
    normalized.length > maxEncodedBytes ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_INVALID');
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.byteLength > maxBytes) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_BYTES_LIMIT_EXCEEDED');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_INVALID');
  }
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
    const { data } = await withRetry(
      'fetch pull request',
      (signal) =>
        client.octokit.pulls.get({
          owner: client.owner,
          repo: client.repo,
          pull_number: prNumber,
          request: { signal },
        }),
      options?.signal,
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
    if (isEvidenceBoundaryError(error)) throw error;
    try {
      return await getPRGraphQL(client, prNumber, options);
    } catch (fallbackError) {
      if (isEvidenceBoundaryError(fallbackError)) throw fallbackError;
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
    const data = await withRetry(
      'list pull request files',
      (signal) => listPRFilesRest(client, prNumber, { ...options, signal }),
      options?.signal,
    );
    const files = [
      ...new Set(
        data.flatMap((file) =>
          [file.filename, file.previous_filename].filter(
            (path): path is string => typeof path === 'string' && path.length > 0,
          ),
        ),
      ),
    ];
    if (files.length > evidenceLimit(options, 'maxFiles', DEFAULT_MAX_EVIDENCE_ITEMS)) {
      throw new Error('GITHUB_EVIDENCE_FILES_LIMIT_EXCEEDED');
    }
    return files;
  } catch (error) {
    if (isEvidenceBoundaryError(error)) throw error;
    try {
      return await listPRFilesGraphQL(client, prNumber, options);
    } catch (fallbackError) {
      if (isEvidenceBoundaryError(fallbackError)) throw fallbackError;
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
    const data = await withRetry(
      'list pull request file patches',
      (signal) => listPRFilesRest(client, prNumber, { ...options, signal }),
      options?.signal,
    );
    const patches = data
      .filter((f): f is typeof f & { patch: string } => typeof f.patch === 'string')
      .map((f) => ({ filename: f.filename, patch: f.patch }));
    if (patches.length > evidenceLimit(options, 'maxPatches', DEFAULT_MAX_EVIDENCE_ITEMS)) {
      throw new Error('GITHUB_EVIDENCE_PATCHES_LIMIT_EXCEEDED');
    }
    return patches;
  } catch (error) {
    if (isEvidenceBoundaryError(error)) throw error;
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
    const data = await withRetry(
      'fetch pull request checks',
      (signal) => listPRChecksRest(client, pr.head.sha, { ...options, signal }),
      options?.signal,
    );
    return data.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
    }));
  } catch (error) {
    if (isEvidenceBoundaryError(error)) throw error;
    try {
      return await getPRChecksGraphQL(client, prNumber, options);
    } catch (fallbackError) {
      if (isEvidenceBoundaryError(fallbackError)) throw fallbackError;
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
    const data = await withRetry(
      'fetch pull request reviews',
      (signal) => listPRReviewsRest(client, prNumber, { ...options, signal }),
      options?.signal,
    );
    return data.map((r) => ({
      user: { login: r.user?.login || 'unknown' },
      state: r.state,
      body: r.body || '',
      submittedAt: r.submitted_at ?? undefined,
      commitOid: r.commit_id ?? undefined,
    }));
  } catch (error) {
    if (isEvidenceBoundaryError(error)) throw error;
    try {
      return await getPRReviewsGraphQL(client, prNumber, options);
    } catch (fallbackError) {
      if (isEvidenceBoundaryError(fallbackError)) throw fallbackError;
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
    const { data } = await withRetry(
      'fetch repository tree',
      (signal) =>
        client.octokit.git.getTree({
          owner: client.owner,
          repo: client.repo,
          tree_sha: treeSha,
          recursive: 'true',
          request: { signal },
        }),
      options?.signal,
    );
    if (data.truncated) {
      throw new Error(`Recursive Git tree ${treeSha} was truncated.`);
    }
    if (data.tree.length > evidenceLimit(options, 'maxTreeEntries', DEFAULT_MAX_TREE_ENTRIES)) {
      throw new Error('GITHUB_EVIDENCE_TREE_LIMIT_EXCEEDED');
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
    const { data } = await withRetry(
      'fetch CODEOWNERS',
      (signal) =>
        client.octokit.repos.getContent({
          owner: client.owner,
          repo: client.repo,
          path: '.github/CODEOWNERS',
          ref,
          request: { signal },
        }),
      options?.signal,
    );
    if ('content' in data && typeof data.content === 'string') {
      return decodeCodeownersBase64(data.content, options);
    }
    return null;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (isEvidenceBoundaryError(error)) throw error;
    try {
      return await getCODEOWNERSGraphQL(client, ref, options);
    } catch (fallbackError) {
      if (isNotFound(fallbackError)) return null;
      if (isEvidenceBoundaryError(fallbackError)) throw fallbackError;
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
    expectedHeadSha?: string;
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
      ...(options.expectedHeadSha ? { sha: options.expectedHeadSha } : {}),
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
