import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claimRefPresent,
  getCleanupPREvidence,
  getDefaultBranch,
  inspectInstallationRepositoryAccess,
  isBranchProtected,
  listOpenPRsForBranch,
} from '@openslack/github';
import {
  createCleanupBrokerClient,
  withCleanupBrokerClient,
} from '@openslack/github/cleanup-broker-internal';
import {
  acquireCleanupExecutorToken,
  createCleanupExecutorJsonRequest,
} from '../internal/cleanup-executor-auth.js';
import { CLEANUP_APP_PERMISSIONS } from '../internal/cleanup-app-permissions.js';
import { createCleanupExecutorHttpFixture } from './fixtures/cleanup-executor-http.js';
import { CLEANUP_FIXTURE_REPOSITORY as repository } from './fixtures/cleanup-executor-repository.js';
import {
  cleanupFixtureFailure,
  readCleanupFixtureLog,
} from './fixtures/cleanup-executor-diagnostics.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('FIXTURE_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}
async function tokenBody(response: Response) {
  const data = object(await response.json());
  if (typeof data.token !== 'string') throw new Error('FIXTURE_TOKEN_REQUIRED');
  return { token: data.token, permissions: object(data.permissions) };
}

const appHeader = { Authorization: 'Bearer synthetic.app.signature' };
const tokenPath = `/app/installations/${repository.installationId}/access_tokens`;
const options = {
  owner: repository.owner,
  repo: repository.name,
  auth: 'app' as const,
  requireLive: true,
  strictEvidence: true,
};
function model() {
  return createCleanupExecutorHttpFixture({ sha: 'a'.repeat(40) });
}
async function mint(fixture: ReturnType<typeof model>, body?: unknown) {
  return fixture.fetch(`https://api.github.com${tokenPath}`, {
    method: 'POST',
    headers: appHeader,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('portable cleanup executor token request (production implementation)', () => {
  let privateKey: string;
  beforeAll(() => {
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
  });
  function input() {
    return {
      repository: repository.fullName,
      appId: repository.appId,
      installationId: repository.installationId,
      privateKey,
      deadlineMs: Date.now() + 30_000,
    };
  }
  it('serializes exactly the four approved permissions and one repository, once', async () => {
    const fixture = model();
    const json = createCleanupExecutorJsonRequest(fixture.fetch);
    const token = await acquireCleanupExecutorToken(input(), json);
    // Deliberately independent oracle: changing the shared ceiling must not silently
    // update both the implementation and every test's expected permission set.
    expect(fixture.calls.filter((call) => call.method === 'POST')).toEqual([
      expect.objectContaining({
        path: tokenPath,
        status: 201,
        permissions: { contents: 'write', pull_requests: 'read', issues: 'read', metadata: 'read' },
        repositories: [repository.name],
      }),
    ]);
    expect(token.permissions).toEqual(CLEANUP_APP_PERMISSIONS);
    expect(Object.isFrozen(CLEANUP_APP_PERMISSIONS)).toBe(true);
  });
  it.each(['id', 'app_id', 'suspended_at'] as const)(
    'rejects installation mismatch %s before requesting a token',
    async (field) => {
      const fixture = model();
      const json = createCleanupExecutorJsonRequest(async (url, init) => {
        const response = await fixture.fetch(url, init);
        const data = object(await response.json());
        return new Response(
          JSON.stringify({ ...data, [field]: field === 'suspended_at' ? 'now' : 999 }),
        );
      });
      await expect(acquireCleanupExecutorToken(input(), json)).rejects.toThrow(
        'CLEANUP_EXECUTOR_INSTALLATION_MISMATCH',
      );
      expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    },
  );
  it.each(['empty', 'invalid expiry', 'deadline', 'contents', 'permissions'])(
    'retains token response rejection for %s',
    async (kind) => {
      const fixture = model();
      const request = input();
      const json = createCleanupExecutorJsonRequest(async (url, init) => {
        const response = await fixture.fetch(url, init);
        if (init?.method !== 'POST') return response;
        const data = object(await response.json());
        if (kind === 'empty') data.token = '';
        if (kind === 'invalid expiry') data.expires_at = 'invalid';
        if (kind === 'deadline') data.expires_at = new Date(request.deadlineMs).toISOString();
        if (kind === 'contents') object(data.permissions).contents = 'read';
        if (kind === 'permissions') data.permissions = [];
        return new Response(JSON.stringify(data));
      });
      await expect(acquireCleanupExecutorToken(request, json)).rejects.toThrow(
        'CLEANUP_EXECUTOR_TOKEN_INVALID',
      );
    },
  );
  it('retains fixed request headers and bounds response bytes before decoding', async () => {
    let cancelled = false;
    const json = createCleanupExecutorJsonRequest(async (url, init) => {
      expect(url).toBe(`https://api.github.com${tokenPath}`);
      expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2022-11-28');
      expect(new Headers(init?.headers).get('accept')).toBe('application/vnd.github+json');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ repositories: [repository.name] }));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    await expect(
      json(tokenPath, 'synthetic', 'POST', { repositories: [repository.name] }),
    ).rejects.toThrow('CLEANUP_EXECUTOR_API_FAILED');
    expect(cancelled).toBe(true);
  });
  it.each(['http', 'no body', 'array', 'utf8', 'json'])(
    'retains bounded JSON rejection for %s',
    async (kind) => {
      const json = createCleanupExecutorJsonRequest(async () => {
        if (kind === 'http') return new Response('{}', { status: 422 });
        if (kind === 'no body') return new Response(null);
        if (kind === 'array') return new Response('[]');
        if (kind === 'utf8') return new Response(new Uint8Array([0xff]));
        return new Response('{');
      });
      await expect(json('/fixture', 'synthetic')).rejects.toThrow();
    },
  );
  it('completes real Octokit evidence reads, pagination, and claim absence without resource stubs', async () => {
    const fixture = createCleanupExecutorHttpFixture({
      sha: 'a'.repeat(40),
      dependencySecondPage: true,
    });
    const json = createCleanupExecutorJsonRequest(fixture.fetch);
    const token = await acquireCleanupExecutorToken(input(), json);
    const client = createCleanupBrokerClient(
      token.token,
      repository.owner,
      repository.name,
      fixture.fetch,
    );
    await withCleanupBrokerClient(client, async () => {
      const pr = await getCleanupPREvidence(1, options);
      expect(pr).toMatchObject({
        merged: true,
        headRef: repository.branch,
        headSha: 'a'.repeat(40),
      });
      expect(await getDefaultBranch(options, pr.repositoryEvidence)).toBe(repository.defaultBranch);
      expect(await isBranchProtected(repository.branch, options)).toBe(false);
      expect(await listOpenPRsForBranch(repository.branch, options)).toEqual([]);
      expect(await claimRefPresent(42, options, pr.repositoryEvidence)).toBe(false);
      expect(
        await inspectInstallationRepositoryAccess(
          { token: token.token, ...options },
          {
            listPage: async ({ page, perPage }) => {
              const data = await json(
                `/installation/repositories?per_page=${perPage}&page=${page}`,
                token.token,
              );
              const repositories = data.repositories as Array<{ full_name: string }>;
              return {
                totalCount: data.total_count as number,
                repositories: repositories.map((r) => ({ fullName: r.full_name })),
              };
            },
          },
        ),
      ).toMatchObject({ accessible: true });
    });
    const pulls = fixture.calls.filter((call) => call.path === `${repository.apiPath}/pulls`);
    expect(pulls.map((call) => call.query)).toEqual([
      {
        head: `${repository.owner}:${repository.branch}`,
        state: 'open',
        per_page: '100',
        page: '1',
      },
      {
        head: `${repository.owner}:${repository.branch}`,
        state: 'open',
        per_page: '100',
        page: '2',
      },
      { base: repository.branch, state: 'open', per_page: '100', page: '1' },
      { base: repository.branch, state: 'open', per_page: '100', page: '2' },
    ]);
    expect(
      fixture.calls.filter((call) => call.path === `${repository.apiPath}/git/ref/heads/main`),
    ).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.reason === 'FIXTURE_CLAIM_ABSENT')).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.path === repository.apiPath)).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('permission-aware offline HTTP boundary', () => {
  it('advertises the correct next page without changing the page-size filter', async () => {
    const fixture = createCleanupExecutorHttpFixture({
      sha: 'a'.repeat(40),
      dependencySecondPage: true,
    });
    const token = await tokenBody(await mint(fixture));
    const response = await fixture.fetch(
      `https://api.github.com${repository.apiPath}/pulls?state=open&head=${repository.owner}:${repository.branch}&per_page=100&page=1`,
      { headers: { Authorization: `Bearer ${token.token}` } },
    );
    expect(response.status).toBe(200);
    const next = new URL(response.headers.get('link')!.match(/^<([^>]+)>/)![1]!);
    expect(next.searchParams.get('per_page')).toBe('100');
    expect(next.searchParams.get('page')).toBe('2');
  });
  it.each([
    [{ permissions: { administration: 'read' } }, 'FIXTURE_TOKEN_PERMISSION_DENIED'],
    [{ permissions: { pull_requests: 'write' } }, 'FIXTURE_TOKEN_PERMISSION_DENIED'],
    [{ permissions: { contents: 1 } }, 'FIXTURE_TOKEN_PERMISSION_DENIED'],
    [{ permissions: null }, 'FIXTURE_TOKEN_PERMISSIONS_INVALID'],
    [{ permissions: [] }, 'FIXTURE_TOKEN_PERMISSIONS_INVALID'],
    [{ repositories: ['wrong'] }, 'FIXTURE_TOKEN_REPOSITORY_DENIED'],
    [{ repositories: [repository.name, 'wrong'] }, 'FIXTURE_TOKEN_REPOSITORY_DENIED'],
    [{ repositories: null }, 'FIXTURE_TOKEN_REPOSITORY_DENIED'],
    [null, 'FIXTURE_TOKEN_BODY_INVALID'],
    [[], 'FIXTURE_TOKEN_BODY_INVALID'],
  ])('refuses an invalid token request with a specific modeled 422 (%j)', async (body, reason) => {
    const fixture = model();
    const response = await mint(fixture, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: reason });
  });
  it('rejects malformed JSON without throwing a raw parser error', async () => {
    const fixture = model();
    const response = await fixture.fetch(`https://api.github.com${tokenPath}`, {
      method: 'POST',
      headers: appHeader,
      body: '{',
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: 'FIXTURE_TOKEN_BODY_INVALID' });
  });
  it.each([undefined, {}, { repositories: [repository.name] }])(
    'uses the installation grants when the whole permissions field is omitted (%j)',
    async (body) => {
      const response = await mint(model(), body);
      expect(response.status).toBe(201);
      expect(object(await response.json()).permissions).toEqual(CLEANUP_APP_PERMISSIONS);
    },
  );
  it('returns only the explicit subset plus Metadata, with independent effective permissions', async () => {
    const fixture = model();
    const requested = { contents: 'read' };
    const response = await mint(fixture, { permissions: requested });
    const data = await tokenBody(response);
    expect(data.permissions).toEqual({ contents: 'read', metadata: 'read' });
    expect(data.permissions).not.toHaveProperty('pull_requests');
    data.permissions.pull_requests = 'read';
    requested.contents = 'write';
    const client = createCleanupBrokerClient(
      data.token,
      repository.owner,
      repository.name,
      fixture.fetch,
    );
    await withCleanupBrokerClient(client, async () => {
      await expect(getCleanupPREvidence(1, options)).rejects.toMatchObject({ status: 403 });
    });
    expect(fixture.calls.some((call) => call.reason === 'FIXTURE_PULL_REQUESTS_REQUIRED')).toBe(
      true,
    );
  });
  it('denies classic protection and unknown endpoints through the real scoped client', async () => {
    const fixture = model();
    const token = await tokenBody(await mint(fixture));
    const client = createCleanupBrokerClient(
      token.token,
      repository.owner,
      repository.name,
      fixture.fetch,
    );
    await withCleanupBrokerClient(client, async () => {
      await expect(
        client.octokit.request(
          `GET ${repository.apiPath}/branches/${repository.branch}/protection`,
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        client.octokit.request(`GET ${repository.apiPath}/unknown`),
      ).rejects.toMatchObject({ status: 501 });
    });
    expect(fixture.calls.map((call) => call.reason)).toContain('FIXTURE_ADMINISTRATION_REQUIRED');
    expect(fixture.calls.map((call) => call.reason)).toContain('FIXTURE_UNEXPECTED_API');
  });
  it('rejects missing Contents, wrong repository, method and token without any network fallback', async () => {
    const fixture = model();
    const token = await tokenBody(await mint(fixture, { permissions: {} }));
    const headers = { Authorization: `Bearer ${token.token}` };
    const cases = [
      [`${repository.apiPath}/branches/${repository.branch}`, 'GET', 'FIXTURE_CONTENTS_REQUIRED'],
      ['/repos/example/wrong', 'GET', 'FIXTURE_REPOSITORY_DENIED'],
      [repository.apiPath, 'DELETE', 'FIXTURE_METHOD_DENIED'],
    ];
    for (const [path, method, reason] of cases) {
      const response = await fixture.fetch(`https://api.github.com${path}`, { method, headers });
      expect(response.ok).toBe(false);
      expect(await response.json()).toEqual({ message: reason });
    }
    expect((await fixture.fetch(`https://api.github.com${repository.apiPath}`)).status).toBe(401);
    expect((await fixture.fetch('https://outside.invalid/')).status).toBe(403);
  });
  it('keeps state private to a fixture and never changes the global HTTP implementation', async () => {
    const globalFetch = globalThis.fetch;
    const first = model(),
      second = model();
    const token = await tokenBody(await mint(first));
    expect(
      (
        await second.fetch(`https://api.github.com${repository.apiPath}`, {
          headers: { Authorization: `Bearer ${token.token}` },
        })
      ).status,
    ).toBe(401);
    expect(globalThis.fetch).toBe(globalFetch);
  });
  it('reports status, reason and safe binding diagnostics, never secret sentinels', async () => {
    const fixture = model();
    await fixture.fetch(`https://api.github.com${tokenPath}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer JWT_SECRET_SENTINEL' },
      body: 'PEM_SECRET_SENTINEL',
    });
    await mint(fixture, {
      permissions: { administration: 'read' },
      repositories: [repository.name],
    });
    const diagnostic = cleanupFixtureFailure(
      '/fixture directory',
      {
        calls: fixture.calls.map((call) => `http:${JSON.stringify(call)}`),
        logStatus: 'OK',
      },
      'CLEANUP_EXECUTOR_API_FAILED',
    );
    expect(diagnostic).toContain('422');
    expect(diagnostic).toContain('FIXTURE_TOKEN_PERMISSION_DENIED');
    expect(diagnostic).toContain('administration');
    expect(diagnostic).toContain(repository.name);
    expect(diagnostic).toContain('/fixture directory');
    expect(diagnostic).not.toMatch(
      /JWT_SECRET_SENTINEL|PEM_SECRET_SENTINEL|synthetic-fixture-token|Authorization/,
    );
    expect(
      readCleanupFixtureLog(join(tmpdir(), 'missing-fixture-log', 'calls.log')).logStatus,
    ).toBe('FIXTURE_LOG_UNAVAILABLE');
  });
});
