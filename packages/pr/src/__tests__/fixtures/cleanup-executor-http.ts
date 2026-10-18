// Pure TEST-ONLY HTTP model. No sockets, global fetch changes, or environment state.
import { CLEANUP_APP_PERMISSIONS } from '../../internal/cleanup-app-permissions.js';
import { CLEANUP_FIXTURE_REPOSITORY as repository } from './cleanup-executor-repository.js';

export interface CleanupFixtureCall {
  method: string;
  path: string;
  status: number;
  reason: string;
  query: Record<string, string>;
  permissions?: Record<string, string>;
  repositories?: string[];
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
// Diagnostics are a closed projection; never record headers, tokens, raw bodies or JWTs.
function safePermissions(value: unknown): Record<string, string> {
  if (!object(value)) return { invalid: '<invalid>' };
  return Object.fromEntries(
    Object.entries(value).map(([key, level]) => [
      /^[a-z_]{1,64}$/.test(key) ? key : '<invalid>',
      level === 'read' || level === 'write' ? level : '<invalid>',
    ]),
  );
}

export function createCleanupExecutorHttpFixture(options: {
  sha: string;
  protected?: boolean;
  dependencySecondPage?: boolean;
  onCall?: (call: CleanupFixtureCall) => void;
}) {
  const calls: CleanupFixtureCall[] = [];
  const tokens = new Map<string, Record<string, string>>();
  const repo = {
    id: repository.id,
    full_name: repository.fullName,
    default_branch: repository.defaultBranch,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const call: CleanupFixtureCall = {
      method: request.method,
      path,
      query: Object.fromEntries(
        ['head', 'base', 'state', 'per_page', 'page']
          .filter((key) => url.searchParams.has(key))
          .map((key) => [key, url.searchParams.get(key)!]),
      ),
      status: 0,
      reason: '',
    };
    const respond = (
      status: number,
      reason: string,
      data: unknown,
      headers?: Record<string, string>,
    ) => {
      call.status = status;
      call.reason = reason;
      calls.push(structuredClone(call));
      options.onCall?.(structuredClone(call));
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    };
    const refuse = (status: number, code: string) => respond(status, code, { message: code });
    if (url.origin !== 'https://api.github.com') return refuse(403, 'FIXTURE_HOST_DENIED');
    const authorization = request.headers.get('authorization') ?? '';
    const isApp = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization);
    if (path === `${repository.apiPath}/installation`) {
      if (request.method !== 'GET') return refuse(405, 'FIXTURE_METHOD_DENIED');
      if (!isApp) return refuse(401, 'FIXTURE_APP_AUTH_REQUIRED');
      return respond(200, 'OK', {
        id: repository.installationId,
        app_id: repository.appId,
        suspended_at: null,
      });
    }
    if (path === `/app/installations/${repository.installationId}/access_tokens`) {
      if (request.method !== 'POST') return refuse(405, 'FIXTURE_METHOD_DENIED');
      if (!isApp) return refuse(401, 'FIXTURE_APP_AUTH_REQUIRED');
      let body: unknown;
      try {
        const text = await request.text();
        body = text ? JSON.parse(text) : {};
      } catch {
        return refuse(422, 'FIXTURE_TOKEN_BODY_INVALID');
      }
      if (
        !object(body) ||
        Object.keys(body).some((key) => !['permissions', 'repositories'].includes(key))
      )
        return refuse(422, 'FIXTURE_TOKEN_BODY_INVALID');
      call.permissions = safePermissions(body.permissions ?? CLEANUP_APP_PERMISSIONS);
      if (Array.isArray(body.repositories))
        call.repositories = body.repositories.map((value: unknown) =>
          typeof value === 'string' && /^[\w.-]{1,100}$/.test(value) ? value : '<invalid>',
        );
      if (
        body.repositories !== undefined &&
        (!Array.isArray(body.repositories) ||
          body.repositories.length !== 1 ||
          body.repositories[0] !== repository.name)
      )
        return refuse(422, 'FIXTURE_TOKEN_REPOSITORY_DENIED');
      const requested =
        body.permissions === undefined ? { ...CLEANUP_APP_PERMISSIONS } : body.permissions;
      if (!object(requested)) return refuse(422, 'FIXTURE_TOKEN_PERMISSIONS_INVALID');
      const granted: Readonly<Record<string, string>> = CLEANUP_APP_PERMISSIONS;
      if (
        Object.entries(requested).some(
          ([name, level]) =>
            !Object.hasOwn(granted, name) ||
            (level !== 'read' && level !== 'write') ||
            (level === 'write' && granted[name] !== 'write'),
        )
      )
        return refuse(422, 'FIXTURE_TOKEN_PERMISSION_DENIED');
      const effective = { ...requested, metadata: 'read' } as Record<string, string>;
      const token = `synthetic-fixture-token-${tokens.size + 1}`;
      tokens.set(token, { ...effective });
      return respond(201, 'CREATED', {
        token,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { ...effective },
      });
    }
    const effective = tokens.get(authorization.replace(/^(?:Bearer|token) /i, ''));
    if (!effective) return refuse(401, 'FIXTURE_INSTALLATION_AUTH_REQUIRED');
    if (request.method !== 'GET') return refuse(405, 'FIXTURE_METHOD_DENIED');
    const need = (name: string) => effective[name] === 'read' || effective[name] === 'write';
    if (path === '/installation/repositories')
      return respond(200, 'OK', { total_count: 1, repositories: [repo] });
    if (path !== repository.apiPath && !path.startsWith(`${repository.apiPath}/`))
      return refuse(403, 'FIXTURE_REPOSITORY_DENIED');
    const route = path.slice(repository.apiPath.length);
    if (route === '')
      return need('metadata') ? respond(200, 'OK', repo) : refuse(403, 'FIXTURE_METADATA_REQUIRED');
    if (route === `/branches/${repository.branch}/protection`)
      return need('administration')
        ? respond(200, 'OK', {})
        : refuse(403, 'FIXTURE_ADMINISTRATION_REQUIRED');
    if (route === `/branches/${repository.branch}`)
      return need('contents')
        ? respond(200, 'OK', { name: repository.branch, protected: options.protected ?? false })
        : refuse(403, 'FIXTURE_CONTENTS_REQUIRED');
    if (route === `/rules/branches/${repository.branch}`)
      return need('metadata') ? respond(200, 'OK', []) : refuse(403, 'FIXTURE_METADATA_REQUIRED');
    if (route === '/pulls/1')
      return need('pull_requests')
        ? respond(200, 'OK', {
            node_id: 'PR_test',
            merged: true,
            body: '',
            number: 1,
            base: { repo, ref: repository.defaultBranch, sha: options.sha },
            head: { repo, ref: repository.branch, sha: options.sha },
          })
        : refuse(403, 'FIXTURE_PULL_REQUESTS_REQUIRED');
    if (route === '/pulls') {
      if (!need('pull_requests')) return refuse(403, 'FIXTURE_PULL_REQUESTS_REQUIRED');
      const head = url.searchParams.get('head');
      const base = url.searchParams.get('base');
      const page = url.searchParams.get('page');
      if (
        url.searchParams.get('state') !== 'open' ||
        url.searchParams.get('per_page') !== '100' ||
        !/^[1-9]\d*$/.test(page ?? '') ||
        !(
          (head === `${repository.owner}:${repository.branch}` && base === null) ||
          (base === repository.branch && head === null)
        )
      )
        return refuse(422, 'FIXTURE_PR_FILTER_INVALID');
      const next = new URL(url);
      next.searchParams.set('page', '2');
      return respond(
        200,
        'OK',
        [],
        options.dependencySecondPage && page === '1'
          ? { link: `<${next.href}>; rel="next"` }
          : undefined,
      );
    }
    if (route.startsWith('/git/ref/')) {
      if (!need('contents')) return refuse(403, 'FIXTURE_CONTENTS_REQUIRED');
      const ref = route.slice('/git/ref/'.length);
      if (ref === `heads/${repository.defaultBranch}`)
        return respond(200, 'OK', { ref: `refs/${ref}`, object: { sha: options.sha } });
      if (/^heads\/openslack\/claims\/issue-[1-9]\d*$/.test(ref))
        return refuse(404, 'FIXTURE_CLAIM_ABSENT');
    }
    return refuse(501, 'FIXTURE_UNEXPECTED_API');
  };
  return { fetch, calls };
}
