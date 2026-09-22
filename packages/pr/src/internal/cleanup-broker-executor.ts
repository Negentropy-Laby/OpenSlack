import { createHash } from 'node:crypto';
import { Agent, ProxyAgent, fetch as networkFetch } from 'undici';
import {
  getDefaultBranch,
  isBranchProtected,
  listOpenPRsForBranch,
  claimRefPresent,
  inspectInstallationRepositoryAccess,
} from '@openslack/github';
import {
  GitAskPassPublisher,
  readRemoteBranchSha,
  deleteRemoteBranchIfAt,
} from '@openslack/delivery';
import { createGitHubAppJwt } from '../../../github/dist/app-jwt.js';
import {
  createCleanupBrokerClient,
  withCleanupBrokerClient,
} from '../../../github/dist/internal/cleanup-broker-client-scope.js';
import { openCleanupBrokerChannel } from '../../../delivery/dist/internal/cleanup-broker-channel.js';
import {
  bindCleanupBrokerTransport,
  type CleanupBrokerSendBinding,
} from '../../../delivery/dist/internal/cleanup-broker-transport.js';
import {
  createCleanupBrokerSession,
  brokerSessionContext,
} from './cleanup-broker-executor-session.js';
import {
  cleanupPRBranchThroughBroker,
  type PRBranchCleanupDependencies,
} from '../cleanup-branch.js';
import { fetchPRDetails } from '../fetch.js';
import type { CleanupBrokerRequest } from '../cleanup-broker-client.js';

interface TaskView {
  schema: 'openslack.cleanup_task_view.v1';
  workspaceId: string;
  repository: string;
  repositoryId: string;
  notBefore: string;
  expiresAt: string;
  tasks: Array<{
    taskId: string;
    issueNumber: number;
    state: 'pending' | 'claimed' | 'in-progress' | 'completed' | 'released';
  }>;
}
export interface CleanupExecutorBootstrap {
  schema: 'openslack.cleanup_executor_bootstrap.v1';
  type: 'start';
  binding: CleanupBrokerSendBinding;
  mode: 'preview' | 'execute';
  request: CleanupBrokerRequest;
  registry: string;
  taskView: TaskView;
  app: { appId: number; installationId: number; privateKey: string };
  deadlineMs: number;
  network: { httpsProxy: string; noProxy: string };
}
function deny(): never {
  throw new Error('CLEANUP_EXECUTOR_INPUT_INVALID');
}
function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function keys(v: unknown, names: string[]): asserts v is Record<string, unknown> {
  if (
    !object(v) ||
    Object.keys(v).length !== names.length ||
    names.some((n) => !Object.hasOwn(v, n))
  )
    deny();
}
const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const digest = /^[0-9a-f]{64}$/;

