import { describe, expect, it, vi } from 'vitest';
import { inspectInstallationRepositoryAccess } from '../installation-access.js';

describe('GitHub App installation repository access', () => {
  it('finds the selected repository across paginated installation scope', async () => {
    const listPage = vi.fn(async ({ page }: { page: number }) => ({
      totalCount: 101,
      repositories:
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ fullName: `acme/repo-${index}` }))
          : [{ fullName: 'acme/target' }],
    }));
    const result = await inspectInstallationRepositoryAccess(
      { token: 'installation-token', owner: 'acme', repo: 'target' },
      { listPage },
    );
    expect(result).toMatchObject({ accessible: true, complete: true, pagesScanned: 2 });
  });

  it('distinguishes a complete not-installed result from an incomplete scan', async () => {
    const missing = await inspectInstallationRepositoryAccess(
      { token: 'installation-token', owner: 'acme', repo: 'missing' },
      {
        listPage: async () => ({
          totalCount: 1,
          repositories: [{ fullName: 'acme/other' }],
        }),
      },
    );
    expect(missing).toMatchObject({ accessible: false, complete: true });

    const incomplete = await inspectInstallationRepositoryAccess(
      { token: 'installation-token', owner: 'acme', repo: 'missing' },
      {
        maxPages: 1,
        listPage: async () => ({
          totalCount: 101,
          repositories: Array.from({ length: 100 }, (_, index) => ({
            fullName: `acme/repo-${index}`,
          })),
        }),
      },
    );
    expect(incomplete).toMatchObject({ accessible: false, complete: false });
  });

  it('redacts list failures', async () => {
    const failure = inspectInstallationRepositoryAccess(
      { token: 'installation-token', owner: 'acme', repo: 'target' },
      {
        listPage: async () => {
          throw new Error('failed with installation-token');
        },
      },
    );
    await expect(failure).rejects.toThrow('request failed safely');
    await failure.catch((error: unknown) =>
      expect(error instanceof Error ? error.message : String(error)).not.toContain(
        'installation-token',
      ),
    );
  });
});
