const TEXT_REDACTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[redacted-private-key]',
  },
  {
    pattern: /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi,
    replacement: '$1[redacted]@',
  },
  {
    pattern: /(authorization\s*:\s*(?:bearer|token)\s+)[^\s,;]+/gi,
    replacement: '$1[redacted]',
  },
  {
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[a-z]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g,
    replacement: '[redacted-token]',
  },
  {
    pattern: /\b(?:AWS_SECRET_ACCESS_KEY|OPENSLACK_[A-Z0-9_]*SECRET)\s*=\s*[^\r\n]*/gi,
    replacement: '[redacted-secret-assignment]',
  },
  {
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|credential)\b(\s*[:=]\s*)(["']?)[^\s,"';]+\3/gi,
    replacement: '$1$2[redacted]',
  },
  {
    pattern:
      /\b([a-z][a-z0-9_.-]*(?:api[_-]?key|secret|password|credential|private[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token)[a-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^\s,"';]+\3/gi,
    replacement: '$1$2[redacted]',
  },
  {
    pattern:
      /(["'])([^"']*(?:api[_-]?key|secret|password|credential|private[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token)[^"']*)\1(\s*:\s*)(["'])[^"']+\4/gi,
    replacement: '$1$2$1$3$4[redacted]$4',
  },
];

export interface SensitiveTextProjection {
  value: string;
  redacted: boolean;
}

/**
 * Produce a provider/transcript-safe text projection. The raw input is never
 * returned once a known credential shape is detected.
 */
export function redactSensitiveText(input: string): SensitiveTextProjection {
  let value = input;
  for (const { pattern, replacement } of TEXT_REDACTIONS) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, replacement);
  }
  return { value, redacted: value !== input };
}

/** Deeply redact string leaves in JSON-compatible tool evidence. */
export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[redacted-depth-limit]';
  if (typeof value === 'string') return redactSensitiveText(value).value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactSensitiveValue(item, depth + 1);
  }
  return result;
}

/**
 * Runtime metadata and credential-equivalent files are never model tools,
 * regardless of their governance risk-zone classification.
 */
export function isSensitiveRepositoryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? '';
  return (
    segments.includes('.git') ||
    segments.includes('.openslack.local') ||
    segments.some((segment) =>
      ['secrets', 'credentials', 'private', 'production-tokens'].includes(segment),
    ) ||
    basename === '.env' ||
    basename.startsWith('.env.') ||
    ['.npmrc', '.netrc', '.pypirc', 'id_rsa', 'id_ed25519'].includes(basename) ||
    basename.endsWith('.pem') ||
    basename.endsWith('.key')
  );
}
