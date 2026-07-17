import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  canonicalizeRepositoryName,
  getClient,
  type GitHubAuthPreference,
  type GitHubClient,
  type RepositoryIdentity,
} from '@openslack/github';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_API_BUDGET = 100;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_PULL_REQUEST_LIMIT = 20;
const MAX_CONCURRENCY = 32;
const MAX_API_BUDGET = 10_000;
const MAX_CACHE_TTL_SECONDS = 86_400;
const MAX_PULL_REQUEST_LIMIT = 100;
const CHECK_PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 10;

export type RepositoryPRProjectionSource = 'github-live' | 'local-cache';

export interface RepositoryPRCheckSummary {
  total: number;
  pending: number;
  successful: number;
  failed: number;
  neutral: number;
  complete: boolean;
}

export interface RepositoryPRProjectionItem {
  repository: RepositoryIdentity;
  prNumber: number;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  headSha: string;
  updatedAt: string;
  checks: RepositoryPRCheckSummary;
  fetchedAt: string;
  ageSeconds: number;
  stale: boolean;
  partial: boolean;
  source: RepositoryPRProjectionSource;
}

export interface PullRequestStateProjectionChange {
  kind: 'pull_request.state_changed';
  repository: RepositoryIdentity;
  prNumber: number;
  observedAt: string;
  synthetic: true;
  source: 'poll';
  changedFields: Array<'state' | 'headSha'>;
  previous: {
    state: string;
    headSha: string;
  };
  current: {
    state: string;
    headSha: string;
  };
}

export interface ChecksSummaryProjectionChange {
  kind: 'checks.summary_changed';
  repository: RepositoryIdentity;
  prNumber: number;
  observedAt: string;
  synthetic: true;
  source: 'poll';
  headSha: string;
  previous: RepositoryPRCheckSummary;
  current: RepositoryPRCheckSummary;
}

export type RepositoryProjectionChange =
  | PullRequestStateProjectionChange
  | ChecksSummaryProjectionChange;

export type RepositoryPRProjectionErrorCode =
  | 'AUTH_REQUIRED'
  | 'API_BUDGET_EXHAUSTED'
  | 'GITHUB_UNAVAILABLE'
  | 'INVALID_GITHUB_RESPONSE';

export interface RepositoryPRProjectionRepositoryResult {
  repository: RepositoryIdentity;
  fetchedAt: string;
  ageSeconds: number;
  stale: boolean;
  partial: boolean;
  source: RepositoryPRProjectionSource;
  items: RepositoryPRProjectionItem[];
  changes: RepositoryProjectionChange[];
  errorCode?: RepositoryPRProjectionErrorCode;
}

export interface RepositoryPRProjectionResult {
  schema: 'openslack.repository_pr_projection.v1';
  fetchedAt: string;
  repositories: RepositoryPRProjectionRepositoryResult[];
  items: RepositoryPRProjectionItem[];
  changes: RepositoryProjectionChange[];
  partial: boolean;
  budget: {
    limit: number;
    used: number;
    remaining: number;
    exhausted: boolean;
  };
  authority: {
    humanApproval: 'not_evaluated';
    mergeReadiness: 'not_evaluated';
  };
  informational: true;
}

export interface RepositoryPRProjectionOptions {
  repositories: Array<{ owner: string; repo: string }>;
  workspaceRoot?: string;
  localStateRoot?: string;
  auth?: GitHubAuthPreference;
  concurrency?: number;
  apiBudget?: number;
  cacheTtlSeconds?: number;
  limit?: number;
  now?: () => Date;
  clientFactory?: (repository: RepositoryIdentity) => Promise<GitHubClient>;
}

interface CachedRepositoryPRProjection {
  schema: 'openslack.repository_pr_projection_cache.v1';
  repository: RepositoryIdentity;
  fetchedAt: string;
  items: Array<
    Pick<
      RepositoryPRProjectionItem,
      'prNumber' | 'title' | 'author' | 'state' | 'draft' | 'headSha' | 'updatedAt' | 'checks'
    >
  >;
}

