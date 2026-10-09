import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  decodeStrictJSON,
  githubProxyBypassed,
  validateGitHubNetwork,
  issueClaimRef,
  isValidCleanupBranch,
  isReservedCleanupBranch,
  isFullGitObjectId,
  parseTaskLinkMarker,
} from '../index.js';

describe('shared cleanup contracts', () => {
  it.each(['topic+fix', '开发/分支', 'release/1.0', 'topic', '@'])(
    'agrees with Git for valid branch %s',
    (branch) => {
      expect(isValidCleanupBranch(branch)).toBe(true);
      expect(spawnSync('git', ['check-ref-format', `refs/heads/${branch}`]).status).toBe(0);
    },
  );
  it.each([
    '../bad',
    'bad..ref',
    'with space',
    '.hidden',
    'path/.hidden',
    'topic.lock',
    'topic.lock/child',
    'path//double',
    '-option',
    'end.',
    'a@{b',
    'a\\b',
    'a\ud800',
    'a'.repeat(1025),
  ])('rejects invalid branch %s', (branch) => expect(isValidCleanupBranch(branch)).toBe(false));
  it.each([40, 64])('reads a complete %i-character object ID', (length) => {
    expect(isFullGitObjectId('a'.repeat(length))).toBe(true);
    expect(isFullGitObjectId('a'.repeat(length - 1))).toBe(false);
  });
  it.each([
    'main',
    'default',
    'openslack/claims',
    'openslack/claims/issue-1',
    'openslack/probes/x',
  ])('reserves branch %s', (branch) =>
    expect(isReservedCleanupBranch(branch, 'default')).toBe(true),
  );
  it('renders both claim-ref formats from one issue binding', () => {
    expect(issueClaimRef(42)).toBe('heads/openslack/claims/issue-42');
    expect(issueClaimRef(42, 'canonical')).toBe('refs/heads/openslack/claims/issue-42');
    expect(() => issueClaimRef(0)).toThrow('ISSUE_CLAIM_REF_INVALID');
  });
  it.each([
    ' api.github.com:443 ',
    ' .API.GITHUB.COM:443 ',
    ' .github.com:443 ',
    'GITHUB.COM',
    '*',
    'localhost, .github.com:443',
  ])('bypasses pinned GitHub hosts for %j', (noProxy) =>
    expect(githubProxyBypassed(noProxy)).toBe(true),
  );
  it.each(['api.github.com:444', 'github.com.evil', 'evilgithub.com', 'localhost', ''])(
    'does not bypass pinned hosts for %j',
    (noProxy) => expect(githubProxyBypassed(noProxy)).toBe(false),
  );
  it.each([
    'http://proxy',
    'http://proxy/',
    'http://proxy:80',
    'https://proxy:443/',
    'http://proxy:1',
    'http://proxy:65535',
  ])('accepts explicit proxy %s', (proxy) =>
    expect(() => validateGitHubNetwork(proxy, '')).not.toThrow(),
  );
  it.each([
    'http://proxy:0',
    'http://proxy:65536',
    'http://proxy:99999',
    'http://user:synthetic@proxy',
    'http://proxy/path',
    'http://proxy?',
    'http://proxy#',
    ' http://proxy',
    'http://proxy\\other',
  ])('rejects unsafe proxy %s', (proxy) =>
    expect(() => validateGitHubNetwork(proxy, '')).toThrow('GITHUB_NETWORK_INVALID'),
  );
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"nested":{"a":1,"a":2}}',
    '{"a":"\\ud800"}',
    'null null',
    '\ufeff{}',
  ])('rejects ambiguous JSON %s', (value) =>
    expect(() => decodeStrictJSON(value, 1024)).toThrow('STRICT_JSON_INVALID'),
  );
  it('enforces JSON byte and nesting budgets while preserving valid escaped keys', () => {
    expect(decodeStrictJSON('{"\\u0061":1}', 64)).toEqual({ a: 1 });
    expect(() => decodeStrictJSON('"开发"', 4)).toThrow();
    expect(() => decodeStrictJSON('[[[0]]]', 64, 2)).toThrow();
    expect(() => decodeStrictJSON(Buffer.from([255]), 64)).toThrow();
  });
  it.each(['good', 'x'.repeat(128), 'task_1.A-b'])('accepts safe task identities %s', (taskId) => {
    const body = `<!-- openslack-task-link ${JSON.stringify({ schema: 'openslack.task_link.v1', issue_number: 42, agent_id: taskId, task_id: taskId, run_id: taskId, claim_ref: issueClaimRef(42, 'canonical') })} -->`;
    expect(parseTaskLinkMarker(body).state).toBe('VALID');
  });
});
