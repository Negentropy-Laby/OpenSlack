import { randomUUID } from 'node:crypto';
import {
  clearTokenCache,
  inspectInstallationRepositoryAccess,
  requireAppInstallationToken,
  resolveGitHubAppLocalStateRoot,
  type GitHubInstallationRepositoryAccess,
} from '@openslack/github';
import { DeliveryError, DeliveryProbeCleanupError } from './errors.js';
import { GitAskPassPublisher } from './git-transport.js';
import {
  assertDeliveryPermissions,
  diagnoseDeliveryPermissions,
} from './permission-diagnostics.js';
import type {
  DeliveryToken,
  DeliveryTokenProvider,
  GitHubDeliveryDiagnosticResult,
  GitHubDeliveryProbeInput,
  GitHubDeliveryProbeResult,
  GitProbePublisher,
} from './types.js';

export interface GitHubDeliveryProbeOptions {
  tokenProvider?: DeliveryTokenProvider;
  gitPublisher?: GitProbePublisher;
  repositoryInspector?: (input: {
    token: string;
    owner: string;
    repo: string;
  }) => Promise<GitHubInstallationRepositoryAccess>;
  now?: () => Date;
  uuid?: () => string;
}

export class GitHubDeliveryProbe {
  private readonly tokenProvider?: DeliveryTokenProvider;
  private readonly gitPublisher: GitProbePublisher;
  private readonly repositoryInspector: NonNullable<
    GitHubDeliveryProbeOptions['repositoryInspector']
  >;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(options: GitHubDeliveryProbeOptions = {}) {
    this.tokenProvider = options.tokenProvider;
    this.gitPublisher = options.gitPublisher ?? new GitAskPassPublisher();
    this.repositoryInspector = options.repositoryInspector ?? inspectInstallationRepositoryAccess;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  async run(input: GitHubDeliveryProbeInput): Promise<GitHubDeliveryProbeResult> {
    const remote = input.remote ?? 'origin';
    const timeoutMs = input.timeoutMs ?? 30_000;
    const { token, permissions, repositoryAccess } = await this.prepare(input);

    const probeRef = `openslack/probes/write-${normalizeUuid(this.uuid())}`;
    let pushed: { branchSha: string; remoteSha: string } | undefined;
    let cleanupRequired = false;
    let result: GitHubDeliveryProbeResult | undefined;
    let primaryError: unknown;
    try {
      pushed = this.gitPublisher.push({
        rootDir: input.rootDir,
        remote,
        branch: probeRef,
        owner: input.owner,
        repo: input.repo,
        token: token.value,
        timeoutMs,
      });
      if (!pushed.remoteSha || pushed.remoteSha !== pushed.branchSha) {
        throw new DeliveryError(
          'DELIVERY_HEAD_STALE',
          'Temporary delivery probe ref did not synchronize with local HEAD.',
          true,
        );
      }
      result = {
        state: 'PROBE_CLEANED',
        probeRef,
        branchSha: pushed.branchSha,
        remoteSha: pushed.remoteSha,
        repositoryAccess: {
          accessible: true,
          totalAccessibleRepositories: repositoryAccess.totalAccessibleRepositories,
          pagesScanned: repositoryAccess.pagesScanned,
        },
        permissions,
        cleanup: 'PASS',
        evidenceTimestamp: this.now().toISOString(),
      };
    } catch (error) {
      primaryError = error;
      try {
        const remoteSha = this.gitPublisher.readRemoteSha({
          rootDir: input.rootDir,
          remote,
          branch: probeRef,
          owner: input.owner,
          repo: input.repo,
          token: token.value,
          timeoutMs,
        });
        cleanupRequired = remoteSha.length > 0;
      } catch {
        // A failed post-push verification leaves remote state unknown; cleanup is mandatory.
        cleanupRequired = true;
      }
    }

    if (pushed || cleanupRequired) {
      try {
        this.gitPublisher.deleteRemoteRef({
          rootDir: input.rootDir,
          remote,
          branch: probeRef,
          owner: input.owner,
          repo: input.repo,
          token: token.value,
          timeoutMs,
        });
      } catch (cleanupError) {
        throw new DeliveryProbeCleanupError(probeRef, input.owner, input.repo, {
          cause: primaryError ?? cleanupError,
        });
      }
    }
    if (primaryError) throw primaryError;
    if (!result) {
      throw new DeliveryError(
        'DELIVERY_PUSH_FAILED',
        'Temporary delivery probe did not produce a result.',
        true,
      );
    }
    return result;
  }

  async diagnose(input: GitHubDeliveryProbeInput): Promise<GitHubDeliveryDiagnosticResult> {
    const { permissions, repositoryAccess } = await this.prepare(input);
    return {
      state: 'READY_FOR_PROBE',
      repositoryAccess: {
        accessible: true,
        totalAccessibleRepositories: repositoryAccess.totalAccessibleRepositories,
        pagesScanned: repositoryAccess.pagesScanned,
      },
      permissions,
      evidenceTimestamp: this.now().toISOString(),
    };
  }

  async cleanupRef(
    input: Omit<GitHubDeliveryProbeInput, 'requireIssuesWrite'> & { branch: string },
  ): Promise<void> {
    validateProbeInput(input);
    if (!/^openslack\/probes\/write-[a-f0-9-]{8,64}$/.test(input.branch)) {
      throw new DeliveryError(
        'DELIVERY_PUSH_FAILED',
        'Cleanup is restricted to OpenSlack temporary probe refs.',
        false,
      );
    }
    const token = await this.acquireToken(input.rootDir);
    const permissions = diagnoseDeliveryPermissions(token.permissions);
    assertDeliveryPermissions(
      permissions.filter((permission) => permission.capability === 'contents'),
    );
    const repositoryAccess = await this.inspectRepository(token, input);
    if (!repositoryAccess.complete || !repositoryAccess.accessible) {
      throw new DeliveryError(
        'DELIVERY_REPOSITORY_NOT_INSTALLED',
        'GitHub App installation repository access could not be confirmed for cleanup.',
        false,
      );
    }
    const transportInput = {
      rootDir: input.rootDir,
      remote: input.remote ?? 'origin',
      branch: input.branch,
      owner: input.owner,
      repo: input.repo,
      token: token.value,
      timeoutMs: input.timeoutMs ?? 30_000,
    };
    if (!this.gitPublisher.readRemoteSha(transportInput)) return;
    this.gitPublisher.deleteRemoteRef(transportInput);
  }

  private async acquireToken(rootDir: string): Promise<DeliveryToken> {
    try {
      return await (
        this.tokenProvider ?? defaultTokenProvider(resolveGitHubAppLocalStateRoot(rootDir))
      ).acquire();
    } catch {
      throw new DeliveryError(
        'DELIVERY_AUTH_REQUIRED',
        'GitHub App installation token is unavailable.',
        true,
      );
    }
  }

  private async prepare(input: GitHubDeliveryProbeInput): Promise<{
    token: DeliveryToken;
    permissions: ReturnType<typeof diagnoseDeliveryPermissions>;
    repositoryAccess: GitHubInstallationRepositoryAccess & { accessible: true; complete: true };
  }> {
    validateProbeInput(input);
    const token = await this.acquireToken(input.rootDir);
    const permissions = diagnoseDeliveryPermissions(token.permissions, input.requireIssuesWrite);
    assertDeliveryPermissions(permissions);
    const repositoryAccess = await this.inspectRepository(token, input);
    if (!repositoryAccess.complete) {
      throw new DeliveryError(
        'DELIVERY_REPOSITORY_SCOPE_INCOMPLETE',
        'GitHub App repository scope diagnostic did not reach a complete result.',
        true,
      );
    }
    if (!repositoryAccess.accessible) {
      throw new DeliveryError(
        'DELIVERY_REPOSITORY_NOT_INSTALLED',
        `GitHub App installation does not include ${input.owner}/${input.repo}. Update the installation repository selection and retry.`,
        false,
      );
    }
    return {
      token,
      permissions,
      repositoryAccess: repositoryAccess as GitHubInstallationRepositoryAccess & {
        accessible: true;
        complete: true;
      },
    };
  }

  private async inspectRepository(
    token: DeliveryToken,
    input: Pick<GitHubDeliveryProbeInput, 'owner' | 'repo'>,
  ): Promise<GitHubInstallationRepositoryAccess> {
    try {
      return await this.repositoryInspector({
        token: token.value,
        owner: input.owner,
        repo: input.repo,
      });
    } catch {
      throw new DeliveryError(
        'DELIVERY_REPOSITORY_SCOPE_INCOMPLETE',
        'GitHub App installation repository access diagnostic failed safely.',
        true,
      );
    }
  }
}

function defaultTokenProvider(localStateRoot: string | undefined): DeliveryTokenProvider {
  return {
    async acquire() {
      const token = await requireAppInstallationToken({ localStateRoot });
      return {
        value: token.token,
        expiresAt: token.expiresAt,
        installationId: token.installationId,
        permissions: token.permissions,
      };
    },
    invalidate() {
      clearTokenCache();
    },
  };
}

function validateProbeInput(
  input: Pick<GitHubDeliveryProbeInput, 'rootDir' | 'owner' | 'repo'>,
): void {
  if (
    !input.rootDir ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.repo)
  ) {
    throw new DeliveryError('DELIVERY_PUSH_FAILED', 'Delivery probe input is invalid.', false);
  }
}

function normalizeUuid(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-f0-9-]/g, '')
    .slice(0, 64);
  if (normalized.length < 8) {
    throw new DeliveryError('DELIVERY_PUSH_FAILED', 'Delivery probe identifier is invalid.', false);
  }
  return normalized;
}
