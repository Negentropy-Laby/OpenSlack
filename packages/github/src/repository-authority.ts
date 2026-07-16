import {
  getClient,
  type GitHubAuthPreference,
  type GitHubClient,
  type GitHubClientOptions,
} from './client.js';
import { canonicalizeRepositoryName, type RepositoryIdentity } from './repository-event.js';

export type RepositoryAuthorityDiagnosticCode =
  | 'AUTH_REQUIRED'
  | 'REPOSITORY_OUT_OF_SCOPE'
  | 'SCOPE_UNVERIFIED'
  | 'REPOSITORY_IDENTITY_MISMATCH'
  | 'AUTH_CONTEXT_CHANGED';

export interface RepositoryAuthorityDiagnostic {
  code: RepositoryAuthorityDiagnosticCode;
  repository: string;
  retryable: boolean;
  message: string;
}

export type RepositoryClientResolution =
  | {
      ok: true;
      repository: RepositoryIdentity;
      client: GitHubClient;
      authMode: 'github_app_installation' | 'token';
    }
  | {
      ok: false;
      diagnostic: RepositoryAuthorityDiagnostic;
    };

export interface RepositoryAuthorityResolverOptions {
  auth?: GitHubAuthPreference;
  cwd?: string;
  localStateRoot?: string;
  credentialStore?: GitHubClientOptions['credentialStore'];
  cacheTtlMs?: number;
  now?: () => Date;
  getClientFn?: (options: GitHubClientOptions) => Promise<GitHubClient>;
}

interface CachedRepositoryClient {
  client: GitHubClient;
  expiresAt: number;
}

const DEFAULT_AUTHORITY_CACHE_TTL_MS = 5 * 60_000;

export class RepositoryAuthorityResolver {
  private readonly initialAuth: GitHubAuthPreference;
  private readonly cwd?: string;
  private readonly localStateRoot?: string;
  private readonly credentialStore?: GitHubClientOptions['credentialStore'];
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly getClientFn: (options: GitHubClientOptions) => Promise<GitHubClient>;
  private readonly cache = new Map<string, CachedRepositoryClient>();
  private lockedAuthMode: 'github_app_installation' | 'token' | null = null;

  constructor(options: RepositoryAuthorityResolverOptions = {}) {
    this.initialAuth = options.auth ?? resolveConfiguredAuthPreference();
    this.cwd = options.cwd;
    this.localStateRoot = options.localStateRoot;
    this.credentialStore = options.credentialStore;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_AUTHORITY_CACHE_TTL_MS;
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0) {
      throw new TypeError('Repository authority cache TTL is invalid.');
    }
    this.now = options.now ?? (() => new Date());
    this.getClientFn = options.getClientFn ?? getClient;
  }

  async resolve(repository: RepositoryIdentity): Promise<RepositoryClientResolution> {
    const canonical = canonicalizeRepositoryName(repository.owner, repository.repo);
    if (
      !canonical ||
      canonical.canonicalFullName !== repository.canonicalFullName ||
      canonical.fullName.toLocaleLowerCase('en-US') !==
        repository.fullName.toLocaleLowerCase('en-US')
    ) {
      return failure(
        'REPOSITORY_IDENTITY_MISMATCH',
        repository.fullName,
        false,
        'The repository identity is inconsistent and cannot be authorized.',
      );
    }

    const cached = this.cache.get(canonical.canonicalFullName);
    if (cached && cached.expiresAt > this.now().getTime()) {
      return {
        ok: true,
        repository: canonical,
        client: cached.client,
        authMode: cached.client.authMode as 'github_app_installation' | 'token',
      };
    }

    let client: GitHubClient;
    try {
      client = await this.getClientFn({
        repoFullName: canonical.fullName,
        auth: this.lockedAuthPreference(),
        requireLive: true,
        cwd: this.cwd,
        localStateRoot: this.localStateRoot,
        credentialStore: this.credentialStore,
      });
    } catch {
      return failure(
        'AUTH_REQUIRED',
        canonical.fullName,
        true,
        'Live GitHub credentials are unavailable for the event repository.',
      );
    }

    if (client.isDryRun || client.authMode === 'dry_run') {
      return failure(
        'AUTH_REQUIRED',
        canonical.fullName,
        true,
        'Live GitHub credentials are required for repository event refresh.',
      );
    }
    if (client.authMode !== 'github_app_installation' && client.authMode !== 'token') {
      return failure(
        'AUTH_REQUIRED',
        canonical.fullName,
        true,
        'The GitHub credential mode cannot authorize repository event refresh.',
      );
    }

    const clientRepository = canonicalizeRepositoryName(client.owner, client.repo);
    if (!clientRepository || clientRepository.canonicalFullName !== canonical.canonicalFullName) {
      return failure(
        'REPOSITORY_IDENTITY_MISMATCH',
        canonical.fullName,
        false,
        'The resolved GitHub client is bound to a different repository.',
      );
    }

    if (this.lockedAuthMode && client.authMode !== this.lockedAuthMode) {
      return failure(
        'AUTH_CONTEXT_CHANGED',
        canonical.fullName,
        false,
        'The daemon GitHub credential context changed while running.',
      );
    }

    try {
      await client.octokit.repos.get({
        owner: canonical.owner,
        repo: canonical.repo,
      });
    } catch (error) {
      const status = errorStatus(error);
      if (status === 403 || status === 404) {
        return failure(
          'REPOSITORY_OUT_OF_SCOPE',
          canonical.fullName,
          false,
          'The configured GitHub credential cannot access the event repository.',
        );
      }
      return failure(
        'SCOPE_UNVERIFIED',
        canonical.fullName,
        status === undefined || status === 408 || status === 429 || status >= 500,
        'Repository access could not be verified safely.',
      );
    }

    this.lockedAuthMode = client.authMode;
    if (this.cacheTtlMs > 0) {
      this.cache.set(canonical.canonicalFullName, {
        client,
        expiresAt: this.now().getTime() + this.cacheTtlMs,
      });
    }
    return {
      ok: true,
      repository: canonical,
      client,
      authMode: client.authMode,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private lockedAuthPreference(): GitHubAuthPreference {
    if (this.lockedAuthMode === 'github_app_installation') return 'app';
    if (this.lockedAuthMode === 'token') return 'token';
    return this.initialAuth;
  }
}

function resolveConfiguredAuthPreference(): GitHubAuthPreference {
  const configured = process.env.OPENSLACK_GITHUB_AUTH_MODE;
  return configured === 'app' || configured === 'token' || configured === 'dry-run'
    ? configured
    : 'auto';
}

function failure(
  code: RepositoryAuthorityDiagnosticCode,
  repository: string,
  retryable: boolean,
  message: string,
): RepositoryClientResolution {
  return {
    ok: false,
    diagnostic: {
      code,
      repository,
      retryable,
      message,
    },
  };
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
