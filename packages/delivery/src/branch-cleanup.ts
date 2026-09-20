import {
  inspectInstallationRepositoryAccess,
  requireAppInstallationToken,
  resolveGitHubAppLocalStateRoot,
  type GitHubInstallationRepositoryAccess,
} from '@openslack/github';
import { DeliveryError } from './errors.js';
import { GitAskPassPublisher } from './git-transport.js';
import {
  assertDeliveryPermissions,
  diagnoseDeliveryPermissions,
} from './permission-diagnostics.js';
import type {
  BranchCleanupInput,
  ConditionalBranchDeleteResult,
  ConditionalBranchTransportInput,
  DeliveryTokenProvider,
  GitConditionalBranchDeleter,
} from './types.js';

export interface BranchCleanupDependencies {
  tokenProvider?: DeliveryTokenProvider;
  gitPublisher?: GitConditionalBranchDeleter;
  repositoryInspector?: (input: {
    token: string;
    owner: string;
    repo: string;
  }) => Promise<GitHubInstallationRepositoryAccess>;
}

/** Authentication is App-only, even when the caller's read evidence uses a PAT. */
async function prepare(
  input: BranchCleanupInput,
  deps: BranchCleanupDependencies,
): Promise<ConditionalBranchTransportInput> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  if (
    !input.rootDir ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.repo) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 600_000 ||
    /^openslack\/(?:claims|probes)(?:\/|$)/.test(input.branch)
  ) {
    throw new DeliveryError(
      'DELIVERY_PUSH_FAILED',
      'Invalid or reserved branch cleanup input.',
      false,
    );
  }
  let token;
  try {
    token = await withinDeadline(async () => {
      if (deps.tokenProvider) return deps.tokenProvider.acquire();
      const acquired = await requireAppInstallationToken({
        localStateRoot: resolveGitHubAppLocalStateRoot(input.rootDir),
        repository: { owner: input.owner, repo: input.repo },
      });
      return { value: acquired.token, permissions: acquired.permissions };
    }, deadline);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(
      'DELIVERY_AUTH_REQUIRED',
      'GitHub App installation token is unavailable.',
      false,
    );
  }
  assertDeliveryPermissions(
    diagnoseDeliveryPermissions(token.permissions).filter(
      (entry) => entry.capability === 'contents',
    ),
  );
  let access;
  try {
    access = await withinDeadline(
      () =>
        (deps.repositoryInspector ?? inspectInstallationRepositoryAccess)({
          token: token.value,
          owner: input.owner,
          repo: input.repo,
        }),
      deadline,
    );
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(
      'DELIVERY_REPOSITORY_SCOPE_INCOMPLETE',
      'Installation repository access could not be verified.',
      false,
    );
  }
  if (!access.complete || !access.accessible) {
    throw new DeliveryError(
      access.complete
        ? 'DELIVERY_REPOSITORY_NOT_INSTALLED'
        : 'DELIVERY_REPOSITORY_SCOPE_INCOMPLETE',
      'Installation repository access is not complete and accessible.',
      false,
    );
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new DeliveryError('DELIVERY_TIMEOUT', 'Branch cleanup deadline expired.', false);
  return { ...input, remote: input.remote ?? 'origin', token: token.value, timeoutMs: remaining };
}

async function withinDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new DeliveryError('DELIVERY_TIMEOUT', 'Branch cleanup deadline expired.', false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DeliveryError('DELIVERY_TIMEOUT', 'Branch cleanup deadline expired.', false),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readRemoteBranchSha(
  input: BranchCleanupInput,
  deps: BranchCleanupDependencies = {},
): Promise<string | null> {
  const ownedInput = { ...input };
  const ownedDeps = { ...deps };
  const prepared = await prepare(ownedInput, ownedDeps);
  return (ownedDeps.gitPublisher ?? new GitAskPassPublisher()).readRemoteBranchSha(prepared);
}

export async function deleteRemoteBranchIfAt(
  input: BranchCleanupInput & { expectedSha: string },
  deps: BranchCleanupDependencies = {},
): Promise<ConditionalBranchDeleteResult> {
  const ownedInput = { ...input };
  const ownedDeps = { ...deps };
  if (!/^[a-f0-9]{40}$/.test(ownedInput.expectedSha))
    throw new DeliveryError(
      'DELIVERY_PUSH_FAILED',
      'Expected branch SHA must be a full 40-hex object id.',
      false,
    );
  const prepared = await prepare(ownedInput, ownedDeps);
  // No authentication refresh or write retry: an attempted operation must be reconciled.
  return (ownedDeps.gitPublisher ?? new GitAskPassPublisher()).deleteRemoteRefIfAt({
    ...prepared,
    expectedSha: ownedInput.expectedSha,
  });
}
