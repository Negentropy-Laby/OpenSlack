import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppInstallationToken } from './auth.js';

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
  cwd?: string;
}

export interface GitHubClient {
  owner: string;
  repo: string;
  octokit: Octokit;
  authMode: AuthMode;
  isDryRun: boolean;
  tokenExpiresAt?: string;
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

export function parseGitHubRepoSpec(input: string | undefined): { owner: string; repo: string } | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;

  const ssh = value.match(/^git@[^:]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2] };
  }

  const shorthand = value.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (shorthand) {
    return { owner: shorthand[1], repo: shorthand[2] };
  }

  try {
    const url = new URL(value);
    if (!url.hostname.endsWith('github.com')) return null;
    const [owner, repoWithSuffix] = url.pathname.replace(/^\/+/, '').split('/');
    if (!owner || !repoWithSuffix) return null;
    return { owner, repo: repoWithSuffix.replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

function resolveGitRemote(cwd: string): { owner: string; repo: string } | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseGitHubRepoSpec(remote);
  } catch {
    return null;
  }
}

function resolveWorkspaceRepo(cwd: string): { owner: string; repo: string } | null {
  const workspacePath = join(cwd, 'openslack.yaml');
  if (!existsSync(workspacePath)) return null;

  try {
    const content = readFileSync(workspacePath, 'utf-8');
    const canonical = content.match(/canonical_remote:[\s\S]*?owner:\s*([^\s#]+)[\s\S]*?repo:\s*([^\s#]+)/);
    if (!canonical) return null;
    return { owner: canonical[1].replace(/['"]/g, ''), repo: canonical[2].replace(/['"]/g, '') };
  } catch {
    return null;
  }
}

export function resolveGitHubRepoTarget(options: GitHubClientOptions = {}): GitHubRepoTarget {
  const cwd = options.cwd ?? process.cwd();

  if (options.repoFullName) {
    const explicit = parseGitHubRepoSpec(options.repoFullName);
    if (!explicit) {
      throw new GitHubRepoRequiredError(`Invalid GitHub repository "${options.repoFullName}". Expected owner/name.`);
    }
    return { ...explicit, source: 'explicit' };
  }

  if (options.owner && options.repo) {
    return { owner: options.owner, repo: options.repo, source: 'explicit' };
  }

  if (process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    return { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, source: 'env' };
  }

  const remote = resolveGitRemote(cwd);
  if (remote) return { ...remote, source: 'git_remote' };

  const workspace = resolveWorkspaceRepo(cwd);
  if (workspace) return { ...workspace, source: 'workspace' };

  throw new GitHubRepoRequiredError(
    'Could not resolve GitHub repository. Pass --repo owner/name or set GITHUB_OWNER and GITHUB_REPO.',
  );
}

export async function getClient(options: GitHubClientOptions = {}): Promise<GitHubClient> {
  const target = resolveGitHubRepoTarget(options);
  const owner = target.owner;
  const repo = target.repo;
  const auth = options.auth ?? 'auto';

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
    let appToken = null;
    try {
      appToken = await getAppInstallationToken();
    } catch {
      // JWT signing or API call failed — fall through to Tier 2 in auto mode.
    }
    if (appToken) {
      return {
        owner,
        repo,
        octokit: new Octokit({ auth: appToken.token }),
        authMode: 'github_app_installation',
        isDryRun: false,
        tokenExpiresAt: appToken.expiresAt,
      };
    }

    if (auth === 'app' && options.requireLive) {
      throw new GitHubAuthRequiredError(
        `AUTH_REQUIRED: GitHub App credentials are required for ${owner}/${repo}. Use scripts/openslack-bot.ps1 or set OPENSLACK_GITHUB_APP_* environment variables.`,
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
        octokit: new Octokit({ auth: token }),
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
      `AUTH_REQUIRED: pr doctor needs live GitHub evidence for ${owner}/${repo}. Use scripts/openslack-bot.ps1, set GITHUB_TOKEN, or pass --dry-run.`,
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

export async function getAuthenticatedIdentity(options: GitHubClientOptions = {}): Promise<GitHubIdentity> {
  const client = await getClient(options);

  if (client.authMode === 'github_app_installation') {
    return {
      login: process.env.OPENSLACK_GITHUB_APP_SLUG || 'openslack-github-app',
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
