// TEST ONLY: no socket or external request is made by this resource fixture.
import { appendFileSync } from 'node:fs';
globalThis.fetch = async () => {
  throw new Error('FIXTURE_EXTERNAL_NETWORK_FORBIDDEN');
};
export class Agent {
  async close() {}
}
export class ProxyAgent extends Agent {}
export async function fetch(url: string): Promise<Response> {
  const path = new URL(url).pathname;
  appendFileSync(process.env.CLEANUP_FIXTURE_LOG!, `api:${path}\n`);
  const repo = { id: 123, full_name: 'example/qualification' };
  let data: unknown;
  if (path.endsWith('/installation')) data = { id: 2, app_id: 1, suspended_at: null };
  else if (path.endsWith('/access_tokens'))
    data = {
      token: 'synthetic-fixture-token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      permissions: { contents: 'write' },
    };
  else if (path === '/installation/repositories') data = { total_count: 1, repositories: [repo] };
  else if (path === '/repos/example/qualification') data = repo;
  else if (path === '/repos/example/qualification/pulls/1')
    data = {
      node_id: 'PR_test',
      number: 1,
      base: { repo },
      head: { repo, ref: 'fixture', sha: process.env.CLEANUP_FIXTURE_SHA },
    };
  else throw new Error('UNEXPECTED_FIXTURE_API');
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
