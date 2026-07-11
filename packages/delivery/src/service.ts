import {
  clearTokenCache,
  requireAppInstallationToken,
  type GitHubAppInstallationToken,
} from '@openslack/github';
import { DeliveryError } from './errors.js';
import { createDeliveryGitHubApi } from './github-api.js';
import { GitAskPassPublisher, isAuthenticationFailure } from './git-transport.js';
import {
  assertDeliveryPermissions,
  diagnoseDeliveryPermissions,
} from './permission-diagnostics.js';
import { advanceDeliveryState } from './state-machine.js';
import type {
  DeliveryGitHubApi,
  DeliveryState,
  DeliveryToken,
  DeliveryTokenProvider,
  GitBranchPublisher,
  GitHubDeliveryInput,
  GitHubDeliveryResult,
} from './types.js';

export interface GitHubDeliveryServiceOptions {
  tokenProvider?: DeliveryTokenProvider;
  gitPublisher?: GitBranchPublisher;
  githubApiFactory?: (input: {
    token: DeliveryToken;
    owner: string;
    repo: string;
    rootDir: string;
  }) => DeliveryGitHubApi;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  headSyncAttempts?: number;
  headSyncIntervalMs?: number;
}

export class GitHubDeliveryService {
  private readonly tokenProvider: DeliveryTokenProvider;
  private readonly gitPublisher: GitBranchPublisher;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: GitHubDeliveryServiceOptions = {}) {
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider();
    this.gitPublisher = options.gitPublisher ?? new GitAskPassPublisher();
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async publish(input: GitHubDeliveryInput): Promise<GitHubDeliveryResult> {
    validateInput(input);
    const base = input.base ?? 'main';
    const remote = input.remote ?? 'origin';
    const timeoutMs = input.timeoutMs ?? 30_000;
    let history: DeliveryState[] = ['PREPARED'];
    let token = await this.acquireToken(false);
    const installationId = token.installationId;
    let permissions = diagnoseDeliveryPermissions(token.permissions, input.requireIssuesWrite);
    assertDeliveryPermissions(permissions);
    let authenticationRefreshUsed = false;
    const refreshAuthentication = async (): Promise<void> => {
      if (authenticationRefreshUsed) {
        throw new DeliveryError(
          'DELIVERY_AUTH_REQUIRED',
          'GitHub App authentication failed after the single refresh attempt.',
          true,
        );
      }
      authenticationRefreshUsed = true;
      this.tokenProvider.invalidate('authentication_failed');
      token = await this.acquireToken(true);
      if (token.installationId !== installationId) {
        throw new DeliveryError(
          'DELIVERY_AUTH_REQUIRED',
          'GitHub App installation identity changed during delivery.',
          false,
        );
      }
      permissions = diagnoseDeliveryPermissions(token.permissions, input.requireIssuesWrite);
      assertDeliveryPermissions(permissions);
    };

    let pushed: { branchSha: string; remoteSha: string };
    try {
      pushed = this.gitPublisher.push({
        rootDir: input.rootDir,
        remote,
        branch: input.branch,
        owner: input.owner,
        repo: input.repo,
        token: token.value,
        timeoutMs,
      });
    } catch (error) {
      if (!isRetryableAuthenticationFailure(error)) throw error;
      await refreshAuthentication();
      pushed = this.gitPublisher.push({
        rootDir: input.rootDir,
        remote,
        branch: input.branch,
        owner: input.owner,
        repo: input.repo,
        token: token.value,
        timeoutMs,
      });
    }
    if (!pushed.remoteSha || pushed.remoteSha !== pushed.branchSha) {
      throw new DeliveryError(
        'DELIVERY_HEAD_STALE',
        'Remote branch SHA did not synchronize with the local branch SHA.',
        true,
      );
    }
    history = advanceDeliveryState(history, 'PUSHED');

    const apiFactory = this.options.githubApiFactory ?? defaultApiFactory;
    let api = apiFactory({
      token,
      owner: input.owner,
      repo: input.repo,
      rootDir: input.rootDir,
    });
    const callApi = async <T>(
      operation: (current: DeliveryGitHubApi) => Promise<T>,
    ): Promise<T> => {
      try {
        return await operation(api);
      } catch (error) {
        if (!isApiAuthenticationFailure(error)) throw error;
        await refreshAuthentication();
        api = apiFactory({
          token,
          owner: input.owner,
          repo: input.repo,
          rootDir: input.rootDir,
        });
        return operation(api);
      }
    };
    let matches;
    try {
      matches = await callApi((current) =>
        current.findOpenPullRequests({
          owner: input.owner,
          repo: input.repo,
          headOwner: input.owner,
          head: input.branch,
        }),
      );
    } catch (error) {
      throw safeDeliveryFailure(error, 'Open pull request lookup failed.');
    }
    if (matches.some((match) => !isExactHead(match, input))) {
      throw new DeliveryError(
        'DELIVERY_PR_CONFLICT',
        'GitHub returned a pull request outside the exact delivery head.',
        false,
      );
    }
    if (matches.length > 1) {
      throw new DeliveryError(
        'DELIVERY_PR_CONFLICT',
        'Multiple open pull requests exist for the exact delivery head.',
        false,
      );
    }
    let pr;
    let action: GitHubDeliveryResult['action'];
    try {
      if (matches.length === 1) {
        pr = await callApi((current) =>
          current.updatePullRequest({
            owner: input.owner,
            repo: input.repo,
            number: matches[0].number,
            base,
            title: input.title,
            body: input.body,
          }),
        );
        history = advanceDeliveryState(history, 'PR_UPDATED');
        action = 'updated';
      } else {
        try {
          pr = await callApi((current) =>
            current.createDraftPullRequest({
              owner: input.owner,
              repo: input.repo,
              head: input.branch,
              base,
              title: input.title,
              body: input.body,
            }),
          );
          history = advanceDeliveryState(history, 'PR_CREATED');
          action = 'created';
        } catch (error) {
          if (!isPullRequestCreateRace(error)) throw error;
          const raced = await callApi((current) =>
            current.findOpenPullRequests({
              owner: input.owner,
              repo: input.repo,
              headOwner: input.owner,
              head: input.branch,
            }),
          );
          if (raced.length !== 1) throw error;
          if (!isExactHead(raced[0], input)) {
            throw new DeliveryError(
              'DELIVERY_PR_CONFLICT',
              'GitHub returned a pull request outside the exact delivery head after a create race.',
              false,
            );
          }
          pr = await callApi((current) =>
            current.updatePullRequest({
              owner: input.owner,
              repo: input.repo,
              number: raced[0].number,
              base,
              title: input.title,
              body: input.body,
            }),
          );
          history = advanceDeliveryState(history, 'PR_UPDATED');
          action = 'updated';
        }
      }
    } catch (error) {
      throw safeDeliveryFailure(error, 'Pull request publication failed.');
    }

    let synchronized;
    try {
      synchronized = await this.waitForSynchronizedHead(
        callApi,
        input,
        pr.number,
        pushed.remoteSha,
      );
    } catch (error) {
      throw safeDeliveryFailure(error, 'Pull request head verification failed.');
    }
    let currentRemoteSha: string;
    try {
      currentRemoteSha = this.gitPublisher.readRemoteSha({
        rootDir: input.rootDir,
        remote,
        branch: input.branch,
        owner: input.owner,
        repo: input.repo,
        token: token.value,
        timeoutMs,
      });
    } catch (error) {
      if (!isRetryableAuthenticationFailure(error)) throw error;
      await refreshAuthentication();
      currentRemoteSha = this.gitPublisher.readRemoteSha({
        rootDir: input.rootDir,
        remote,
        branch: input.branch,
        owner: input.owner,
        repo: input.repo,
        token: token.value,
        timeoutMs,
      });
    }
    if (
      !currentRemoteSha ||
      currentRemoteSha !== pushed.branchSha ||
      synchronized.headSha !== currentRemoteSha
    ) {
      throw new DeliveryError(
        'DELIVERY_HEAD_STALE',
        'Local, remote, and pull request head SHAs are not synchronized.',
        true,
      );
    }
    history = advanceDeliveryState(history, 'HEAD_SYNCHRONIZED');
    let checks;
    try {
      checks = await callApi((current) =>
        current.listChecks({
          owner: input.owner,
          repo: input.repo,
          ref: synchronized.headSha,
        }),
      );
    } catch (error) {
      throw safeDeliveryFailure(error, 'Check evidence query failed.');
    }
    history = advanceDeliveryState(history, 'AWAITING_GATES');
    return {
      state: 'AWAITING_GATES',
      history,
      action,
      prNumber: synchronized.number,
      prUrl: synchronized.url,
      branchSha: pushed.remoteSha,
      prHeadSha: synchronized.headSha,
      checks,
      checksStatus: checks.length === 0 ? 'empty' : 'observed',
      permissions,
      evidenceTimestamp: this.now().toISOString(),
    };
  }

  private async acquireToken(forceRefresh: boolean): Promise<DeliveryToken> {
    try {
      return await this.tokenProvider.acquire({ forceRefresh });
    } catch {
      throw new DeliveryError(
        'DELIVERY_AUTH_REQUIRED',
        'GitHub App installation token is unavailable.',
        true,
      );
    }
  }

  private async waitForSynchronizedHead(
    callApi: <T>(operation: (api: DeliveryGitHubApi) => Promise<T>) => Promise<T>,
    input: GitHubDeliveryInput,
    prNumber: number,
    expectedSha: string,
  ) {
    const attempts = this.options.headSyncAttempts ?? 5;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const pr = await callApi((api) =>
        api.getPullRequest({ owner: input.owner, repo: input.repo, number: prNumber }),
      );
      if (!isExactHead(pr, input)) {
        throw new DeliveryError(
          'DELIVERY_PR_CONFLICT',
          'Pull request head repository or ref does not match the delivery target.',
          false,
        );
      }
      if (pr.headSha === expectedSha) return pr;
      if (attempt + 1 < attempts) await this.sleep(this.options.headSyncIntervalMs ?? 250);
    }
    throw new DeliveryError(
      'DELIVERY_HEAD_STALE',
      'Pull request head did not synchronize with the remote branch SHA.',
      true,
    );
  }
}

