import { parseGitHubRepoSpec } from './repo-spec.js';
export { parseGitHubRepoSpec } from './repo-spec.js';
import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  requireAppInstallationToken,
  type GitHubAppAuthDiagnostic,
  type GitHubAppInstallationTokenOptions,
} from './auth.js';
import { readStableLocalUtf8 as readStableUtf8 } from './stable-local-file.js';
import {
  cleanupBrokerClient,
  assertNoCleanupBrokerClientConstruction,
} from './internal/cleanup-broker-client-scope.js';

const LOCAL_METADATA_MAX_BYTES = 256 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const GIT_COMMAND_MAX_BUFFER = 64 * 1024;

export type AuthMode = 'github_app_installation' | 'token' | 'dry_run';
export type GitHubAuthPreference = 'auto' | 'app' | 'token' | 'dry-run';

export interface GitHubRepoTarget {
  owner: string;
  repo: string;
  source: 'explicit' | 'env' | 'git_remote' | 'workspace';
}

export interface GitHubClientOptions {
  owner?: string;
  repo?: string;
  repoFullName?: string;
  auth?: GitHubAuthPreference;
  requireLive?: boolean;
  strictEvidence?: boolean;
  cwd?: string;
  localStateRoot?: string;
  credentialStore?: GitHubAppInstallationTokenOptions['credentialStore'];
  signal?: AbortSignal;
  onAuthDiagnostic?: (diagnostic: GitHubAppAuthDiagnostic) => void;
  evidenceLimits?: {
    maxPages?: number;
    maxFiles?: number;
    maxReviews?: number;
    maxChecks?: number;
    maxTreeEntries?: number;
    maxPatches?: number;
    maxCodeownersBytes?: number;
    maxCodeownersLines?: number;
    maxCodeownersEntries?: number;
    maxCodeownerMatchOperations?: number;
  };
}

export interface GitHubClient {
  owner: string;
  repo: string;
  octokit: Octokit;
  authMode: AuthMode;
  isDryRun: boolean;
  tokenExpiresAt?: string;
  appSlug?: string;
  installationHintReplaced?: boolean;
}

export interface GitHubIdentity {
  login: string | null;
  type: 'github_app' | 'user' | 'dry_run' | 'unknown';
  authMode: AuthMode;
  isBot: boolean;
}

export class GitHubAuthRequiredError extends Error {
  readonly code = 'AUTH_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthRequiredError';
  }
}

export class GitHubRepoRequiredError extends Error {
  readonly code = 'REPO_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'GitHubRepoRequiredError';
  }
}