interface RepositoryPRProjectionCursorItem {
  state: string;
  headSha: string;
  checks?: RepositoryPRCheckSummary;
}

interface RepositoryPRProjectionCursor {
  schema: 'openslack.repository_pr_projection_cursor.v1';
  repository: RepositoryIdentity;
  updatedAt: string;
  pullRequests: Record<string, RepositoryPRProjectionCursorItem>;
}

interface GitHubPullRequestSnapshot {
  prNumber: number;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  headSha: string;
  updatedAt: string;
}

class ProjectionBudgetExhaustedError extends Error {
  constructor() {
    super('Repository projection API budget is exhausted.');
    this.name = 'ProjectionBudgetExhaustedError';
  }
}

class ProjectionInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionInvalidResponseError';
  }
}

class ProjectionApiScheduler {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private usedCount = 0;

  constructor(
    readonly limit: number,
    private readonly concurrency: number,
  ) {}

  get used(): number {
    return this.usedCount;
  }

  get exhausted(): boolean {
    return this.usedCount >= this.limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.usedCount >= this.limit) throw new ProjectionBudgetExhaustedError();
    this.usedCount += 1;
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolveWaiter) => {
      this.waiting.push(resolveWaiter);
    });
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

class RepositoryPRProjectionStore {
  constructor(private readonly root: string) {}

  async readCache(repository: RepositoryIdentity): Promise<CachedRepositoryPRProjection | null> {
    const cache = await this.readJson<CachedRepositoryPRProjection>(
      this.cachePath(repository),
      'openslack.repository_pr_projection_cache.v1',
    );
    return cache && isCachedRepositoryPRProjection(cache, repository) ? cache : null;
  }

  async writeCache(
    repository: RepositoryIdentity,
    cache: CachedRepositoryPRProjection,
  ): Promise<void> {
    await this.atomicWrite(this.cachePath(repository), cache);
  }

  async readCursor(repository: RepositoryIdentity): Promise<RepositoryPRProjectionCursor | null> {
    const cursor = await this.readJson<RepositoryPRProjectionCursor>(
      this.cursorPath(repository),
      'openslack.repository_pr_projection_cursor.v1',
    );
    return cursor && isRepositoryPRProjectionCursor(cursor, repository) ? cursor : null;
  }

  async writeCursor(
    repository: RepositoryIdentity,
    cursor: RepositoryPRProjectionCursor,
  ): Promise<void> {
    await this.atomicWrite(this.cursorPath(repository), cursor);
  }

  private cachePath(repository: RepositoryIdentity): string {
    return join(this.root, 'cache', `${repositoryFileKey(repository)}.json`);
  }

  private cursorPath(repository: RepositoryIdentity): string {
    return join(this.root, 'cursors', `${repositoryFileKey(repository)}.json`);
  }

  private async readJson<T extends { schema: string }>(
    path: string,
    expectedSchema: T['schema'],
  ): Promise<T | null> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        (parsed as { schema?: unknown }).schema !== expectedSchema
      ) {
        return null;
      }
      return parsed as T;
    } catch {
      return null;
    }
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
      await syncDirectory(dirname(path));
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function isCachedRepositoryPRProjection(
  value: unknown,
  expectedRepository: RepositoryIdentity,
): value is CachedRepositoryPRProjection {
  if (
    !isRecordWithExactKeys(value, ['schema', 'repository', 'fetchedAt', 'items']) ||
    value.schema !== 'openslack.repository_pr_projection_cache.v1' ||
    !isRepositoryIdentity(value.repository, expectedRepository) ||
    !isDateString(value.fetchedAt) ||
    !Array.isArray(value.items)
  ) {
    return false;
  }
  const numbers = new Set<number>();
  for (const item of value.items) {
    if (
      !isRecordWithExactKeys(item, [
        'prNumber',
        'title',
        'author',
        'state',
        'draft',
        'headSha',
        'updatedAt',
        'checks',
      ]) ||
      !isPositiveSafeInteger(item.prNumber) ||
      numbers.has(item.prNumber) ||
      typeof item.title !== 'string' ||
      typeof item.author !== 'string' ||
      typeof item.state !== 'string' ||
      typeof item.draft !== 'boolean' ||
      typeof item.headSha !== 'string' ||
      !isDateString(item.updatedAt) ||
      !isRepositoryPRCheckSummary(item.checks)
    ) {
      return false;
    }
    numbers.add(item.prNumber);
  }
  return true;
}

