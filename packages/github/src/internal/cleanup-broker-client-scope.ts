import { AsyncLocalStorage } from 'node:async_hooks';
import { Octokit } from '@octokit/rest';
import type { GitHubClient, GitHubClientOptions } from '../client.js';

export function createCleanupBrokerClient(
  token: string,
  owner: string,
  repo: string,
  fetch: typeof globalThis.fetch,
): GitHubClient {
  return {
    owner,
    repo,
    isDryRun: false,
    authMode: 'github_app_installation',
    octokit: new Octokit({
      auth: token,
      request: { fetch },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    }),
  };
}

const scope = new AsyncLocalStorage<{ client: GitHubClient; active: boolean }>();
function deny(): never {
  throw new Error('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
}

/** Internal fixed-worker composition. No environment, file or global token mutation. */
export function withCleanupBrokerClient<T>(
  client: GitHubClient,
  operation: () => Promise<T>,
): Promise<T> {
  if (
    scope.getStore() ||
    client.isDryRun ||
    client.authMode !== 'github_app_installation' ||
    !client.octokit ||
    !client.owner ||
    !client.repo
  )
    deny();
  const entry = { client: Object.freeze({ ...client }), active: true };
  return scope.run(entry, async () => {
    try {
      return await operation();
    } finally {
      entry.active = false;
    }
  });
}

/** Called before public client's caches/config resolution; never exported by index. */
export function cleanupBrokerClient(options: GitHubClientOptions): GitHubClient | undefined {
  const entry = scope.getStore();
  if (!entry) return undefined;
  if (!entry.active) deny();
  const { client } = entry;
  const expected = `${client.owner}/${client.repo}`;
  if (
    options.auth !== 'app' ||
    options.requireLive !== true ||
    options.strictEvidence !== true ||
    (options.repoFullName !== undefined && options.repoFullName !== expected) ||
    (options.owner !== undefined && options.owner !== client.owner) ||
    (options.repo !== undefined && options.repo !== client.repo) ||
    (options.repoFullName === undefined &&
      (options.owner !== client.owner || options.repo !== client.repo)) ||
    options.credentialStore !== undefined ||
    options.localStateRoot !== undefined
  )
    deny();
  if (client.tokenExpiresAt && !(Date.parse(client.tokenExpiresAt) > Date.now())) deny();
  return client;
}
