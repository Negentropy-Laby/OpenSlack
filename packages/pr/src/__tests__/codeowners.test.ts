import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it, expect, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getCODEOWNERS: vi.fn() }));
vi.mock('@openslack/github', () => ({
  getCODEOWNERS: (...args: unknown[]) => hoisted.getCODEOWNERS(...args),
}));

import {
  loadPRCodeownerEvidence,
  parseCODEOWNERS,
  PRCodeownerEvidenceUnavailableError,
  resolveCodeowners,
} from '../codeowners.js';
import type { PRReviewReport } from '../types.js';

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

  it('assigns the repository owner to every core workflow artifact', () => {
    const content = readFileSync(
      new URL('../../../../.github/CODEOWNERS', import.meta.url),
      'utf8',
    );
    const repositoryEntries = parseCODEOWNERS(content);

    expect(resolveCodeowners([
      'packages/workflows/src/builtins/profile-sync.ts',
      'packages/workflows/src/workflow-catalog.ts',
      'packages/workflows/src/pattern-registry.ts',
    ], repositoryEntries)).toEqual(['@wsman']);
  });
});

function report(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 185,
    title: 'release: add native signed release artifacts',
    author: 'openslack-agent-operator[bot]',
    state: 'closed',
    draft: false,
    baseRef: 'main',
    baseSha: 'immutable-base-sha',
    headSha: 'reviewed-head-sha',
    riskZone: 'red',
    changedFiles: [
      '.github/workflows/openslack-release.yml',
      'packages/workflows/src/builtins/profile-sync.ts',
    ],
    checks: [],
    reviews: [],
    humanApprovals: [],
    decision: 'ANALYZED',
    reason: '',
    recommendation: '',
    mergeable: true,
    ...overrides,
  };
}

describe('loadPRCodeownerEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getCODEOWNERS.mockResolvedValue([
      '.github/** @wsman',
      'packages/workflows/src/builtins/** @workflow-owner',
    ].join('\n'));
  });

  it('loads CODEOWNERS from baseSha and resolves the complete PR file set', async () => {
    const evidence = await loadPRCodeownerEvidence(report({ baseRef: 'moved-main' }), {
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
    });

    expect(hoisted.getCODEOWNERS).toHaveBeenCalledWith('immutable-base-sha', {
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      strictEvidence: true,
    });
    expect(evidence).toMatchObject({
      ref: 'immutable-base-sha',
      owners: ['@wsman', '@workflow-owner'],
    });
  });

  it('is unaffected when the mutable base branch later points elsewhere', async () => {
    await loadPRCodeownerEvidence(report({ baseRef: 'main-after-drift' }));
    expect(hoisted.getCODEOWNERS).toHaveBeenCalledWith('immutable-base-sha', {
      strictEvidence: true,
    });
  });

  it('fails closed when baseSha or CODEOWNERS evidence is unavailable', async () => {
    await expect(loadPRCodeownerEvidence(report({ baseSha: undefined })))
      .rejects.toBeInstanceOf(PRCodeownerEvidenceUnavailableError);
    expect(hoisted.getCODEOWNERS).not.toHaveBeenCalled();

    hoisted.getCODEOWNERS.mockResolvedValueOnce(null);
    await expect(loadPRCodeownerEvidence(report()))
      .rejects.toThrow('CODEOWNERS could not be loaded from immutable-base-sha');
  });

  it('is the only CODEOWNERS loading path used by PRMS consumers', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const trackedSourceFiles = execFileSync('git', ['ls-files', 'packages', 'apps'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path))
      .filter((path) => !path.includes('/__tests__/'));
    const allowedDefinitions = new Set([
      'packages/github/src/index.ts',
      'packages/github/src/pr.ts',
      'packages/pr/src/codeowners.ts',
    ]);

    const bypasses = trackedSourceFiles.filter((path) => {
      if (allowedDefinitions.has(path)) return false;
      return /\bgetCODEOWNERS\b/.test(readFileSync(`${repositoryRoot}/${path}`, 'utf8'));
    });

    expect(bypasses).toEqual([]);
  });
});
