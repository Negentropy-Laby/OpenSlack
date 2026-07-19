import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../profile-sync.js', () => ({
  readRepoDirectory: vi.fn(),
  readRepoFile: vi.fn(),
  parseFrontmatter: vi.fn(),
  validatePost: vi.fn(),
}));

import {
  readRepoDirectory,
  readRepoFile,
  parseFrontmatter,
  validatePost,
} from '../profile-sync.js';
import { checkProfileSync } from '../profile-sync-check.js';
import type { ProfileSyncConfig } from '../profile-sync-config.js';

const mockReadRepoDirectory = readRepoDirectory as ReturnType<typeof vi.fn>;
const mockReadRepoFile = readRepoFile as ReturnType<typeof vi.fn>;
const mockParseFrontmatter = parseFrontmatter as ReturnType<typeof vi.fn>;
const mockValidatePost = validatePost as ReturnType<typeof vi.fn>;

const mockConfig: ProfileSyncConfig = {
  schema: 'openslack.profile_sync.v1',
  source: { repo: 'owner/whitepapers', branch: 'main', path: 'posts' },
  target: {
    repo: 'owner/.github',
    branch: 'main',
    path: 'profile/README.md',
    marker: 'latest-insights',
  },
  mode: 'manual',
  max_posts: 5,
  pr: { draft: true, labels: ['profile:sync'] },
  failure_issue: { enabled: true },
};

