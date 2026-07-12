import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerGitCredentialPrompt, GitAskPassPublisher } from '../index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitAskPassPublisher', () => {
  it('answers only exact username and password prompt classes', () => {
    expect(answerGitCredentialPrompt('Username for https://github.com:', 'secret')).toBe(
      'x-access-token',
    );
    expect(answerGitCredentialPrompt('Password for https://github.com:', 'secret')).toBe('secret');
    expect(answerGitCredentialPrompt('Unknown prompt', 'secret')).toBeNull();
  });

  it('keeps the token out of argv and parent env while disabling credentials and hooks', () => {
    const token = 'delivery-canary-token';
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawn = vi.fn(
      (_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options.env });
        if (args[0] === 'remote') return result('https://github.com/acme/repo.git\n');
        if (args[0] === 'rev-parse') return result(`${'a'.repeat(40)}\n`);
        if (args.includes('ls-remote')) return result(`${'a'.repeat(40)}\trefs/heads/topic\n`);
        return result('');
      },
    ) as unknown as typeof spawnSync;
    const originalGitHub = process.env.GITHUB_TOKEN;
    const originalGh = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'human-token';
    process.env.GH_TOKEN = 'human-gh-token';
    try {
      const publisher = new GitAskPassPublisher({ spawn });
      expect(
        publisher.push({
          rootDir: '.',
          remote: 'origin',
          branch: 'topic',
          owner: 'acme',
          repo: 'repo',
          token,
          timeoutMs: 1000,
        }),
      ).toEqual({ branchSha: 'a'.repeat(40), remoteSha: 'a'.repeat(40) });
    } finally {
      restoreEnv('GITHUB_TOKEN', originalGitHub);
      restoreEnv('GH_TOKEN', originalGh);
    }
    const push = calls.find((call) => call.args.includes('push'))!;
    const remoteRead = calls.find((call) => call.args.includes('ls-remote'))!;
    expect(JSON.stringify(push.args)).not.toContain(token);
    expect(push.args).toContain('credential.helper=');
    expect(push.args.some((arg) => arg.startsWith('core.hooksPath='))).toBe(true);
    expect(push.args).toContain('HEAD:refs/heads/topic');
    expect(push.env?.GITHUB_TOKEN).toBeUndefined();
    expect(push.env?.GH_TOKEN).toBeUndefined();
    expect(push.env?.OPENSLACK_GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(push.env?.OPENSLACK_GIT_ASKPASS_TOKEN).toBe(token);
    expect(remoteRead.args).toContain('credential.helper=');
    expect(remoteRead.env?.GITHUB_TOKEN).toBeUndefined();
    expect(remoteRead.env?.GH_TOKEN).toBeUndefined();
    expect(remoteRead.env?.OPENSLACK_GIT_ASKPASS_TOKEN).toBe(token);
    expect(remoteRead.env?.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(remoteRead.env?.GIT_TRACE).toBeUndefined();
    expect(process.env.OPENSLACK_GIT_ASKPASS_TOKEN).toBeUndefined();
  });

  it('rejects a push URL that does not match the API repository before sending a token', () => {
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      if (args[0] === 'remote') return result('https://github.com/attacker/other.git\n');
      return result(`${'a'.repeat(40)}\n`);
    }) as unknown as typeof spawnSync;
    const publisher = new GitAskPassPublisher({ spawn });
    expect(() =>
      publisher.push({
        rootDir: '.',
        remote: 'origin',
        branch: 'topic',
        owner: 'acme',
        repo: 'repo',
        token: 'must-not-be-sent',
        timeoutMs: 1000,
      }),
    ).toThrow('does not match');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('surfaces redacted porcelain rejection details written to stdout', () => {
    const token = 'delivery-canary-token';
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      if (args[0] === 'remote') return result('https://github.com/acme/repo.git\n');
      if (args[0] === 'rev-parse') return result(`${'a'.repeat(40)}\n`);
      if (args.includes('push')) {
        return {
          pid: 1,
          output: [],
          stdout: `!\tHEAD:refs/heads/topic\t[remote rejected] (ruleset blocked ${token})\nDone\n`,
          stderr: "error: failed to push some refs to 'https://github.com/acme/repo.git'\n",
          status: 1,
          signal: null,
        };
      }
      return result('');
    }) as unknown as typeof spawnSync;
    const publisher = new GitAskPassPublisher({ spawn });

    expect(() =>
      publisher.push({
        rootDir: '.',
        remote: 'origin',
        branch: 'topic',
        owner: 'acme',
        repo: 'repo',
        token,
        timeoutMs: 1000,
      }),
    ).toThrow('remote rejected] (ruleset blocked [redacted])');
  });

  it('pushes HEAD to a test bare remote without mutating remote or credential config', () => {
    const root = temp('delivery-work-');
    const bare = temp('delivery-bare-');
    run('git', ['init', '--bare', bare]);
    run('git', ['init', root]);
    run('git', ['-C', root, 'config', 'user.email', 'test@example.test']);
    run('git', ['-C', root, 'config', 'user.name', 'Delivery Test']);
    writeFileSync(join(root, 'README.md'), 'delivery\n', 'utf-8');
    run('git', ['-C', root, 'add', 'README.md']);
    run('git', ['-C', root, 'commit', '-m', 'test: seed delivery']);
    run('git', ['-C', root, 'remote', 'add', 'origin', bare]);
    run('git', ['-C', root, 'config', 'credential.helper', '!exit 99']);
    const beforeRemote = output('git', ['-C', root, 'remote', 'get-url', 'origin']);
    const beforeHelper = output('git', ['-C', root, 'config', 'credential.helper']);
    const publisher = new GitAskPassPublisher({ allowLocalRemoteForTests: true });
    const transportInput = {
      rootDir: root,
      remote: 'origin',
      branch: 'agent/test-delivery',
      owner: 'test',
      repo: 'delivery',
      token: 'test-only-token',
      timeoutMs: 5000,
    };
    const result = publisher.push(transportInput);
    expect(result.remoteSha).toBe(result.branchSha);
    expect(output('git', ['-C', root, 'remote', 'get-url', 'origin'])).toBe(beforeRemote);
    expect(output('git', ['-C', root, 'config', 'credential.helper'])).toBe(beforeHelper);
    expect(existsSync(join(root, 'test-only-token'))).toBe(false);
    publisher.deleteRemoteRef(transportInput);
    expect(
      output('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads']),
    ).toBe('');
  });
});

function result(stdout: string) {
  return { pid: 1, output: [], stdout, stderr: '', status: 0, signal: null };
}

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

function output(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
