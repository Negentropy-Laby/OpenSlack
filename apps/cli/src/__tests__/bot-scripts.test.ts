import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  readBotGitHubPublicConfig,
  resolveBotGitHubRepository,
} from '../../../../packages/github/src/bot-auth.js';

const repoRoot = resolve(process.cwd());
const forbiddenInstallationId = ['135', '500', '236'].join('');

interface BotTokenModule {
  loadBotAuth(): Promise<Record<string, unknown>>;
}

function tokenModule(): BotTokenModule {
  const require = createRequire(import.meta.url);
  return require(scriptPath('bot-gh-token.js')) as BotTokenModule;
}

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
    expect(tokenScript).toContain("require('tsx/esm/api')");
    expect(tokenScript).toContain("'packages', 'github', 'src', 'bot-auth.ts'");
    expect(tokenScript).not.toMatch(/createSign|node:https|app\/installations\?/u);
    expect(tokenScript).not.toContain('3728623');
    expect(tokenScript).not.toContain(forbiddenInstallationId);
  });

  it('loads the package-owned implementation through a cwd-independent bridge', async () => {
    const token = tokenModule();
    await expect(token.loadBotAuth()).resolves.toMatchObject({
      acquireBotGitHubToken: expect.any(Function),
      resolveBotGitHubRepository: expect.any(Function),
    });
  });

  it('reads only the closed public GitHub App identity shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-bot-public-'));
    const path = join(root, 'github-app-public.json');
    const value = {
      schema: 'openslack.github_app_public.v1',
      appId: '123',
      appSlug: 'test-app',
      repository: 'Public-Owner/public-repo',
    };
    try {
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      expect(readBotGitHubPublicConfig(path)).toEqual(value);

      writeFileSync(path, `${JSON.stringify({ ...value, installationId: '456' }, null, 2)}\n`);
      expect(() => readBotGitHubPublicConfig(path)).toThrow('configuration is invalid');

      writeFileSync(
        path,
        '{"schema":"openslack.github_app_public.v1","appId":"123","appId":"456","appSlug":"test-app","repository":"Public-Owner/public-repo"}\n',
      );
      expect(() => readBotGitHubPublicConfig(path)).toThrow('configuration is invalid');

      if (process.platform !== 'win32') {
        const target = join(root, 'target.json');
        writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
        rmSync(path);
        symlinkSync(target, path, 'file');
        expect(() => readBotGitHubPublicConfig(path)).toThrow('configuration');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves repository precedence as explicit, complete env, verified origin, then public', async () => {
    const publicConfig = {
      schema: 'openslack.github_app_public.v1' as const,
      appId: '123',
      appSlug: 'test-app',
      repository: 'public-owner/public-repo',
    };
    expect(
      resolveBotGitHubRepository({
        ghArgs: ['pr', 'comment', '1', '--repo', 'explicit-owner/explicit-repo'],
        env: { GITHUB_OWNER: 'env-owner', GITHUB_REPO: 'env-repo' },
        gitOrigin: 'https://github.com/origin-owner/origin-repo.git',
        publicConfig,
      }),
    ).toMatchObject({ fullName: 'explicit-owner/explicit-repo', source: 'explicit' });
    expect(
      resolveBotGitHubRepository({
        env: { GITHUB_OWNER: 'env-owner', GITHUB_REPO: 'env-repo' },
        gitOrigin: 'https://github.com/origin-owner/origin-repo.git',
        publicConfig,
      }),
    ).toMatchObject({ fullName: 'env-owner/env-repo', source: 'environment' });
    expect(
      resolveBotGitHubRepository({
        env: {},
        cwd: tmpdir(),
        gitOrigin: 'git@github.com:origin-owner/origin-repo.git',
        publicConfig,
      }),
    ).toMatchObject({ fullName: 'origin-owner/origin-repo', source: 'git_origin' });
    const publicRoot = mkdtempSync(join(tmpdir(), 'openslack-public-target-'));
    try {
      expect(
        resolveBotGitHubRepository({
          repoRoot: publicRoot,
          cwd: publicRoot,
          env: {},
          gitOrigin: null,
          publicConfig,
        }),
      ).toMatchObject({ fullName: 'public-owner/public-repo', source: 'public_config' });
    } finally {
      rmSync(publicRoot, { recursive: true, force: true });
    }
    expect(() =>
      resolveBotGitHubRepository({
        env: { GITHUB_OWNER: 'partial-owner' },
        gitOrigin: null,
        publicConfig,
      }),
    ).toThrow('must be configured together');
  });

  it('keeps repository installation discovery out of the bridge implementation', () => {
    const source = readFileSync(scriptPath('bot-gh-token.js'), 'utf8');
    expect(source).not.toContain('/app/installations');
    expect(source).not.toContain('selectInstallationForOwner');
  });

  it('uses a dedicated installation-list entry point with a stable envelope', () => {
    const powershell = readFileSync(scriptPath('openslack-bot.ps1'), 'utf8');
    const listScript = readFileSync(scriptPath('bot-list-installations.js'), 'utf8');
    expect(powershell).toContain('bot-list-installations.js');
    expect(powershell).toContain('openslack.github_app_installation_list.v1');
    expect(listScript).toContain('installations');
    expect(listScript).not.toContain('process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID');
  });

  it('passes grammar-aware target inputs into the shared token resolver', async () => {
    const wrapper = (await tokenModule().loadBotAuth()) as {
      parseGhRepositoryArguments(args: string[]): string | null;
    };
    expect(wrapper.parseGhRepositoryArguments(['pr', 'edit', '1', '-Rowner/repo'])).toBe(
      'owner/repo',
    );
    expect(
      wrapper.parseGhRepositoryArguments(['pr', 'comment', '1', '--body', '--repo=body/value']),
    ).toBeNull();
  });

  it('PR creation wrappers delegate to the package-backed delivery path', () => {
    const compat = readFileSync(scriptPath('bot-delivery-compat.js'), 'utf8');
    expect(compat).toContain("['delivery', 'publish']");
    expect(compat).toContain('withConfiguredBotInstallation');
    expect(compat).toContain('mappedRepository');
    expect(compat).toContain('openSlackInvocation');
    expect(compat).not.toContain('3728623');
    expect(compat).not.toContain(forbiddenInstallationId);
    expect(compat).not.toContain('OPENSLACK_GITHUB_APP_PRIVATE_KEY =');
    expect(compat).not.toContain('{ ...process.env }');
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

  it('shares public identity and discovery without env-file loading or PowerShell defaults', () => {
    const publicConfigPath = resolve(
      repoRoot,
      '.openslack',
      'integrations',
      'github-app-public.json',
    );
    const publicConfigBytes = readFileSync(publicConfigPath, 'utf8');
    const publicConfig = JSON.parse(publicConfigBytes) as Record<string, unknown>;
    expect(publicConfig).toEqual({
      schema: 'openslack.github_app_public.v1',
      appId: '3728623',
      appSlug: 'openslack-agent-operator',
      repository: 'Negentropy-Laby/OpenSlack',
    });
    expect(publicConfig).not.toHaveProperty('installationId');
    expect(publicConfig).not.toHaveProperty('token');
    expect(publicConfig).not.toHaveProperty('privateKeyPath');
    expect(publicConfigBytes).toBe(`${JSON.stringify(publicConfig, null, 2)}\n`);

    const powershell = readFileSync(scriptPath('openslack-bot.ps1'), 'utf8');
    const gate = readFileSync(scriptPath('openslack-pr-gate.ps1'), 'utf8');
    const launcher = readFileSync(scriptPath('bot-openslack-command.js'), 'utf8');
    for (const source of [powershell, gate]) {
      expect(source).not.toContain('3728623');
      expect(source).not.toContain("else { 'Negentropy-Laby' }");
      expect(source).not.toContain('Get-Content -Raw');
      expect(source).not.toContain('createSign');
    }
    expect(launcher).toContain('withConfiguredBotLaunchIdentity');
    expect(launcher).not.toContain('OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN');
    const require = createRequire(import.meta.url);
    const openSlackLauncher = require(scriptPath('bot-openslack-command.js')) as {
      createChildEnvironment(
        credentials: Record<string, unknown>,
        parent?: Record<string, string>,
      ): Record<string, string>;
    };
    const child = openSlackLauncher.createChildEnvironment(
      {
        appId: '123',
        appSlug: 'test-app',
        installationId: '456',
        owner: 'target-owner',
        repo: 'target-repo',
        privateKey: 'private-key-canary',
        forwardPrivateKey: true,
      },
      {
        PATH: 'path-canary',
        OPENSLACK_LLM_ENDPOINT: 'llm-canary',
        GITHUB_TOKEN: 'human-token-canary',
      },
    );
    expect(child).toMatchObject({
      OPENSLACK_GITHUB_AUTH_MODE: 'app',
      OPENSLACK_GITHUB_APP_ID: '123',
      OPENSLACK_GITHUB_APP_INSTALLATION_ID: '456',
      OPENSLACK_GITHUB_APP_PRIVATE_KEY: 'private-key-canary',
      OPENSLACK_LLM_ENDPOINT: 'llm-canary',
      GITHUB_OWNER: 'target-owner',
      GITHUB_REPO: 'target-repo',
    });
    expect(child).not.toHaveProperty('GITHUB_TOKEN');
    expect(child).not.toHaveProperty('GH_TOKEN');
    expect(child).not.toHaveProperty('OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN');
    const keychainChild = openSlackLauncher.createChildEnvironment(
      {
        appId: '123',
        appSlug: 'test-app',
        installationId: '456',
        owner: 'target-owner',
        repo: 'target-repo',
        privateKey: 'private-key-canary',
        forwardPrivateKey: false,
      },
      {
        OPENSLACK_GITHUB_APP_ID: 'stale-app-id',
        OPENSLACK_GITHUB_APP_PRIVATE_KEY: 'stale-key',
      },
    );
    expect(keychainChild).not.toHaveProperty('OPENSLACK_GITHUB_AUTH_MODE');
    expect(keychainChild).not.toHaveProperty('OPENSLACK_GITHUB_APP_ID');
    expect(keychainChild).not.toHaveProperty('OPENSLACK_GITHUB_APP_INSTALLATION_ID');
    expect(keychainChild).not.toHaveProperty('OPENSLACK_GITHUB_APP_PRIVATE_KEY');
    expect(keychainChild).toMatchObject({
      GITHUB_OWNER: 'target-owner',
      GITHUB_REPO: 'target-repo',
    });
    expect(readFileSync(scriptPath('bot-gh-token.js'), 'utf8')).not.toMatch(
      /(?:source\s+[^\n]*\.env|dotenv|github-app\.env)/u,
    );

    for (const path of [
      scriptPath('bot-gh-token.js'),
      scriptPath('bot-openslack-command.js'),
      scriptPath('bot-delivery-compat.js'),
      resolve(repoRoot, 'packages', 'github', 'src', 'bot-auth.ts'),
    ]) {
      expect(readFileSync(path, 'utf8')).not.toContain(forbiddenInstallationId);
    }
  });

  it('leaves typed OpenSlack repository arguments to the product launcher', async () => {
    const require = createRequire(import.meta.url);
    const launcher = require(scriptPath('bot-openslack-command.js')) as {
      main(args: string[], dependencies: Record<string, unknown>): Promise<number>;
    };
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const withIdentity = async (
      _options: unknown,
      consumer: (identity: Record<string, unknown>) => number,
    ) =>
      consumer({
        appId: '123',
        appSlug: 'test-app',
        installationId: null,
        privateKey: 'private-key-canary',
        forwardPrivateKey: true,
      });
    const spawn = (_command: string, args: string[], options: { env: Record<string, string> }) => {
      calls.push({ args, env: options.env });
      return { status: 0 };
    };
    await expect(
      launcher.main(['setup', 'github'], { withIdentity, spawn, env: {} }),
    ).resolves.toBe(0);
    await expect(
      launcher.main(['github', 'watch', 'once', '--repo', 'OpenSlack'], {
        withIdentity,
        spawn,
        env: {},
      }),
    ).resolves.toBe(0);
    expect(calls[0].args.slice(-2)).toEqual(['setup', 'github']);
    expect(calls[1].args.slice(-5)).toEqual(['github', 'watch', 'once', '--repo', 'OpenSlack']);
    expect(calls[1].env).not.toHaveProperty('GITHUB_OWNER');
    expect(calls[1].env).not.toHaveProperty('GITHUB_REPO');
    expect(calls[1].env).not.toHaveProperty('OPENSLACK_GITHUB_APP_INSTALLATION_ID');
  });

  it('does not expose the installation token through the token script stdout', () => {
    const result = spawnSync(process.execPath, [scriptPath('bot-gh-token.js')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Direct token output is disabled');
  });

  it.each([
    { installations: [] },
    { installations: [{ id: '1', account: 'one', repositorySelection: 'all' }] },
    {
      installations: [
        { id: '1', account: 'one', repositorySelection: 'all' },
        { id: '2', account: 'two', repositorySelection: 'selected' },
      ],
    },
  ])('emits a stable installation-list envelope', async ({ installations }) => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const require = createRequire(import.meta.url);
    const list = require(scriptPath('bot-list-installations.js')) as {
      main(dependencies: Record<string, unknown>): Promise<number>;
    };
    await expect(list.main({ list: async () => installations })).resolves.toBe(0);
    stdout.mockRestore();
    expect(JSON.parse(writes.join(''))).toEqual({
      schema: 'openslack.github_app_installation_list.v1',
      installations,
    });
  });

  it.runIf(process.platform === 'win32')(
    'renders zero, one, and multiple installations in Windows PowerShell 5.1 and pwsh 7',
    () => {
      const shells = ['powershell'];
      if (spawnSync('where.exe', ['pwsh'], { encoding: 'utf8' }).status === 0) shells.push('pwsh');
      for (const shell of shells) {
        for (const installations of [
          [],
          [{ id: '1', account: 'one', repositorySelection: 'all' }],
          [
            { id: '1', account: 'one', repositorySelection: 'all' },
            { id: '2', account: 'two', repositorySelection: 'selected' },
          ],
        ]) {
          const root = mkdtempSync(join(tmpdir(), 'openslack-node-shim-'));
          try {
            const envelope = JSON.stringify({
              schema: 'openslack.github_app_installation_list.v1',
              installations,
            });
            writeFileSync(
              join(root, 'node.cmd'),
              '@echo off\r\necho ' + envelope + '\r\nexit /b 0\r\n',
            );
            const result = spawnSync(
              shell,
              [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptPath('openslack-bot.ps1'),
                '-ListInstallations',
              ],
              {
                encoding: 'utf8',
                env: { ...process.env, PATH: root + ';' + (process.env.PATH ?? '') },
              },
            );
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout.split(/\r?\n/u).filter(Boolean)).toHaveLength(
              installations.length,
            );
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    },
  );

  it('rejects token-revealing or extension gh commands before loading credentials', () => {
    const result = spawnSync(process.execPath, [scriptPath('bot-gh-command.js'), 'auth', 'token'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('BOT_GH_COMMAND_FORBIDDEN');
  });

  it('allows the non-secret PR lifecycle commands needed after publication', () => {
    const require = createRequire(import.meta.url);
    const wrapper = require(scriptPath('bot-gh-command.js')) as {
      isAllowedCommand(args: string[]): boolean;
    };
    expect(wrapper.isAllowedCommand(['pr', 'edit', '183'])).toBe(true);
    expect(wrapper.isAllowedCommand(['pr', 'comment', '183'])).toBe(true);
    expect(wrapper.isAllowedCommand(['pr', 'ready', '183'])).toBe(true);
    expect(wrapper.isAllowedCommand(['issue', 'edit', '369'])).toBe(true);
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
      '--branch',
      'agent/topic',
    ]);
    expect(() =>
      compatibility.mapCreateArgs(['--base', 'release/0.3', '--head', 'agent/topic']),
    ).toThrow('DELIVERY_BASE_FORBIDDEN');
    expect(() => compatibility.mapCreateArgs(['--unknown'])).toThrow(
      'Unsupported bot PR compatibility argument',
    );
  });
});
