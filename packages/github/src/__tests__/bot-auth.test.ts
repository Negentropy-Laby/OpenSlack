import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireBotGitHubToken,
  parseGhRepositoryArguments,
  readBotGitHubPublicConfig,
  resolveBotGitHubRepository,
  withBotGitHubInstallation,
  type BotGitHubPublicConfig,
} from '../bot-auth.js';
import { parseGitHubRepoSpec } from '../client.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const roots: string[] = [];
const PUBLIC_CONFIG: BotGitHubPublicConfig = {
  schema: 'openslack.github_app_public.v1',
  appId: '123',
  appSlug: 'Test-App',
  repository: 'Canonical-Owner/canonical-repo',
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('package-owned bot GitHub authentication', () => {
  it('accepts semantically valid public config independent of indentation and EOL', () => {
    const root = temporaryRoot();
    const path = join(root, 'public.json');
    writeFileSync(path, `${JSON.stringify(PUBLIC_CONFIG)}\r\n`);
    expect(readBotGitHubPublicConfig(path)).toEqual(PUBLIC_CONFIG);

    writeFileSync(path, JSON.stringify({ ...PUBLIC_CONFIG, installationId: '456' }));
    expect(() => readBotGitHubPublicConfig(path)).toThrowError(
      expect.objectContaining({ code: 'BOT_APP_CONFIG_INVALID' }),
    );
  });

  it.each([
    'https://github.com/Owner/Repo.git/',
    'https://user@github.com/Owner/Repo.git',
    'git@github.com:Owner/Repo.git',
    'ssh://git@ssh.github.com:443/Owner/Repo.git',
  ])('parses supported GitHub origin form %s', (origin) => {
    expect(parseGitHubRepoSpec(origin)).toEqual({ owner: 'Owner', repo: 'Repo' });
  });

  it.each([
    'http://github.com/Owner/Repo.git',
    'https://example.com/Owner/Repo.git',
    'ssh://git@ssh.github.com:22/Owner/Repo.git',
  ])('rejects unsupported Git origin form %s', (origin) => {
    expect(parseGitHubRepoSpec(origin)).toBeNull();
  });

  it('parses gh repository options without treating option values as selectors', () => {
    expect(
      parseGhRepositoryArguments([
        'pr',
        'comment',
        '42',
        '--body',
        '--repo=body-owner/body-repo',
        '-R',
        'Target-Owner/target-repo',
      ]),
    ).toBe('Target-Owner/target-repo');
    expect(
      parseGhRepositoryArguments([
        'pr',
        'edit',
        '42',
        '--body=--repo=body-owner/body-repo',
        '-RTarget-Owner/target-repo',
      ]),
    ).toBe('Target-Owner/target-repo');
    expect(parseGhRepositoryArguments(['issue', 'edit', 'Target-Owner/target-repo#42'])).toBe(
      'Target-Owner/target-repo',
    );
    expect(
      parseGhRepositoryArguments([
        'pr',
        'comment',
        '42',
        '--',
        '--repo=ignored-owner/ignored-repo',
      ]),
    ).toBeNull();
  });

  it('rejects duplicate gh targets instead of guessing precedence', () => {
    expect(() =>
      parseGhRepositoryArguments(['pr', 'edit', '42', '--repo', 'one/repo', '-Rtwo/repo']),
    ).toThrowError(expect.objectContaining({ code: 'BOT_REPOSITORY_AMBIGUOUS' }));
  });

  it('uses explicit and GH_REPO targets before complete product environment', () => {
    const root = temporaryRoot();
    expect(
      resolveBotGitHubRepository({
        repoRoot: root,
        cwd: root,
        explicitRepository: 'explicit-owner/explicit-repo',
        env: {
          GH_REPO: 'gh-owner/gh-repo',
          GITHUB_OWNER: 'env-owner',
          GITHUB_REPO: 'env-repo',
        },
        gitOrigin: null,
      }),
    ).toMatchObject({ fullName: 'explicit-owner/explicit-repo', source: 'explicit' });
    expect(
      resolveBotGitHubRepository({
        repoRoot: root,
        cwd: root,
        useGhRepoEnvironment: true,
        env: {
          GH_REPO: 'gh-owner/gh-repo',
          GITHUB_OWNER: 'env-owner',
          GITHUB_REPO: 'env-repo',
        },
        gitOrigin: null,
      }),
    ).toMatchObject({ fullName: 'gh-owner/gh-repo', source: 'gh_repo' });
  });

  it('fails closed on a present invalid origin and outside an unbound workspace', () => {
    const root = temporaryRoot();
    expect(() =>
      resolveBotGitHubRepository({ repoRoot: root, cwd: root, env: {}, gitOrigin: 'not-a-url' }),
    ).toThrowError(expect.objectContaining({ code: 'BOT_GIT_ORIGIN_INVALID' }));
    expect(() =>
      resolveBotGitHubRepository({
        repoRoot: join(root, 'different-repository'),
        cwd: root,
        env: {},
        gitOrigin: null,
      }),
    ).toThrowError(expect.objectContaining({ code: 'BOT_REPOSITORY_REQUIRED' }));
  });

  it('selects a fork workspace canonical target only when public identity agrees', () => {
    const root = temporaryWorkspace('Canonical-Owner', 'canonical-repo');
    const diagnostics: string[] = [];
    expect(
      resolveBotGitHubRepository({
        repoRoot: root,
        cwd: root,
        env: {},
        gitOrigin: 'https://github.com/Fork-Owner/canonical-repo.git',
        publicConfig: PUBLIC_CONFIG,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      }),
    ).toMatchObject({
      fullName: 'Canonical-Owner/canonical-repo',
      source: 'workspace_canonical',
    });
    expect(diagnostics).toEqual(['BOT_FORK_CANONICAL_TARGET']);

    expect(() =>
      resolveBotGitHubRepository({
        repoRoot: root,
        cwd: root,
        env: {},
        gitOrigin: 'https://github.com/Fork-Owner/canonical-repo.git',
        publicConfig: { ...PUBLIC_CONFIG, repository: 'Another-Owner/another-repo' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'BOT_WORKSPACE_CONFIG_INVALID' }));
  });

  it('verifies the exact repository installation and treats the configured ID as a hint', async () => {
    const diagnostics: string[] = [];
    const resolveInstallation = vi.fn(async () => ({
      id: '222',
      account: 'Target-Owner',
      repositorySelection: 'selected' as const,
    }));
    const result = await withBotGitHubInstallation(
      {
        explicitRepository: 'Target-Owner/target-repo',
        env: {
          OPENSLACK_GITHUB_APP_ID: '123',
          OPENSLACK_GITHUB_APP_INSTALLATION_ID: '111',
          OPENSLACK_GITHUB_APP_SLUG: 'Test-App',
          OPENSLACK_GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
        },
        resolveInstallation,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      },
      ({ privateKey: _privateKey, ...context }) => context,
    );
    expect(resolveInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'Target-Owner', repo: 'target-repo' }),
    );
    expect(result).toMatchObject({ installationId: '222', installationHintReplaced: true });
    expect(diagnostics).toEqual(['BOT_INSTALLATION_HINT_REPLACED']);
  });

  it('uses the default PEM when the inline key is blank and does not eagerly read public config', async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, '.openslack.local'), { recursive: true });
    writeFileSync(join(root, '.openslack.local', 'github-app.pem'), PRIVATE_KEY);
    const resolveInstallation = vi.fn(async () => ({
      id: '456',
      account: 'Target-Owner',
      repositorySelection: 'selected' as const,
    }));
    await expect(
      withBotGitHubInstallation(
        {
          repoRoot: root,
          publicConfigPath: join(root, 'missing-public.json'),
          explicitRepository: 'Target-Owner/target-repo',
          publicConfig: PUBLIC_CONFIG,
          env: { OPENSLACK_GITHUB_APP_PRIVATE_KEY: '   ' },
          resolveInstallation,
        },
        (context) => context.installationId,
      ),
    ).resolves.toBe('456');

    const sharedLocalState = join(root, 'primary-local-state');
    mkdirSync(sharedLocalState, { recursive: true });
    writeFileSync(join(sharedLocalState, 'github-app.pem'), PRIVATE_KEY);
    await expect(
      withBotGitHubInstallation(
        {
          repoRoot: root,
          localStateRoot: sharedLocalState,
          explicitRepository: 'Target-Owner/target-repo',
          publicConfig: PUBLIC_CONFIG,
          env: { OPENSLACK_GITHUB_APP_PRIVATE_KEY: '   ' },
          resolveInstallation,
        },
        (context) => context.installationId,
      ),
    ).resolves.toBe('456');

    await expect(
      withBotGitHubInstallation(
        {
          explicitRepository: 'Target-Owner/target-repo',
          publicConfigPath: join(root, 'missing-public.json'),
          env: {
            OPENSLACK_GITHUB_APP_ID: '123',
            OPENSLACK_GITHUB_APP_SLUG: 'Test-App',
            OPENSLACK_GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
          },
          resolveInstallation,
        },
        (context) => context.installationId,
      ),
    ).resolves.toBe('456');

    await expect(
      withBotGitHubInstallation(
        {
          explicitRepository: 'Target-Owner/target-repo',
          publicConfigPath: join(root, 'missing-public.json'),
          env: {},
          localConfig: {
            schema: 'openslack.github_app_local.v1',
            appId: '123',
            appSlug: 'Test-App',
            installationId: '456',
            privateKeyRef: 'keychain:openslack/test-app',
          },
          credentialStore: {
            withSecret: (_reference, consumer) => consumer(PRIVATE_KEY),
          },
          resolveInstallation,
        },
        (context) => context.forwardPrivateKey,
      ),
    ).resolves.toBe(false);
  });

  it('mints a token only after exact repository discovery', async () => {
    const order: string[] = [];
    const token = await acquireBotGitHubToken({
      explicitRepository: 'Target-Owner/target-repo',
      env: {
        OPENSLACK_GITHUB_APP_ID: '123',
        OPENSLACK_GITHUB_APP_INSTALLATION_ID: '111',
        OPENSLACK_GITHUB_APP_SLUG: 'Test-App',
        OPENSLACK_GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
      },
      resolveInstallation: async () => {
        order.push('installation');
        return { id: '222', account: 'Target-Owner', repositorySelection: 'selected' };
      },
      requestToken: async ({ env }) => {
        order.push('token');
        expect(env.OPENSLACK_GITHUB_APP_INSTALLATION_ID).toBe('222');
        return {
          token: 'token-canary',
          expiresAt: '2030-01-01T00:00:00.000Z',
          tokenType: 'installation',
          appId: '123',
          installationId: '222',
          appSlug: 'Test-App',
          permissions: { contents: 'write' },
          installationHintReplaced: false,
        };
      },
    });
    expect(order).toEqual(['installation', 'token']);
    expect(token).toMatchObject({ value: 'token-canary', repository: 'Target-Owner/target-repo' });
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-bot-auth-'));
  roots.push(root);
  return root;
}

function temporaryWorkspace(owner: string, repo: string): string {
  const root = temporaryRoot();
  writeFileSync(
    join(root, 'openslack.yaml'),
    `schema: openslack.workspace.v1\ncanonical_remote:\n  provider: github\n  owner: ${owner}\n  repo: ${repo}\n  default_branch: main\n`,
  );
  return root;
}
