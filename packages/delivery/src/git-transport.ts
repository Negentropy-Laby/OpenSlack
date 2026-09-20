import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryError } from './errors.js';
import type {
  GitProbePublisher,
  GitConditionalBranchDeleter,
  ConditionalBranchDeleteResult,
} from './types.js';

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

export class GitAskPassPublisher implements GitProbePublisher, GitConditionalBranchDeleter {
  constructor(private readonly options: GitAskPassPublisherOptions = {}) {}

  readRemoteBranchSha(input: GitTransportInput): string | null {
    const deadline = Date.now() + input.timeoutMs;
    const spawn = this.options.spawn ?? spawnSync;
    validateCleanupRef(spawn, input);
    const pushUrl = resolvePushUrl(
      spawn,
      { ...input, timeoutMs: remaining(deadline) },
      this.options.allowLocalRemoteForTests === true,
    );
    return withAskPassEnvironment(input.token, (env, hooksDir) => {
      const transportDir = cleanupRepository(spawn, hooksDir, env, remaining(deadline));
      return (
        readRemoteShaAtUrl(
          spawn,
          transportDir,
          pushUrl,
          input.branch,
          env,
          hooksDir,
          remaining(deadline),
          input.token,
        ) || null
      );
    });
  }

  deleteRemoteRefIfAt(
    input: GitTransportInput & { expectedSha: string },
  ): ConditionalBranchDeleteResult {
    const deadline = Date.now() + input.timeoutMs;
    if (!/^[a-f0-9]{40}$/.test(input.expectedSha)) {
      throw new DeliveryError(
        'DELIVERY_PUSH_FAILED',
        'Conditional deletion requires a full 40-hex Git object id.',
        false,
      );
    }
    const spawn = this.options.spawn ?? spawnSync;
    validateCleanupRef(spawn, input);
    const pushUrl = resolvePushUrl(
      spawn,
      { ...input, timeoutMs: remaining(deadline) },
      this.options.allowLocalRemoteForTests === true,
    );
    return withAskPassEnvironment(input.token, (env, hooksDir) => {
      const transportDir = cleanupRepository(spawn, hooksDir, env, remaining(deadline));
      const read = () =>
        readRemoteShaAtUrl(
          spawn,
          transportDir,
          pushUrl,
          input.branch,
          env,
          hooksDir,
          remaining(deadline),
          input.token,
        );
      const before = read();
      if (!before) return { state: 'ABSENT', attempted: false, observedRefState: 'ABSENT' };
      if (before !== input.expectedSha)
        return {
          state: 'STALE',
          attempted: false,
          observedRefState: 'PRESENT',
          observedSha: before,
        };
      const ref = `refs/heads/${input.branch}`;
      // Reserve part of the shared budget for reconciliation; never retry a push.
      const pushBudget = Math.max(1, Math.floor(remaining(deadline) * 0.7));
      const result = spawn(
        'git',
        [
          '-c',
          'credential.helper=',
          '-c',
          `core.hooksPath=${hooksDir}`,
          'push',
          '--porcelain',
          `--force-with-lease=${ref}:${input.expectedSha}`,
          pushUrl,
          `:${ref}`,
        ],
        {
          cwd: transportDir,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          timeout: pushBudget,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      );
      const lines = String(result.stdout ?? '').split(/\r?\n/);
      const receipt = (flag: string, summary: string) =>
        lines.some(
          (line) =>
            line === `${flag}\t:${ref}\t${summary}` ||
            line === `${flag}\t(delete):${ref}\t${summary}`,
        );
      const deleted = !result.error && result.status === 0 && receipt('-', '[deleted]');
      const stale = !result.error && result.status !== 0 && receipt('!', '[rejected] (stale info)');
      const message =
        result.error || result.status !== 0
          ? redactTransportText(
              `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`,
              input.token,
            )
          : undefined;
      let after: string;
      try {
        after = read();
      } catch {
        return {
          state: 'RECONCILIATION_REQUIRED',
          attempted: true,
          observedRefState: 'UNKNOWN',
          message,
        };
      }
      if (!after)
        return {
          state: deleted ? 'DELETED' : 'ABSENT_AFTER_ATTEMPT',
          attempted: true,
          observedRefState: 'ABSENT',
          message,
        };
      const state =
        stale && after !== input.expectedSha
          ? 'STALE'
          : !deleted && (result.error || result.status !== 0) && after === input.expectedSha
            ? 'FAILED'
            : 'RECONCILIATION_REQUIRED';
      return { state, attempted: true, observedRefState: 'PRESENT', observedSha: after, message };
    });
  }

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

  deleteRemoteRef(input: GitTransportInput): void {
    assertGitRef(input.branch);
    const spawn = this.options.spawn ?? spawnSync;
    const pushUrl = resolvePushUrl(spawn, input, this.options.allowLocalRemoteForTests === true);
    withAskPassEnvironment(input.token, (env, hooksDir) => {
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
          `:refs/heads/${input.branch}`,
        ],
        env,
        input.timeoutMs,
        input.token,
        'Temporary delivery ref cleanup',
      );
      const remaining = readRemoteShaAtUrl(
        spawn,
        input.rootDir,
        pushUrl,
        input.branch,
        env,
        hooksDir,
        input.timeoutMs,
        input.token,
      );
      if (remaining) {
        throw new DeliveryError(
          'DELIVERY_PUSH_FAILED',
          'Temporary delivery ref cleanup could not be verified.',
          true,
        );
      }
    });
  }
}

