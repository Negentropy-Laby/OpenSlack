import { createDefaultCredentialStore, type CredentialStore } from '@openslack/credentials';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { isGitHubAppSlug } from './app-slug.js';
import {
  listGitHubAppInstallations,
  resolveGitHubAppRepositoryInstallation,
  type GitHubAppInstallationSummary,
} from './app-installation-resolution.js';
import { createGitHubAppJwt, POSITIVE_GITHUB_ID_PATTERN } from './app-jwt.js';
import { readGitHubAppLocalConfig, type GitHubAppLocalConfig } from './app-local-config.js';
import {
  requireAppInstallationToken,
  type GitHubAppAuthDiagnostic,
  type GitHubAppInstallationToken,
} from './auth.js';
import {
  parseGitHubRepoSpec,
  resolveGitHubAppLocalStateRoot,
  resolveGitHubWorkspaceTarget,
} from './client.js';
import { readStableLocalUtf8 } from './stable-local-file.js';

export const BOT_GITHUB_PUBLIC_CONFIG_SCHEMA = 'openslack.github_app_public.v1';
const PUBLIC_CONFIG_MAX_BYTES = 64 * 1024;
const PRIVATE_KEY_MAX_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024;
const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface BotGitHubPublicConfig {
  schema: typeof BOT_GITHUB_PUBLIC_CONFIG_SCHEMA;
  appId: string;
  appSlug: string;
  repository: string;
}

export type BotGitHubRepositorySource =
  | 'explicit'
  | 'gh_repo'
  | 'environment'
  | 'git_origin'
  | 'workspace_canonical'
  | 'public_config';

export interface BotGitHubRepositoryTarget {
  owner: string;
  repo: string;
  fullName: string;
  source: BotGitHubRepositorySource;
}

export interface BotGitHubDiagnostic {
  code: 'BOT_INSTALLATION_HINT_REPLACED' | 'BOT_FORK_CANONICAL_TARGET';
  message: string;
}

export class BotGitHubAuthError extends Error {
  constructor(
    readonly code:
      | 'BOT_APP_CONFIG_INVALID'
      | 'BOT_APP_CONFIG_MISSING'
      | 'BOT_APP_INSTALLATION_FAILED'
      | 'BOT_APP_PRIVATE_KEY_INVALID'
      | 'BOT_GH_ARGUMENT_INVALID'
      | 'BOT_GIT_ORIGIN_INVALID'
      | 'BOT_REPOSITORY_AMBIGUOUS'
      | 'BOT_REPOSITORY_REQUIRED'
      | 'BOT_WORKSPACE_CONFIG_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'BotGitHubAuthError';
  }
}

export interface BotGitHubAuthOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  repoRoot?: string;
  localStateRoot?: string;
  publicConfigPath?: string;
  publicConfig?: BotGitHubPublicConfig;
  localConfig?: GitHubAppLocalConfig | null;
  credentialStore?: Pick<CredentialStore, 'withSecret'>;
  explicitRepository?: string;
  ghArgs?: readonly string[];
  useGhRepoEnvironment?: boolean;
  gitOrigin?: string | null;
  privateKey?: string;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: BotGitHubDiagnostic) => void;
  resolveInstallation?: typeof resolveGitHubAppRepositoryInstallation;
  requestToken?: (input: {
    env: NodeJS.ProcessEnv;
    repository: { owner: string; repo: string };
    onDiagnostic: (diagnostic: GitHubAppAuthDiagnostic) => void;
  }) => Promise<GitHubAppInstallationToken>;
}

export interface BotGitHubInstallationContext {
  appId: string;
  appSlug: string;
  installationId: string;
  installationHintReplaced: boolean;
  owner: string;
  repo: string;
  repository: string;
  repositorySource: BotGitHubRepositorySource;
  privateKey: string;
  forwardPrivateKey: boolean;
}

export interface BotGitHubLaunchIdentity {
  appId: string;
  appSlug: string;
  installationId: string | null;
  privateKey: string;
  forwardPrivateKey: boolean;
}

export interface BotGitHubTokenContext extends Omit<
  BotGitHubInstallationContext,
  'privateKey' | 'forwardPrivateKey'
