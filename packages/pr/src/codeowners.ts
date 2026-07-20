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

export function parseCODEOWNERS(content: string): CodeownersEntry[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/\s+/);
      return { pattern: parts[0], owners: parts.slice(1) };
    });
}

export function resolveCodeowners(changedFiles: string[], entries: CodeownersEntry[]): string[] {
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

  const entries = parseCODEOWNERS(content);
  return {
    ref,
    entries,
    owners: resolveCodeowners(report.changedFiles, entries),
  };
}
