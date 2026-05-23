import { describe, it, expect } from 'vitest';
import { parseCODEOWNERS, resolveCodeowners } from '../codeowners.js';

const SAMPLE_CODEOWNERS = `
# Red Zone paths
.github/**                                     @wsman
.openslack/policies/**                         @wsman
packages/kernel/src/**                         @wsman

# Yellow Zone
apps/**                                        @wsman @alice
packages/core/**                               @bob

# Docs
docs/**                                        @wsman @alice @bob
`;

describe('parseCODEOWNERS', () => {
  it('parses entries and ignores comments/blank lines', () => {
    const entries = parseCODEOWNERS(SAMPLE_CODEOWNERS);
    expect(entries).toHaveLength(6);
    expect(entries[0]).toEqual({ pattern: '.github/**', owners: ['@wsman'] });
    expect(entries[1]).toEqual({ pattern: '.openslack/policies/**', owners: ['@wsman'] });
    expect(entries[5]).toEqual({ pattern: 'docs/**', owners: ['@wsman', '@alice', '@bob'] });
  });

  it('returns empty array for empty content', () => {
    expect(parseCODEOWNERS('')).toEqual([]);
    expect(parseCODEOWNERS('# only comments\n\n  ')).toEqual([]);
  });
});

describe('resolveCodeowners', () => {
  const entries = parseCODEOWNERS(SAMPLE_CODEOWNERS);

  it('resolves owners for changed files', () => {
    const owners = resolveCodeowners(['.github/workflows/ci.yml'], entries);
    expect(owners).toContain('@wsman');
  });

  it('returns multiple owners for matching patterns', () => {
    const owners = resolveCodeowners(['apps/cli/src/index.ts'], entries);
    expect(owners).toContain('@wsman');
    expect(owners).toContain('@alice');
  });

  it('returns empty array when no patterns match', () => {
    const owners = resolveCodeowners(['unknown/file.txt'], entries);
    expect(owners).toEqual([]);
  });

  it('deduplicates owners across multiple files', () => {
    const owners = resolveCodeowners(
      ['.github/workflows/ci.yml', '.openslack/policies/pr.yaml'],
      entries,
    );
    expect(owners).toEqual(['@wsman']);
  });

  it('matches globstar patterns', () => {
    const owners = resolveCodeowners(['packages/kernel/src/zones.ts'], entries);
    expect(owners).toContain('@wsman');
  });
});
