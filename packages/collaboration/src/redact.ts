import type { CollaborationEvent } from './types.js';

const SECRET_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /xox[baprs]-[A-Za-z0-9-]+/, name: 'Slack token' },
  { pattern: /gh[pousr]_[A-Za-z0-9_]+/, name: 'GitHub token' },
  { pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/, name: 'Private key' },
  { pattern: /AWS_SECRET_ACCESS_KEY\s*=/i, name: 'AWS secret' },
  { pattern: /OPENSLACK_.*SECRET\s*=/i, name: 'OpenSlack secret' },
];

export function containsSecret(value: unknown): { found: boolean; name?: string } {
  if (typeof value !== 'string') return { found: false };

  for (const { pattern, name } of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      return { found: true, name };
    }
  }

  return { found: false };
}

export function scanValue(value: unknown, path: string, depth: number = 0): { found: boolean; name?: string; path?: string } {
  // Guard against circular references and excessive depth
  if (depth > 10) return { found: false };

  if (value === null || value === undefined) {
    return { found: false };
  }

  if (typeof value === 'string') {
    const secret = containsSecret(value);
    if (secret.found) {
      return { found: true, name: secret.name, path };
    }
    return { found: false };
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const result = scanValue(value[i], `${path}[${i}]`, depth + 1);
        if (result.found) return result;
      }
    } else {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const result = scanValue(val, `${path}.${key}`, depth + 1);
        if (result.found) return result;
      }
    }
  }

  return { found: false };
}

export function sanitizeEvent(event: CollaborationEvent): { safe: boolean; reason?: string } {
  // Check summary
  const summaryCheck = containsSecret(event.summary);
  if (summaryCheck.found) {
    return { safe: false, reason: `Secret detected in summary: ${summaryCheck.name}` };
  }

  // Check metadata recursively
  if (event.metadata) {
    const metaCheck = scanValue(event.metadata, 'metadata');
    if (metaCheck.found) {
      return { safe: false, reason: `Secret detected in ${metaCheck.path}: ${metaCheck.name}` };
    }
  }

  // Check nextAction fields
  if (event.nextAction) {
    const actionCheck = containsSecret(event.nextAction.action);
    if (actionCheck.found) {
      return { safe: false, reason: `Secret detected in nextAction.action: ${actionCheck.name}` };
    }
    if (event.nextAction.command) {
      const cmdCheck = containsSecret(event.nextAction.command);
      if (cmdCheck.found) {
        return { safe: false, reason: `Secret detected in nextAction.command: ${cmdCheck.name}` };
      }
    }
  }

  return { safe: true };
}

export function getSecretPatterns(): { pattern: RegExp; name: string }[] {
  return SECRET_PATTERNS.map((s) => ({ pattern: s.pattern, name: s.name }));
}
