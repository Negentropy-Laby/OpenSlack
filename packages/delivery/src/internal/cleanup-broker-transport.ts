import { validateGitHubNetwork, isValidCleanupBranch } from '@openslack/core';
import { createConditionalGitTransport } from '../git-transport.js';
import type { GitConditionalBranchDeleter } from '../types.js';
import { spawnSync } from 'node:child_process';
import { DeliveryError } from '../errors.js';
import { isCleanupBrokerChannel, type CleanupBrokerChannel } from './cleanup-broker-channel.js';

const GIT = '/usr/lib/openslack-cleanup/git';
const ROOT = '/var/lib/openslack-cleanup';
const channels = new WeakSet<object>();

export interface CleanupBrokerSendBinding {
  workerId: string;
  operationId: string;
  requestDigest: string;
  target: {
    workspaceId: string;
    host: string;
    repositoryId: string;
    repository: string;
    prNodeId: string;
    prNumber: number;
    ref: string;
    expectedSha: string;
  };
  instance: { brokerId: string; generation: string; bootNonce: string };
}

export interface CleanupBrokerNetwork {
  httpsProxy: string;
  noProxy: string;
}

export class CleanupBrokerSendDeniedError extends DeliveryError {
  readonly attempted = false;
  constructor() {
    super('DELIVERY_PUSH_FAILED', 'CLEANUP_BROKER_SEND_NOT_ADMITTED', false);
  }
}

function deny(): never {
  throw new CleanupBrokerSendDeniedError();
}

/** Internal bundle composition only. Never exported by the package entrypoint. */
export function createCleanupBrokerTransport(
  channel: CleanupBrokerChannel,
  input: CleanupBrokerSendBinding,
  network?: CleanupBrokerNetwork,
): GitConditionalBranchDeleter {
  if (!isCleanupBrokerChannel(channel) || channels.has(channel)) deny();
  // Only the pinned installation bootstrap may supply this configuration.
  // Never inherit process.env proxies (including lowercase aliases).
  const proxy = network?.httpsProxy ?? '';
  const noProxy = network?.noProxy ?? '';
  try {
    validateGitHubNetwork(proxy, noProxy);
  } catch {
    deny();
  }
  const binding = structuredClone(input);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(binding.workerId) ||
    (binding.operationId !== '' &&
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(binding.operationId)) ||
    !/^[a-f0-9]{64}$/.test(binding.requestDigest) ||
    binding.target.host !== 'github.com' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(binding.target.repository) ||
    !binding.target.ref.startsWith('refs/heads/') ||
    !isValidCleanupBranch(binding.target.ref.slice(11)) ||
    !/^[a-f0-9]{40}$/.test(binding.target.expectedSha) ||
    /^0{40}$/.test(binding.target.expectedSha)
  )
    deny();
  Object.freeze(binding.target);
  Object.freeze(binding.instance);
  Object.freeze(binding);
  let requested = false;
  const spawn = ((command: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
    if (command !== 'git') deny();
    // Only the minimal askpass settings assembled by trusted transport survive.
    // No caller PATH, HOME, Git config, TLS override, proxy or preload is inherited.
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/lib/openslack-cleanup:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EXEC_PATH: '/usr/lib/openslack-cleanup/git-core',
    };
    if (proxy !== '') env.HTTPS_PROXY = proxy;
    if (noProxy !== '') env.NO_PROXY = noProxy;
    for (const key of [
      'GIT_CONFIG_GLOBAL',
      'GIT_ASKPASS',
      'GIT_ASKPASS_REQUIRE',
      'OPENSLACK_GIT_ASKPASS_TOKEN',
    ]) {
      if (options?.env?.[key] !== undefined) env[key] = options.env[key];
    }
    const trustedOptions = { ...options, env, detached: false };
    return spawnSync(GIT, args, trustedOptions);
  }) as unknown as typeof spawnSync;
  channels.add(channel);
  const context = Object.freeze({
    fixed: true,
    url: `https://github.com/${binding.target.repository}.git`,
    rootDir: ROOT,
    spawn,
    tempRoot: '/tmp',
    shell: '/usr/lib/openslack-cleanup/sh',
    beforePush(): void {
      if (requested || binding.operationId === '') deny();
      requested = true;
      const frame = {
        schema: 'openslack.cleanup_executor_control.v1',
        type: 'admit',
        ...binding,
      };
      try {
        channel.writeControl(frame);
        const reply = channel.readControl();
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)) deny();
        const expected = { ...frame, type: 'admitted' };
        // Property order is irrelevant, but every value and every field is bound.
        if (!sameJSON(reply, expected)) deny();
      } catch {
        deny();
      }
    },
  });
  return Object.freeze(
    createConditionalGitTransport({}, (input) => {
      const t = binding.target;
      if (
        `${input.owner}/${input.repo}` !== t.repository ||
        `refs/heads/${input.branch}` !== t.ref ||
        (input.expectedSha !== undefined && input.expectedSha !== t.expectedSha)
      )
        deny();
      return context;
    }),
  );
}

function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) ||
    Array.isArray(b)
  )
    return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(right).every((key) => Object.hasOwn(left, key) && sameJSON(left[key], right[key]))
  );
}