function isRepositoryPRProjectionCursor(
  value: unknown,
  expectedRepository: RepositoryIdentity,
): value is RepositoryPRProjectionCursor {
  if (
    !isRecordWithExactKeys(value, ['schema', 'repository', 'updatedAt', 'pullRequests']) ||
    value.schema !== 'openslack.repository_pr_projection_cursor.v1' ||
    !isRepositoryIdentity(value.repository, expectedRepository) ||
    !isDateString(value.updatedAt) ||
    !isRecord(value.pullRequests)
  ) {
    return false;
  }
  for (const [number, snapshot] of Object.entries(value.pullRequests)) {
    if (
      String(Number(number)) !== number ||
      !isPositiveSafeInteger(Number(number)) ||
      !isRecordWithAllowedKeys(snapshot, ['state', 'headSha', 'checks']) ||
      !hasExactRequiredKeys(snapshot, ['state', 'headSha']) ||
      typeof snapshot.state !== 'string' ||
      typeof snapshot.headSha !== 'string' ||
      (snapshot.checks !== undefined && !isRepositoryPRCheckSummary(snapshot.checks))
    ) {
      return false;
    }
  }
  return true;
}

function isRepositoryIdentity(value: unknown, expected: RepositoryIdentity): boolean {
  if (
    !isRecordWithExactKeys(value, ['owner', 'repo', 'fullName', 'canonicalFullName']) ||
    typeof value.owner !== 'string' ||
    typeof value.repo !== 'string' ||
    typeof value.fullName !== 'string' ||
    typeof value.canonicalFullName !== 'string'
  ) {
    return false;
  }
  const canonical = canonicalizeRepositoryName(value.owner, value.repo);
  return Boolean(
    canonical &&
      canonical.fullName === value.fullName &&
      canonical.canonicalFullName === value.canonicalFullName &&
      canonical.canonicalFullName === expected.canonicalFullName,
  );
}

function isRepositoryPRCheckSummary(value: unknown): value is RepositoryPRCheckSummary {
  if (
    !isRecordWithExactKeys(value, [
      'total',
      'pending',
      'successful',
      'failed',
      'neutral',
      'complete',
    ]) ||
    !isNonNegativeSafeInteger(value.total) ||
    !isNonNegativeSafeInteger(value.pending) ||
    !isNonNegativeSafeInteger(value.successful) ||
    !isNonNegativeSafeInteger(value.failed) ||
    !isNonNegativeSafeInteger(value.neutral) ||
    typeof value.complete !== 'boolean'
  ) {
    return false;
  }
  return value.total === value.pending + value.successful + value.failed + value.neutral;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactRequiredKeys(value, expectedKeys) &&
    Object.keys(value).length === expectedKeys.length
  );
}

function isRecordWithAllowedKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasExactRequiredKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
): boolean {
  return requiredKeys.every((key) => Object.hasOwn(value, key));
}

