interface TextRedaction {
  pattern: RegExp;
  replacement: string;
}

const ALWAYS_REDACTIONS: TextRedaction[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[redacted-private-key]',
  },
  {
    pattern:
      /((?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|ftp|sftp):\/\/[^\s/:@]+:)[^\s/@]+@/gi,
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
];

const GENERIC_HEURISTIC_REDACTIONS: TextRedaction[] = [
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

const SENSITIVE_IDENTIFIER = String.raw`(?:[A-Za-z0-9_$.-]*(?:api[_-]?key|secret|password|credential|private[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token)[A-Za-z0-9_$.-]*|[A-Za-z0-9_$.-]*token)`;

const SOURCE_LITERAL_REDACTIONS: TextRedaction[] = [
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_$.-])(${SENSITIVE_IDENTIFIER})(\s*[:=]\s*)"(?:\\.|[^"\\])*"`,
      'gi',
    ),
    replacement: '$1$2"[redacted]"',
  },
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_$.-])(${SENSITIVE_IDENTIFIER})(\s*[:=]\s*)'(?:\\.|[^'\\])*'`,
      'gi',
    ),
    replacement: "$1$2'[redacted]'",
  },
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_$.-])(${SENSITIVE_IDENTIFIER})(\s*[:=]\s*)\`(?:\\.|[^\`\\])*\``,
      'gi',
    ),
    replacement: '$1$2`[redacted]`',
  },
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_$.-])(${SENSITIVE_IDENTIFIER})(\s*:\s*[^=;\r\n]+?=\s*)"(?:\\.|[^"\\])*"`,
      'gi',
    ),
    replacement: '$1$2"[redacted]"',
  },
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_$.-])(${SENSITIVE_IDENTIFIER})(\s*:\s*[^=;\r\n]+?=\s*)'(?:\\.|[^'\\])*'`,
      'gi',
    ),
    replacement: "$1$2'[redacted]'",
  },
  {
    pattern: new RegExp(
      String.raw`(["'])(${SENSITIVE_IDENTIFIER})\1(\s*:\s*)"(?:\\.|[^"\\])*"`,
      'gi',
    ),
    replacement: '$1$2$1$3"[redacted]"',
  },
  {
    pattern: new RegExp(
      String.raw`(["'])(${SENSITIVE_IDENTIFIER})\1(\s*:\s*)'(?:\\.|[^'\\])*'`,
      'gi',
    ),
    replacement: "$1$2$1$3'[redacted]'",
  },
];

const SOURCE_MULTILINE_TEMPLATE_START = new RegExp(
  String.raw`(?<![A-Za-z0-9_$.-])${SENSITIVE_IDENTIFIER}\s*(?:(?::\s*[^=;\r\n]+?)?=|:)\s*\``,
  'i',
);

const GENERIC_REDACTIONS = [...ALWAYS_REDACTIONS, ...GENERIC_HEURISTIC_REDACTIONS];
const SOURCE_REDACTIONS = [...ALWAYS_REDACTIONS, ...SOURCE_LITERAL_REDACTIONS];

const SOURCE_CODE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.cts',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.mjs',
  '.mts',
  '.php',
  '.py',
  '.pyi',
  '.r',
  '.rb',
  '.rs',
  '.scala',
  '.sql',
  '.swift',
  '.ts',
  '.tsx',
]);

export type SensitiveProjectionContext = 'generic' | 'source-code' | 'diff';

export interface SensitiveTextProjectionOptions {
  context?: SensitiveProjectionContext;
}

export interface SensitiveTextProjection {
  value: string;
  redacted: boolean;
}

/**
 * Produce a provider/transcript-safe text projection. The raw input is never
 * returned once a known credential shape is detected.
 */
export function redactSensitiveText(
  input: string,
  options: SensitiveTextProjectionOptions = {},
): SensitiveTextProjection {
  const context = options.context ?? 'generic';
  const value =
    context === 'diff'
      ? redactSensitiveDiff(input)
      : applyRedactions(input, context === 'source-code' ? SOURCE_REDACTIONS : GENERIC_REDACTIONS);
  return { value, redacted: value !== input };
}

