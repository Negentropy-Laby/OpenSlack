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
    expect(tokenScript).not.toContain('50 * 60 * 1000');
  });

  it('requires a valid endpoint-provided installation token expiry', () => {
    const require = createRequire(import.meta.url);
    const tokenModule = require(scriptPath('bot-gh-token.js')) as {
      parseInstallationTokenResponse(
        data: unknown,
        installationId: string,
        now?: number,
      ): { value: string; expiresAt: string; installationId: string };
    };
    const expiresAt = '2030-01-01T00:00:00.000Z';
    expect(
      tokenModule.parseInstallationTokenResponse(
        { token: 'token-canary', expires_at: expiresAt },
        '456',
        Date.parse('2029-01-01T00:00:00.000Z'),
      ),
    ).toMatchObject({ value: 'token-canary', expiresAt, installationId: '456' });
    expect(() =>
      tokenModule.parseInstallationTokenResponse({ token: 'token-canary' }, '456'),
    ).toThrow('response was invalid');
    expect(() =>
      tokenModule.parseInstallationTokenResponse(
        { token: 'token-canary', expires_at: '2020-01-01T00:00:00.000Z' },
        '456',
        Date.parse('2029-01-01T00:00:00.000Z'),
      ),
    ).toThrow('expiry was invalid');
  });

  it('PR creation wrappers delegate to the package-backed delivery path', () => {
    const compat = readFileSync(scriptPath('bot-delivery-compat.js'), 'utf8');
    expect(compat).toContain("['delivery', 'publish']");
    expect(compat).toContain('cwd: process.cwd()');
    expect(compat).not.toContain('3728623');
    expect(compat).not.toContain('135500236');
    expect(compat).not.toContain('OPENSLACK_GITHUB_APP_PRIVATE_KEY =');
    expect(compat).not.toContain('{ ...process.env }');
    expect(compat).toContain('createChildEnvironment');
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
    expect(result.stderr).toContain('permits only pr edit, pr comment, and pr ready');
  });

  it('allows the non-secret PR lifecycle commands needed after publication', () => {
    const require = createRequire(import.meta.url);
    const wrapper = require(scriptPath('bot-gh-command.js')) as {
      isAllowedCommand(args: string[]): boolean;
    };
    expect(wrapper.isAllowedCommand(['pr', 'edit', '183'])).toBe(true);
    expect(wrapper.isAllowedCommand(['pr', 'comment', '183'])).toBe(true);
    expect(wrapper.isAllowedCommand(['pr', 'ready', '183'])).toBe(true);
    expect(wrapper.isAllowedCommand(['auth', 'token'])).toBe(false);
  });

  it('completes merged task Issues from structured claim evidence without a human token fallback', () => {
    const workflow = readFileSync(
      resolve(repoRoot, '.github', 'workflows', 'openslack-issue-done.yml'),
      'utf8',
    );
    expect(workflow).toContain('openslack-task-link');
    expect(workflow).toContain("taskLink.schema !== 'openslack.task_link.v1'");
    expect(workflow).toContain('--agent-id');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('OPENSLACK_ISSUE_NUMBER: ${{ steps.extract.outputs.issue_number }}');
    expect(workflow).toContain('OPENSLACK_AGENT_ID: ${{ steps.extract.outputs.agent_id }}');
    expect(workflow).toContain('OPENSLACK_PR_URL: ${{ github.event.pull_request.html_url }}');
    expect(workflow).toContain('--issue-number "$OPENSLACK_ISSUE_NUMBER"');
    expect(workflow).toContain('--agent-id "$OPENSLACK_AGENT_ID"');
    expect(workflow).not.toContain('--agent-id "${{ steps.extract.outputs.agent_id }}"');
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: write/);
    expect(workflow).not.toContain('OPENSLACK_GITHUB_TOKEN');
    expect(workflow).not.toContain('Issue:\\s*#?');
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
