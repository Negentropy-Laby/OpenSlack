// TEST ONLY: no socket or external request is made by this resource fixture.
import { appendFileSync } from 'node:fs';
globalThis.fetch = async () => {
  throw new Error('FIXTURE_EXTERNAL_NETWORK_FORBIDDEN');
};
export class Agent {
  async close() {}
}
export class ProxyAgent extends Agent {}
export async function fetch(url: string, init?: RequestInit): Promise<Response> {
  const path = new URL(url).pathname;
  appendFileSync(process.env.CLEANUP_FIXTURE_LOG!, `api:${path}\n`);
  const repo = { id: 123, full_name: 'example/qualification', default_branch: 'main' };
  let data: unknown;
  if (path.endsWith('/installation')) data = { id: 2, app_id: 1, suspended_at: null };
  else if (path.endsWith('/access_tokens')) {
    // Model the selected installation's actual permission ceiling. GitHub
    // refuses token requests containing permissions the App was not granted.
    const granted: Record<string, string> = {
      contents: 'write',
      pull_requests: 'read',
      issues: 'read',
      metadata: 'read',
    };
    const request: { permissions: Record<string, string>; repositories: string[] } = JSON.parse(
      String(init?.body),
    );
    appendFileSync(
      process.env.CLEANUP_FIXTURE_LOG!,
      `token-permissions:${Object.entries(request.permissions)
        .map(([name, level]) => `${name}=${level}`)
        .sort()
        .join(',')}\n`,
    );
    if (
      request.repositories.length !== 1 ||
      request.repositories[0] !== 'qualification' ||
      Object.entries(request.permissions).some(([name, level]) => granted[name] !== level)
    ) {
      return new Response(
        JSON.stringify({ message: 'Unapproved token permission or repository' }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    data = {
      token: 'synthetic-fixture-token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      permissions: request.permissions,
    };
  } else if (path === '/installation/repositories') data = { total_count: 1, repositories: [repo] };
  else if (path === '/repos/example/qualification') data = repo;
  else if (path === '/repos/example/qualification/pulls/1')
    data = {
      node_id: 'PR_test',
      merged: true,
      body: '',
      number: 1,
      base: { repo, ref: 'main', sha: process.env.CLEANUP_FIXTURE_SHA },
      head: { repo, ref: 'fixture', sha: process.env.CLEANUP_FIXTURE_SHA },
    };
  else throw new Error('UNEXPECTED_FIXTURE_API');
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