function validateInput(input: GitHubDeliveryInput): void {
  if (
    !input.rootDir ||
    !input.owner ||
    !input.repo ||
    !input.branch ||
    !input.title ||
    !input.body
  ) {
    throw new DeliveryError('DELIVERY_PR_FAILED', 'Delivery input is incomplete.', false);
  }
}

function isRetryableAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof DeliveryError &&
    error.code === 'DELIVERY_PUSH_FAILED' &&
    error.retryable &&
    isAuthenticationFailure(error.message)
  );
}

function isApiAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 401 || candidate.code === 'BAD_CREDENTIALS';
}

function isPullRequestCreateRace(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    response?: { data?: { message?: unknown; errors?: unknown } };
  };
  if (candidate.status !== 422) return false;
  const message = candidate.response?.data?.message;
  const errors = candidate.response?.data?.errors;
  return (
    (typeof message === 'string' && /pull request.*already exists/i.test(message)) ||
    (Array.isArray(errors) &&
      errors.some(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          (entry as { code?: unknown }).code === 'already_exists',
      ))
  );
}

function isExactHead(
  pullRequest: { headOwner: string; headRepo: string; headRef: string },
  input: GitHubDeliveryInput,
): boolean {
  return (
    pullRequest.headOwner.toLowerCase() === input.owner.toLowerCase() &&
    pullRequest.headRepo.toLowerCase() === input.repo.toLowerCase() &&
    pullRequest.headRef === input.branch
  );
}