export async function buildRepositoryPRProjection(
  options: RepositoryPRProjectionOptions,
): Promise<RepositoryPRProjectionResult> {
  const repositories = normalizeRepositories(options.repositories);
  if (repositories.length === 0) {
    throw new TypeError('At least one repository is required for repository PR projection.');
  }

  const concurrency = boundedInteger(
    options.concurrency,
    DEFAULT_CONCURRENCY,
    1,
    MAX_CONCURRENCY,
    'concurrency',
  );
  const apiBudget = boundedInteger(
    options.apiBudget,
    DEFAULT_API_BUDGET,
    1,
    MAX_API_BUDGET,
    'apiBudget',
  );
  const cacheTtlSeconds = boundedInteger(
    options.cacheTtlSeconds,
    DEFAULT_CACHE_TTL_SECONDS,
    0,
    MAX_CACHE_TTL_SECONDS,
    'cacheTtlSeconds',
  );
  const limit = boundedInteger(
    options.limit,
    DEFAULT_PULL_REQUEST_LIMIT,
    1,
    MAX_PULL_REQUEST_LIMIT,
    'limit',
  );
  const now = options.now ?? (() => new Date());
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const localStateRoot = resolve(
    options.localStateRoot ?? join(workspaceRoot, '.openslack.local', 'pr-projection'),
  );
  const store = new RepositoryPRProjectionStore(localStateRoot);
  const scheduler = new ProjectionApiScheduler(apiBudget, concurrency);
  const clientFactory = createClientFactory(options, repositories);

  const repositoryResults = await Promise.all(
    repositories.map((repository) =>
      projectRepository({
        repository,
        store,
        scheduler,
        clientFactory,
        cacheTtlSeconds,
        limit,
        now,
      }),
    ),
  );
  const fetchedAt = now().toISOString();
  const items = repositoryResults.flatMap((result) => result.items);
  const changes = repositoryResults.flatMap((result) => result.changes);

  return {
    schema: 'openslack.repository_pr_projection.v1',
    fetchedAt,
    repositories: repositoryResults,
    items,
    changes,
    partial: repositoryResults.some((result) => result.partial),
    budget: {
      limit: apiBudget,
      used: scheduler.used,
      remaining: Math.max(0, apiBudget - scheduler.used),
      exhausted: scheduler.exhausted,
    },
    authority: {
      humanApproval: 'not_evaluated',
      mergeReadiness: 'not_evaluated',
    },
    informational: true,
  };
}

export function renderRepositoryPRProjection(result: RepositoryPRProjectionResult): string {
  const lines = [
    'Repository PR Projection',
    '========================',
    `Fetched: ${result.fetchedAt}`,
    `Repositories: ${result.repositories.length}`,
    `API budget: ${result.budget.used}/${result.budget.limit}${result.budget.exhausted ? ' (exhausted)' : ''}`,
    `Partial: ${result.partial ? 'yes' : 'no'}`,
    'Authority: human approval and merge readiness are not evaluated.',
  ];
  if (result.items.length === 0) {
    lines.push('', 'No open pull requests found.');
  }
  for (const repository of result.repositories) {
    lines.push(
      '',
      `[${repository.repository.fullName}] source=${repository.source} age=${repository.ageSeconds}s stale=${repository.stale ? 'yes' : 'no'} partial=${repository.partial ? 'yes' : 'no'}`,
    );
    if (repository.errorCode) lines.push(`  Error: ${repository.errorCode}`);
    for (const item of repository.items) {
      lines.push(
        `  #${item.prNumber} ${item.title}`,
        `    Author: @${item.author} | State: ${item.state}${item.draft ? ' (draft)' : ''}`,
        `    Head: ${item.headSha.slice(0, 12)} | Updated: ${item.updatedAt}`,
        `    Checks: ${item.checks.successful} successful, ${item.checks.failed} failed, ${item.checks.pending} pending, ${item.checks.neutral} neutral${item.checks.complete ? '' : ' (partial)'}`,
        `    Source: ${item.source} | fetchedAt=${item.fetchedAt} | age=${item.ageSeconds}s | stale=${item.stale ? 'yes' : 'no'} | partial=${item.partial ? 'yes' : 'no'}`,
        `    Diagnose: openslack pr doctor ${item.prNumber} --repo ${item.repository.fullName}`,
      );
    }
  }
  if (result.changes.length > 0) {
    lines.push('', `Synthetic polling changes: ${result.changes.length} (informational only)`);
    for (const change of result.changes) {
      lines.push(`  ${change.kind} ${change.repository.fullName}#${change.prNumber}`);
    }
  }
  return lines.join('\n');
}

