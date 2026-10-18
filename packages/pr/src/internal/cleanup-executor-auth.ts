import { createGitHubAppJwt } from '@openslack/github/cleanup-broker-internal';
import { CLEANUP_APP_PERMISSIONS } from './cleanup-app-permissions.js';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Private executor implementation. The caller supplies its host/signal-bound fetch. */
export function createCleanupExecutorJsonRequest(fetchBound: typeof globalThis.fetch) {
  return async (
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchBound('https://api.github.com' + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('CLEANUP_EXECUTOR_API_FAILED');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('CLEANUP_EXECUTOR_API_FAILED');
    let n = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      n += next.value.length;
      if (n > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('CLEANUP_EXECUTOR_API_FAILED');
      }
      chunks.push(next.value);
    }
    const result: unknown = JSON.parse(
      new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!object(result)) throw new Error('CLEANUP_EXECUTOR_API_FAILED');
    return result;
  };
}

/** Not a package export or an alternate credential path. */
export async function acquireCleanupExecutorToken(
  input: {
    repository: string;
    appId: number;
    installationId: number;
    privateKey: string;
    deadlineMs: number;
  },
  json: ReturnType<typeof createCleanupExecutorJsonRequest>,
): Promise<{ token: string; expires_at: string; permissions: Record<string, unknown> }> {
  const jwt = createGitHubAppJwt(String(input.appId), input.privateKey);
  const installation = await json(`/repos/${input.repository}/installation`, jwt);
  if (
    installation.id !== input.installationId ||
    installation.app_id !== input.appId ||
    installation.suspended_at !== null
  )
    throw new Error('CLEANUP_EXECUTOR_INSTALLATION_MISMATCH');
  const token = await json(
    `/app/installations/${input.installationId}/access_tokens`,
    jwt,
    'POST',
    {
      repositories: [input.repository.split('/')[1]],
      permissions: CLEANUP_APP_PERMISSIONS,
    },
  );
  if (
    typeof token.token !== 'string' ||
    !token.token ||
    typeof token.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(token.expires_at)) ||
    Date.parse(token.expires_at) <= input.deadlineMs ||
    !object(token.permissions) ||
    token.permissions.contents !== 'write'
  )
    throw new Error('CLEANUP_EXECUTOR_TOKEN_INVALID');
  return { token: token.token, expires_at: token.expires_at, permissions: token.permissions };
}
