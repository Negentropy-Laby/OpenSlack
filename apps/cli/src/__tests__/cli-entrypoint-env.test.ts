import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('CLI entrypoint environment handling', () => {
  it('does not load .env from the current working directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openslack-cli-env-'));
    const cliIndex = resolve(process.cwd(), 'apps', 'cli', 'src', 'index.ts');
    const env = { ...process.env };
    delete env.OPENSLACK_DOTENV_SENTINEL;

    try {
      writeFileSync(join(tempDir, '.env'), 'OPENSLACK_DOTENV_SENTINEL=loaded\n', 'utf-8');
      const script = [
        `process.chdir(${JSON.stringify(tempDir)});`,
        "process.argv = ['node', 'openslack', '--help'];",
        "process.exit = ((code) => { throw new Error(`exit:${code ?? 0}`); });",
        'try {',
        `  await import(${JSON.stringify(pathToFileURL(cliIndex).href)});`,
        '} catch (err) {',
        "  if (!(err instanceof Error) || !err.message.startsWith('exit:')) throw err;",
        '}',
        "console.log(`sentinel=${process.env.OPENSLACK_DOTENV_SENTINEL ?? 'unset'}`);",
      ].join('\n');

      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        { cwd: resolve(process.cwd()), env, encoding: 'utf-8', timeout: 30000 },
      );

      expect(output).toContain('sentinel=unset');
      expect(output).not.toContain('sentinel=loaded');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