> {
  value: string;
  expiresAt: string;
  permissions: Record<string, string>;
}

interface BotGitHubIdentitySource {
  appId: string;
  appSlug: string;
  installationHint: string | null;
  forwardPrivateKey: boolean;
  withPrivateKey<T>(consumer: (privateKey: string) => T): T;
}

const GH_VALUE_OPTIONS = new Set([
  '-a',
  '--add-assignee',
  '--add-label',
  '--add-project',
  '--add-reviewer',
  '-B',
  '--base',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-m',
  '--milestone',
  '--remove-assignee',
  '--remove-label',
  '--remove-project',
  '--remove-reviewer',
  '-t',
  '--title',
]);

export function readBotGitHubPublicConfig(
  configPath = join(DEFAULT_REPO_ROOT, '.openslack', 'integrations', 'github-app-public.json'),
): BotGitHubPublicConfig {
  let content: string | null;
  try {
    content = readStableLocalUtf8(configPath, {
      maxBytes: PUBLIC_CONFIG_MAX_BYTES,
      required: true,
    });
  } catch {
    throw new BotGitHubAuthError(
      'BOT_APP_CONFIG_INVALID',
      'GitHub App public identity configuration could not be read safely.',
    );
  }
  let value: unknown;
  try {
    const document = parseDocument(content as string, { uniqueKeys: true });
    if (document.errors.length > 0) throw new Error('invalid');
    value = JSON.parse(content as string) as unknown;
  } catch {
    throw new BotGitHubAuthError(
      'BOT_APP_CONFIG_INVALID',
      'GitHub App public identity configuration is invalid.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BotGitHubAuthError(
      'BOT_APP_CONFIG_INVALID',
      'GitHub App public identity configuration is invalid.',
    );
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const expected = ['appId', 'appSlug', 'repository', 'schema'];
  const repository =
    typeof candidate.repository === 'string' ? parseGitHubRepoSpec(candidate.repository) : null;
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    candidate.schema !== BOT_GITHUB_PUBLIC_CONFIG_SCHEMA ||
    typeof candidate.appId !== 'string' ||
    !POSITIVE_GITHUB_ID_PATTERN.test(candidate.appId) ||
    !isGitHubAppSlug(candidate.appSlug) ||
    !repository
  ) {
    throw new BotGitHubAuthError(
      'BOT_APP_CONFIG_INVALID',
      'GitHub App public identity configuration is invalid.',
    );
  }
  return Object.freeze({
    schema: BOT_GITHUB_PUBLIC_CONFIG_SCHEMA,
    appId: candidate.appId,
    appSlug: candidate.appSlug,
    repository: `${repository.owner}/${repository.repo}`,
  });
}

export function parseGhRepositoryArguments(args: readonly string[]): string | null {
  let repository: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === '--') break;
    if (argument === '-R' || argument === '--repo') {
      const value = args[index + 1];
      if (value === undefined || value === '--') {
        throw new BotGitHubAuthError(
          'BOT_GH_ARGUMENT_INVALID',
          'GitHub repository option is missing its value.',
        );
      }
      repository = assignUniqueGhTarget(repository, value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--repo=')) {
      repository = assignUniqueGhTarget(repository, argument.slice('--repo='.length));
      continue;
    }
    if (argument.startsWith('-R') && argument.length > 2) {
      repository = assignUniqueGhTarget(repository, argument.slice(2));
      continue;
    }
    const optionName = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (GH_VALUE_OPTIONS.has(optionName) && !argument.includes('=')) {
      if (args[index + 1] === undefined) {
        throw new BotGitHubAuthError(
          'BOT_GH_ARGUMENT_INVALID',
          'GitHub command option is missing its value.',
        );
      }
      index += 1;
      continue;
    }
    if (!argument.startsWith('-')) {
      const positional = parseGhPositionalRepository(argument);
      if (positional) repository = assignUniqueGhTarget(repository, positional);
    }
  }
  return repository;
}

