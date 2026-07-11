import { Octokit } from '@octokit/rest';

export interface GitHubInstallationRepositoryAccess {
  owner: string;
  repo: string;
  accessible: boolean;
  complete: boolean;
  totalAccessibleRepositories: number;
  pagesScanned: number;
}

export interface InstallationRepositoryPage {
  totalCount: number;
  repositories: Array<{ fullName: string }>;
}

export interface GitHubInstallationAccessDependencies {
  listPage?: (input: {
    token: string;
    page: number;
    perPage: number;
  }) => Promise<InstallationRepositoryPage>;
  maxPages?: number;
}

export async function inspectInstallationRepositoryAccess(
  input: { token: string; owner: string; repo: string },
  dependencies: GitHubInstallationAccessDependencies = {},
): Promise<GitHubInstallationRepositoryAccess> {
  if (!input.token || !isGitHubName(input.owner) || !isGitHubName(input.repo)) {
    throw new Error('GitHub App installation repository diagnostic input is invalid.');
  }
  const perPage = 100;
  const maxPages = dependencies.maxPages ?? 100;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new Error('GitHub App installation repository diagnostic page limit is invalid.');
  }
  const listPage = dependencies.listPage ?? defaultListPage;
  const target = `${input.owner}/${input.repo}`.toLowerCase();
  let totalCount = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    let result: InstallationRepositoryPage;
    try {
      result = await listPage({ token: input.token, page, perPage });
    } catch {
      throw new Error('GitHub App installation repository diagnostic request failed safely.');
    }
    if (!Number.isSafeInteger(result.totalCount) || result.totalCount < 0) {
      throw new Error('GitHub App installation repository diagnostic response is invalid.');
    }
    totalCount = result.totalCount;
    if (result.repositories.some((repository) => repository.fullName.toLowerCase() === target)) {
      return {
        owner: input.owner,
        repo: input.repo,
        accessible: true,
        complete: true,
        totalAccessibleRepositories: totalCount,
        pagesScanned: page,
      };
    }
    if (page * perPage >= totalCount || result.repositories.length === 0) {
      return {
        owner: input.owner,
        repo: input.repo,
        accessible: false,
        complete: true,
        totalAccessibleRepositories: totalCount,
        pagesScanned: page,
      };
    }
  }
  return {
    owner: input.owner,
    repo: input.repo,
    accessible: false,
    complete: false,
    totalAccessibleRepositories: totalCount,
    pagesScanned: maxPages,
  };
}

async function defaultListPage(input: {
  token: string;
  page: number;
  perPage: number;
}): Promise<InstallationRepositoryPage> {
  const octokit = new Octokit({ auth: input.token });
  const response = await octokit.rest.apps.listReposAccessibleToInstallation({
    page: input.page,
    per_page: input.perPage,
  });
  return {
    totalCount: response.data.total_count,
    repositories: response.data.repositories.map((repository) => ({
      fullName: repository.full_name,
    })),
  };
}

function isGitHubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value);
}
