import { Octokit } from '@octokit/rest';

let cachedClient: Octokit | null = null;
let cachedOwner: string | null = null;
let cachedRepo: string | null = null;

export interface GitHubClient {
  owner: string;
  repo: string;
  octokit: Octokit;
  isDryRun: boolean;
}

export function getClient(): GitHubClient {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'wsman';
  const repo = process.env.GITHUB_REPO || 'OpenSlack';
  const isDryRun = !token;

  if (!token) {
    return {
      owner,
      repo,
      octokit: null as unknown as Octokit,
      isDryRun: true,
    };
  }

  if (!cachedClient || cachedOwner !== owner || cachedRepo !== repo) {
    cachedClient = new Octokit({ auth: token });
    cachedOwner = owner;
    cachedRepo = repo;
  }

  return { owner, repo, octokit: cachedClient, isDryRun: false };
}