/** Structural validation is separate from the inherited-pipe/OS trust boundary. */
export function parseCleanupExecutorBootstrap(value: unknown): CleanupExecutorBootstrap {
  keys(value, [
    'schema',
    'type',
    'binding',
    'mode',
    'request',
    'registry',
    'taskView',
    'app',
    'deadlineMs',
    'network',
  ]);
  if (
    value.schema !== 'openslack.cleanup_executor_bootstrap.v1' ||
    value.type !== 'start' ||
    !['preview', 'execute'].includes(value.mode as string) ||
    typeof value.registry !== 'string' ||
    Buffer.byteLength(value.registry) > 65536 ||
    !Number.isSafeInteger(value.deadlineMs) ||
    Number(value.deadlineMs) <= Date.now() ||
    Number(value.deadlineMs) > Date.now() + 600000
  )
    deny();
  keys(value.binding, ['workerId', 'operationId', 'requestDigest', 'target', 'instance']);
  keys(value.binding.target, [
    'workspaceId',
    'host',
    'repositoryId',
    'repository',
    'prNodeId',
    'prNumber',
    'ref',
    'expectedSha',
  ]);
  keys(value.binding.instance, ['brokerId', 'generation', 'bootNonce']);
  const target = value.binding.target;
  const instance = value.binding.instance;
  if (
    typeof value.binding.workerId !== 'string' ||
    !id.test(value.binding.workerId) ||
    typeof value.binding.requestDigest !== 'string' ||
    !digest.test(value.binding.requestDigest) ||
    typeof target.workspaceId !== 'string' ||
    !id.test(target.workspaceId) ||
    target.host !== 'github.com' ||
    typeof target.repositoryId !== 'string' ||
    !/^[1-9][0-9]{0,39}$/.test(target.repositoryId) ||
    typeof target.repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.repository) ||
    typeof target.prNodeId !== 'string' ||
    !id.test(target.prNodeId) ||
    !Number.isSafeInteger(target.prNumber) ||
    Number(target.prNumber) <= 0 ||
    typeof target.ref !== 'string' ||
    !target.ref.startsWith('refs/heads/') ||
    target.ref.length > 1024 ||
    typeof target.expectedSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(target.expectedSha) ||
    /^0{40}$/.test(target.expectedSha) ||
    typeof instance.brokerId !== 'string' ||
    !id.test(instance.brokerId) ||
    typeof instance.generation !== 'string' ||
    !/^[1-9][0-9]{0,39}$/.test(instance.generation) ||
    typeof instance.bootNonce !== 'string' ||
    !digest.test(instance.bootNonce)
  )
    deny();
  keys(value.request, [
    'schema',
    'mode',
    'agentId',
    'principalId',
    'runtimeUid',
    'runId',
    'repo',
    'remote',
    'prNumber',
    'permitId',
    'operationId',
  ]);
  const r = value.request;
  if (
    r.schema !== 'openslack.cleanup_request.v1' ||
    r.mode !== value.mode ||
    r.repo !== target.repository ||
    r.prNumber !== target.prNumber ||
    r.operationId !== value.binding.operationId ||
    !['agentId', 'principalId', 'runtimeUid', 'runId'].every(
      (n) => typeof r[n] === 'string' && id.test(r[n]),
    ) ||
    typeof r.remote !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(r.remote) ||
    typeof r.permitId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(r.permitId) ||
    typeof r.operationId !== 'string' ||
    (value.mode === 'preview' ? r.operationId !== '' : !id.test(r.operationId))
  )
    deny();
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'openslack.cleanup_execution_digest.v1',
        r.agentId,
        r.principalId,
        r.runtimeUid,
        r.runId,
        r.repo,
        r.remote,
        String(r.prNumber),
        r.permitId,
        r.operationId,
      ]),
    )
    .digest('hex');
  if (hash !== value.binding.requestDigest) deny();
  keys(value.app, ['appId', 'installationId', 'privateKey']);
  if (
    !Number.isSafeInteger(value.app.appId) ||
    Number(value.app.appId) <= 0 ||
    !Number.isSafeInteger(value.app.installationId) ||
    Number(value.app.installationId) <= 0 ||
    typeof value.app.privateKey !== 'string' ||
    value.app.privateKey.length < 1 ||
    value.app.privateKey.length > 65536
  )
    deny();
  keys(value.network, ['httpsProxy', 'noProxy']);
  if (
    typeof value.network.httpsProxy !== 'string' ||
    value.network.httpsProxy.length > 2048 ||
    typeof value.network.noProxy !== 'string' ||
    value.network.noProxy.length > 2048 ||
    /[\r\n\0]/.test(value.network.noProxy)
  )
    deny();
  if (value.network.httpsProxy) {
    const url = new URL(value.network.httpsProxy);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== '/')
    )
      deny();
  }
  const result = structuredClone(value) as unknown as CleanupExecutorBootstrap;
  checkTaskView(result.taskView, result.binding.target);
  return result;
}

