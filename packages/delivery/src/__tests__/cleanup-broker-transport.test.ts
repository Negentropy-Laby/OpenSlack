import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitAskPassPublisher } from '../git-transport.js';
import { openCleanupBrokerChannel } from '../internal/cleanup-broker-channel.js';
import {
  bindCleanupBrokerTransport,
  type CleanupBrokerSendBinding,
  type CleanupBrokerNetwork,
} from '../internal/cleanup-broker-transport.js';

const state = vi.hoisted(() => ({
  input: Buffer.alloc(0),
  written: '',
  calls: [] as {
    command: string;
    args: string[];
    options: SpawnSyncOptions & { detached?: boolean };
  }[],
  sha: 'a'.repeat(40),
  reads: 0,
  root: '',
  remote: '',
  onAdmit: undefined as (() => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    fstatSync: (fd: number) => ([3, 4].includes(fd) ? { isFIFO: () => true } : fs.fstatSync(fd)),
    readSync: (fd: number, b: Buffer, offset: number, length: number, position: number | null) => {
      if (fd !== 3) return fs.readSync(fd, b, offset, length, position);
      const n = Math.min(length, state.input.length);
      state.input.copy(b, offset, 0, n);
      state.input = state.input.subarray(n);
      return n;
    },
    writeSync: (fd: number, b: Buffer, offset: number, length: number) => {
      if (fd !== 4) return fs.writeSync(fd, b, offset, length);
      state.written += b.subarray(offset, offset + length).toString();
      if (state.written.endsWith('\n')) state.onAdmit?.();
      return length;
    },
  };
});
vi.mock('node:child_process', async (original) => {
  const child = await original<typeof ChildProcess>();
  return {
    ...child,
    spawnSync: (
      command: string,
      args: string[],
      options: SpawnSyncOptions & { detached?: boolean },
    ) => {
      if (command !== '/usr/lib/openslack-cleanup/git')
        return child.spawnSync(command, args, options);
      state.calls.push({ command, args: [...args], options });
      if (options.env?.GIT_ASKPASS) {
        expect(readFileSync(options.env.GIT_ASKPASS, 'utf8')).toMatch(
          /^#!\/usr\/lib\/openslack-cleanup\/sh\n/,
        );
      }
      if (state.root) {
        return child.spawnSync(
          'git',
          args.map((a) => (a === 'https://github.com/acme/repo.git' ? state.remote : a)),
          {
            ...options,
            cwd: options.cwd === '/var/lib/openslack-cleanup' ? state.root : options.cwd,
          },
        );
      }
      let stdout = '';
      if (args.includes('ls-remote'))
        stdout = ++state.reads === 1 ? `${state.sha}\trefs/heads/topic\n` : '';
      if (args.includes('push')) stdout = '-\t:refs/heads/topic\t[deleted]\n';
      return { status: 0, signal: null, pid: 1, stdout, stderr: '', output: [null, stdout, ''] };
    },
  };
});

const roots: string[] = [];
beforeEach(() => {
  state.input = Buffer.alloc(0);
  state.written = '';
  state.calls = [];
  state.sha = 'a'.repeat(40);
  state.reads = 0;
  state.root = '';
  state.remote = '';
  state.onAdmit = undefined;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function binding(): CleanupBrokerSendBinding {
  return {
    workerId: 'worker-1',
    operationId: 'operation-1',
    requestDigest: 'd'.repeat(64),
    target: {
      workspaceId: 'workspace-1',
      host: 'github.com',
      repositoryId: '123',
      repository: 'acme/repo',
      prNodeId: 'PR_node',
      prNumber: 7,
      ref: 'refs/heads/topic',
      expectedSha: state.sha,
    },
    instance: { brokerId: 'broker-1', generation: '1', bootNonce: 'b'.repeat(64) },
  };
}
function input() {
  return {
    rootDir: '/agent-controlled',
    remote: 'origin',
    branch: 'topic',
    owner: 'acme',
    repo: 'repo',
    token: 'synthetic-token',
    timeoutMs: 10000,
    expectedSha: state.sha,
  };
}
function setup(
  replyChange?: (r: Record<string, unknown>) => void,
  network?: CleanupBrokerNetwork,
  preview = false,
) {
  const b = binding();
  if (preview) b.operationId = '';
  const reply: Record<string, unknown> = {
    schema: 'openslack.cleanup_executor_control.v1',
    type: 'admitted',
    ...b,
  };
  replyChange?.(reply);
  state.input = Buffer.from(`{}\n${JSON.stringify(reply)}\n`);
  const channel = openCleanupBrokerChannel();
  channel.readBootstrap();
  const publisher = new GitAskPassPublisher({
    spawn: vi.fn(() => {
      throw Error('public spawn injection');
    }) as unknown as typeof spawnSync,
  });
  bindCleanupBrokerTransport(publisher, channel, b, network);
  return { publisher, channel, b };
}
function supported() {
  if (process.platform === 'linux') return true;
  expect(() => openCleanupBrokerChannel()).toThrow();
  return false;
}

describe('private broker final-send fence', () => {
  it('pins preview reads but refuses any admission or push with an empty operation', () => {
    if (!supported()) return;
    const { publisher } = setup(undefined, undefined, true);
    expect(publisher.readRemoteBranchSha(input())).toBe(state.sha);
    state.reads = 0;
    expect(() => publisher.deleteRemoteRefIfAt(input())).toThrow();
    expect(state.written).toBe('');
    expect(state.calls.filter((c) => c.args.includes('push'))).toHaveLength(0);
  });
  it('uses only pinned network settings, owning values before sending', () => {
    if (!supported()) return;
    vi.stubEnv('HTTPS_PROXY', 'http://evil');
    vi.stubEnv('https_proxy', 'http://evil');
    vi.stubEnv('NO_PROXY', '*');
    const network = { httpsProxy: 'http://127.0.0.1:8080', noProxy: 'localhost,127.0.0.1' };
    const { publisher } = setup(undefined, network);
    network.httpsProxy = 'http://evil';
    expect(publisher.deleteRemoteRefIfAt(input()).state).toBe('DELETED');
    for (const { options } of state.calls) {
      expect(options.env?.HTTPS_PROXY).toBe('http://127.0.0.1:8080');
      expect(options.env?.NO_PROXY).toBe('localhost,127.0.0.1');
      expect(options.env?.https_proxy).toBeUndefined();
    }
  });
  it.each([
    'http://u:p@host',
    'http://host/path',
    'http://host?',
    'http://host#',
    'ftp://host',
    'http://host\\evil',
    ' http://host',
    'http://host\n',
  ])('rejects unsafe proxy %j before Git', (httpsProxy) => {
    if (!supported()) return;
    expect(() => setup(undefined, { httpsProxy, noProxy: '' })).toThrow();
    expect(state.calls).toHaveLength(0);
  });
  it('waits until remote observation, binds full tuple, ignores caller Git configuration', () => {
    if (!supported()) return;
    vi.stubEnv('NODE_OPTIONS', '--require /agent/evil');
    vi.stubEnv('HTTPS_PROXY', 'http://agent/');
    const { publisher, b } = setup();
    state.onAdmit = () => {
      expect(state.calls.some((c) => c.args.includes('ls-remote'))).toBe(true);
      expect(state.calls.some((c) => c.args.includes('push'))).toBe(false);
    };
    expect(publisher.deleteRemoteRefIfAt(input()).state).toBe('DELETED');
    expect(JSON.parse(state.written)).toEqual({
      schema: 'openslack.cleanup_executor_control.v1',
      type: 'admit',
      ...b,
    });
    const pushes = state.calls.filter((c) => c.args.includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args).toContain(`--force-with-lease=refs/heads/topic:${state.sha}`);
    for (const c of state.calls) {
      expect(c.command).toBe('/usr/lib/openslack-cleanup/git');
      expect(c.options.detached).toBe(false);
      expect(c.args).not.toContain('get-url');
      expect(c.options.env?.HTTPS_PROXY).toBeUndefined();
      expect(c.options.env?.NODE_OPTIONS).toBeUndefined();
      expect(c.options.env?.HOME).toBeUndefined();
      expect(c.options.env?.GIT_EXEC_PATH).toBe('/usr/lib/openslack-cleanup/git-core');
    }
  });
  it.each(['workerId', 'requestDigest', 'operationId', 'target', 'instance', 'type', 'extra'])(
    'rejects mismatched %s with zero push',
    (key) => {
      if (!supported()) return;
      const { publisher } = setup((r) => {
        r[key] = 'wrong';
      });
      expect(() => publisher.deleteRemoteRefIfAt(input())).toThrow();
      expect(state.calls.filter((c) => c.args.includes('push'))).toHaveLength(0);
    },
  );
  it('rejects forged channels and target drift before transport', () => {
    if (!supported()) return;
    const { publisher, channel, b } = setup();
    expect(() => bindCleanupBrokerTransport({}, { ...channel }, b)).toThrow();
    expect(() => bindCleanupBrokerTransport(publisher, channel, b)).toThrow();
    expect(() => publisher.deleteRemoteRefIfAt({ ...input(), branch: 'other' })).toThrow();
    expect(state.calls).toHaveLength(0);
  });
  it('requires a new private request to obtain admission and never retries a denied one', () => {
    if (!supported()) return;
    const { publisher } = setup((r) => {
      r.type = 'rejected';
      r.reason = 'FINAL_SEND_DENIED';
    });
    expect(() => publisher.deleteRemoteRefIfAt(input())).toThrow();
    state.reads = 0;
    expect(() => publisher.deleteRemoteRefIfAt(input())).toThrow();
    expect(state.calls.filter((c) => c.args.includes('push'))).toHaveLength(0);
  });
  it('does no further Git preparation between final broker resource approval and push', () => {
    if (!supported()) return;
    const { publisher } = setup();
    let callsAtAdmission = -1;
    state.onAdmit = () => {
      callsAtAdmission = state.calls.length;
    };
    expect(publisher.deleteRemoteRefIfAt(input()).state).toBe('DELETED');
    expect(callsAtAdmission).toBeGreaterThan(0);
    expect(state.calls[callsAtAdmission].args).toContain('push');
    expect(state.calls[callsAtAdmission - 1].args).toContain('ls-remote');
  });
  it('preserves a real concurrent bare-Git update after admission wait using exact CAS', () => {
    if (!supported()) return;
    const root = mkdtempSync(join(tmpdir(), 'broker-cas-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const first = join(root, 'first');
    const second = join(root, 'second');
    const git = (args: string[], cwd = root) => {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      });
      if (r.status !== 0) throw Error(`fixture git failed: ${r.stderr}`);
      return String(r.stdout).trim();
    };
    git(['init', '--bare', remote]);
    git(['clone', remote, first]);
    git(['config', 'user.email', 'fixture@example.test'], first);
    git(['config', 'user.name', 'Fixture'], first);
    writeFileSync(join(first, 'file'), 'first');
    git(['add', 'file'], first);
    git(['commit', '-m', 'first'], first);
    git(['push', 'origin', 'HEAD:refs/heads/topic'], first);
    state.sha = git(['rev-parse', 'HEAD'], first);
    git(['clone', '--branch', 'topic', remote, second]);
    git(['config', 'user.email', 'fixture@example.test'], second);
    git(['config', 'user.name', 'Fixture'], second);
    state.root = root;
    state.remote = remote;
    const { publisher } = setup();
    let newer = '';
    state.onAdmit = () => {
      writeFileSync(join(second, 'file'), 'second');
      git(['add', 'file'], second);
      git(['commit', '-m', 'second'], second);
      newer = git(['rev-parse', 'HEAD'], second);
      git(['push', 'origin', 'topic'], second);
    };
    const result = publisher.deleteRemoteRefIfAt(input());
    expect(result.state).toBe('STALE');
    expect(result.observedSha).toBe(newer);
    expect(git(['--git-dir', remote, 'rev-parse', 'refs/heads/topic'])).toBe(newer);
    expect(state.calls.filter((c) => c.args.includes('push'))).toHaveLength(1);
  });
});
