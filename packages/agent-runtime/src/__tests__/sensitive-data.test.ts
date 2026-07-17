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
      'const database = "postgresql://db-user:database-password@example.test/app";',
      'const cache = "redis://cache-user:cache-password@example.test/0";',
      'const documentStore = "mongodb+srv://mongo-user:mongo-password@example.test/app";',
      'OPENSLACK_PROVIDER_SECRET=getSecret()',
      'const pem = `-----BEGIN PRIVATE KEY-----',
      'private-key-body',
      '-----END PRIVATE KEY-----`;',
    ].join('\n');

    const projection = redactSensitiveText(input, { context: 'source-code' }).value;

    expect(projection).toContain('Authorization: Bearer [redacted]');
    expect(projection).toContain('https://user:[redacted]@example.test/path');
    expect(projection).toContain('postgresql://db-user:[redacted]@example.test/app');
    expect(projection).toContain('redis://cache-user:[redacted]@example.test/0');
    expect(projection).toContain('mongodb+srv://mongo-user:[redacted]@example.test/app');
    expect(projection).toContain('[redacted-secret-assignment]');
    expect(projection).toContain('[redacted-private-key]');
    expect(projection).not.toContain('bearer-value');
    expect(projection).not.toContain('password-value');
    expect(projection).not.toContain('database-password');
    expect(projection).not.toContain('cache-password');
    expect(projection).not.toContain('mongo-password');
    expect(projection).not.toContain('private-key-body');
  });

  it('redacts multiline template literals directly in source-code context', () => {
    const projection = redactSensitiveText(
      ['const accessToken = `', 'multiline-token-body', '`;', 'const value = compute();'].join(
        '\n',
      ),
      { context: 'source-code' },
    ).value;

    expect(projection).toContain('const accessToken = `[redacted]`;');
    expect(projection).toContain('const value = compute();');
    expect(projection).not.toContain('multiline-token-body');
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

  it('contains an unclosed private key projection to its diff file', () => {
    const diff = [
      'diff --git a/src/key.ts b/src/key.ts',
      '--- a/src/key.ts',
      '+++ b/src/key.ts',
      '@@ -1 +1,2 @@',
      '+-----BEGIN PRIVATE KEY-----',
      '+truncated-private-key-body',
      '+++ b/src/forged.ts',
      'diff --git a/src/next.ts b/src/next.ts',
      '--- a/src/next.ts',
      '+++ b/src/next.ts',
      '@@ -1 +1,2 @@',
      '+const logic = compute();',
      '+const password = "following-file-secret";',
    ].join('\n');

    const projection = redactSensitiveText(diff, { context: 'diff' }).value;

    expect(projection).not.toContain('truncated-private-key-body');
    expect(projection).not.toContain('forged.ts');
    expect(projection).toContain('diff --git a/src/next.ts b/src/next.ts');
    expect(projection).toContain('+++ b/src/next.ts');
    expect(projection).toContain('+const logic = compute();');
    expect(projection).toContain('+const password = "[redacted]";');
    expect(projection).not.toContain('following-file-secret');
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
