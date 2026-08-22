import { createDefaultCredentialStore, type CredentialStore } from '@openslack/credentials';
import { boundedJsonPost, BoundedJsonPostError } from './bounded-json-post.js';
import { GitHubAppLocalConfigError, readGitHubAppLocalConfig } from './app-local-config.js';
import { isGitHubAppSlug } from './app-slug.js';
import { createGitHubAppJwt, POSITIVE_GITHUB_ID_PATTERN } from './app-jwt.js';
import {
  GitHubAppInstallationResolutionError,
  resolveGitHubAppRepositoryInstallation,
} from './app-installation-resolution.js';

export interface GitHubAppInstallationToken {
  token: string;
  expiresAt: string;
  tokenType: 'installation';
  appId: string;
  installationId: string;
  appSlug?: string;
  permissions: Record<string, string>;
  installationHintReplaced: boolean;
}

export interface GitHubAppRepositoryTarget {
  owner: string;
  repo: string;
}

export interface GitHubAppAuthDiagnostic {
  code: 'APP_INSTALLATION_HINT_REPLACED';
  message: string;
}

export interface GitHubAppInstallationTokenOptions {
  env?: NodeJS.ProcessEnv;
  localStateRoot?: string;
  credentialStore?: Pick<CredentialStore, 'withSecret'>;
  signal?: AbortSignal;
  repository?: GitHubAppRepositoryTarget;
  onDiagnostic?: (diagnostic: GitHubAppAuthDiagnostic) => void;
}

/** Internal App-auth context for endpoints that require a JWT rather than an installation token. */
export interface GitHubAppJwtContext {
  jwt: string;
  appId: string;
  installationId: string;
  appSlug?: string;
  installationHintReplaced?: boolean;
}

interface TokenCache {
  identityKey: string;
  value: GitHubAppInstallationToken;
  expiresAt: Date;
}

export class GitHubAppTokenError extends Error {
  readonly code:
    | 'APP_CONFIG_MISSING'
    | 'APP_CONFIG_INVALID'
    | 'APP_INSTALLATION_NOT_FOUND'
    | 'APP_INSTALLATION_REQUEST_FAILED'
    | 'APP_TOKEN_REQUEST_FAILED'
    | 'APP_TOKEN_INVALID';

  constructor(code: GitHubAppTokenError['code'], message: string) {
    super(message);
    this.name = 'GitHubAppTokenError';
    this.code = code;
  }
}

let cachedToken: TokenCache | null = null;
let inFlight: { identityKey: string; promise: Promise<GitHubAppInstallationToken> } | null = null;
let cacheGeneration = 0;

