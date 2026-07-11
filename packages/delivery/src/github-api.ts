import { createInstallationClient } from '@openslack/github';
import type { DeliveryGitHubApi, DeliveryPullRequest } from './types.js';

function mapPullRequest(data: {
  number: number;
  html_url: string;
  head: {
    ref: string;
    sha: string;
    repo: { name: string; owner: { login: string } } | null;
  };
}): DeliveryPullRequest {
  if (!data.head.repo) {
    throw new Error('Pull request head repository is unavailable.');
  }
  return {
    number: data.number,
    url: data.html_url,
    headOwner: data.head.repo.owner.login,
    headRepo: data.head.repo.name,
    headRef: data.head.ref,
    headSha: data.head.sha,
  };
}

export function createDeliveryGitHubApi(input: {
  token: string;
  owner: string;
  repo: string;
  rootDir: string;
}): DeliveryGitHubApi {
  const client = createInstallationClient(input.token, {
    owner: input.owner,
    repo: input.repo,
    cwd: input.rootDir,
    requireLive: true,
  });
  return {
    async findOpenPullRequests(query) {
      const data = await client.octokit.paginate(client.octokit.pulls.list, {
        owner: query.owner,
        repo: query.repo,
        state: 'open',
        head: `${query.headOwner}:${query.head}`,
        per_page: 100,
      });
      return data.map(mapPullRequest);
    },
    async createDraftPullRequest(query) {
      const { data } = await client.octokit.pulls.create({
        owner: query.owner,
        repo: query.repo,
        head: query.head,
        base: query.base,
        title: query.title,
        body: query.body,
        draft: true,
      });
      return mapPullRequest(data);
    },
    async updatePullRequest(query) {
      const { data } = await client.octokit.pulls.update({
        owner: query.owner,
        repo: query.repo,
        pull_number: query.number,
        base: query.base,
        title: query.title,
        body: query.body,
      });
      return mapPullRequest(data);
    },
    async getPullRequest(query) {
      const { data } = await client.octokit.pulls.get({
        owner: query.owner,
        repo: query.repo,
        pull_number: query.number,
      });
      return mapPullRequest(data);
    },
    async listChecks(query) {
      const checkRuns = await client.octokit.paginate(client.octokit.checks.listForRef, {
        owner: query.owner,
        repo: query.repo,
        ref: query.ref,
        per_page: 100,
      });
      return checkRuns.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        headSha: query.ref,
      }));
    },
  };
}
