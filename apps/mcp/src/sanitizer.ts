import { types as utilTypes } from 'node:util';
import { getSecretPatterns } from '@openslack/collaboration';

const MAX_PERCENT_DECODE_PASSES = 3;
const MAX_TYPED_EVIDENCE_REF_LENGTH = 512;
const MAX_VERSIONED_REPO_PATH_LENGTH = 374;

const URL_WITH_USERINFO = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s"'<>@]+@[^\s"'<>]+/gi;
const ABSOLUTE_URL = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const FILE_URL = /\bfile:(?:\/|\\){1,}[^\s"'<>]*/gi;
const SENSITIVE_STRUCTURAL_ESCAPE = /%(?:25|2F|3A|3D|40|5C)/i;
const WINDOWS_ABSOLUTE_PATH =
  /(^|[\s"'=([{,;:])(?:[A-Za-z]:[\\/][^\s"'<>]*|\\\\[^\\/\s"'<>]+[\\/][^\s"'<>]*)/g;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'=([{,;:])\/(?!\/)[^\s"'<>]+/g;

const SENSITIVE_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:npm_[A-Za-z0-9]{20,}|\/\/registry\.npmjs\.org\/:_authToken=\S+)/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(?:api[_-]?key|client[_-]?secret|cookie|password|passwd|session(?:[_-]?id)?|authorization)\s*[:=]\s*[^\s,;]+/gi,
] as const;
const TYPED_EVIDENCE_REF =
  /^(?:event|query|artifact|test|repo|workflow-run|run|plan|issue|pr|decision|handoff|notification|assumption|fixture):[A-Za-z0-9][A-Za-z0-9._~:/@+?%=&-]{0,499}$/;
const VERSIONED_REPO_EVIDENCE_REF =
  /^repo:([A-Za-z0-9._/-]+)#([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const REPOSITORY_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

function fresh(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function matches(pattern: RegExp, value: string): boolean {
  return fresh(pattern).test(value);
}

function hasSecret(value: string): boolean {
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => matches(pattern, value))) return true;
  return getSecretPatterns().some(({ pattern }) => matches(pattern, value));
}

function hasAbsoluteLocalPath(value: string): boolean {
  return (
    matches(FILE_URL, value) ||
    matches(WINDOWS_ABSOLUTE_PATH, value) ||
    matches(POSIX_ABSOLUTE_PATH, value)
  );
}

export function decodeForSensitiveInspection(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    if (!/%[0-9A-Fa-f]{2}/.test(decoded)) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      const next = decoded.replace(/%([0-9A-Fa-f]{2})/g, (_match, octet: string) =>
        String.fromCharCode(Number.parseInt(octet, 16)),
      );
      if (next === decoded) break;
      decoded = next;
    }
  }
  return decoded;
}

function containsSensitiveOutput(value: string): boolean {
  return hasSecret(value) || matches(URL_WITH_USERINFO, value) || hasAbsoluteLocalPath(value);
}

export function isUnsafeEvidenceReference(value: string): boolean {
  const decoded = decodeForSensitiveInspection(value);
  return (
    containsSensitiveOutput(value) ||
    containsSensitiveOutput(decoded) ||
    matches(ABSOLUTE_URL, value) ||
    matches(ABSOLUTE_URL, decoded) ||
    SENSITIVE_STRUCTURAL_ESCAPE.test(decoded)
  );
}

function isVersionedRepoEvidenceReference(value: string): boolean {
  const match = VERSIONED_REPO_EVIDENCE_REF.exec(value);
  if (!match) return false;
  const repositoryPath = match[1];
  if (
    repositoryPath.length > MAX_VERSIONED_REPO_PATH_LENGTH ||
    repositoryPath.startsWith('/') ||
    repositoryPath.endsWith('/')
  ) {
    return false;
  }
  return repositoryPath
    .split('/')
    .every(
      (segment) => segment !== '.' && segment !== '..' && REPOSITORY_PATH_SEGMENT.test(segment),
    );
}

export function normalizeTypedEvidenceReference(value: string): string | undefined {
  const reference = value.trim();
  if (reference.length === 0 || reference.length > MAX_TYPED_EVIDENCE_REF_LENGTH) return undefined;
  if (isUnsafeEvidenceReference(reference)) return undefined;
  if (/^commit:[0-9a-f]{40}$/i.test(reference)) return reference.toLowerCase();
  if (isVersionedRepoEvidenceReference(reference)) return reference;
  return TYPED_EVIDENCE_REF.test(reference) ? reference : undefined;
}

export function normalizeTypedEvidenceReferences(
  values: readonly unknown[],
  limit = 50,
): readonly string[] {
  if (utilTypes.isProxy(values)) throw new TypeError('PROTOCOL_OUTPUT_PROXY_REJECTED');
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const reference = normalizeTypedEvidenceReference(value);
    if (reference) normalized.add(reference);
    if (normalized.size >= limit) break;
  }
  return [...normalized];
}

function redactPattern(value: string, pattern: RegExp): string {
  return value.replace(fresh(pattern), (match, prefix: string | undefined) => {
    if (
      pattern.source === WINDOWS_ABSOLUTE_PATH.source ||
      pattern.source === POSIX_ABSOLUTE_PATH.source
    ) {
      return `${prefix ?? ''}[REDACTED]`;
    }
    return '[REDACTED]';
  });
}

export function redactProtocolString(value: string, maxLength: number): string {
  let safe = value.slice(0, maxLength);

  // Decode only for inspection. Replacing the original token avoids re-emitting a
  // decoded secret and handles single, double, and triple encoded disguises.
  safe = safe.replace(/[^\s"'<>]+/g, (token) => {
    const decoded = decodeForSensitiveInspection(token);
    return decoded !== token &&
      (containsSensitiveOutput(decoded) || SENSITIVE_STRUCTURAL_ESCAPE.test(decoded))
      ? '[REDACTED]'
      : token;
  });

  for (const { pattern } of getSecretPatterns()) {
    safe = safe.replace(fresh(pattern), '[REDACTED]');
  }
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    safe = safe.replace(fresh(pattern), '[REDACTED]');
  }
  safe = redactPattern(safe, URL_WITH_USERINFO);
  safe = redactPattern(safe, FILE_URL);
  safe = redactPattern(safe, WINDOWS_ABSOLUTE_PATH);
  safe = redactPattern(safe, POSIX_ABSOLUTE_PATH);
  return safe;
}