export function checkTaskView(view: TaskView, target: CleanupBrokerSendBinding['target']): void {
  keys(view, [
    'schema',
    'workspaceId',
    'repository',
    'repositoryId',
    'notBefore',
    'expiresAt',
    'tasks',
  ]);
  const begin = Date.parse(view.notBefore as string),
    end = Date.parse(view.expiresAt as string),
    now = Date.now();
  if (
    view.schema !== 'openslack.cleanup_task_view.v1' ||
    view.workspaceId !== target.workspaceId ||
    view.repository !== target.repository ||
    view.repositoryId !== target.repositoryId ||
    typeof view.notBefore !== 'string' ||
    typeof view.expiresAt !== 'string' ||
    !Number.isFinite(begin) ||
    !Number.isFinite(end) ||
    begin >= end ||
    now < begin ||
    now >= end ||
    !Array.isArray(view.tasks) ||
    view.tasks.length > 4096
  )
    deny();
  const seen = new Set<string>();
  for (const t of view.tasks) {
    keys(t, ['taskId', 'issueNumber', 'state']);
    if (
      typeof t.taskId !== 'string' ||
      !id.test(t.taskId) ||
      seen.has(t.taskId) ||
      !Number.isSafeInteger(t.issueNumber) ||
      Number(t.issueNumber) <= 0 ||
      !['pending', 'claimed', 'in-progress', 'completed', 'released'].includes(t.state as string)
    )
      deny();
    seen.add(t.taskId);
  }
}