function abortError(): Error {
  const error = new Error('GITHUB_EVIDENCE_ABORTED');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Resolves the same fail-closed credential source used for installation tokens,
 * signs a short-lived App JWT, and never returns the private key.
 *
 * This is intentionally not re-exported from the package root. Package-owned
 * diagnostics use it for App-only REST endpoints.
 */
export function createGitHubAppJwtContext(
  options: GitHubAppInstallationTokenOptions = {},
): GitHubAppJwtContext {
  assertNotAborted(options.signal);
  const source = resolveGitHubAppCredentialSource(options);
  let jwt: string;
  try {
    jwt = source.withPrivateKey((privateKey) => createGitHubAppJwt(source.appId, privateKey));
  } catch (error) {
    if (error instanceof GitHubAppTokenError) throw error;
    throw new GitHubAppTokenError(
      'APP_TOKEN_INVALID',
      'GitHub App private-key credential is unavailable or invalid.',
    );
  }
  return {
    jwt,
    appId: source.appId,
    installationId: requireInstallationHint(source.installationHint),
    appSlug: source.appSlug,
  };
}

export async function resolveGitHubAppJwtContext(
  options: GitHubAppInstallationTokenOptions & { repository: GitHubAppRepositoryTarget },
): Promise<GitHubAppJwtContext> {
  assertNotAborted(options.signal);
  const source = resolveGitHubAppCredentialSource(options);
  let jwt: string;
  try {
    jwt = source.withPrivateKey((privateKey) => createGitHubAppJwt(source.appId, privateKey));
  } catch (error) {
    if (error instanceof GitHubAppTokenError) throw error;
    throw new GitHubAppTokenError(
      'APP_TOKEN_INVALID',
      'GitHub App private-key credential is unavailable or invalid.',
    );
  }
  let installation;
  try {
    installation = await resolveGitHubAppRepositoryInstallation({
      jwt,
      owner: options.repository.owner,
      repo: options.repository.repo,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof GitHubAppInstallationResolutionError) {
      throw new GitHubAppTokenError(
        error.code === 'APP_INSTALLATION_NOT_FOUND'
          ? 'APP_INSTALLATION_NOT_FOUND'
          : 'APP_INSTALLATION_REQUEST_FAILED',
        error.code === 'APP_INSTALLATION_NOT_FOUND'
          ? 'GitHub App is not installed for the target repository.'
          : 'GitHub App installation could not be resolved safely.',
      );
    }
    throw error;
  }
  const installationHintReplaced =
    source.installationHint !== null && source.installationHint !== installation.id;
  if (installationHintReplaced) {
    options.onDiagnostic?.({
      code: 'APP_INSTALLATION_HINT_REPLACED',
      message:
        'Configured GitHub App installation hint did not match the target repository; the verified repository installation is used for this process.',
    });
  }
  return {
    jwt,
    appId: source.appId,
    installationId: installation.id,
    appSlug: source.appSlug,
    installationHintReplaced,
  };
}

export async function requireAppInstallationToken(
  options: GitHubAppInstallationTokenOptions = {},
): Promise<GitHubAppInstallationToken> {
  assertNotAborted(options.signal);
  const source = resolveGitHubAppCredentialSource(options);
  const targetKey = options.repository
    ? `${options.repository.owner.toLowerCase()}/${options.repository.repo.toLowerCase()}`
    : '';
  const identityKey = `${source.appId}\0${source.installationHint ?? ''}\0${targetKey}`;

  // Return cached token if still valid (with 5-minute safety margin)
  if (
    cachedToken?.identityKey === identityKey &&
    cachedToken.expiresAt > new Date(Date.now() + 300000)
  ) {
    return cachedToken.value;
  }
  if (!options.signal && inFlight?.identityKey === identityKey) return inFlight.promise;

  let promise: Promise<GitHubAppInstallationToken>;
  try {
    promise = source.withPrivateKey((privateKey) =>
      resolveAndRefreshInstallationToken({
        source,
        privateKey,
        repository: options.repository,
        onDiagnostic: options.onDiagnostic,
        identityKey,
        generation: cacheGeneration,
        signal: options.signal,
      }),
    );
  } catch (error) {
    if (error instanceof GitHubAppTokenError) throw error;
    throw new GitHubAppTokenError(
      'APP_TOKEN_INVALID',
      'GitHub App private-key credential is unavailable or invalid.',
    );
  }
  if (!options.signal) inFlight = { identityKey, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

async function resolveAndRefreshInstallationToken(input: {
  source: GitHubAppCredentialSource;
  privateKey: string;
  repository?: GitHubAppRepositoryTarget;
  onDiagnostic?: (diagnostic: GitHubAppAuthDiagnostic) => void;
  identityKey: string;
  generation: number;
  signal?: AbortSignal;
}): Promise<GitHubAppInstallationToken> {
  let jwt: string;
  try {
    jwt = createGitHubAppJwt(input.source.appId, input.privateKey);
  } catch {
    throw new GitHubAppTokenError(
      'APP_TOKEN_INVALID',
      'GitHub App private-key credential is unavailable or invalid.',
    );
  }
  let installationId: string;
  let installationHintReplaced = false;
  if (input.repository) {
    let resolved;
    try {
      resolved = await resolveGitHubAppRepositoryInstallation({
        jwt,
        owner: input.repository.owner,
        repo: input.repository.repo,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof GitHubAppInstallationResolutionError) {
        throw new GitHubAppTokenError(
          error.code === 'APP_INSTALLATION_NOT_FOUND'
            ? 'APP_INSTALLATION_NOT_FOUND'
            : 'APP_INSTALLATION_REQUEST_FAILED',
          error.code === 'APP_INSTALLATION_NOT_FOUND'
            ? 'GitHub App is not installed for the target repository.'
            : 'GitHub App installation could not be resolved safely.',
        );
      }
      throw error;
    }
    installationId = resolved.id;
    installationHintReplaced =
      input.source.installationHint !== null && input.source.installationHint !== installationId;
    if (installationHintReplaced) {
      input.onDiagnostic?.({
        code: 'APP_INSTALLATION_HINT_REPLACED',
        message:
          'Configured GitHub App installation hint did not match the target repository; the verified repository installation is used for this process.',
      });
    }
  } else {
    installationId = requireInstallationHint(input.source.installationHint);
  }
  return refreshInstallationToken({
    appId: input.source.appId,
    installationId,
    appSlug: input.source.appSlug,
    installationHintReplaced,
    jwt,
    identityKey: input.identityKey,
    generation: input.generation,
    signal: input.signal,
  });
}

async function refreshInstallationToken(input: {
  appId: string;
  installationId: string;
  appSlug?: string;
  installationHintReplaced: boolean;
  jwt: string;
  identityKey: string;
  generation: number;
  signal?: AbortSignal;
}): Promise<GitHubAppInstallationToken> {
  assertNotAborted(input.signal);
  try {
    const response = await boundedJsonPost({
      url: `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
      body: '{}',
      headers: {
        Authorization: `Bearer ${input.jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'openslack-github-provider',
      },
      signal: input.signal,
    });
    assertNotAborted(input.signal);

    // The shared transport validates only a top-level object; this endpoint owns its schema.
    if (
      typeof response.token !== 'string' ||
      response.token.trim().length === 0 ||
      typeof response.expires_at !== 'string' ||
      Number.isNaN(Date.parse(response.expires_at))
    ) {
      throw new GitHubAppTokenError(
        'APP_TOKEN_INVALID',
        'GitHub App token endpoint returned an invalid response.',
      );
    }

    const expiresAt = new Date(response.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 300_000) {
      throw new GitHubAppTokenError(
        'APP_TOKEN_INVALID',
        'GitHub App token endpoint returned an invalid expiry.',
      );
    }
    const permissions = readStringRecord(response.permissions);
    const value: GitHubAppInstallationToken = {
      token: response.token,
      expiresAt: expiresAt.toISOString(),
      tokenType: 'installation',
      appId: input.appId,
      installationId: input.installationId,
      appSlug: input.appSlug,
      permissions,
      installationHintReplaced: input.installationHintReplaced,
    };
    if (input.generation === cacheGeneration) {
      cachedToken = {
        identityKey: input.identityKey,
        value,
        expiresAt,
      };
    }
    return value;
  } catch (err) {
    if (err instanceof GitHubAppTokenError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (err instanceof BoundedJsonPostError) {
      if (err.code === 'ABORTED') throw abortError();
      throw new GitHubAppTokenError(
        err.code === 'INVALID_JSON' || err.code === 'INVALID_RESPONSE'
          ? 'APP_TOKEN_INVALID'
          : 'APP_TOKEN_REQUEST_FAILED',
        'GitHub App installation token request failed safely.',
      );
    }
    throw new GitHubAppTokenError(
      'APP_TOKEN_REQUEST_FAILED',
      'GitHub App installation token request failed.',
    );
  }
}

export async function getAppInstallationToken(
  options: GitHubAppInstallationTokenOptions = {},
): Promise<GitHubAppInstallationToken | null> {
  try {
    return await requireAppInstallationToken(options);
  } catch {
    return null;
  }
}

export function clearTokenCache(): void {
  cacheGeneration += 1;
  cachedToken = null;
  inFlight = null;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export interface GitHubAppCredentialSource {
  appId: string;
  installationHint: string | null;
  appSlug?: string;
  withPrivateKey<T>(consumer: (privateKey: string) => T): T;
}

export function resolveGitHubAppCredentialSource(
  options: GitHubAppInstallationTokenOptions,
): GitHubAppCredentialSource {
  const env = options.env ?? process.env;
  const appId = env.OPENSLACK_GITHUB_APP_ID;
  const installationId = env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
  const rawPrivateKey = env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;
  const privateKey = rawPrivateKey && rawPrivateKey.trim() ? rawPrivateKey : undefined;
  const blankPrivateKeyWasExplicit =
    rawPrivateKey !== undefined && rawPrivateKey.trim().length === 0;
  if (privateKey || ((appId || installationId) && !blankPrivateKeyWasExplicit)) {
    if (
      !appId ||
      !privateKey ||
      !POSITIVE_GITHUB_ID_PATTERN.test(appId) ||
      (installationId !== undefined && !POSITIVE_GITHUB_ID_PATTERN.test(installationId)) ||
      (!installationId && !options.repository)
    ) {
      throw new GitHubAppTokenError(
        'APP_CONFIG_INVALID',
        'GitHub App environment configuration is incomplete or invalid.',
      );
    }
    return {
      appId,
      installationHint: installationId ?? null,
      appSlug: validAppSlug(env.OPENSLACK_GITHUB_APP_SLUG),
      withPrivateKey: (consumer) => consumer(privateKey),
    };
  }

  let config;
  try {
    config = readGitHubAppLocalConfig(options.localStateRoot);
  } catch (error) {
    if (error instanceof GitHubAppLocalConfigError) {
      throw new GitHubAppTokenError('APP_CONFIG_INVALID', error.message);
    }
    throw new GitHubAppTokenError(
      'APP_CONFIG_INVALID',
      'GitHub App local configuration is invalid.',
    );
  }
  if (!config) {
    throw new GitHubAppTokenError(
      'APP_CONFIG_MISSING',
      'GitHub App installation credentials are not configured.',
    );
  }
  if (!config.installationId && !options.repository) {
    throw new GitHubAppTokenError(
      'APP_CONFIG_MISSING',
      'GitHub App installation is not bound in local configuration.',
    );
  }

  const store = options.credentialStore ?? createDefaultCredentialStore(env);
  return {
    appId: config.appId,
    installationHint: config.installationId,
    appSlug: config.appSlug,
    withPrivateKey<T>(consumer: (privateKey: string) => T): T {
      try {
        return store.withSecret(config.privateKeyRef, consumer);
      } catch {
        throw new GitHubAppTokenError(
          'APP_CONFIG_MISSING',
          'GitHub App private-key credential is unavailable.',
        );
      }
    },
  };
}

function requireInstallationHint(value: string | null): string {
  if (!value) {
    throw new GitHubAppTokenError(
      'APP_CONFIG_MISSING',
      'GitHub App installation is not bound and no repository target was supplied.',
    );
  }
  return value;
}

function validAppSlug(value: string | undefined): string | undefined {
  return isGitHubAppSlug(value) ? value : undefined;
}