async function projectRepository(input: {
  repository: RepositoryIdentity;
  store: RepositoryPRProjectionStore;
  scheduler: ProjectionApiScheduler;
  clientFactory: (repository: RepositoryIdentity) => Promise<GitHubClient>;
  cacheTtlSeconds: number;
  limit: number;
  now: () => Date;
}): Promise<RepositoryPRProjectionRepositoryResult> {
  const { repository, store, scheduler, clientFactory, cacheTtlSeconds, limit, now } = input;
  const observedAt = now();
  const cache = await store.readCache(repository);
  const cacheAge = cache ? ageSeconds(cache.fetchedAt, observedAt) : Number.POSITIVE_INFINITY;
  if (cache && cacheTtlSeconds > 0 && cacheAge <= cacheTtlSeconds) {
    return resultFromCache(repository, cache, cacheAge, cacheAge > cacheTtlSeconds, false);
  }

  try {
    const client = await clientFactory(repository);
    assertClientRepository(client, repository);
    if (client.isDryRun) throw new ProjectionInvalidResponseError('Dry-run clients cannot build live projections.');

    const openPullRequests = await scheduler.run(async () => {
      const response = await client.octokit.pulls.list({
        owner: repository.owner,
        repo: repository.repo,
        state: 'open',
        per_page: limit,
        sort: 'updated',
        direction: 'desc',
      });
      return normalizePullRequestList(response.data);
    });

    const cachedByNumber = new Map(cache?.items.map((item) => [item.prNumber, item]) ?? []);
    const liveItems = await Promise.all(
      openPullRequests.map(async (pullRequest) => {
        const cached = cachedByNumber.get(pullRequest.prNumber);
        const checkResult = await fetchCheckSummary(
          scheduler,
          client,
          repository,
          pullRequest.headSha,
        );
        const checks =
          checkResult.summary ??
          (cached?.headSha === pullRequest.headSha ? cloneCheckSummary(cached.checks) : emptyCheckSummary(false));
        return {
          ...pullRequest,
          checks,
          partial: !checkResult.complete,
        };
      }),
    );

    const cursor = await store.readCursor(repository);
    const missingChanges = await findMissingPullRequestChanges({
      repository,
      cursor,
      currentNumbers: new Set(liveItems.map((item) => item.prNumber)),
      client,
      scheduler,
      observedAt: observedAt.toISOString(),
    });
    const changes = [
      ...compareProjectionCursor(repository, cursor, liveItems, observedAt.toISOString()),
      ...missingChanges.changes,
    ];
    const fetchedAt = observedAt.toISOString();
    const items: RepositoryPRProjectionItem[] = liveItems.map((item) => ({
      repository,
      prNumber: item.prNumber,
      title: item.title,
      author: item.author,
      state: item.state,
      draft: item.draft,
      headSha: item.headSha,
      updatedAt: item.updatedAt,
      checks: cloneCheckSummary(item.checks),
      fetchedAt,
      ageSeconds: 0,
      stale: false,
      partial: item.partial,
      source: 'github-live',
    }));
    const partial =
      liveItems.some((item) => item.partial) ||
      missingChanges.partial ||
      scheduler.exhausted;

    await store.writeCache(repository, {
      schema: 'openslack.repository_pr_projection_cache.v1',
      repository,
      fetchedAt,
      items: items.map((item) => ({
        prNumber: item.prNumber,
        title: item.title,
        author: item.author,
        state: item.state,
        draft: item.draft,
        headSha: item.headSha,
        updatedAt: item.updatedAt,
        checks: cloneCheckSummary(item.checks),
      })),
    });
    await store.writeCursor(repository, buildNextCursor(repository, cursor, liveItems, fetchedAt));

    return {
      repository,
      fetchedAt,
      ageSeconds: 0,
      stale: false,
      partial,
      source: 'github-live',
      items,
      changes,
      ...(scheduler.exhausted ? { errorCode: 'API_BUDGET_EXHAUSTED' as const } : {}),
    };
  } catch (error) {
    const errorCode = projectionErrorCode(error);
    if (cache) {
      return resultFromCache(repository, cache, cacheAge, true, true, errorCode);
    }
    return {
      repository,
      fetchedAt: observedAt.toISOString(),
      ageSeconds: 0,
      stale: true,
      partial: true,
      source: 'local-cache',
      items: [],
      changes: [],
      errorCode,
    };
  }
}