/** A delete needs no local objects. Keep untrusted repository config out of transport. */
function cleanupRepository(
  spawn: typeof spawnSync,
  hooksDir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): string {
  const root = join(hooksDir, 'transport.git');
  const result = spawn('git', ['init', '--bare', '--template=', root], {
    cwd: hooksDir,
    env: { ...env, OPENSLACK_GIT_ASKPASS_TOKEN: undefined },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new DeliveryError(
      'DELIVERY_PUSH_FAILED',
      'Isolated cleanup transport could not be prepared.',
      false,
    );
  return root;
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
  const askpassPath = join(helperDir, 'askpass.sh');
  const globalConfigPath = join(helperDir, 'empty-gitconfig');
  writeFileSync(globalConfigPath, '', { encoding: 'utf-8', flag: 'wx' });
  writeFileSync(
    askpassPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  *[Uu][Ss][Ee][Rr][Nn][Aa][Mm][Ee]*) printf %s x-access-token ;;',
      '  *[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*) printf %s "$OPENSLACK_GIT_ASKPASS_TOKEN" ;;',
      '  *) exit 1 ;;',
      'esac',
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
  if (!output) return '';
  const lines = output.split(/\r?\n/);
  const match = /^([a-f0-9]{40})\t(.+)$/.exec(lines[0]);
  if (lines.length !== 1 || !match || match[2] !== `refs/heads/${branch}`) {
    throw new DeliveryError(
      'DELIVERY_PUSH_FAILED',
      'Remote branch evidence is not one exact full-SHA ref.',
      false,
    );
  }
  return match[1];
}

function remaining(deadline: number): number {
  const budget = deadline - Date.now();
  if (budget <= 0)
    throw new DeliveryError('DELIVERY_TIMEOUT', 'Branch cleanup deadline expired.', false);
  return budget;
}

function validateCleanupRef(spawn: typeof spawnSync, input: GitTransportInput): void {
  assertGitRef(input.branch);
  if (
    /^openslack\/(?:claims|probes)(?:\/|$)/.test(input.branch) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.remote)
  ) {
    throw new DeliveryError(
      'DELIVERY_PUSH_FAILED',
      'Reserved branch or invalid remote cannot be cleaned.',
      false,
    );
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new DeliveryError('DELIVERY_TIMEOUT', 'Invalid branch cleanup deadline.', false);
  }
  runLocalGit(
    spawn,
    input.rootDir,
    ['check-ref-format', `refs/heads/${input.branch}`],
    input.timeoutMs,
  );
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
      `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`,
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
      url.port ||
      url.search ||
      url.hash ||
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