describe('checkProfileSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok=true when everything passes', async () => {
    mockReadRepoDirectory.mockResolvedValue([
      { name: 'post-1.md', path: 'posts/post-1.md', type: 'file', sha: 'abc' },
    ]);
    mockReadRepoFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'posts/post-1.md') {
        return {
          content:
            '---\ntitle: Hello\ndate: 2026-05-30\nsummary: A summary\ntags: [tech]\nstatus: published\n---\n\nBody',
          sha: 'abc',
        };
      }
      if (path === 'profile/README.md') {
        return {
          content:
            '# Profile\n\n<!-- openslack:latest-insights:start -->\nOld\n<!-- openslack:latest-insights:end -->',
          sha: 'def',
        };
      }
      return null;
    });
    mockParseFrontmatter.mockReturnValue({
      title: 'Hello',
      date: '2026-05-30',
      summary: 'A summary',
      tags: ['tech'],
      status: 'published',
    });
    mockValidatePost.mockReturnValue({ valid: true, errors: [] });

    const result = await checkProfileSync(mockConfig);

    expect(result.ok).toBe(true);
    expect(result.source.accessible).toBe(true);
    expect(result.source.postCount).toBe(1);
    expect(result.target.accessible).toBe(true);
    expect(result.target.markerExists).toBe(true);
    expect(result.posts.total).toBe(1);
    expect(result.posts.published).toBe(1);
    expect(result.posts.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns ok=false when marker is missing', async () => {
    mockReadRepoDirectory.mockResolvedValue([
      { name: 'post-1.md', path: 'posts/post-1.md', type: 'file', sha: 'abc' },
    ]);
    mockReadRepoFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'posts/post-1.md') {
        return {
          content:
            '---\ntitle: Hello\ndate: 2026-05-30\nsummary: A summary\ntags: [tech]\nstatus: published\n---',
          sha: 'abc',
        };
      }
      if (path === 'profile/README.md') {
        return {
          content: '# Profile\n\nNo markers here',
          sha: 'def',
        };
      }
      return null;
    });
    mockParseFrontmatter.mockReturnValue({
      title: 'Hello',
      date: '2026-05-30',
      summary: 'A summary',
      tags: ['tech'],
      status: 'published',
    });
    mockValidatePost.mockReturnValue({ valid: true, errors: [] });

    const result = await checkProfileSync(mockConfig);

    expect(result.ok).toBe(false);
    expect(result.target.markerExists).toBe(false);
    expect(result.errors.some((e) => e.includes('Marker'))).toBe(true);
  });

  it('returns ok=false when no published posts', async () => {
    mockReadRepoDirectory.mockResolvedValue([
      { name: 'draft.md', path: 'posts/draft.md', type: 'file', sha: 'abc' },
    ]);
    mockReadRepoFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'posts/draft.md') {
        return {
          content:
            '---\ntitle: Draft\ndate: 2026-05-30\nsummary: A summary\ntags: [tech]\nstatus: draft\n---',
          sha: 'abc',
        };
      }
      if (path === 'profile/README.md') {
        return {
          content:
            '# Profile\n\n<!-- openslack:latest-insights:start -->\nOld\n<!-- openslack:latest-insights:end -->',
          sha: 'def',
        };
      }
      return null;
    });
    mockParseFrontmatter.mockReturnValue({
      title: 'Draft',
      date: '2026-05-30',
      summary: 'A summary',
      tags: ['tech'],
      status: 'draft',
    });
    mockValidatePost.mockReturnValue({ valid: true, errors: [] });

    const result = await checkProfileSync(mockConfig);

    expect(result.ok).toBe(false);
    expect(result.posts.published).toBe(0);
    expect(result.errors.some((e) => e.includes('published'))).toBe(true);
  });

  it('returns ok=false when frontmatter validation fails', async () => {
    mockReadRepoDirectory.mockResolvedValue([
      { name: 'bad.md', path: 'posts/bad.md', type: 'file', sha: 'abc' },
    ]);
    mockReadRepoFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'posts/bad.md') {
        return {
          content:
            '---\ntitle: Bad\ndate: invalid\nsummary: A summary\ntags: [tech]\nstatus: published\n---',
          sha: 'abc',
        };
      }
      if (path === 'profile/README.md') {
        return {
          content:
            '# Profile\n\n<!-- openslack:latest-insights:start -->\nOld\n<!-- openslack:latest-insights:end -->',
          sha: 'def',
        };
      }
      return null;
    });
    mockParseFrontmatter.mockReturnValue({
      title: 'Bad',
      date: 'invalid',
      summary: 'A summary',
      tags: ['tech'],
      status: 'published',
    });
    mockValidatePost.mockReturnValue({
      valid: false,
      errors: [{ field: 'date', message: 'Invalid date: invalid' }],
    });

    const result = await checkProfileSync(mockConfig);

    expect(result.ok).toBe(false);
    expect(result.posts.failed).toBe(1);
    expect(result.posts.failures).toHaveLength(1);
    expect(result.posts.failures[0].file).toBe('bad.md');
    expect(result.posts.failures[0].errors[0].field).toBe('date');
  });

  it('returns ok=false when source is inaccessible', async () => {
    mockReadRepoDirectory.mockRejectedValue(new Error('Not found'));

    const result = await checkProfileSync(mockConfig);

    expect(result.ok).toBe(false);
    expect(result.source.accessible).toBe(false);
    expect(result.errors.some((e) => e.includes('Source repository inaccessible'))).toBe(true);
  });

  it('returns ok=false when target file is missing', async () => {
    mockReadRepoDirectory.mockResolvedValue([
      { name: 'post-1.md', path: 'posts/post-1.md', type: 'file', sha: 'abc' },
    ]);
    mockReadRepoFile.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'posts/post-1.md') {
        return {
          content:
            '---\ntitle: Hello\ndate: 2026-05-30\nsummary: A summary\ntags: [tech]\nstatus: published\n---',
          sha: 'abc',
        };
      }
      return null;
    });
    mockParseFrontmatter.mockReturnValue({
      title: 'Hello',
      date: '2026-05-30',
      summary: 'A summary',
      tags: ['tech'],
      status: 'published',
    });
    mockValidatePost.mockReturnValue({ valid: true, errors: [] });

    const result = await checkProfileSync(mockConfig);

    expect(result.ok).toBe(false);
    expect(result.target.accessible).toBe(false);
    expect(result.errors.some((e) => e.includes('not found'))).toBe(true);
  });

  it('never throws for expected errors', async () => {
    mockReadRepoDirectory.mockRejectedValue(new Error('Network error'));

    await expect(checkProfileSync(mockConfig)).resolves.toBeDefined();
    const result = await checkProfileSync(mockConfig);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
