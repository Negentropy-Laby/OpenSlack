import { createOpenSlackMcpResult, type OpenSlackMcpResult } from '@openslack/qoder-adapter';
import { normalizeTypedEvidenceReference, normalizeTypedEvidenceReferences } from '../sanitizer.js';

export function numberArg(
  input: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = input[key];
  return typeof value === 'number' ? value : fallback;
}

export function stringArg(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function walkEvidence(value: unknown, output: Set<string>, depth: number): void {
  if (depth > 8 || output.size >= 50 || value === null || value === undefined) return;
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (const child of value) walkEvidence(child, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'headSha' && typeof child === 'string') {
      const sha = child.trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) output.add(`commit:${sha.toLowerCase()}`);
    } else if (key === 'evidenceRef' && typeof child === 'string') {
      const reference = normalizeEvidenceReference(child);
      if (reference) output.add(reference);
    } else if (key === 'evidenceRefs' && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item !== 'string') continue;
        const reference = normalizeEvidenceReference(item);
        if (reference) output.add(reference);
      }
    } else {
      walkEvidence(child, output, depth + 1);
    }
  }
}

export function normalizeEvidenceReference(value: string): string | undefined {
  return normalizeTypedEvidenceReference(value);
}

export function normalizeEvidenceReferences(values: readonly string[]): readonly string[] {
  return normalizeTypedEvidenceReferences(values);
}

export function evidenceFrom(value: unknown): readonly string[] {
  const output = new Set<string>();
  walkEvidence(value, output, 0);
  return [...output];
}

export function completedProjection<T>(summary: string, data: T): OpenSlackMcpResult<T> {
  return createOpenSlackMcpResult({
    summary,
    data,
    evidenceRefs: evidenceFrom(data),
  });
}