async function fetchCheckSummary(
  scheduler: ProjectionApiScheduler,
  client: GitHubClient,
  repository: RepositoryIdentity,
  headSha: string,
): Promise<{ summary: RepositoryPRCheckSummary | null; complete: boolean }> {
  const summary = emptyCheckSummary(true);
  try {
    for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
      const response = await scheduler.run(() =>
        client.octokit.checks.listForRef({
          owner: repository.owner,
          repo: repository.repo,
          ref: headSha,
          per_page: CHECK_PAGE_SIZE,
          page,
        }),
      );
      const runs = response.data.check_runs;
      if (!Array.isArray(runs)) throw new ProjectionInvalidResponseError('GitHub check response is invalid.');
      for (const run of runs) {
        summarizeCheck(summary, String(run.status), run.conclusion === null ? null : String(run.conclusion));
      }
      if (runs.length < CHECK_PAGE_SIZE) return { summary, complete: true };
    }
    summary.complete = false;
    return { summary, complete: false };
  } catch {
    summary.complete = false;
    return { summary: summary.total > 0 ? summary : null, complete: false };
  }
}

async function findMissingPullRequestChanges(input: {
  repository: RepositoryIdentity;
  cursor: RepositoryPRProjectionCursor | null;
  currentNumbers: Set<number>;
  client: GitHubClient;
  scheduler: ProjectionApiScheduler;
  observedAt: string;
}): Promise<{ changes: RepositoryProjectionChange[]; partial: boolean }> {
  if (!input.cursor) return { changes: [], partial: false };
  const missing = Object.entries(input.cursor.pullRequests)
    .map(([number, snapshot]) => ({ prNumber: Number(number), snapshot }))
    .filter(({ prNumber }) => Number.isSafeInteger(prNumber) && !input.currentNumbers.has(prNumber));
  const changes: RepositoryProjectionChange[] = [];
  let partial = false;
  await Promise.all(
    missing.map(async ({ prNumber, snapshot }) => {
      try {
        const response = await input.scheduler.run(() =>
          input.client.octokit.pulls.get({
            owner: input.repository.owner,
            repo: input.repository.repo,
            pull_number: prNumber,
          }),
        );
        const state = typeof response.data.state === 'string' ? response.data.state : null;
        const headSha = typeof response.data.head?.sha === 'string' ? response.data.head.sha : null;
        if (!state || !headSha) throw new ProjectionInvalidResponseError('GitHub pull request response is invalid.');
        const changedFields: Array<'state' | 'headSha'> = [];
        if (snapshot.state !== state) changedFields.push('state');
        if (snapshot.headSha !== headSha) changedFields.push('headSha');
        if (changedFields.length > 0) {
          changes.push({
            kind: 'pull_request.state_changed',
            repository: input.repository,
            prNumber,
            observedAt: input.observedAt,
            synthetic: true,
            source: 'poll',
            changedFields,
            previous: { state: snapshot.state, headSha: snapshot.headSha },
            current: { state, headSha },
          });
        }
      } catch {
        partial = true;
      }
    }),
  );
  return { changes: changes.sort((left, right) => left.prNumber - right.prNumber), partial };
}