/**
 * Recheck only context-independent credential shapes after a repository field
 * has already been projected. This avoids re-deriving source/diff context while
 * retaining a final hard-secret backstop before recording or provider reuse.
 */
export function redactProjectedSensitiveText(input: string): SensitiveTextProjection {
  const value = applyRedactions(input, ALWAYS_REDACTIONS);
  return { value, redacted: value !== input };
}

export function isSourceCodeRepositoryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const basename = normalized.split('/').at(-1) ?? '';
  const dot = basename.lastIndexOf('.');
  return dot >= 0 && SOURCE_CODE_EXTENSIONS.has(basename.slice(dot));
}

function redactSensitiveDiff(input: string): string {
  let currentPath: string | undefined;
  let inPrivateKey = false;
  let inSensitiveTemplate = false;
  let awaitingTargetHeader = false;
  const segments = input.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  return segments
    .filter((segment, index) => segment.length > 0 || index === segments.length - 1)
    .map((segment) => {
      const newline = segment.endsWith('\r\n') ? '\r\n' : segment.endsWith('\n') ? '\n' : '';
      const line = newline ? segment.slice(0, -newline.length) : segment;

      const diffHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (diffHeader) {
        currentPath = diffHeader[2];
        inPrivateKey = false;
        inSensitiveTemplate = false;
        awaitingTargetHeader = true;
      }
      const targetHeader = /^\+\+\+ b\/(.+)$/.exec(line);
      if (targetHeader && (awaitingTargetHeader || currentPath === undefined)) {
        currentPath = targetHeader[1];
        inPrivateKey = false;
        inSensitiveTemplate = false;
        awaitingTargetHeader = false;
      } else if (/^@@(?:\s|$)/.test(line)) {
        awaitingTargetHeader = false;
      }

      if (/^[ +\-]*-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
        inPrivateKey = true;
      }
      if (inPrivateKey) {
        const ends = /^[ +\-]*-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line);
        const prefix = /^[ +\-]/.test(line) ? line[0] : '';
        if (ends) inPrivateKey = false;
        return `${prefix}[redacted-private-key]${newline}`;
      }

      const context =
        currentPath && isSourceCodeRepositoryPath(currentPath) ? 'source-code' : 'generic';
      if (context === 'source-code' && inSensitiveTemplate) {
        const prefix = /^[ +\-]/.test(line) ? line[0] : '';
        const closingIndex = findUnescapedBacktick(line);
        if (closingIndex < 0) return `${prefix}[redacted]${newline}`;
        inSensitiveTemplate = false;
        const suffix = applyRedactions(line.slice(closingIndex + 1), SOURCE_REDACTIONS);
        return `${prefix}[redacted]\`${suffix}${newline}`;
      }
      if (context === 'source-code') {
        SOURCE_MULTILINE_TEMPLATE_START.lastIndex = 0;
        const start = SOURCE_MULTILINE_TEMPLATE_START.exec(line);
        if (start) {
          const openingIndex = line.indexOf('`', start.index);
          if (openingIndex >= 0 && findUnescapedBacktick(line, openingIndex + 1) < 0) {
            inSensitiveTemplate = true;
            const prefix = applyRedactions(line.slice(0, openingIndex + 1), SOURCE_REDACTIONS);
            return `${prefix}[redacted]${newline}`;
          }
        }
      }
      return `${applyRedactions(
        line,
        context === 'source-code' ? SOURCE_REDACTIONS : GENERIC_REDACTIONS,
      )}${newline}`;
    })
    .join('');
}

function findUnescapedBacktick(input: string, start = 0): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] !== '`') continue;
    let precedingSlashes = 0;
    for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) {
      precedingSlashes += 1;
    }
    if (precedingSlashes % 2 === 0) return index;
  }
  return -1;
}

function applyRedactions(input: string, redactions: TextRedaction[]): string {
  let value = input;
  for (const { pattern, replacement } of redactions) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, replacement);
  }
  return value;
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
