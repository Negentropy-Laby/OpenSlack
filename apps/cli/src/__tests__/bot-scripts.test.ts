import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());
const forbiddenInstallationId = ['135', '500', '236'].join('');

interface Installation {
  id: string;
  account: string;
  repositorySelection: 'all' | 'selected';
}

interface BotTokenModule {
  acquireConfiguredInstallationCredentials(options: Record<string, unknown>): Promise<{
    appId: string;
    appSlug: string;
    installationId: string;
    owner: string;
    repo: string;
    repository: string;
    value: string;
  }>;
  listGitHubAppInstallations(options: Record<string, unknown>): Promise<readonly Installation[]>;
  parseInstallationTokenResponse(
    data: unknown,
    installationId: string,
    now?: number,
  ): { value: string; expiresAt: string; installationId: string };
  readPublicConfig(path?: string): {
    schema: string;
    appId: string;
    appSlug: string;
    repository: string;
  };
  resolveAppIdentity(options: Record<string, unknown>): {
    appId: string;
    appSlug: string;
    installationHint: string | null;
  };
  resolveTargetRepository(options: Record<string, unknown>): {
    owner: string;
    repo: string;
    fullName: string;
    source: string;
  };
  selectInstallationForOwner(
    installations: readonly Installation[],
    owner: string,
    hint?: string | null,
  ): Installation & { replacedHint: boolean };
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
    expect(tokenScript).toContain('.openslack.local');
    expect(tokenScript).toContain('github-app.json');
    expect(tokenScript).toContain('github-app-public.json');
    expect(tokenScript).toContain('acquireConfiguredInstallationToken');
    expect(tokenScript).not.toContain('3728623');
    expect(tokenScript).not.toContain(forbiddenInstallationId);
    expect(tokenScript).not.toContain('50 * 60 * 1000');
  });

  it('requires a valid endpoint-provided installation token expiry', () => {
    const token = tokenModule();
    const expiresAt = '2030-01-01T00:00:00.000Z';
    expect(
      token.parseInstallationTokenResponse(
        { token: 'token-canary', expires_at: expiresAt },
        '456',
        Date.parse('2029-01-01T00:00:00.000Z'),
      ),
    ).toMatchObject({ value: 'token-canary', expiresAt, installationId: '456' });
    expect(() => token.parseInstallationTokenResponse({ token: 'token-canary' }, '456')).toThrow(
      'response was invalid',
    );
    expect(() =>
      token.parseInstallationTokenResponse(
        { token: 'token-canary', expires_at: '2020-01-01T00:00:00.000Z' },
        '456',
        Date.parse('2029-01-01T00:00:00.000Z'),
      ),
    ).toThrow('expiry was invalid');
  });

  it('reads only the exact canonical public GitHub App identity shape', () => {
    const token = tokenModule();
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
      expect(token.readPublicConfig(path)).toEqual(value);

      writeFileSync(path, `${JSON.stringify({ ...value, installationId: '456' }, null, 2)}\n`);
      expect(() => token.readPublicConfig(path)).toThrow('configuration is invalid');

      writeFileSync(
        path,
        '{"schema":"openslack.github_app_public.v1","appId":"123","appId":"456","appSlug":"test-app","repository":"Public-Owner/public-repo"}\n',
      );
      expect(() => token.readPublicConfig(path)).toThrow('configuration is not canonical');

      if (process.platform !== 'win32') {
        const target = join(root, 'target.json');
        writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
        rmSync(path);
        symlinkSync(target, path, 'file');
        expect(() => token.readPublicConfig(path)).toThrow('configuration');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves repository precedence as explicit, complete env, verified origin, then public', () => {
    const token = tokenModule();
    const publicConfig = {
      schema: 'openslack.github_app_public.v1',
      appId: '123',
      appSlug: 'test-app',
      repository: 'public-owner/public-repo',
    };
    expect(
      token.resolveTargetRepository({
        args: ['pr', 'comment', '1', '--repo', 'explicit-owner/explicit-repo'],
        env: { GITHUB_OWNER: 'env-owner', GITHUB_REPO: 'env-repo' },
        gitOrigin: 'https://github.com/origin-owner/origin-repo.git',
        publicConfig,
      }),
    ).toMatchObject({ fullName: 'explicit-owner/explicit-repo', source: 'explicit' });
    expect(
      token.resolveTargetRepository({
        args: [],
        env: { GITHUB_OWNER: 'env-owner', GITHUB_REPO: 'env-repo' },
        gitOrigin: 'https://github.com/origin-owner/origin-repo.git',
        publicConfig,
      }),
    ).toMatchObject({ fullName: 'env-owner/env-repo', source: 'environment' });
    expect(
      token.resolveTargetRepository({
        args: [],
        env: {},
        gitOrigin: 'git@github.com:origin-owner/origin-repo.git',
        publicConfig,
      }),
    ).toMatchObject({ fullName: 'origin-owner/origin-repo', source: 'git_origin' });
    expect(
      token.resolveTargetRepository({ args: [], env: {}, gitOrigin: null, publicConfig }),
    ).toMatchObject({ fullName: 'public-owner/public-repo', source: 'public_config' });
    expect(() =>
      token.resolveTargetRepository({
        args: [],
        env: { GITHUB_OWNER: 'partial-owner' },
        gitOrigin: null,
        publicConfig,
      }),
    ).toThrow('must be configured together');
  });

  it('selects exactly one owner installation and treats any configured id as a hint', () => {
    const token = tokenModule();
    const installations: Installation[] = [
      { id: '111', account: 'another-owner', repositorySelection: 'all' },
      { id: '222', account: 'Target-Owner', repositorySelection: 'selected' },
    ];
    expect(token.selectInstallationForOwner(installations, 'target-owner', '111')).toMatchObject({
      id: '222',
      replacedHint: true,
    });
    expect(token.selectInstallationForOwner(installations, 'TARGET-OWNER')).toMatchObject({
      id: '222',
      replacedHint: false,
    });
    expect(() => token.selectInstallationForOwner(installations, 'missing-owner', '111')).toThrow(
      'No GitHub App installation matches',
    );
    expect(() =>
      token.selectInstallationForOwner(
        [...installations, { id: '333', account: 'target-owner', repositorySelection: 'all' }],
        'target-owner',
      ),
    ).toThrow('Multiple GitHub App installations match');
  });

  it('discovers bounded installation pages without numeric or response-body downgrade', async () => {
    const token = tokenModule();
    const pages: number[] = [];
    const timeouts: number[] = [];
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { login: `owner-${index}` },
      repository_selection: 'selected',
    }));
    const installations = await token.listGitHubAppInstallations({
      appId: '123',
      privateKey: 'not-used',
      bearer: 'jwt-canary',
      requestPage: ({ page, timeoutMs }: { page: number; timeoutMs: number }) => {
        pages.push(page);
        timeouts.push(timeoutMs);
        return page === 1
          ? first
          : [{ id: 101, account: { login: 'target-owner' }, repository_selection: 'all' }];
      },
    });
    expect(pages).toEqual([1, 2]);
    expect(timeouts).toEqual([15_000, 15_000]);
    expect(installations).toHaveLength(101);
    expect(installations.at(-1)).toEqual({
      id: '101',
      account: 'target-owner',
      repositorySelection: 'all',
    });

    await expect(
      token.listGitHubAppInstallations({
        appId: '123',
        privateKey: 'not-used',
        bearer: 'jwt-canary',
        requestPage: () => {
          throw new Error('sensitive-response-canary');
        },
      }),
    ).rejects.toThrow('installations could not be discovered');
    await expect(
      token.listGitHubAppInstallations({
        appId: '123',
        privateKey: 'not-used',
        bearer: 'jwt-canary',
        requestPage: () => [
          { id: 'unsafe-number', account: { login: 'owner' }, repository_selection: 'all' },
        ],
      }),
    ).rejects.toThrow('installation response is invalid');

    const boundedPages: number[] = [];
    await expect(
      token.listGitHubAppInstallations({
        appId: '123',
        privateKey: 'not-used',
        bearer: 'jwt-canary',
        requestPage: ({ page }: { page: number }) => {
          boundedPages.push(page);
          return Array.from({ length: 100 }, (_, index) => ({
            id: page * 1000 + index + 1,
            account: { login: `page-${page}-owner-${index}` },
            repository_selection: 'selected',
          }));
        },
      }),
    ).rejects.toThrow('pagination exceeded its limit');
    expect(boundedPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const clock = [0, 0, 30_000];
    await expect(
      token.listGitHubAppInstallations({
        appId: '123',
        privateKey: 'not-used',
        bearer: 'jwt-canary',
        now: () => clock.shift() ?? 30_000,
        requestPage: () => first,
      }),
    ).rejects.toThrow('installation discovery timed out');
  });

  it('uses env identity over local/public metadata but replaces a stale installation hint', async () => {
    const token = tokenModule();
    const publicConfig = {
      schema: 'openslack.github_app_public.v1',
      appId: '123',
      appSlug: 'public-app',
      repository: 'target-owner/target-repo',
    };
    expect(
      token.resolveAppIdentity({
        env: {},
        localConfig: { appId: '456', installationId: '444', appSlug: 'local-app' },
        publicConfig,
      }),
    ).toEqual({ appId: '456', appSlug: 'local-app', installationHint: '444' });
    const credentials = await token.acquireConfiguredInstallationCredentials({
      args: [],
      env: {
        OPENSLACK_GITHUB_APP_ID: '789',
        OPENSLACK_GITHUB_APP_INSTALLATION_ID: '111',
        OPENSLACK_GITHUB_APP_SLUG: 'env-app',
      },
      localConfig: { appId: '456', installationId: '444', appSlug: 'local-app' },
      publicConfig,
      gitOrigin: null,
      privateKey: 'not-used',
      bearer: 'jwt-canary',
      requestPage: () => [
        { id: 222, account: { login: 'TARGET-OWNER' }, repository_selection: 'selected' },
      ],
      getInstallationToken: async (_appId: string, installationId: string) => ({
        value: 'installation-token-canary',
        expiresAt: '2030-01-01T00:00:00.000Z',
        installationId,
        permissions: {},
      }),
    });
    expect(credentials).toMatchObject({
      appId: '789',
      appSlug: 'env-app',
      installationId: '222',
      repository: 'target-owner/target-repo',
      value: 'installation-token-canary',
    });
  });

  it('PR creation wrappers delegate to the package-backed delivery path', () => {
    const compat = readFileSync(scriptPath('bot-delivery-compat.js'), 'utf8');
    expect(compat).toContain("['delivery', 'publish']");
    expect(compat).toContain('cwd: process.cwd()');
    expect(compat).not.toContain('3728623');
    expect(compat).not.toContain(forbiddenInstallationId);
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

  it('shares public identity and discovery without env-file loading or PowerShell defaults', () => {
    const publicConfig = JSON.parse(
      readFileSync(
        resolve(repoRoot, '.openslack', 'integrations', 'github-app-public.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(publicConfig).toEqual({
      schema: 'openslack.github_app_public.v1',
      appId: '3728623',
      appSlug: 'openslack-agent-operator',
      repository: 'Negentropy-Laby/OpenSlack',
    });
    expect(publicConfig).not.toHaveProperty('installationId');
    expect(publicConfig).not.toHaveProperty('token');
    expect(publicConfig).not.toHaveProperty('privateKeyPath');

    const powershell = readFileSync(scriptPath('openslack-bot.ps1'), 'utf8');
    const gate = readFileSync(scriptPath('openslack-pr-gate.ps1'), 'utf8');
    const launcher = readFileSync(scriptPath('bot-openslack-command.js'), 'utf8');
    for (const source of [powershell, gate]) {
      expect(source).not.toContain('3728623');
      expect(source).not.toContain("else { 'Negentropy-Laby' }");
      expect(source).not.toContain('Get-Content -Raw');
      expect(source).not.toContain('createSign');
    }
    expect(launcher).toContain('acquireConfiguredInstallationCredentials');
    expect(launcher).toContain('OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN');
    expect(launcher).not.toContain('OPENSLACK_GITHUB_APP_PRIVATE_KEY');
    const require = createRequire(import.meta.url);
    const openSlackLauncher = require(scriptPath('bot-openslack-command.js')) as {
      createChildEnvironment(credentials: Record<string, unknown>): Record<string, string>;
    };
    const child = openSlackLauncher.createChildEnvironment({
      appId: '123',
      appSlug: 'test-app',
      installationId: '456',
      owner: 'target-owner',
      repo: 'target-repo',
      value: 'installation-token-canary',
      expiresAt: '2030-01-01T00:00:00.000Z',
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    expect(child).toMatchObject({
      OPENSLACK_GITHUB_AUTH_MODE: 'app',
      OPENSLACK_GITHUB_APP_ID: '123',
      OPENSLACK_GITHUB_APP_INSTALLATION_ID: '456',
      OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN: 'installation-token-canary',
      OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT: '2030-01-01T00:00:00.000Z',
      OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS: JSON.stringify({
        contents: 'write',
        pull_requests: 'write',
      }),
      GITHUB_OWNER: 'target-owner',
      GITHUB_REPO: 'target-repo',
    });
    expect(child).not.toHaveProperty('GITHUB_TOKEN');
    expect(child).not.toHaveProperty('GH_TOKEN');
    expect(child).not.toHaveProperty('OPENSLACK_GITHUB_APP_PRIVATE_KEY');
    expect(readFileSync(scriptPath('bot-gh-token.js'), 'utf8')).not.toMatch(
      /(?:source\s+[^\n]*\.env|dotenv|github-app\.env)/u,
    );

    const forbidden = spawnSync('git', ['grep', '-n', forbiddenInstallationId, '--', '.'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(forbidden.status).toBe(1);
    expect(forbidden.stdout).toBe('');
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
    expect(result.stderr).toContain('permits only pr edit, pr comment, pr ready, and issue edit');
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
