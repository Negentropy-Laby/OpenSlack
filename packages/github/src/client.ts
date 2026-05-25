import { Octokit } from '@octokit/rest';
import { getAppInstallationToken } from './auth.js';

export type AuthMode = 'github_app_installation' | 'token' | 'dry_run';

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

export async function getClient(): Promise<GitHubClient> {
  const owner = process.env.GITHUB_OWNER || 'wsman';
  const repo = process.env.GITHUB_REPO || 'OpenSlack';

  // Tier 1: GitHub App installation token (primary runtime credential)
  let appToken = null;
  try {
    appToken = await getAppInstallationToken();
  } catch {
    // JWT signing or API call failed — fall through to Tier 2
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

  // Tier 2: PAT / GITHUB_TOKEN (local dev fallback)
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    return {
      owner,
      repo,
      octokit: new Octokit({ auth: token }),
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

export async function getAuthenticatedIdentity(): Promise<GitHubIdentity> {
  const client = await getClient();

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
