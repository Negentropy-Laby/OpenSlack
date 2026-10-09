import { AsyncLocalStorage } from 'node:async_hooks';
import { Octokit } from '@octokit/rest';
import type { GitHubClient, GitHubClientOptions } from '../client.js';

interface Lifetime {
  active: boolean;
  used: boolean;
  abort: AbortController;
  client: GitHubClient;
  owner: string;
  repo: string;
  expiresAt?: string;
  executionSignal?: AbortSignal;
}
const owned = new WeakMap<GitHubClient, Lifetime>();
const scope = new AsyncLocalStorage<{ client: GitHubClient; active: boolean }>();
function deny(): never {
  throw new Error('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
}

function check(lifetime: Lifetime, url?: string, method = 'GET'): void {
  const { client } = lifetime;
  if (
    !lifetime.active ||
    lifetime.abort.signal.aborted ||
    client.owner !== lifetime.owner ||
    client.repo !== lifetime.repo ||
    client.tokenExpiresAt !== lifetime.expiresAt ||
    (client.tokenExpiresAt !== undefined && !(Date.parse(client.tokenExpiresAt) > Date.now()))
  )
    deny();
  lifetime.executionSignal?.throwIfAborted();
  if (url === undefined) return;
  const target = new URL(url);
  const prefix = `/repos/${lifetime.owner}/${lifetime.repo}`;
  // Only REST reads under the bound repository. No GraphQL, alternate hosts,
  // writes, redirects to credentials, or public-client fallback.
  if (
    method !== 'GET' ||
    target.origin !== 'https://api.github.com' ||
    target.username ||
    target.password ||
    !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
  )
    deny();
}

/** Internal fixed-worker composition; the capability is revoked at scope exit. */
export function createCleanupBrokerClient(
  token: string,
  owner: string,
  repo: string,
  fetch: typeof globalThis.fetch,
  executionSignal?: AbortSignal,
): GitHubClient {
  if (!token || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) deny();
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    check(lifetime, request?.url ?? String(input), init?.method ?? request?.method ?? 'GET');
    const signals = [lifetime.abort.signal, executionSignal, init?.signal, request?.signal].filter(
      (s): s is AbortSignal => s !== null && s !== undefined,
    );
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, signal, redirect: 'error' });
    // A fetch implementation may ignore cancellation. Late data cannot be used.
    check(lifetime);
    signal.throwIfAborted();
    return response;
  };
  const octokit = new Octokit({
    auth: token,
    request: { fetch: guardedFetch },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  octokit.hook.before('request', (options) => {
    const endpoint = octokit.request.endpoint(options);
    check(lifetime, endpoint.url, endpoint.method);
    if (options.request?.fetch !== guardedFetch) deny();
  });
  // Derivation cannot establish a new trust root from mutable endpoint metadata.
  // All REST/defaults chains retain the hook captured at client construction.
  const pinnedRequestHook = octokit.request.endpoint.DEFAULTS.request?.hook;
  // Octokit's internal request hook already holds the original collection. Do
  // not expose its mutation API: a public wrap/before callback could bypass the
  // repository read and replace it with arbitrary work before guarded fetch.
  octokit.hook = new Proxy(octokit.hook, {
    apply() {
      deny();
    },
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? () => deny() : value;
    },
  });
  // REST methods and derived defaults must not replace the pinned transport or
  // remove its request hook. Metadata-only endpoint helpers remain available.
  function protect<F extends typeof octokit.request>(request: F): F {
    const endpoint = request.endpoint;
    const wrap = new Proxy(request, {
      async apply(target, thisArg, args: unknown[]) {
        check(lifetime);
        for (const arg of args) {
          if (arg && typeof arg === 'object' && 'request' in arg) {
            const options = (arg as { request?: { fetch?: unknown; hook?: unknown } }).request;
            if (
              options &&
              ((options.fetch !== undefined && options.fetch !== guardedFetch) || 'hook' in options)
            )
              deny();
          }
        }
        // Resolve the actual endpoint, including derived defaults. Public
        // metadata objects are mutable: the transport and hook must stay pinned
        // even if a caller changes DEFAULTS rather than passing request options.
        const options = Reflect.apply(endpoint, undefined, args) as ReturnType<typeof endpoint>;
        check(lifetime, options.url, options.method);
        if (options.request?.fetch !== guardedFetch || options.request?.hook !== pinnedRequestHook)
          deny();
        const signal = options.request?.signal as AbortSignal | undefined;
        signal?.throwIfAborted();
        const response = await Reflect.apply(target, thisArg, args);
        // Headers may arrive before the body is read. Parsed late data remains
        // subject to execution cancellation, scope revocation and token expiry.
        check(lifetime);
        signal?.throwIfAborted();
        return response;
      },
      get(target, key, receiver) {
        if (key === 'defaults')
          return (defaults: Parameters<F['defaults']>[0]) => {
            if (
              endpoint.DEFAULTS.request?.fetch !== guardedFetch ||
              endpoint.DEFAULTS.request?.hook !== pinnedRequestHook
            )
              deny();
            if (defaults.request && ('fetch' in defaults.request || 'hook' in defaults.request))
              deny();
            return protect(target.defaults(defaults));
          };
        return Reflect.get(target, key, receiver);
      },
    });
    return wrap as F;
  }
  // This capability exposes repository REST reads only. GraphQL's separate
  // request/defaults chain cannot be confined by a repository URL prefix, and
  // public auth() must not turn a revoked client into a reusable raw token.
  octokit.graphql = new Proxy(octokit.graphql, {
    async apply() {
      deny();
    },
    get(target, key, receiver) {
      if (key === 'defaults') return () => deny();
      return Reflect.get(target, key, receiver);
    },
  });
  octokit.auth = async () => deny();
  octokit.request = protect(octokit.request);
  for (const methods of Object.values(octokit.rest)) {
    for (const [name, method] of Object.entries(methods)) {
      (methods as unknown as Record<string, typeof octokit.request>)[name] = protect(
        method as typeof octokit.request,
      );
    }
  }
  const client: GitHubClient = {
    owner,
    repo,
    isDryRun: false,
    authMode: 'github_app_installation',
    octokit,
  };
  const lifetime: Lifetime = {
    active: false,
    used: false,
    abort: new AbortController(),
    client,
    owner,
    repo,
    executionSignal,
  };
  owned.set(client, lifetime);
  return client;
}

/** Public construction cannot supply an unguarded parallel client in this scope. */
export function assertNoCleanupBrokerClientConstruction(): void {
  if (scope.getStore()) deny();
}

export function withCleanupBrokerClient<T>(
  client: GitHubClient,
  operation: () => Promise<T>,
): Promise<T> {
  const lifetime = owned.get(client);
  if (
    scope.getStore() ||
    !lifetime ||
    lifetime.used ||
    client.isDryRun ||
    client.authMode !== 'github_app_installation'
  )
    deny();
  lifetime.expiresAt = client.tokenExpiresAt;
  lifetime.used = true;
  lifetime.active = true;
  const entry = { client: Object.freeze({ ...client }), active: true };
  return scope.run(entry, async () => {
    try {
      return await operation();
    } finally {
      entry.active = false;
      lifetime.active = false;
      lifetime.abort.abort(new Error('CLEANUP_BROKER_CLIENT_SCOPE_INVALID'));
    }
  });
}

/** Called before public client's caches/config resolution; not exported by index. */
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