async function run(
  bootstrap: CleanupExecutorBootstrap,
  channel: ReturnType<typeof openCleanupBrokerChannel>,
): Promise<void> {
  const { request: r, binding } = bootstrap;
  const session = createCleanupBrokerSession(
    channel,
    bootstrap.registry,
    r.agentId,
    { principalId: r.principalId, runtimeUid: r.runtimeUid, runId: r.runId },
    binding,
  );
  const publisher = new GitAskPassPublisher();
  bindCleanupBrokerTransport(publisher, channel, binding, bootstrap.network);
  const signal = AbortSignal.timeout(Math.max(1, bootstrap.deadlineMs - Date.now()));
  const bypass = bootstrap.network.noProxy
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((s) => s === '*' || s === 'api.github.com' || s === '.github.com' || s === 'github.com');
  const dispatcher =
    bootstrap.network.httpsProxy && !bypass
      ? new ProxyAgent(bootstrap.network.httpsProxy)
      : new Agent();
  const fetchBound: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (
      !url.startsWith('https://api.github.com/') ||
      new URL(url).origin !== 'https://api.github.com'
    )
      throw new Error('CLEANUP_EXECUTOR_NETWORK_DENIED');
    const response = await networkFetch(url, {
      ...init,
      headers: new Headers(init?.headers) as never,
      body: init?.body as never,
      dispatcher,
      redirect: 'error',
      signal: signal,
    });
    return response as unknown as Response;
  };
  const json = async (
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchBound('https://api.github.com' + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('CLEANUP_EXECUTOR_API_FAILED');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('CLEANUP_EXECUTOR_API_FAILED');
    let n = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      n += next.value.length;
      if (n > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('CLEANUP_EXECUTOR_API_FAILED');
      }
      chunks.push(next.value);
    }
    const result: unknown = JSON.parse(
      new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!object(result)) throw new Error('CLEANUP_EXECUTOR_API_FAILED');
    return result;
  };
  try {
    const jwt = createGitHubAppJwt(String(bootstrap.app.appId), bootstrap.app.privateKey);
    const installation = await json(`/repos/${r.repo}/installation`, jwt);
    if (
      installation.id !== bootstrap.app.installationId ||
      installation.app_id !== bootstrap.app.appId ||
      installation.suspended_at !== null
    )
      throw new Error('CLEANUP_EXECUTOR_INSTALLATION_MISMATCH');
    const token = await json(
      `/app/installations/${bootstrap.app.installationId}/access_tokens`,
      jwt,
      'POST',
      {
        repositories: [r.repo.split('/')[1]],
        permissions: {
          contents: 'write',
          pull_requests: 'read',
          issues: 'read',
          administration: 'read',
          metadata: 'read',
        },
      },
    );
    if (
      typeof token.token !== 'string' ||
      !token.token ||
      typeof token.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(token.expires_at)) ||
      Date.parse(token.expires_at) <= bootstrap.deadlineMs ||
      !object(token.permissions) ||
      token.permissions.contents !== 'write'
    )
      throw new Error('CLEANUP_EXECUTOR_TOKEN_INVALID');
    const [owner, repo] = r.repo.split('/') as [string, string];
    const client = createCleanupBrokerClient(token.token, owner, repo, fetchBound);
    client.tokenExpiresAt = token.expires_at;
    const validateResource = async () => {
      checkTaskView(bootstrap.taskView, binding.target);
      const [repository, pull] = await Promise.all([
        client.octokit.repos.get({ owner, repo, request: { signal } }),
        client.octokit.pulls.get({ owner, repo, pull_number: r.prNumber, request: { signal } }),
      ]);
      if (
        !Number.isSafeInteger(repository.data.id) ||
        String(repository.data.id) !== binding.target.repositoryId ||
        repository.data.full_name !== r.repo ||
        pull.data.node_id !== binding.target.prNodeId ||
        pull.data.number !== r.prNumber ||
        String(pull.data.base.repo.id) !== binding.target.repositoryId ||
        String(pull.data.head.repo?.id) !== binding.target.repositoryId ||
        `refs/heads/${pull.data.head.ref}` !== binding.target.ref ||
        pull.data.head.sha !== binding.target.expectedSha
      )
        throw new Error('CLEANUP_EXECUTOR_RESOURCE_MISMATCH');
      checkTaskView(bootstrap.taskView, binding.target);
    };
    await withCleanupBrokerClient(client, async () => {
      await validateResource();
      const access = async (input: { token: string; owner: string; repo: string }) =>
        inspectInstallationRepositoryAccess(input, {
          listPage: async ({ page, perPage }) => {
            const data = await json(
              `/installation/repositories?per_page=${perPage}&page=${page}`,
              input.token,
            );
            if (!Array.isArray(data.repositories) || !Number.isSafeInteger(data.total_count))
              throw new Error('CLEANUP_EXECUTOR_ACCESS_INVALID');
            return {
              totalCount: Number(data.total_count),
              repositories: data.repositories.map((item) => {
                if (!object(item) || typeof item.full_name !== 'string')
                  throw new Error('CLEANUP_EXECUTOR_ACCESS_INVALID');
                return { fullName: item.full_name };
              }),
            };
          },
        });
      const deps = {
        tokenProvider: {
          invalidate: () => {},
          acquire: async () => ({
            value: token.token as string,
            expiresAt: token.expires_at as string,
            installationId: String(bootstrap.app.installationId),
            permissions: token.permissions as Record<string, string>,
          }),
        },
        gitPublisher: publisher,
        repositoryInspector: access,
      };
      const resources: PRBranchCleanupDependencies = {
        fetchPR: async (n, o) => {
          await validateResource();
          return fetchPRDetails(n, o);
        },
        getDefaultBranch,
        isBranchProtected,
        listOpenPRsForBranch,
        claimRefPresent,
        readRemoteBranchSha: (input) => readRemoteBranchSha(input, deps),
        deleteRemoteBranchIfAt: (input) => deleteRemoteBranchIfAt(input, deps),
        hasLocalTaskDependency: (_root, link) => {
          checkTaskView(bootstrap.taskView, binding.target);
          return bootstrap.taskView.tasks.some(
            (task) =>
              (task.taskId === link.task_id || task.issueNumber === link.issue_number) &&
              ['pending', 'claimed', 'in-progress'].includes(task.state),
          );
        },
      };
      const result = await cleanupPRBranchThroughBroker(
        {
          prNumber: r.prNumber,
          rootDir: '/var/lib/openslack-cleanup',
          owner,
          repo,
          remote: r.remote,
          auth: 'app',
          timeoutMs: Math.max(1, bootstrap.deadlineMs - Date.now()),
          execute: bootstrap.mode === 'execute',
          context: brokerSessionContext(session),
        },
        session,
        resources,
      );
      channel.writeControl({
        schema: 'openslack.cleanup_executor_control.v1',
        type: 'result',
        ...binding,
        state: result.state,
        reason: result.reason,
        attempted: result.attempted,
      });
    });
  } finally {
    await dispatcher.close();
  }
}

/** Only the private bundle entrypoint invokes this function. */
export async function runCleanupBrokerExecutor(): Promise<void> {
  const channel = openCleanupBrokerChannel();
  let bootstrap: CleanupExecutorBootstrap | undefined;
  try {
    bootstrap = parseCleanupExecutorBootstrap(channel.readBootstrap());
    await run(bootstrap, channel);
  } catch {
    // Do not synthesize attempted=false after an arbitrary execution failure.
    // EOF lets the broker reconcile against its own durable send admission.
    process.exitCode = 1;
  }
}
