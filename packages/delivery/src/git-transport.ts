import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryError } from './errors.js';
import type { GitBranchPublisher } from './types.js';

export interface GitAskPassPublisherOptions {
  allowLocalRemoteForTests?: boolean;
  spawn?: typeof spawnSync;
}

interface GitTransportInput {
  rootDir: string;
  remote: string;
  branch: string;
  owner: string;
  repo: string;
  token: string;
  timeoutMs: number;
}

export class GitAskPassPublisher implements GitBranchPublisher {
  constructor(private readonly options: GitAskPassPublisherOptions = {}) {}

  push(input: GitTransportInput): { branchSha: string; remoteSha: string } {
    assertGitRef(input.branch);
    const spawn = this.options.spawn ?? spawnSync;
    const pushUrl = resolvePushUrl(spawn, input, this.options.allowLocalRemoteForTests === true);
    const branchSha = runLocalGit(
      spawn,
      input.rootDir,
      ['rev-parse', 'HEAD^{commit}'],
      input.timeoutMs,
    );

    return withAskPassEnvironment(input.token, (env, hooksDir) => {
      runAuthenticatedGit(
        spawn,
        input.rootDir,
        [
          '-c',
          'credential.helper=',
          '-c',
          `core.hooksPath=${hooksDir}`,
          'push',
          '--porcelain',
          pushUrl,
          `HEAD:refs/heads/${input.branch}`,
        ],
        env,
        input.timeoutMs,
        input.token,
        'Git branch publication',
      );
      const remoteSha = readRemoteShaAtUrl(
        spawn,
        input.rootDir,
        pushUrl,
        input.branch,
        env,
        hooksDir,
        input.timeoutMs,
        input.token,
      );
      return { branchSha, remoteSha };
    });
  }

  readRemoteSha(input: GitTransportInput): string {
    assertGitRef(input.branch);
    const spawn = this.options.spawn ?? spawnSync;
    const pushUrl = resolvePushUrl(spawn, input, this.options.allowLocalRemoteForTests === true);
    return withAskPassEnvironment(input.token, (env, hooksDir) =>
      readRemoteShaAtUrl(
        spawn,
        input.rootDir,
        pushUrl,
        input.branch,
        env,
        hooksDir,
        input.timeoutMs,
        input.token,
      ),
    );
  }
}

function resolvePushUrl(
  spawn: typeof spawnSync,
  input: Pick<GitTransportInput, 'rootDir' | 'remote' | 'owner' | 'repo' | 'timeoutMs'>,
  allowLocal: boolean,
): string {
  const output = runLocalGit(
    spawn,
    input.rootDir,
    ['remote', 'get-url', '--push', '--all', input.remote],
    input.timeoutMs,
  );
  const urls = output.split(/\r?\n/).filter(Boolean);
  if (urls.length !== 1) {
    throw new DeliveryError(
      'DELIVERY_REMOTE_UNSUPPORTED',
      'Delivery requires exactly one configured push URL.',
      false,
    );
  }
  const pushUrl = urls[0];
  if (allowLocal) return pushUrl;
  const target = parseGitHubHttpsTarget(pushUrl);
  if (!target) {
    throw new DeliveryError(
      'DELIVERY_REMOTE_UNSUPPORTED',
      'Delivery requires an HTTPS GitHub push URL without embedded credentials.',
      false,
    );
  }
  if (
    target.owner.toLowerCase() !== input.owner.toLowerCase() ||
    target.repo.toLowerCase() !== input.repo.toLowerCase()
  ) {
    throw new DeliveryError(
      'DELIVERY_TARGET_MISMATCH',
      'Git push target does not match the GitHub API repository target.',
      false,
    );
  }
  return pushUrl;
}

function withAskPassEnvironment<T>(
  token: string,
  operation: (env: NodeJS.ProcessEnv, hooksDir: string) => T,
): T {
  const helperDir = mkdtempSync(join(tmpdir(), 'openslack-askpass-'));
  const hooksDir = join(helperDir, 'disabled-hooks');
  mkdirSync(hooksDir, { recursive: true });
  const askpassPath = join(helperDir, 'askpass.js');
  const globalConfigPath = join(helperDir, 'empty-gitconfig');
  writeFileSync(globalConfigPath, '', { encoding: 'utf-8', flag: 'wx' });
  writeFileSync(
    askpassPath,
    [
      '#!/usr/bin/env node',
      "const prompt = String(process.argv[2] ?? '').toLowerCase();",
      "if (prompt.includes('username')) process.stdout.write('x-access-token');",
      "else if (prompt.includes('password')) process.stdout.write(String(process.env.OPENSLACK_GIT_ASKPASS_TOKEN ?? ''));",
      'else process.exitCode = 1;',
    ].join('\n'),
    { encoding: 'utf-8', flag: 'wx' },
  );
  chmodSync(askpassPath, 0o700);
  try {
    const env = createTransportEnvironment(globalConfigPath);
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_ASKPASS = askpassPath;
    env.GIT_ASKPASS_REQUIRE = 'force';
    env.OPENSLACK_GIT_ASKPASS_TOKEN = token;
    return operation(env, hooksDir);
  } finally {
    rmSync(helperDir, { recursive: true, force: true });
  }
}

function createTransportEnvironment(globalConfigPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowedKeys = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = globalConfigPath;
  return env;
}

function readRemoteShaAtUrl(
  spawn: typeof spawnSync,
  cwd: string,
  pushUrl: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  hooksDir: string,
  timeoutMs: number,
  token: string,
): string {
  const output = runAuthenticatedGit(
    spawn,
    cwd,
    [
      '-c',
      'credential.helper=',
      '-c',
      `core.hooksPath=${hooksDir}`,
      'ls-remote',
      pushUrl,
      `refs/heads/${branch}`,
    ],
    env,
    timeoutMs,
    token,
    'Remote branch verification',
  );
  return output.split(/\s+/)[0] ?? '';
}

function runLocalGit(
  spawn: typeof spawnSync,
  cwd: string,
  args: string[],
  timeoutMs: number,
): string {
  const result = spawn('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new DeliveryError('DELIVERY_PUSH_FAILED', 'Git repository inspection failed.', false);
  }
  return String(result.stdout ?? '').trim();
}

function runAuthenticatedGit(
  spawn: typeof spawnSync,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  token: string,
  operation: string,
): string {
  const result = spawn('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = redactTransportText(
      `${result.stderr ?? ''}\n${result.error?.message ?? ''}`,
      token,
    );
    const timeout = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    throw new DeliveryError(
      timeout ? 'DELIVERY_TIMEOUT' : 'DELIVERY_PUSH_FAILED',
      timeout ? `${operation} timed out.` : `${operation} failed: ${detail}`,
      timeout || isAuthenticationFailure(detail),
    );
  }
  return String(result.stdout ?? '').trim();
}

function assertGitRef(ref: string): void {
  if (!/^(?![-/.])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new DeliveryError('DELIVERY_PUSH_FAILED', 'Delivery branch name is invalid.', false);
  }
}

function parseGitHubHttpsTarget(value: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'github.com' ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') };
  } catch {
    return null;
  }
}

export function isAuthenticationFailure(value: string): boolean {
  return /authentication failed|invalid username or password|http 401|bad credentials|could not read username/i.test(
    value,
  );
}

function redactTransportText(value: string, token: string): string {
  return value
    .replaceAll(token, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 500);
}