function compareProjectionCursor(
  repository: RepositoryIdentity,
  cursor: RepositoryPRProjectionCursor | null,
  items: Array<GitHubPullRequestSnapshot & { checks: RepositoryPRCheckSummary; partial: boolean }>,
  observedAt: string,
): RepositoryProjectionChange[] {
  if (!cursor) return [];
  const changes: RepositoryProjectionChange[] = [];
  for (const item of items) {
    const previous = cursor.pullRequests[String(item.prNumber)];
    if (!previous) continue;
    const changedFields: Array<'state' | 'headSha'> = [];
    if (previous.state !== item.state) changedFields.push('state');
    if (previous.headSha !== item.headSha) changedFields.push('headSha');
    if (changedFields.length > 0) {
      changes.push({
        kind: 'pull_request.state_changed',
        repository,
        prNumber: item.prNumber,
        observedAt,
        synthetic: true,
        source: 'poll',
        changedFields,
        previous: { state: previous.state, headSha: previous.headSha },
        current: { state: item.state, headSha: item.headSha },
      });
    }
    if (
      item.checks.complete &&
      previous.checks?.complete &&
      !checkSummariesEqual(previous.checks, item.checks)
    ) {
      changes.push({
        kind: 'checks.summary_changed',
        repository,
        prNumber: item.prNumber,
        observedAt,
        synthetic: true,
        source: 'poll',
        headSha: item.headSha,
        previous: cloneCheckSummary(previous.checks),
        current: cloneCheckSummary(item.checks),
      });
    }
  }
  return changes.sort(
    (left, right) =>
      left.prNumber - right.prNumber ||
      left.kind.localeCompare(right.kind, 'en-US'),
  );
}

function buildNextCursor(
  repository: RepositoryIdentity,
  previous: RepositoryPRProjectionCursor | null,
  items: Array<GitHubPullRequestSnapshot & { checks: RepositoryPRCheckSummary; partial: boolean }>,
  updatedAt: string,
): RepositoryPRProjectionCursor {
  const pullRequests: Record<string, RepositoryPRProjectionCursorItem> = {};
  for (const item of items) {
    const previousItem = previous?.pullRequests[String(item.prNumber)];
    const checks = item.checks.complete
      ? cloneCheckSummary(item.checks)
      : previousItem?.headSha === item.headSha && previousItem.checks
        ? cloneCheckSummary(previousItem.checks)
        : undefined;
    pullRequests[String(item.prNumber)] = {
      state: item.state,
      headSha: item.headSha,
      ...(checks ? { checks } : {}),
    };
  }
  return {
    schema: 'openslack.repository_pr_projection_cursor.v1',
    repository,
    updatedAt,
    pullRequests,
  };
}

function resultFromCache(
  repository: RepositoryIdentity,
  cache: CachedRepositoryPRProjection,
  age: number,
  stale: boolean,
  partial: boolean,
  errorCode?: RepositoryPRProjectionErrorCode,
): RepositoryPRProjectionRepositoryResult {
  return {
    repository,
    fetchedAt: cache.fetchedAt,
    ageSeconds: age,
    stale,
    partial,
    source: 'local-cache',
    items: cache.items.map((item) => ({
      repository,
      ...item,
      checks: cloneCheckSummary(item.checks),
      fetchedAt: cache.fetchedAt,
      ageSeconds: age,
      stale,
      partial: partial || !item.checks.complete,
      source: 'local-cache',
    })),
    changes: [],
    ...(errorCode ? { errorCode } : {}),
  };
}

function createClientFactory(
  options: RepositoryPRProjectionOptions,
  repositories: RepositoryIdentity[],
): (repository: RepositoryIdentity) => Promise<GitHubClient> {
  if (options.clientFactory) return options.clientFactory;
  let sharedClient: Promise<GitHubClient> | undefined;
  return async (repository) => {
    sharedClient ??= getClient({
      repoFullName: repositories[0]!.fullName,
      auth: options.auth,
      requireLive: true,
      strictEvidence: true,
      cwd: options.workspaceRoot,
      localStateRoot: options.workspaceRoot
        ? join(resolve(options.workspaceRoot), '.openslack.local')
        : undefined,
    });
    const client = await sharedClient;
    return {
      ...client,
      owner: repository.owner,
      repo: repository.repo,
    };
  };
}

function normalizeRepositories(
  repositories: Array<{ owner: string; repo: string }>,
): RepositoryIdentity[] {
  const normalized: RepositoryIdentity[] = [];
  const seen = new Set<string>();
  for (const repository of repositories) {
    const identity = canonicalizeRepositoryName(repository.owner, repository.repo);
    if (!identity) {
      throw new TypeError(`Invalid GitHub repository "${repository.owner}/${repository.repo}".`);
    }
    if (seen.has(identity.canonicalFullName)) continue;
    seen.add(identity.canonicalFullName);
    normalized.push(identity);
  }
  return normalized;
}

