import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerGitCredentialPrompt, GitAskPassPublisher } from '../index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitAskPassPublisher', () => {
  const cleanupInput = {
    rootDir: '.',
    remote: 'origin',
    branch: 'topic',
    owner: 'acme',
    repo: 'repo',
    token: 'test-only-token',
    timeoutMs: 5000,
    expectedSha: 'a'.repeat(40),
  };

  it.each([
    ['deleted', 0, '-\t:refs/heads/topic\t[deleted]', '', 'DELETED'],
    ['ambiguous absent', 1, '', '', 'ABSENT_AFTER_ATTEMPT'],
    [
      'lease refused',
      1,
      '!\t:refs/heads/topic\t[rejected] (stale info)',
      `${'b'.repeat(40)}\trefs/heads/topic`,
      'STALE',
    ],
    ['unchanged failure', 1, '', `${'a'.repeat(40)}\trefs/heads/topic`, 'FAILED'],
    [
      'recreated',
      0,
      '-\t:refs/heads/topic\t[deleted]',
      `${'b'.repeat(40)}\trefs/heads/topic`,
      'RECONCILIATION_REQUIRED',
    ],
    ['ambiguous changed', 1, '', `${'b'.repeat(40)}\trefs/heads/topic`, 'RECONCILIATION_REQUIRED'],
  ])('classifies conditional cleanup: %s', (_, status, receipt, after, state) => {
    let reads = 0;
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      if (args[0] === 'remote') return result('https://github.com/acme/repo.git');
      if (args.includes('ls-remote'))
        return result(++reads === 1 ? `${'a'.repeat(40)}\trefs/heads/topic` : String(after));
      if (args.includes('push')) return { ...result(String(receipt)), status: Number(status) };
      return result('');
    }) as unknown as typeof spawnSync;
    const outcome = new GitAskPassPublisher({ spawn }).deleteRemoteRefIfAt(cleanupInput);
    expect(outcome.state).toBe(state);
    expect(outcome.attempted).toBe(true);
    const pushes = vi
      .mocked(spawn)
      .mock.calls.filter((call) => (call[1] as string[]).includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1]).toContain(`--force-with-lease=refs/heads/topic:${'a'.repeat(40)}`);
    expect(pushes[0][1]).toContain(':refs/heads/topic');
  });

  it.each(['', `${'b'.repeat(40)}\trefs/heads/topic`])(
    'does not push on absent or stale preflight',
    (evidence) => {
      const spawn = vi.fn((_command: string, args: readonly string[]) =>
        result(
          args[0] === 'remote'
            ? 'https://github.com/acme/repo.git'
            : args.includes('ls-remote')
              ? evidence
              : '',
        ),
      ) as unknown as typeof spawnSync;
      const outcome = new GitAskPassPublisher({ spawn }).deleteRemoteRefIfAt(cleanupInput);
      expect(outcome.attempted).toBe(false);
      expect(
        vi.mocked(spawn).mock.calls.some((call) => (call[1] as string[]).includes('push')),
      ).toBe(false);
    },
  );

  it.each(['absent', 'unreadable'])(
    'never retries a timed-out push with %s reconciliation',
    (observation) => {
      let reads = 0;
      let pushes = 0;
      const spawn = vi.fn((_command: string, args: readonly string[]) => {
        if (args[0] === 'remote') return result('https://github.com/acme/repo.git');
        if (args.includes('ls-remote')) {
          if (++reads === 1) return result(`${'a'.repeat(40)}\trefs/heads/topic`);
          return { ...result(''), status: observation === 'absent' ? 0 : 1 };
        }
        if (args.includes('push')) {
          pushes++;
          return {
            ...result(''),
            status: null,
            error: Object.assign(new Error('test-only-token timeout'), { code: 'ETIMEDOUT' }),
          };
        }
        return result('');
      }) as unknown as typeof spawnSync;
      const outcome = new GitAskPassPublisher({ spawn }).deleteRemoteRefIfAt(cleanupInput);
      expect(outcome.state).toBe(
        observation === 'absent' ? 'ABSENT_AFTER_ATTEMPT' : 'RECONCILIATION_REQUIRED',
      );
      expect(outcome.attempted).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain(cleanupInput.token);
      expect(pushes).toBe(1);
    },
  );

  it.each(['topic//bad', 'topic/', 'topic.lock', 'openslack/claims', 'openslack/probes/item'])(
    'rejects invalid or reserved real Git ref %s',
    (branch) => {
      expect(() =>
        new GitAskPassPublisher().deleteRemoteRefIfAt({ ...cleanupInput, branch }),
      ).toThrow();
    },
  );

  it.each([
    `${'a'.repeat(40)}\trefs/heads/wrong`,
    'abc\trefs/heads/topic',
    `${'a'.repeat(40)}\trefs/heads/topic\n${'a'.repeat(40)}\trefs/heads/topic`,
  ])('rejects malformed exact ref evidence', (evidence) => {
    const spawn = vi.fn((_command: string, args: readonly string[]) =>
      result(
        args[0] === 'remote'
          ? 'https://github.com/acme/repo.git'
          : args.includes('ls-remote')
            ? evidence
            : '',
      ),
    ) as unknown as typeof spawnSync;
    expect(() => new GitAskPassPublisher({ spawn }).deleteRemoteRefIfAt(cleanupInput)).toThrow(
      'exact',
    );
  });

  it.each([
    'https://github.com/acme/repo.git?x=y',
    'https://github.com/acme/repo.git#ref',
    'https://github.com:8443/acme/repo.git',
    'https://user:token@github.com/acme/repo.git',
    'https://github.com/acme/repo.git\nhttps://github.com/acme/other.git',
  ])('rejects unsafe URL %s', (url) => {
    const spawn = vi.fn((_command: string, args: readonly string[]) =>
      result(args[0] === 'remote' ? url : ''),
    ) as unknown as typeof spawnSync;
    expect(() => new GitAskPassPublisher({ spawn }).deleteRemoteRefIfAt(cleanupInput)).toThrow();
    expect(
      vi.mocked(spawn).mock.calls.some((call) => (call[1] as string[]).includes('ls-remote')),
    ).toBe(false);
  });

  it('uses real Git CAS with two clones and preserves a concurrent push', () => {
    const bare = temp('cleanup-bare-');
    const first = temp('cleanup-first-');
    const second = temp('cleanup-second-');
    run('git', ['init', '--bare', bare]);
    run('git', ['clone', bare, first]);
    run('git', [
      '-C',
      first,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'seed',
    ]);
    run('git', ['-C', first, 'push', 'origin', 'HEAD:refs/heads/topic']);
    run('git', ['clone', '--branch', 'topic', bare, second]);
    const expectedSha = output('git', ['-C', first, 'rev-parse', 'HEAD']);
    run('git', [
      '-C',
      second,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'competitor',
    ]);
    const competitorSha = output('git', ['-C', second, 'rev-parse', 'HEAD']);
    // These local settings must never influence the authenticated deletion.
    run('git', ['-C', first, 'config', 'remote.origin.push', ':refs/heads/unrelated']);
    run('git', ['-C', first, 'config', 'core.hooksPath', '/nonexistent/malicious-hooks']);
    let raced = false;
    const spawn = ((command: string, args: string[], options: object) => {
      if (args.includes('push') && !raced) {
        raced = true;
        // Inject after URL validation: transport must not consult this config again.
        run('git', ['-C', first, 'config', `url.${bare}/attacker.insteadOf`, bare]);
        run('git', ['-C', second, 'push', 'origin', 'HEAD:refs/heads/topic']);
      }
      return spawnSync(command, args, options);
    }) as typeof spawnSync;
    const input = { ...cleanupInput, rootDir: first, expectedSha };
    const publisher = new GitAskPassPublisher({ allowLocalRemoteForTests: true, spawn });
    const racedResult = publisher.deleteRemoteRefIfAt(input);
    expect(racedResult, racedResult.message).toMatchObject({
      state: 'STALE',
      attempted: true,
      observedSha: competitorSha,
    });
    run('git', ['-C', first, 'config', '--unset-all', `url.${bare}/attacker.insteadOf`]);
    expect(output('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/topic'])).toBe(competitorSha);
    expect(publisher.deleteRemoteRefIfAt({ ...input, expectedSha: competitorSha })).toMatchObject({
      state: 'DELETED',
      attempted: true,
    });
    expect(publisher.deleteRemoteRefIfAt({ ...input, expectedSha: competitorSha })).toMatchObject({
      state: 'ABSENT',
      attempted: false,
    });
  });
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
    let askpassSource = '';
    const spawn = vi.fn(
      (_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options.env });
        if (args.includes('push') && options.env?.GIT_ASKPASS) {
          askpassSource = readFileSync(options.env.GIT_ASKPASS, 'utf-8');
        }
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
    expect(askpassSource).toMatch(/^#!\/bin\/sh/);
    expect(askpassSource).not.toContain('node');
    expect(askpassSource).not.toContain(token);
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
