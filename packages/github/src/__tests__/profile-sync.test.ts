import { describe, it, expect } from 'vitest';
import {
  patchMarkerSection,
  MarkerNotFoundError,
  parseFrontmatter,
  validatePost,
  sortPostsByDate,
  renderLatestInsightsSection,
  extractBody,
} from '../profile-sync.js';

// ── patchMarkerSection ────────────────────────────────────────────────────────

describe('patchMarkerSection', () => {
  it('replaces content between markers', () => {
    const content = `<!-- openslack:latest-insights:start -->\nOld content\n<!-- openslack:latest-insights:end -->`;
    const result = patchMarkerSection(content, 'latest-insights', 'New content');
    expect(result).toContain('New content');
    expect(result).not.toContain('Old content');
    expect(result).toContain('<!-- openslack:latest-insights:start -->');
    expect(result).toContain('<!-- openslack:latest-insights:end -->');
  });

  it('preserves content outside markers', () => {
    const content = `Header\n<!-- openslack:latest-insights:start -->\nOld\n<!-- openslack:latest-insights:end -->\nFooter`;
    const result = patchMarkerSection(content, 'latest-insights', 'New');
    expect(result.startsWith('Header\n')).toBe(true);
    expect(result.endsWith('Footer')).toBe(true);
  });

  it('throws when start marker is missing', () => {
    const content = `<!-- openslack:latest-insights:end -->`;
    expect(() => patchMarkerSection(content, 'latest-insights', 'x')).toThrow(MarkerNotFoundError);
  });

  it('throws when end marker is missing', () => {
    const content = `<!-- openslack:latest-insights:start -->`;
    expect(() => patchMarkerSection(content, 'latest-insights', 'x')).toThrow(MarkerNotFoundError);
  });

  it('throws when end marker appears before start marker', () => {
    const content = `<!-- openslack:latest-insights:end -->\n<!-- openslack:latest-insights:start -->`;
    expect(() => patchMarkerSection(content, 'latest-insights', 'x')).toThrow(MarkerNotFoundError);
  });

  it('handles multiple markers with different names independently', () => {
    const content = `
<!-- openslack:latest-insights:start -->
Insights old
<!-- openslack:latest-insights:end -->

<!-- openslack:featured:start -->
Featured old
<!-- openslack:featured:end -->
`;
    const result = patchMarkerSection(content, 'featured', 'Featured new');
    expect(result).toContain('Featured new');
    expect(result).toContain('Insights old');
    expect(result).not.toContain('Featured old');
  });

  it('handles empty new section', () => {
    const content = `<!-- openslack:latest-insights:start -->\nOld\n<!-- openslack:latest-insights:end -->`;
    const result = patchMarkerSection(content, 'latest-insights', '');
    expect(result).toBe(
      '<!-- openslack:latest-insights:start -->\n\n<!-- openslack:latest-insights:end -->',
    );
  });
});

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses basic frontmatter', () => {
    const source = `---
title: Hello World
date: 2026-05-30
status: published
---

# Body`;
    const result = parseFrontmatter(source);
    expect(result).toEqual({
      title: 'Hello World',
      date: '2026-05-30',
      status: 'published',
    });
  });

  it('parses arrays', () => {
    const source = `---
tags: ["Agent OS", "Security"]
---

Body`;
    const result = parseFrontmatter(source);
    expect(result?.tags).toEqual(['Agent OS', 'Security']);
  });

  it('parses arrays without quotes', () => {
    const source = `---
tags: [Agent OS, Security]
---

Body`;
    const result = parseFrontmatter(source);
    expect(result?.tags).toEqual(['Agent OS', 'Security']);
  });

  it('returns null when no frontmatter', () => {
    const result = parseFrontmatter('# Just a heading\n\nBody');
    expect(result).toBeNull();
  });

  it('returns null when frontmatter is unclosed', () => {
    const result = parseFrontmatter('---\ntitle: x');
    expect(result).toBeNull();
  });

  it('ignores comments in frontmatter', () => {
    const source = `---
# This is a comment
title: Hello
---

Body`;
    const result = parseFrontmatter(source);
    expect(result?.title).toBe('Hello');
  });

  it('strips surrounding quotes from values', () => {
    const source = `---
title: "Quoted Title"
summary: 'Quoted summary'
---

Body`;
    const result = parseFrontmatter(source);
    expect(result?.title).toBe('Quoted Title');
    expect(result?.summary).toBe('Quoted summary');
  });
});

// ── extractBody ───────────────────────────────────────────────────────────────

describe('extractBody', () => {
  it('returns body after frontmatter', () => {
    const source = `---
title: x
---

# Heading\n\nBody text`;
    const result = extractBody(source);
    expect(result).toBe('# Heading\n\nBody text');
  });

  it('returns full content when no frontmatter', () => {
    const source = '# Heading\n\nBody';
    const result = extractBody(source);
    expect(result).toBe('# Heading\n\nBody');
  });
});