function createOctokit(auth: string): Octokit {
  return new Octokit({
    auth,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
}

export function createInstallationClient(
  token: string,
  options: Omit<GitHubClientOptions, 'auth'> = {},
): GitHubClient {
  assertNoCleanupBrokerClientConstruction();
  if (!token) throw new GitHubAuthRequiredError('AUTH_REQUIRED: installation token is empty.');
  const target = resolveGitHubRepoTarget(options);
  return {
    owner: target.owner,
    repo: target.repo,
    octokit: createOctokit(token),
    authMode: 'github_app_installation',
    isDryRun: false,
  };
}

function abortError(): Error {
  const error = new Error('GITHUB_EVIDENCE_ABORTED');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function runBoundedGit(cwd: string, args: string[], signal?: AbortSignal): string {
  assertNotAborted(signal);
  const output = execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER,
    killSignal: 'SIGKILL',
  });
  assertNotAborted(signal);
  return output;
}

function readStableLocalUtf8(path: string, maxBytes: number): string | null {
  try {
    return readStableUtf8(path, { maxBytes });
  } catch (error) {
    throw error;
  }
}

function resolveGitRemote(
  cwd: string,
  signal?: AbortSignal,
): { owner: string; repo: string } | null {
  try {
    const remote = runBoundedGit(cwd, ['remote', 'get-url', 'origin'], signal).trim();
    return parseGitHubRepoSpec(remote);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

export function resolveGitHubWorkspaceTarget(cwd: string): { owner: string; repo: string } | null {
  const workspacePath = join(cwd, 'openslack.yaml');

  try {
    const content = readStableLocalUtf8(workspacePath, LOCAL_METADATA_MAX_BYTES);
    if (content === null) return null;
    const canonical = content.match(
      /canonical_remote:[\s\S]*?owner:\s*([^\s#]+)[\s\S]*?repo:\s*([^\s#]+)/,
    );
    if (!canonical) return null;
    return { owner: canonical[1].replace(/['"]/g, ''), repo: canonical[2].replace(/['"]/g, '') };
  } catch {
    return null;
  }
}

export function resolveGitHubRepoTarget(options: GitHubClientOptions = {}): GitHubRepoTarget {
  assertNotAborted(options.signal);
  const cwd = options.cwd ?? process.cwd();

  if (options.repoFullName) {
    const explicit = parseGitHubRepoSpec(options.repoFullName);
    if (!explicit) {
      throw new GitHubRepoRequiredError(
        `Invalid GitHub repository "${options.repoFullName}". Expected owner/name.`,
      );
    }
    return { ...explicit, source: 'explicit' };
  }

  if (options.owner && options.repo) {
    return { owner: options.owner, repo: options.repo, source: 'explicit' };
  }

  if (process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    return { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, source: 'env' };
  }

  const remote = resolveGitRemote(cwd, options.signal);
  if (remote) return { ...remote, source: 'git_remote' };

  const workspace = resolveGitHubWorkspaceTarget(cwd);
  if (workspace) return { ...workspace, source: 'workspace' };

  throw new GitHubRepoRequiredError(
    'Could not resolve GitHub repository. Pass --repo owner/name or set GITHUB_OWNER and GITHUB_REPO.',
  );
}

export function resolveGitHubAppLocalStateRoot(
  cwd: string = process.cwd(),
  signal?: AbortSignal,
): string | undefined {
  assertNotAborted(signal);
  let current = resolve(cwd);
  let workspaceRoot: string | undefined;
  for (;;) {
    if (readStableLocalUtf8(join(current, 'openslack.yaml'), LOCAL_METADATA_MAX_BYTES) !== null) {
      workspaceRoot = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const workspaceLocalState = workspaceRoot ? join(workspaceRoot, '.openslack.local') : undefined;
  if (workspaceLocalState && existsSync(join(workspaceLocalState, 'github-app.json'))) {
    return workspaceLocalState;
  }

  try {
    if (workspaceRoot) {
      const primary = registeredPrimaryWorkspace(workspaceRoot, signal);
      if (primary) return join(primary, '.openslack.local');
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    // A non-Git initialized workspace still owns its local state beside openslack.yaml.
  }
  assertNotAborted(signal);
  return workspaceLocalState;
}

function gitPathLine(value: string): string {
  // Git appends one LF. Trimming whitespace would corrupt valid Unix paths.
  if (!value.endsWith('\n') || value.includes('\0')) throw new Error('GIT_PATH_INVALID');
  const path = value.slice(0, -1);
  if (!path) throw new Error('GIT_PATH_INVALID');
  return path;
}

function registeredPrimaryWorkspace(workspace: string, signal?: AbortSignal): string | null {
  const common = realpathSync.native(
    gitPathLine(
      runBoundedGit(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
    ),
  );
  const gitDir = realpathSync.native(
    gitPathLine(runBoundedGit(workspace, ['rev-parse', '--absolute-git-dir'], signal)),
  );
  const primary = dirname(common);
  // Only the conventional primary layout is provable here. A separate gitdir
  // or a forged pointer must not borrow some other workspace's App state.
  if (!lstatSync(join(primary, '.git')).isDirectory()) return null;
  if (normalizeRealPath(join(primary, '.git')) !== normalizeRealPath(common)) return null;
  if (
    normalizeRealPath(
      gitPathLine(runBoundedGit(primary, ['rev-parse', '--show-toplevel'], signal)),
    ) !== normalizeRealPath(primary)
  )
    return null;
  if (readStableLocalUtf8(join(primary, 'openslack.yaml'), LOCAL_METADATA_MAX_BYTES) === null)
    return null;
  if (normalizeRealPath(gitDir) === normalizeRealPath(common))
    return normalizeRealPath(workspace) === normalizeRealPath(primary) ? primary : null;

  // Reciprocal Git administration links prove this exact registration without
  // depending on `worktree list -z` (Git >=2.36), ambiguous newline porcelain,
  // or the existence of any unrelated registered worktree.
  if (normalizeRealPath(dirname(gitDir)) !== normalizeRealPath(join(common, 'worktrees')))
    return null;
  const pointer = readStableLocalUtf8(join(workspace, '.git'), LOCAL_METADATA_MAX_BYTES);
  const backPointer = readStableLocalUtf8(join(gitDir, 'gitdir'), LOCAL_METADATA_MAX_BYTES);
  const commonPointer = readStableLocalUtf8(join(gitDir, 'commondir'), LOCAL_METADATA_MAX_BYTES);
  if (!pointer?.startsWith('gitdir: ') || !backPointer || !commonPointer) return null;
  if (
    normalizeRealPath(resolve(workspace, gitPathLine(pointer.slice('gitdir: '.length)))) !==
    normalizeRealPath(gitDir)
  )
    return null;
  if (
    normalizeRealPath(resolve(gitDir, gitPathLine(backPointer))) !==
    normalizeRealPath(join(workspace, '.git'))
  )
    return null;
  if (normalizeRealPath(resolve(gitDir, gitPathLine(commonPointer))) !== normalizeRealPath(common))
    return null;
  assertNotAborted(signal);
  return primary;
}

function normalizeRealPath(path: string): string {
  const value = realpathSync.native(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

const inFlightClients = new WeakMap<GitHubClientOptions, Promise<GitHubClient>>();
const resolvedClients = new WeakMap<GitHubClientOptions, GitHubClient>();

export async function getClient(options: GitHubClientOptions = {}): Promise<GitHubClient> {
  assertNotAborted(options.signal);
  const brokerClient = cleanupBrokerClient(options);
  if (brokerClient) return brokerClient;
  const resolved = resolvedClients.get(options);
  if (
    resolved &&
    (!resolved.tokenExpiresAt || Date.parse(resolved.tokenExpiresAt) > Date.now() + 300_000)
  ) {
    return resolved;
  }
  if (resolved) resolvedClients.delete(options);
  const existing = inFlightClients.get(options);
  if (existing) return existing;
  const promise = getClientUncached(options);
  inFlightClients.set(options, promise);
  try {
    const client = await promise;
    resolvedClients.set(options, client);
    return client;
  } finally {
    if (inFlightClients.get(options) === promise) inFlightClients.delete(options);
  }
}

async function getClientUncached(options: GitHubClientOptions): Promise<GitHubClient> {
  assertNotAborted(options.signal);
  const target = resolveGitHubRepoTarget(options);
  const owner = target.owner;
  const repo = target.repo;
  const envAuth = process.env.OPENSLACK_GITHUB_AUTH_MODE;
  const auth =
    options.auth ??
    (envAuth === 'app' || envAuth === 'token' || envAuth === 'dry-run' ? envAuth : 'auto');

  if (auth === 'dry-run') {
    return {
      owner,
      repo,
      octokit: null as unknown as Octokit,
      authMode: 'dry_run',
      isDryRun: true,
    };
  }

  // Tier 1: GitHub App installation token (primary runtime credential)
  if (auth === 'auto' || auth === 'app') {
    const forwardedAppToken = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN?.trim();
    if (forwardedAppToken) {
      return {
        owner,
        repo,
        octokit: createOctokit(forwardedAppToken),
        authMode: 'github_app_installation',
        isDryRun: false,
      };
    }

    const localStateRoot =
      options.localStateRoot ??
      resolveGitHubAppLocalStateRoot(options.cwd ?? process.cwd(), options.signal);
    const appConfigured = hasGitHubAppConfigurationIntent(localStateRoot);
    let appToken = null;
    try {
      appToken = await requireAppInstallationToken({
        localStateRoot,
        credentialStore: options.credentialStore,
        signal: options.signal,
        repository: { owner, repo },
        onDiagnostic: options.onAuthDiagnostic ?? emitAuthDiagnostic,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (auth === 'app' || appConfigured) {
        throw new GitHubAuthRequiredError(
          `AUTH_REQUIRED: configured GitHub App credentials are unavailable for ${owner}/${repo}.`,
        );
      }
      // With no App configuration intent, auto mode retains the explicit dev PAT fallback.
    }
    if (appToken) {
      return {
        owner,
        repo,
        octokit: createOctokit(appToken.token),
        authMode: 'github_app_installation',
        isDryRun: false,
        tokenExpiresAt: appToken.expiresAt,
        appSlug: appToken.appSlug,
        installationHintReplaced: appToken.installationHintReplaced,
      };
    }

    if (auth === 'app') {
      // App mode is identity-strict even when requireLive is false. Callers that
      // want a non-live client must request dry-run explicitly.
      throw new GitHubAuthRequiredError(
        `AUTH_REQUIRED: GitHub App credentials are required for ${owner}/${repo}. Complete GitHub App onboarding or set OPENSLACK_GITHUB_APP_* environment variables.`,
      );
    }
  }

  // Tier 2: PAT / GITHUB_TOKEN (local dev fallback)
  if (auth === 'auto' || auth === 'token') {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      return {
        owner,
        repo,
        octokit: createOctokit(token),
        authMode: 'token',
        isDryRun: false,
      };
    }

    if (auth === 'token' && options.requireLive) {
      throw new GitHubAuthRequiredError(
        `AUTH_REQUIRED: GITHUB_TOKEN or GH_TOKEN is required for ${owner}/${repo}.`,
      );
    }
  }

  if (options.requireLive) {
    throw new GitHubAuthRequiredError(
      `AUTH_REQUIRED: live GitHub credentials are required for ${owner}/${repo}. Complete GitHub App onboarding, configure OPENSLACK_GITHUB_APP_*, or select an explicit development token mode.`,
    );
  }

  // Tier 3: Dry-run (no credentials)
  return {
    owner,
    repo,
    octokit: null as unknown as Octokit,
    authMode: 'dry_run',
    isDryRun: true,
  };
}

function emitAuthDiagnostic(diagnostic: GitHubAppAuthDiagnostic): void {
  process.emitWarning(diagnostic.message, { code: diagnostic.code });
}

function hasGitHubAppConfigurationIntent(localStateRoot: string | undefined): boolean {
  return Boolean(
    process.env.OPENSLACK_GITHUB_APP_ID ||
    process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID ||
    process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY ||
    (localStateRoot && existsSync(join(localStateRoot, 'github-app.json'))),
  );
}

export async function getAuthenticatedIdentity(
  options: GitHubClientOptions = {},
): Promise<GitHubIdentity> {
  const client = await getClient(options);

  if (client.authMode === 'github_app_installation') {
    return {
      login: client.appSlug || process.env.OPENSLACK_GITHUB_APP_SLUG || 'openslack-github-app',
      type: 'github_app',
      authMode: client.authMode,
      isBot: true,
    };
  }

  if (client.isDryRun) {
    return {
      login: null,
      type: 'dry_run',
      authMode: client.authMode,
      isBot: true,
    };
  }

  try {
    const { data } = await client.octokit.users.getAuthenticated();
    const login = data.login || null;
    return {
      login,
      type: data.type === 'Bot' ? 'github_app' : 'user',
      authMode: client.authMode,
      isBot: data.type === 'Bot' || Boolean(login?.endsWith('[bot]')),
    };
  } catch {
    return {
      login: null,
      type: 'unknown',
      authMode: client.authMode,
      isBot: false,
    };
  }
}