function normalizePullRequestList(value: unknown): GitHubPullRequestSnapshot[] {
  if (!Array.isArray(value)) throw new ProjectionInvalidResponseError('GitHub pull request list is invalid.');
  const snapshots: GitHubPullRequestSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProjectionInvalidResponseError('GitHub pull request entry is invalid.');
    }
    const record = item as Record<string, unknown>;
    const head = record.head as Record<string, unknown> | null | undefined;
    const user = record.user as Record<string, unknown> | null | undefined;
    if (
      typeof record.number !== 'number' ||
      !Number.isSafeInteger(record.number) ||
      typeof record.title !== 'string' ||
      typeof record.state !== 'string' ||
      typeof record.updated_at !== 'string' ||
      !head ||
      typeof head.sha !== 'string'
    ) {
      throw new ProjectionInvalidResponseError('GitHub pull request entry is incomplete.');
    }
    snapshots.push({
      prNumber: record.number,
      title: record.title,
      author: user && typeof user.login === 'string' ? user.login : 'unknown',
      state: record.state,
      draft: record.draft === true,
      headSha: head.sha,
      updatedAt: record.updated_at,
    });
  }
  return snapshots;
}

function assertClientRepository(client: GitHubClient, repository: RepositoryIdentity): void {
  if (
    client.owner.toLocaleLowerCase('en-US') !== repository.owner.toLocaleLowerCase('en-US') ||
    client.repo.toLocaleLowerCase('en-US') !== repository.repo.toLocaleLowerCase('en-US')
  ) {
    throw new ProjectionInvalidResponseError('Repository projection client is bound to another repository.');
  }
}

function summarizeCheck(
  summary: RepositoryPRCheckSummary,
  status: string,
  conclusion: string | null,
): void {
  summary.total += 1;
  if (status !== 'completed' || conclusion === null) {
    summary.pending += 1;
  } else if (conclusion === 'success') {
    summary.successful += 1;
  } else if (
    conclusion === 'failure' ||
    conclusion === 'cancelled' ||
    conclusion === 'timed_out' ||
    conclusion === 'action_required' ||
    conclusion === 'startup_failure' ||
    conclusion === 'stale'
  ) {
    summary.failed += 1;
  } else {
    summary.neutral += 1;
  }
}

function emptyCheckSummary(complete: boolean): RepositoryPRCheckSummary {
  return {
    total: 0,
    pending: 0,
    successful: 0,
    failed: 0,
    neutral: 0,
    complete,
  };
}

function cloneCheckSummary(summary: RepositoryPRCheckSummary): RepositoryPRCheckSummary {
  return { ...summary };
}

function checkSummariesEqual(
  left: RepositoryPRCheckSummary,
  right: RepositoryPRCheckSummary,
): boolean {
  return (
    left.total === right.total &&
    left.pending === right.pending &&
    left.successful === right.successful &&
    left.failed === right.failed &&
    left.neutral === right.neutral &&
    left.complete === right.complete
  );
}

function projectionErrorCode(error: unknown): RepositoryPRProjectionErrorCode {
  if (error instanceof ProjectionBudgetExhaustedError) return 'API_BUDGET_EXHAUSTED';
  if (error instanceof ProjectionInvalidResponseError) return 'INVALID_GITHUB_RESPONSE';
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'AUTH_REQUIRED'
  ) {
    return 'AUTH_REQUIRED';
  }
  return 'GITHUB_UNAVAILABLE';
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolvedValue = value ?? defaultValue;
  if (
    !Number.isSafeInteger(resolvedValue) ||
    resolvedValue < minimum ||
    resolvedValue > maximum
  ) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolvedValue;
}

function ageSeconds(fetchedAt: string, now: Date): number {
  const timestamp = Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}

function repositoryFileKey(repository: RepositoryIdentity): string {
  return repository.canonicalFullName.replace('/', '--').replace(/[^a-z0-9_.-]/g, '_');
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // File content has already been fsynced; directory fsync is best-effort on unsupported filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
