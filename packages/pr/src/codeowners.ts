import { getCODEOWNERS } from '@openslack/github';
import type { GitHubClientOptions } from '@openslack/github';
import type { PRReviewReport } from './types.js';

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
}

export interface PRCodeownerEvidence {
  /** Immutable Git commit used to load the CODEOWNERS file. */
  ref: string;
  owners: string[];
  entries: CodeownersEntry[];
}

export class PRCodeownerEvidenceUnavailableError extends Error {
  readonly code = 'PR_CODEOWNER_EVIDENCE_UNAVAILABLE';
  readonly operation = 'load immutable PR CODEOWNERS';
  readonly prNumber?: number;

  constructor(message: string, prNumber?: number) {
    super(`PR_CODEOWNER_EVIDENCE_UNAVAILABLE: ${message}`);
    this.name = 'PRCodeownerEvidenceUnavailableError';
    this.prNumber = prNumber;
  }
}

const DEFAULT_MAX_CODEOWNERS_BYTES = 256 * 1024;
const DEFAULT_MAX_CODEOWNERS_LINES = 10_000;
const DEFAULT_MAX_CODEOWNERS_ENTRIES = 1_000;
const DEFAULT_MAX_CHANGED_FILES = 1_000;
const DEFAULT_MAX_CODEOWNER_MATCH_OPERATIONS = 100_000;

function codeownersLimit(
  options: GitHubClientOptions | undefined,
  key: 'maxCodeownersBytes' | 'maxCodeownersLines' | 'maxCodeownersEntries',
  fallback: number,
  absoluteMax: number,
): number {
  const value = options?.evidenceLimits?.[key] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > absoluteMax) {
    throw new Error(`GITHUB_EVIDENCE_LIMIT_INVALID: ${key}`);
  }
  return value;
}

function changedFileLimit(options?: GitHubClientOptions): number {
  const value = options?.evidenceLimits?.maxFiles ?? DEFAULT_MAX_CHANGED_FILES;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error('GITHUB_EVIDENCE_LIMIT_INVALID: maxFiles');
  }
  return value;
}

function codeownerMatchOperationLimit(options?: GitHubClientOptions): number {
  const value =
    options?.evidenceLimits?.maxCodeownerMatchOperations ?? DEFAULT_MAX_CODEOWNER_MATCH_OPERATIONS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error('GITHUB_EVIDENCE_LIMIT_INVALID: maxCodeownerMatchOperations');
  }
  return value;
}

function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<GLOBSTAR_SLASH>>')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR_SLASH>>/g, '(.*/)?')
    .replace(/<<GLOBSTAR>>/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(path);
}

export function parseCODEOWNERS(content: string, options?: GitHubClientOptions): CodeownersEntry[] {
  if (
    Buffer.byteLength(content, 'utf8') >
    codeownersLimit(options, 'maxCodeownersBytes', DEFAULT_MAX_CODEOWNERS_BYTES, 4 * 1024 * 1024)
  ) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_BYTES_LIMIT_EXCEEDED');
  }
  const lines = content === '' ? [] : content.split('\n');
  if (
    lines.length >
    codeownersLimit(options, 'maxCodeownersLines', DEFAULT_MAX_CODEOWNERS_LINES, 100_000)
  ) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_LINES_LIMIT_EXCEEDED');
  }
  const maxEntries = codeownersLimit(
    options,
    'maxCodeownersEntries',
    DEFAULT_MAX_CODEOWNERS_ENTRIES,
    100_000,
  );
  const entries: CodeownersEntry[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    entries.push({ pattern: parts[0], owners: parts.slice(1) });
    if (entries.length > maxEntries) {
      throw new Error('GITHUB_EVIDENCE_CODEOWNERS_ENTRIES_LIMIT_EXCEEDED');
    }
  }
  return entries;
}

export function resolveCodeowners(
  changedFiles: string[],
  entries: CodeownersEntry[],
  options?: GitHubClientOptions,
): string[] {
  if (changedFiles.length > changedFileLimit(options)) {
    throw new Error('GITHUB_EVIDENCE_FILES_LIMIT_EXCEEDED');
  }
  const maxEntries = codeownersLimit(
    options,
    'maxCodeownersEntries',
    DEFAULT_MAX_CODEOWNERS_ENTRIES,
    100_000,
  );
  if (entries.length > maxEntries) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNERS_ENTRIES_LIMIT_EXCEEDED');
  }
  const matchOperations = changedFiles.length * entries.length;
  if (
    !Number.isSafeInteger(matchOperations) ||
    matchOperations > codeownerMatchOperationLimit(options)
  ) {
    throw new Error('GITHUB_EVIDENCE_CODEOWNER_MATCH_OPERATIONS_LIMIT_EXCEEDED');
  }
  const owners = new Set<string>();
  for (const file of changedFiles) {
    for (const entry of entries) {
      if (matchesGlob(file, entry.pattern)) {
        for (const owner of entry.owners) {
          owners.add(owner);
        }
      }
    }
  }
  return Array.from(owners);
}

/**
 * Load PR-level CODEOWNER evidence from the immutable base commit.
 *
 * CODEOWNERS are resolved against the complete changed-file set because the
 * approval applies to the PR, not only to a feature-specific subset such as
 * workflow artifacts. Missing or unreadable evidence fails closed.
 */
export async function loadPRCodeownerEvidence(
  report: PRReviewReport,
  options?: GitHubClientOptions,
): Promise<PRCodeownerEvidence> {
  if (!report.baseSha?.trim()) {
    throw new PRCodeownerEvidenceUnavailableError(
      `PR #${report.prNumber} is missing its immutable base SHA.`,
      report.prNumber,
    );
  }

  const ref = report.baseSha;
  const content = await getCODEOWNERS(ref, {
    ...options,
    strictEvidence: true,
  });
  if (content === null) {
    throw new PRCodeownerEvidenceUnavailableError(
      `CODEOWNERS could not be loaded from ${ref}.`,
      report.prNumber,
    );
  }

  const entries = parseCODEOWNERS(content, options);
  return {
    ref,
    entries,
    owners: resolveCodeowners(report.changedFiles, entries, options),
  };
}
