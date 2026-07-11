import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());

function scriptPath(name: string): string {
  return resolve(repoRoot, 'scripts', name);
}

describe('bot-auth wrapper scripts', () => {
  it.each(['bot-gh.sh', 'bot-gh-pr-create.sh', 'bot-gh.ps1', 'bot-gh-pr-create.ps1'])(
    '%s exists',
    (name) => {
      expect(existsSync(scriptPath(name))).toBe(true);
    },
  );

  it('keeps App identifiers configurable and token acquisition in-process', () => {
    const tokenScript = readFileSync(scriptPath('bot-gh-token.js'), 'utf8');
    expect(tokenScript).toContain('.openslack.local');
    expect(tokenScript).toContain('github-app.json');
    expect(tokenScript).toContain('acquireConfiguredInstallationToken');
    expect(tokenScript).not.toContain('3728623');
    expect(tokenScript).not.toContain('135500236');
  });

  it('PR creation wrappers delegate to the package-backed delivery path', () => {
    const compat = readFileSync(scriptPath('bot-delivery-compat.js'), 'utf8');
    expect(compat).toContain("['delivery', 'publish']");
    expect(compat).toContain('cwd: process.cwd()');
    expect(compat).not.toContain('3728623');
    expect(compat).not.toContain('135500236');
    expect(compat).not.toContain('OPENSLACK_GITHUB_APP_PRIVATE_KEY =');
    expect(readFileSync(scriptPath('bot-gh-pr-create.sh'), 'utf8')).toContain(
      'bot-delivery-compat.js',
    );
    expect(readFileSync(scriptPath('bot-gh-pr-create.ps1'), 'utf8')).toContain(
      'bot-delivery-compat.js',
    );
  });

  it('generic bot wrappers route pr create before legacy gh token execution', () => {
    const bash = readFileSync(scriptPath('bot-gh.sh'), 'utf8');
    const powershell = readFileSync(scriptPath('bot-gh.ps1'), 'utf8');
    expect(bash).toContain('exec node "${repo_root}/scripts/bot-delivery-compat.js"');
    expect(bash).toContain('bot-gh-command.js');
    expect(bash).not.toContain('token="$');
    expect(powershell).toContain("$GhArgs[1] -eq 'create'");
    expect(powershell).toContain('bot-gh-command.js');
    expect(powershell).not.toContain('$tokenOutput');
  });

  it('does not expose the installation token through the token script stdout', () => {
    const result = spawnSync(process.execPath, [scriptPath('bot-gh-token.js')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Direct token output is disabled');
  });

  it('rejects token-revealing or extension gh commands before loading credentials', () => {
    const result = spawnSync(process.execPath, [scriptPath('bot-gh-command.js'), 'auth', 'token'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('permits only pr edit and pr comment');
  });

  it('maps historical PR creation flags without invoking GitHub or credentials', () => {
    const require = createRequire(import.meta.url);
    const compatibility = require(scriptPath('bot-delivery-compat.js')) as {
      mapCreateArgs(args: string[]): string[];
    };

    expect(
      compatibility.mapCreateArgs([
        '--draft',
        '--title',
        'delivery title',
        '--body-file',
        'pr-body.md',
        '--base',
        'main',
        '--head',
        'agent/topic',
      ]),
    ).toEqual([
      'delivery',
      'publish',
      '--title',
      'delivery title',
      '--body-file',
      'pr-body.md',
      '--base',
      'main',
      '--branch',
      'agent/topic',
    ]);
    expect(() => compatibility.mapCreateArgs(['--unknown'])).toThrow(
      'Unsupported bot PR compatibility argument',
    );
  });
});
