import { describe, expect, it } from 'vitest';
import {
  isSourceCodeRepositoryPath,
  redactSensitiveText,
  redactSensitiveValue,
} from '../sensitive-data.js';

describe('context-aware sensitive data projection', () => {
  it('preserves source expressions while redacting credential literals', () => {
    const fakeToken = `sk-${'s'.repeat(24)}`;
    const input = [
      'const secret = getSecret();',
      'const password: string = "literal-password";',
      "const serviceCredential = 'literal-credential';",
      'const $privateKey = `literal-private-key`;',
      'const headers = { "apiKey": "literal-api-key" };',
      'const token = "opaque-token-value";',
      `const token = "${fakeToken}";`,
    ].join('\n');

    const projection = redactSensitiveText(input, { context: 'source-code' });

    expect(projection.value).toContain('const secret = getSecret();');
    expect(projection.value).toContain('password: string = "[redacted]"');
    expect(projection.value).toContain("serviceCredential = '[redacted]'");
    expect(projection.value).toContain('$privateKey = `[redacted]`');
    expect(projection.value).toContain('"apiKey": "[redacted]"');
    expect(projection.value).toContain('const token = "[redacted]";');
    expect(projection.value).not.toContain('literal-password');
    expect(projection.value).not.toContain('literal-credential');
    expect(projection.value).not.toContain('literal-private-key');
    expect(projection.value).not.toContain('literal-api-key');
    expect(projection.value).not.toContain('opaque-token-value');
    expect(projection.value).not.toContain(fakeToken);
  });

  it('keeps hard credential shapes redacted in source-code context', () => {
    const input = [
      'const auth = "Authorization: Bearer bearer-value";',
      'const url = "https://user:password-value@example.test/path";',
      'OPENSLACK_PROVIDER_SECRET=getSecret()',
      'const pem = `-----BEGIN PRIVATE KEY-----',
      'private-key-body',
      '-----END PRIVATE KEY-----`;',
    ].join('\n');

    const projection = redactSensitiveText(input, { context: 'source-code' }).value;

    expect(projection).toContain('Authorization: Bearer [redacted]');
    expect(projection).toContain('https://user:[redacted]@example.test/path');
    expect(projection).toContain('[redacted-secret-assignment]');
    expect(projection).toContain('[redacted-private-key]');
    expect(projection).not.toContain('bearer-value');
    expect(projection).not.toContain('password-value');
    expect(projection).not.toContain('private-key-body');
  });

  it('keeps the conservative heuristic for generic and nested projections', () => {
    expect(redactSensitiveText('secret = getSecret()').value).toBe('secret = [redacted]');
    expect(redactSensitiveValue({ output: { password: 'password = getSecret()' } })).toEqual({
      output: { password: 'password = [redacted]' },
    });
  });

  it('redacts diff hunks according to each target path', () => {
    const fakeToken = `ghp_${'d'.repeat(24)}`;
    const diff = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,2 +1,3 @@',
      '+const secret = getSecret();',
      '+const password = "source-literal";',
      `+const token = "${fakeToken}";`,
      '+const accessToken = `',
      '+multiline-token-body',
      '+`;',
      'diff --git a/config/settings.yaml b/config/settings.yaml',
      '--- a/config/settings.yaml',
      '+++ b/config/settings.yaml',
      '@@ -1 +1 @@',
      '+password: plain-config-value',
      '',
    ].join('\n');

    const projection = redactSensitiveText(diff, { context: 'diff' }).value;

    expect(projection).toContain('+const secret = getSecret();');
    expect(projection).toContain('+const password = "[redacted]";');
    expect(projection).toContain('+password: [redacted]');
    expect(projection).toContain('+const token = "[redacted]";');
    expect(projection).not.toContain('source-literal');
    expect(projection).not.toContain('plain-config-value');
    expect(projection).not.toContain('multiline-token-body');
    expect(projection).not.toContain(fakeToken);
  });

  it('redacts private key blocks even when diff markers prefix every line', () => {
    const diff = [
      'diff --git a/src/key.ts b/src/key.ts',
      '+++ b/src/key.ts',
      '+-----BEGIN PRIVATE KEY-----',
      '+private-key-body',
      '+-----END PRIVATE KEY-----',
    ].join('\n');

    const projection = redactSensitiveText(diff, { context: 'diff' }).value;

    expect(projection).not.toContain('private-key-body');
    expect(projection.match(/\[redacted-private-key\]/g)).toHaveLength(3);
  });

  it('recognizes only the bounded source-code extension allowlist', () => {
    expect(isSourceCodeRepositoryPath('packages/runtime/src/example.ts')).toBe(true);
    expect(isSourceCodeRepositoryPath('src/example.PY')).toBe(true);
    expect(isSourceCodeRepositoryPath('config/settings.yaml')).toBe(false);
    expect(isSourceCodeRepositoryPath('fixtures/example.json')).toBe(false);
    expect(isSourceCodeRepositoryPath('scripts/deploy.sh')).toBe(false);
    expect(isSourceCodeRepositoryPath('README.md')).toBe(false);
  });
});