function safeDeliveryFailure(error: unknown, message: string): DeliveryError {
  if (error instanceof DeliveryError) return error;
  return new DeliveryError('DELIVERY_PR_FAILED', message, true);
}

function defaultTokenProvider(): DeliveryTokenProvider {
  return {
    async acquire(options) {
      const forwarded = readForwardedInstallationToken();
      if (forwarded) {
        if (options?.forceRefresh) {
          throw new DeliveryError(
            'DELIVERY_AUTH_REQUIRED',
            'The forwarded installation token cannot be refreshed in this process.',
            true,
          );
        }
        return forwarded;
      }
      if (options?.forceRefresh) clearTokenCache();
      return mapToken(await requireAppInstallationToken());
    },
    invalidate() {
      clearTokenCache();
    },
  };
}

function readForwardedInstallationToken(): DeliveryToken | null {
  const value = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN?.trim();
  const installationId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID?.trim();
  if (!value || !installationId) return null;

  let permissions: Record<string, string> = {};
  const rawPermissions = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS;
  if (rawPermissions) {
    try {
      const parsed: unknown = JSON.parse(rawPermissions);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        permissions = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      }
    } catch {
      throw new DeliveryError(
        'DELIVERY_AUTH_REQUIRED',
        'Forwarded GitHub App permission evidence is invalid.',
        false,
      );
    }
  }

  return {
    value,
    installationId,
    expiresAt:
      process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT ??
      new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    permissions,
  };
}

function mapToken(token: GitHubAppInstallationToken): DeliveryToken {
  return {
    value: token.token,
    expiresAt: token.expiresAt,
    installationId: token.installationId,
    permissions: token.permissions,
  };
}

function defaultApiFactory(input: {
  token: DeliveryToken;
  owner: string;
  repo: string;
  rootDir: string;
}): DeliveryGitHubApi {
  return createDeliveryGitHubApi({ ...input, token: input.token.value });
}
