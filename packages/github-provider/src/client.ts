import { Octokit } from '@octokit/rest';
import { getAppInstallationToken } from './auth.js';

let cachedClient: Octokit | null = null;
let cachedOwner: string | null = null;
let cachedRepo: string | null = null;

export type AuthMode = 'github_app_installation' | 'token' | 'dry_run';

export interface GitHubClient {
  owner: string;
  repo: string;
  octokit: Octokit;
  authMode: AuthMode;
  isDryRun: boolean;
  tokenExpiresAt?: string;
}

export async function getClient(): Promise<GitHubClient> {
  const owner = process.env.GITHUB_OWNER || 'wsman';
  const repo = process.env.GITHUB_REPO || 'OpenSlack';

  // Tier 1: GitHub App installation token (primary runtime credential)
  const appToken = await getAppInstallationToken();
  if (appToken) {
    if (!cachedClient || cachedOwner !== owner || cachedRepo !== repo) {
      cachedClient = new Octokit({ auth: appToken.token });
      cachedOwner = owner;
      cachedRepo = repo;
    } else {
      // Re-auth with fresh token
      (cachedClient as unknown as { authenticate: (auth: Record<string, string>) => void }).authenticate?.({ type: 'token', token: appToken.token });
    }

    return {
      owner,
      repo,
      octokit: cachedClient,
      authMode: 'github_app_installation',
      isDryRun: false,
      tokenExpiresAt: appToken.expiresAt,
    };
  }

  // Tier 2: PAT / GITHUB_TOKEN (local dev fallback)
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    if (!cachedClient || cachedOwner !== owner || cachedRepo !== repo) {
      cachedClient = new Octokit({ auth: token });
      cachedOwner = owner;
      cachedRepo = repo;
    }

    return {
      owner,
      repo,
      octokit: cachedClient,
      authMode: 'token',
      isDryRun: false,
    };
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
