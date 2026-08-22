import { boundedJsonRequest, BoundedJsonRequestError } from './bounded-json-request.js';
import { POSITIVE_GITHUB_ID_PATTERN } from './app-jwt.js';

const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_INSTALLATION_PAGES = 10;
const INSTALLATIONS_PER_PAGE = 100;

export interface GitHubAppInstallationSummary {
  id: string;
  account: string;
  repositorySelection: 'all' | 'selected';
}

export class GitHubAppInstallationResolutionError extends Error {
  readonly code:
    | 'APP_INSTALLATION_NOT_FOUND'
    | 'APP_INSTALLATION_REQUEST_FAILED'
    | 'APP_INSTALLATION_RESPONSE_INVALID'
    | 'APP_INSTALLATION_PAGINATION_EXCEEDED';

  constructor(code: GitHubAppInstallationResolutionError['code']) {
    super(code);
    this.name = 'GitHubAppInstallationResolutionError';
    this.code = code;
  }
}

interface InstallationRequestOptions {
  jwt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export async function resolveGitHubAppRepositoryInstallation(
  options: InstallationRequestOptions & { owner: string; repo: string },
): Promise<GitHubAppInstallationSummary> {
  let value: unknown;
  try {
    value = await boundedJsonRequest({
      url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/installation`,
      method: 'GET',
      headers: requestHeaders(options.jwt),
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    if (
      error instanceof BoundedJsonRequestError &&
      error.code === 'HTTP_ERROR' &&
      error.status === 404
    ) {
      throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_NOT_FOUND');
    }
    throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_REQUEST_FAILED');
  }
  const parsed = parseInstallation(value);
  if (parsed.account.toLowerCase() !== options.owner.toLowerCase()) {
    throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_RESPONSE_INVALID');
  }
  return parsed;
}

export async function listGitHubAppInstallations(
  options: InstallationRequestOptions,
): Promise<readonly GitHubAppInstallationSummary[]> {
  const installations: GitHubAppInstallationSummary[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
    let value: unknown;
    try {
      value = await boundedJsonRequest({
        url: `https://api.github.com/app/installations?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
        method: 'GET',
        headers: requestHeaders(options.jwt),
        maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      });
    } catch {
      throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_REQUEST_FAILED');
    }
    if (!Array.isArray(value) || value.length > INSTALLATIONS_PER_PAGE) {
      throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_RESPONSE_INVALID');
    }
    installations.push(...value.map(parseInstallation));
    if (value.length < INSTALLATIONS_PER_PAGE) return Object.freeze(installations);
  }
  throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_PAGINATION_EXCEEDED');
}

function requestHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'openslack-github-app',
  };
}

function parseInstallation(value: unknown): GitHubAppInstallationSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_RESPONSE_INVALID');
  }
  const candidate = value as Record<string, unknown>;
  const account = candidate.account;
  if (
    !Number.isSafeInteger(candidate.id) ||
    (candidate.id as number) <= 0 ||
    !account ||
    typeof account !== 'object' ||
    Array.isArray(account) ||
    typeof (account as Record<string, unknown>).login !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(
      (account as Record<string, unknown>).login as string,
    ) ||
    (candidate.repository_selection !== 'all' && candidate.repository_selection !== 'selected')
  ) {
    throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_RESPONSE_INVALID');
  }
  const id = String(candidate.id);
  if (!POSITIVE_GITHUB_ID_PATTERN.test(id)) {
    throw new GitHubAppInstallationResolutionError('APP_INSTALLATION_RESPONSE_INVALID');
  }
  return Object.freeze({
    id,
    account: (account as Record<string, unknown>).login as string,
    repositorySelection: candidate.repository_selection,
  });
}