function assignUniqueGhTarget(current: string | null, value: string): string {
  const parsed = parseGitHubRepoSpec(value);
  if (!parsed) {
    throw new BotGitHubAuthError(
      'BOT_GH_ARGUMENT_INVALID',
      'GitHub repository target is invalid; expected owner/repository.',
    );
  }
  if (current !== null) {
    throw new BotGitHubAuthError(
      'BOT_REPOSITORY_AMBIGUOUS',
      'GitHub command contains multiple repository targets.',
    );
  }
  return `${parsed.owner}/${parsed.repo}`;
}

function parseGhPositionalRepository(value: string): string | null {
  const issueReference = value.match(/^([^/#\s]+\/[^/#\s]+)#\d+$/u);
  if (issueReference) return issueReference[1];
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const parsed = parseGitHubRepoSpec(`${parts[0]}/${parts[1]}`);
    return parsed ? `${parsed.owner}/${parsed.repo}` : null;
  } catch {
    return null;
  }
}

export function resolveBotGitHubRepository(
  options: BotGitHubAuthOptions = {},
): BotGitHubRepositoryTarget {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  let explicit = options.explicitRepository ?? null;
  if (options.ghArgs) {
    const ghTarget = parseGhRepositoryArguments(options.ghArgs);
    if (explicit && ghTarget) {
      throw new BotGitHubAuthError(
        'BOT_REPOSITORY_AMBIGUOUS',
        'Repository target was supplied through multiple explicit inputs.',
      );
    }
    explicit = explicit ?? ghTarget;
  }
  if (explicit) return targetFromSpec(explicit, 'explicit');

  if (options.useGhRepoEnvironment && nonBlank(env.GH_REPO)) {
    return targetFromSpec(env.GH_REPO as string, 'gh_repo');
  }
  const owner = nonBlank(env.GITHUB_OWNER);
  const repo = nonBlank(env.GITHUB_REPO);
  if (Boolean(owner) !== Boolean(repo)) {
    throw new BotGitHubAuthError(
      'BOT_REPOSITORY_REQUIRED',
      'GITHUB_OWNER and GITHUB_REPO must be configured together.',
    );
  }
  if (owner && repo) return targetFromSpec(`${owner}/${repo}`, 'environment');

  const workspace = findWorkspaceCanonicalTarget(cwd);
  const originResult = readGitOrigin(cwd, options.gitOrigin);
  if (originResult.present) {
    if (!originResult.target) {
      throw new BotGitHubAuthError(
        'BOT_GIT_ORIGIN_INVALID',
        'The existing Git origin is not a supported GitHub repository URL.',
      );
    }
    if (workspace && !sameTarget(originResult.target, workspace.target)) {
      const publicConfig = resolvePublicConfig(options, repoRoot);
      const publicTarget = targetFromSpec(publicConfig.repository, 'public_config');
      if (!sameTarget(workspace.target, publicTarget)) {
        throw new BotGitHubAuthError(
          'BOT_WORKSPACE_CONFIG_INVALID',
          'Workspace canonical repository does not match the checked-in GitHub App identity.',
        );
      }
      options.onDiagnostic?.({
        code: 'BOT_FORK_CANONICAL_TARGET',
        message:
          'Fork checkout detected; the verified workspace canonical repository is used for bot operations.',
      });
      return { ...workspace.target, source: 'workspace_canonical' };
    }
    return { ...originResult.target, source: 'git_origin' };
  }
  if (workspace) return { ...workspace.target, source: 'workspace_canonical' };

  if (isPathInside(cwd, repoRoot)) {
    return targetFromSpec(resolvePublicConfig(options, repoRoot).repository, 'public_config');
  }
  throw new BotGitHubAuthError(
    'BOT_REPOSITORY_REQUIRED',
    'Repository target is required outside a verified OpenSlack workspace.',
  );
}

export async function withBotGitHubInstallation<T>(
  options: BotGitHubAuthOptions,
  consumer: (context: BotGitHubInstallationContext) => T | Promise<T>,
): Promise<T> {
  const env = options.env ?? process.env;
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const target = resolveBotGitHubRepository(options);
  const identity = resolveBotIdentity(options, repoRoot);
  return identity.withPrivateKey(async (privateKey) => {
    let jwt: string;
    try {
      jwt = createGitHubAppJwt(identity.appId, privateKey);
    } catch {
      throw new BotGitHubAuthError(
        'BOT_APP_PRIVATE_KEY_INVALID',
        'GitHub App private-key credential is invalid.',
      );
    }
    let installation: GitHubAppInstallationSummary;
    try {
      installation = await (options.resolveInstallation ?? resolveGitHubAppRepositoryInstallation)({
        jwt,
        owner: target.owner,
        repo: target.repo,
        signal: options.signal,
      });
    } catch {
      throw new BotGitHubAuthError(
        'BOT_APP_INSTALLATION_FAILED',
        'GitHub App installation could not be verified for the target repository.',
      );
    }
    const installationHintReplaced =
      identity.installationHint !== null && identity.installationHint !== installation.id;
    if (installationHintReplaced) {
      options.onDiagnostic?.({
        code: 'BOT_INSTALLATION_HINT_REPLACED',
        message:
          'Configured installation hint was stale; the repository-verified installation is used for this process.',
      });
    }
    return consumer({
      appId: identity.appId,
      appSlug: identity.appSlug,
      installationId: installation.id,
      installationHintReplaced,
      owner: target.owner,
      repo: target.repo,
      repository: target.fullName,
      repositorySource: target.source,
      privateKey,
      forwardPrivateKey: identity.forwardPrivateKey,
    });
  });
}

/**
 * Resolves only the App signing identity for an OpenSlack child. Repository
 * selection remains inside the typed product command, where the exact target
 * is available. PEM-backed identities are forwarded so the child can refresh
 * installation tokens; keychain-backed identities remain native to the child.
 */
export function withBotGitHubLaunchIdentity<T>(
  options: BotGitHubAuthOptions,
  consumer: (identity: BotGitHubLaunchIdentity) => T,
): T {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const identity = resolveBotIdentity(options, repoRoot);
  return identity.withPrivateKey((privateKey) => {
    try {
      createGitHubAppJwt(identity.appId, privateKey);
    } catch {
      throw new BotGitHubAuthError(
        'BOT_APP_PRIVATE_KEY_INVALID',
        'GitHub App private-key credential is invalid.',
      );
    }
    return consumer({
      appId: identity.appId,
      appSlug: identity.appSlug,
      installationId: identity.installationHint,
      privateKey,
      forwardPrivateKey: identity.forwardPrivateKey,
    });
  });
}

export async function acquireBotGitHubToken(
  options: BotGitHubAuthOptions = {},
): Promise<BotGitHubTokenContext> {
  return withBotGitHubInstallation(options, async (context) => {
    const tokenEnv: NodeJS.ProcessEnv = {
      ...options.env,
      OPENSLACK_GITHUB_APP_ID: context.appId,
      OPENSLACK_GITHUB_APP_INSTALLATION_ID: context.installationId,
      OPENSLACK_GITHUB_APP_PRIVATE_KEY: context.privateKey,
      OPENSLACK_GITHUB_APP_SLUG: context.appSlug,
    };
    const token = await (options.requestToken ?? defaultTokenRequest)({
      env: tokenEnv,
      repository: { owner: context.owner, repo: context.repo },
      onDiagnostic: () => {},
    });
    return Object.freeze({
      appId: context.appId,
      appSlug: context.appSlug,
      installationId: token.installationId,
      installationHintReplaced: context.installationHintReplaced || token.installationHintReplaced,
      owner: context.owner,
      repo: context.repo,
      repository: context.repository,
      repositorySource: context.repositorySource,
      value: token.token,
      expiresAt: token.expiresAt,
      permissions: token.permissions,
    });
  });
}

export async function listConfiguredBotGitHubInstallations(
  options: BotGitHubAuthOptions = {},
): Promise<readonly GitHubAppInstallationSummary[]> {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const identity = resolveBotIdentity(options, repoRoot);
  return identity.withPrivateKey(async (privateKey) => {
    let jwt: string;
    try {
      jwt = createGitHubAppJwt(identity.appId, privateKey);
    } catch {
      throw new BotGitHubAuthError(
        'BOT_APP_PRIVATE_KEY_INVALID',
        'GitHub App private-key credential is invalid.',
      );
    }
    try {
      return await listGitHubAppInstallations({ jwt, signal: options.signal });
    } catch {
      throw new BotGitHubAuthError(
        'BOT_APP_INSTALLATION_FAILED',
        'GitHub App installations could not be listed safely.',
      );
    }
  });
}

function defaultTokenRequest(input: {
  env: NodeJS.ProcessEnv;
  repository: { owner: string; repo: string };
  onDiagnostic: (diagnostic: GitHubAppAuthDiagnostic) => void;
}): Promise<GitHubAppInstallationToken> {
  // The repository installation was already resolved immediately before this
  // request. Supplying the exact ID avoids a second network discovery while
  // retaining the package token parser, cache, and refresh semantics.
  return requireAppInstallationToken({ env: input.env });
}

function resolveBotIdentity(
  options: BotGitHubAuthOptions,
  repoRoot: string,
): BotGitHubIdentitySource {
  const env = options.env ?? process.env;
  const inlinePrivateKey = nonBlank(options.privateKey ?? env.OPENSLACK_GITHUB_APP_PRIVATE_KEY);
  const configuredPath = nonBlank(env.OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH);
  const needsLocal =
    !nonBlank(env.OPENSLACK_GITHUB_APP_ID) ||
    !nonBlank(env.OPENSLACK_GITHUB_APP_SLUG) ||
    (!inlinePrivateKey && !configuredPath);
  const localStateRoot =
    options.localStateRoot ??
    resolveGitHubAppLocalStateRoot(options.repoRoot ?? options.cwd ?? process.cwd()) ??
    join(repoRoot, '.openslack.local');
  let localConfig = options.localConfig;
  if (localConfig === undefined && needsLocal) {
    try {
      localConfig = readGitHubAppLocalConfig(localStateRoot);
    } catch {
      throw new BotGitHubAuthError(
        'BOT_APP_CONFIG_INVALID',
        'GitHub App local configuration is invalid.',
      );
    }
  }
  const hasHigherPriorityIdentity =
    (nonBlank(env.OPENSLACK_GITHUB_APP_ID) !== undefined &&
      nonBlank(env.OPENSLACK_GITHUB_APP_SLUG) !== undefined) ||
    (localConfig?.appId !== undefined && localConfig.appSlug !== undefined);
  const publicConfig = hasHigherPriorityIdentity
    ? options.publicConfig
    : resolvePublicConfig(options, repoRoot);
  const appId = nonBlank(env.OPENSLACK_GITHUB_APP_ID) ?? localConfig?.appId ?? publicConfig?.appId;
  const appSlug =
    nonBlank(env.OPENSLACK_GITHUB_APP_SLUG) ?? localConfig?.appSlug ?? publicConfig?.appSlug;
  const hint =
    nonBlank(env.OPENSLACK_GITHUB_APP_INSTALLATION_ID) ?? localConfig?.installationId ?? null;
  if (!appId || !POSITIVE_GITHUB_ID_PATTERN.test(appId) || !isGitHubAppSlug(appSlug)) {
    throw new BotGitHubAuthError(
      'BOT_APP_CONFIG_MISSING',
      'GitHub App public identity is not configured completely.',
    );
  }
  if (hint !== null && !POSITIVE_GITHUB_ID_PATTERN.test(hint)) {
    throw new BotGitHubAuthError(
      'BOT_APP_CONFIG_INVALID',
      'GitHub App installation hint is invalid.',
    );
  }

  if (inlinePrivateKey) {
    return {
      appId,
      appSlug,
      installationHint: hint,
      forwardPrivateKey: true,
      withPrivateKey: (consumer) => consumer(inlinePrivateKey),
    };
  }
  if (configuredPath) {
    const privateKeyPath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(repoRoot, configuredPath);
    return fileKeyIdentity(appId, appSlug, hint, privateKeyPath);
  }
  if (localConfig) {
    const envAppId = nonBlank(env.OPENSLACK_GITHUB_APP_ID);
    const envAppSlug = nonBlank(env.OPENSLACK_GITHUB_APP_SLUG);
    if (
      (envAppId && envAppId !== localConfig.appId) ||
      (envAppSlug && envAppSlug.toLowerCase() !== localConfig.appSlug.toLowerCase())
    ) {
      throw new BotGitHubAuthError(
        'BOT_APP_CONFIG_INVALID',
        'GitHub App environment identity does not match the local credential binding.',
      );
    }
    const store = options.credentialStore ?? createDefaultCredentialStore(env);
    return {
      appId,
      appSlug,
      installationHint: hint,
      forwardPrivateKey: false,
      withPrivateKey<T>(consumer: (privateKey: string) => T): T {
        try {
          return store.withSecret(localConfig.privateKeyRef, consumer);
        } catch {
          throw new BotGitHubAuthError(
            'BOT_APP_CONFIG_MISSING',
            'GitHub App private-key credential is unavailable.',
          );
        }
      },
    };
  }
  return fileKeyIdentity(appId, appSlug, hint, join(localStateRoot, 'github-app.pem'));
}

function fileKeyIdentity(
  appId: string,
  appSlug: string,
  installationHint: string | null,
  privateKeyPath: string,
): BotGitHubIdentitySource {
  return {
    appId,
    appSlug,
    installationHint,
    forwardPrivateKey: true,
    withPrivateKey<T>(consumer: (privateKey: string) => T): T {
      let privateKey: string | null;
      try {
        privateKey = readStableLocalUtf8(privateKeyPath, {
          maxBytes: PRIVATE_KEY_MAX_BYTES,
          required: true,
        });
      } catch {
        throw new BotGitHubAuthError(
          'BOT_APP_CONFIG_MISSING',
          'GitHub App private-key credential could not be read safely.',
        );
      }
      if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
        throw new BotGitHubAuthError(
          'BOT_APP_PRIVATE_KEY_INVALID',
          'GitHub App private-key credential is invalid.',
        );
      }
      return consumer(privateKey);
    },
  };
}

function resolvePublicConfig(
  options: BotGitHubAuthOptions,
  repoRoot: string,
): BotGitHubPublicConfig {
  return (
    options.publicConfig ??
    readBotGitHubPublicConfig(
      options.publicConfigPath ??
        join(repoRoot, '.openslack', 'integrations', 'github-app-public.json'),
    )
  );
}

function findWorkspaceCanonicalTarget(cwd: string): {
  target: Omit<BotGitHubRepositoryTarget, 'source'>;
} | null {
  let current = cwd;
  for (;;) {
    const workspacePath = join(current, 'openslack.yaml');
    if (existsSync(workspacePath)) {
      const target = resolveGitHubWorkspaceTarget(current);
      if (!target) {
        throw new BotGitHubAuthError(
          'BOT_WORKSPACE_CONFIG_INVALID',
          'OpenSlack workspace canonical repository is invalid.',
        );
      }
      return { target: { ...target, fullName: `${target.owner}/${target.repo}` } };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readGitOrigin(
  cwd: string,
  injected: string | null | undefined,
): { present: boolean; target: Omit<BotGitHubRepositoryTarget, 'source'> | null } {
  let value: string | null = injected ?? null;
  let present = injected !== undefined && injected !== null;
  if (injected === undefined) {
    try {
      value = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      }).trim();
      present = value.length > 0;
    } catch {
      return { present: false, target: null };
    }
  }
  if (!present || !value) return { present: false, target: null };
  const parsed = parseGitHubRepoSpec(value);
  return {
    present: true,
    target: parsed ? { ...parsed, fullName: `${parsed.owner}/${parsed.repo}` } : null,
  };
}

function targetFromSpec(
  value: string,
  source: BotGitHubRepositorySource,
): BotGitHubRepositoryTarget {
  const parsed = parseGitHubRepoSpec(value);
  if (!parsed) {
    throw new BotGitHubAuthError(
      'BOT_REPOSITORY_REQUIRED',
      'GitHub repository target is invalid; expected owner/repository.',
    );
  }
  return { ...parsed, fullName: `${parsed.owner}/${parsed.repo}`, source };
}

function sameTarget(
  left: { owner: string; repo: string },
  right: { owner: string; repo: string },
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function isPathInside(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