// ── validatePost ──────────────────────────────────────────────────────────────

describe('validatePost', () => {
  it('accepts a valid published post', () => {
    const result = validatePost({
      title: 'Hello',
      date: '2026-05-30',
      summary: 'A short summary.',
      tags: ['tech'],
      status: 'published',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing title', () => {
    const result = validatePost({
      date: '2026-05-30',
      summary: 'A short summary.',
      tags: ['tech'],
      status: 'published',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'title')).toBe(true);
  });

  it('rejects empty title', () => {
    const result = validatePost({
      title: '   ',
      date: '2026-05-30',
      summary: 'A short summary.',
      tags: ['tech'],
      status: 'published',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'title')).toBe(true);
  });

  it('rejects invalid date', () => {
    const result = validatePost({
      title: 'Hello',
      date: 'not-a-date',
      summary: 'A short summary.',
      tags: ['tech'],
      status: 'published',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'date')).toBe(true);
  });

  it('rejects missing summary', () => {
    const result = validatePost({
      title: 'Hello',
      date: '2026-05-30',
      tags: ['tech'],
      status: 'published',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'summary')).toBe(true);
  });

  it('rejects summary over 240 chars', () => {
    const result = validatePost({
      title: 'Hello',
      date: '2026-05-30',
      summary: 'a'.repeat(241),
      tags: ['tech'],
      status: 'published',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'summary' && e.message.includes('240'))).toBe(
      true,
    );
  });

  it('rejects non-array tags', () => {
    const result = validatePost({
      title: 'Hello',
      date: '2026-05-30',
      summary: 'A short summary.',
      tags: 'tech',
      status: 'published',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'tags')).toBe(true);
  });

  it('rejects non-published status', () => {
    const result = validatePost({
      title: 'Hello',
      date: '2026-05-30',
      summary: 'A short summary.',
      tags: ['tech'],
      status: 'draft',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'status')).toBe(true);
  });
});

// ── sortPostsByDate ───────────────────────────────────────────────────────────

describe('sortPostsByDate', () => {
  it('sorts by date descending', () => {
    const posts = [
      {
        title: 'Old',
        date: '2026-01-01',
        tags: [],
        summary: '',
        status: 'published',
        slug: '',
        sourcePath: '',
      },
      {
        title: 'New',
        date: '2026-05-30',
        tags: [],
        summary: '',
        status: 'published',
        slug: '',
        sourcePath: '',
      },
      {
        title: 'Mid',
        date: '2026-03-15',
        tags: [],
        summary: '',
        status: 'published',
        slug: '',
        sourcePath: '',
      },
    ];
    const sorted = sortPostsByDate(posts);
    expect(sorted.map((p) => p.title)).toEqual(['New', 'Mid', 'Old']);
  });
});

// ── renderLatestInsightsSection ───────────────────────────────────────────────

describe('renderLatestInsightsSection', () => {
  it('renders a list of posts', () => {
    const posts = [
      {
        title: 'Why AI Agents Need Contracts',
        date: '2026-05-30',
        tags: ['AI'],
        summary: 'An exploration into agent runtime contracts.',
        status: 'published',
        slug: 'agent-contracts',
        sourcePath: 'posts/agent-contracts.md',
      },
    ];
    const rendered = renderLatestInsightsSection(posts, 'Negentropy-Laby/whitepapers');
    expect(rendered).toContain('[Why AI Agents Need Contracts]');
    expect(rendered).toContain(
      'https://github.com/Negentropy-Laby/whitepapers/blob/main/posts/agent-contracts.md',
    );
    expect(rendered).toContain('*2026-05-30*');
    expect(rendered).toContain('An exploration into agent runtime contracts.');
  });

  it('escapes markdown in titles', () => {
    const posts = [
      {
        title: 'Title [with] brackets',
        date: '2026-05-30',
        tags: [],
        summary: 'Summary.',
        status: 'published',
        slug: 'x',
        sourcePath: 'posts/x.md',
      },
    ];
    const rendered = renderLatestInsightsSection(posts, 'o/r');
    expect(rendered).toContain('Title \\[with\\] brackets');
  });

  it('renders multiple posts', () => {
    const posts = [
      {
        title: 'First',
        date: '2026-05-30',
        tags: [],
        summary: 'First summary.',
        status: 'published',
        slug: 'first',
        sourcePath: 'posts/first.md',
      },
      {
        title: 'Second',
        date: '2026-05-29',
        tags: [],
        summary: 'Second summary.',
        status: 'published',
        slug: 'second',
        sourcePath: 'posts/second.md',
      },
    ];
    const rendered = renderLatestInsightsSection(posts, 'o/r');
    const lines = rendered.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(4); // 2 list items + 2 summaries
  });
});
