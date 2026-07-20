import { sanitizeTerminalText } from '../sanitize.js';

export interface RepositoryPrProjectionInput {
  fetchedAt: string;
  partial: boolean;
  budget: {
    limit: number;
    used: number;
    exhausted: boolean;
  };
  repositories: Array<{
    repository: { fullName: string };
  }>;
  items: Array<{
    repository: { fullName: string };
    prNumber: number;
    title: string;
    author: string;
    state: string;
    draft: boolean;
    headSha: string;
    updatedAt: string;
    checks: {
      successful: number;
      failed: number;
      pending: number;
      neutral: number;
      complete: boolean;
    };
    fetchedAt: string;
    ageSeconds: number;
    stale: boolean;
    partial: boolean;
    source: string;
  }>;
}

export interface RepositoryPrProjectionViewModel {
  title: string;
  fetchedAt: string;
  repositoryCount: number;
  itemCount: number;
  partial: boolean;
  budgetLabel: string;
  authorityLabel: string;
  items: Array<{
    key: string;
    repository: string;
    prNumber: number;
    title: string;
    author: string;
    state: string;
    draft: boolean;
    headSha: string;
    updatedAt: string;
    checksLabel: string;
    freshnessLabel: string;
    warning: boolean;
  }>;
}

export function mapRepositoryPrProjectionToViewModel(
  input: RepositoryPrProjectionInput,
): RepositoryPrProjectionViewModel {
  const s = sanitizeTerminalText;
  return {
    title: 'Repository PR Projection',
    fetchedAt: s(input.fetchedAt),
    repositoryCount: input.repositories.length,
    itemCount: input.items.length,
    partial: input.partial,
    budgetLabel: `${input.budget.used}/${input.budget.limit}${input.budget.exhausted ? ' exhausted' : ''}`,
    authorityLabel: 'Human approval and merge readiness are not evaluated.',
    items: input.items.map((item) => ({
      key: `${item.repository.fullName.toLocaleLowerCase('en-US')}#${item.prNumber}`,
      repository: s(item.repository.fullName),
      prNumber: item.prNumber,
      title: s(item.title),
      author: s(item.author),
      state: s(item.state),
      draft: item.draft,
      headSha: s(item.headSha.slice(0, 12)),
      updatedAt: s(item.updatedAt),
      checksLabel: `${item.checks.successful} successful, ${item.checks.failed} failed, ${item.checks.pending} pending, ${item.checks.neutral} neutral${item.checks.complete ? '' : ' (partial)'}`,
      freshnessLabel: `${s(item.source)} | age=${item.ageSeconds}s | stale=${item.stale ? 'yes' : 'no'} | partial=${item.partial ? 'yes' : 'no'}`,
      warning: item.partial || item.stale || item.checks.failed > 0,
    })),
  };
}
