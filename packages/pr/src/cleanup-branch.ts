import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { authorizeAgentAction } from '@openslack/kernel';
import {
  claimRefPresent,
  getDefaultBranch,
  isBranchProtected,
  listOpenPRsForBranch,
  type GitHubClientOptions,
} from '@openslack/github';
import { deleteRemoteBranchIfAt, readRemoteBranchSha } from '@openslack/delivery';
import { fetchPRDetails } from './fetch.js';
import { evaluatePRBasePolicy } from './base-policy.js';
import { parseTaskLinkMarker } from './task-link.js';
import type { CleanupTaskLink } from './task-link.js';
import {
  matchesBrokerSession,
  brokerSessionTarget,
  type CleanupBrokerSession,
} from './internal/cleanup-broker-executor-session.js';
import { CleanupBrokerSendDeniedError } from '../../delivery/dist/internal/cleanup-broker-transport.js';
import type {
  PRBranchCleanupInput,
  PRBranchCleanupResult,
  PRBranchCleanupState,
} from './cleanup-types.js';

export interface PRBranchCleanupDependencies {
  fetchPR: typeof fetchPRDetails;
  getDefaultBranch: typeof getDefaultBranch;
  isBranchProtected: typeof isBranchProtected;
  listOpenPRsForBranch: typeof listOpenPRsForBranch;
  claimRefPresent: typeof claimRefPresent;
  readRemoteBranchSha: typeof readRemoteBranchSha;
  deleteRemoteBranchIfAt: typeof deleteRemoteBranchIfAt;
  hasLocalTaskDependency: (rootDir: string, link: CleanupTaskLink) => boolean;
}

function hasLocalTaskDependency(root: string, link: CleanupTaskLink): boolean {
  // A local non-terminal association is positive evidence, never a global index.
  // Do not interpret or trust a mutable run status to release a claimed task.
  for (const state of ['claimed', 'pending', 'in-progress']) {
    try {
      lstatSync(join(root, '.openslack', 'tasks', state, link.task_id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

const defaults: PRBranchCleanupDependencies = {
  fetchPR: (n, options) => fetchPRDetails(n, options),
  getDefaultBranch: (options) => getDefaultBranch(options),
  isBranchProtected: (branch, options) => isBranchProtected(branch, options),
  listOpenPRsForBranch: (branch, options) => listOpenPRsForBranch(branch, options),
  claimRefPresent: (issue, options) => claimRefPresent(issue, options),
  readRemoteBranchSha: (input, options) => readRemoteBranchSha(input, options),
  deleteRemoteBranchIfAt: (input, options) => deleteRemoteBranchIfAt(input, options),
  hasLocalTaskDependency,
};

const fullSha = /^[0-9a-f]{40}$/;
const repositoryPart = /^[A-Za-z0-9_.-]+$/;

function validBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 1024 &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !branch.endsWith('.') &&
    !branch.startsWith('-') &&
    branch !== '@' &&
    branch
      .split('/')
      .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

function reserved(branch: string, defaultBranch: string): boolean {
  return (
    branch === 'main' ||
    branch === defaultBranch ||
    /^openslack\/(claims|probes)(\/|$)/.test(branch)
  );
}

function authorized(input: PRBranchCleanupInput): boolean {
  const c = input.context;
  if (!c) return false;
  if (c.kind === 'human-cli') return !('snapshot' in c) && !('principal' in c);
  if (c.kind !== 'agent' || !c.principal || !c.snapshot?.principal) return false;
  const p = c.principal;
  const s = c.snapshot.principal;
  if (
    !p.registry_id ||
    !p.runtime_uid ||
    !p.run_id ||
    p.registry_id !== s.registry_id ||
    p.runtime_uid !== s.runtime_uid ||
    p.run_id !== s.run_id ||
    p.provider !== s.provider ||
    c.snapshot.registry_entry_agent_id !== p.registry_id
  )
    return false;
  try {
    return (
      authorizeAgentAction({
        snapshot: c.snapshot,
        action: 'pr.cleanup_branch',
        riskZone: 'yellow',
      }).decision === 'allow'
    );
  } catch {
    return false;
  }
}

/** Bound read/audit latency. The destructive transport has its own absolute deadline. */
async function within<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('CLEANUP_DEADLINE');
  let listener: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        listener = () => reject(new Error('CLEANUP_DEADLINE'));
        signal.addEventListener('abort', listener, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

export async function planPRBranchCleanup(
  input: PRBranchCleanupInput,
  dependencies: Partial<PRBranchCleanupDependencies> = {},
): Promise<PRBranchCleanupResult> {
  return cleanupPRBranch({ ...input, execute: false }, dependencies);
}

export async function cleanupPRBranch(
  input: PRBranchCleanupInput,
  dependencies: Partial<PRBranchCleanupDependencies> = {},
): Promise<PRBranchCleanupResult> {
  return cleanupOwned(input, dependencies);
}

/** Private fixed-executor entry; not exported from the package index. The
 * broker owns durable intent/outcome auditing, not a caller-supplied callback. */
export async function cleanupPRBranchThroughBroker(
  input: PRBranchCleanupInput,
  session: CleanupBrokerSession,
  dependencies: PRBranchCleanupDependencies,
): Promise<PRBranchCleanupResult> {
  if (input.audit !== undefined || !matchesBrokerSession(session, input))
    throw new Error('CLEANUP_BROKER_SESSION_INVALID');
  return cleanupOwned(input, dependencies, session);
}

async function cleanupOwned(
  input: PRBranchCleanupInput,
  dependencies: Partial<PRBranchCleanupDependencies>,
  broker?: CleanupBrokerSession,
): Promise<PRBranchCleanupResult> {
  const { audit, ...data } = input;
  const owned = { ...structuredClone(data), audit };
  const deadline = Date.now() + (owned.timeoutMs ?? 60_000);
  const result = await runCleanup(owned, dependencies, broker);
  // Read-only and preflight-blocked decisions are also observable. Unlike the
  // mandatory pre-delete intent, failure of this notification cannot cause a write.
  if (result.auditStatus === 'NOT_REQUIRED' && audit) {
    const context = owned.context;
    const executor =
      context?.kind === 'human-cli'
        ? 'human-cli'
        : context?.kind === 'agent' &&
            /^[A-Za-z0-9_.-]{1,128}$/.test(context.principal?.registry_id ?? '')
          ? context.principal.registry_id
          : 'unknown';
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('CLEANUP_DEADLINE');
      await within(
        Promise.resolve().then(() =>
          audit({
            mode: owned.execute ? 'execute' : 'preview',
            phase: 'outcome',
            operationId: result.operationId,
            repository: result.repository,
            prNumber: result.prNumber,
            branch: result.branch,
            expectedSha: result.expectedSha,
            observedSha: result.observedSha,
            observedRefState: result.observedRefState,
            state: result.state,
            attempted: result.attempted,
            executor,
            authorizationSource: !owned.execute
              ? 'preview-only'
              : executor === 'human-cli'
                ? 'human-cli:--execute'
                : 'registry:pr.cleanup_branch',
            evidenceTimestamp: result.evidenceTimestamp,
          }),
        ),
        AbortSignal.timeout(Math.max(1, remainingMs)),
      );
      result.auditStatus = 'RECORDED';
    } catch {
      result.auditStatus = 'FAILED';
    }
  }
  return result;
}

async function runCleanup(
  caller: PRBranchCleanupInput,
  overrides: Partial<PRBranchCleanupDependencies>,
  broker?: CleanupBrokerSession,
): Promise<PRBranchCleanupResult> {
  // Own authorization and target data before the first await. Audit is a capability.
  const { audit, ...data } = caller;
  let input: PRBranchCleanupInput;
  try {
    input = { ...structuredClone(data), audit };
  } catch {
    throw new TypeError('CLEANUP_INPUT_INVALID');
  }
  const deps = { ...defaults, ...overrides };
  let result: PRBranchCleanupResult = {
    state: 'BLOCKED_EVIDENCE',
    repository: `${input.owner}/${input.repo}`,
    prNumber: input.prNumber,
    attempted: false,
    checks: [],
    reason: '',
    operationId: randomUUID(),
    evidenceTimestamp: new Date().toISOString(),
    auditStatus: 'NOT_REQUIRED',
  };
  const stop = (state: PRBranchCleanupState, name: string, reason: string) => {
    result.state = state;
    result.reason = reason;
    result.checks.push({ name, status: 'FAIL', detail: reason });
    return result;
  };
  const pass = (name: string) => result.checks.push({ name, status: 'PASS' });
  const timeout = input.timeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(input.prNumber) ||
    input.prNumber <= 0 ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > 600_000 ||
    !repositoryPart.test(input.owner) ||
    !repositoryPart.test(input.repo) ||
    ['.', '..'].includes(input.owner) ||
    ['.', '..'].includes(input.repo) ||
    !input.rootDir ||
    !['auto', 'app', 'token'].includes(input.auth ?? 'auto') ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.remote ?? 'origin')
  ) {
    return stop('BLOCKED_EVIDENCE', 'input', 'CLEANUP_INPUT_INVALID');
  }
  if (!(broker ? matchesBrokerSession(broker, input) : authorized(input)))
    return stop('BLOCKED_AUTHORIZATION', 'authorization', 'CLEANUP_AUTHORIZATION_REQUIRED');
  pass('authorization');
  const deadline = Date.now() + timeout;
  const signal = AbortSignal.timeout(timeout);
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0 || signal.aborted) throw new Error('CLEANUP_DEADLINE');
    return ms;
  };
  const options: GitHubClientOptions = {
    owner: input.owner,
    repo: input.repo,
    auth: input.auth ?? 'auto',
    cwd: input.rootDir,
    requireLive: true,
    strictEvidence: true,
    signal,
  };
  const gitInput = () => ({
    rootDir: input.rootDir,
    owner: input.owner,
    repo: input.repo,
    remote: input.remote ?? 'origin',
    branch: result.branch!,
    timeoutMs: remaining(),
  });
  const observe = async (): Promise<boolean> => {
    remaining();
    const pr = await within(deps.fetchPR(input.prNumber, options), signal);
    if (
      pr.prNumber !== input.prNumber ||
      !pr.headRepoFullName ||
      !pr.baseRepoFullName ||
      !pr.headRef ||
      !validBranch(pr.headRef) ||
      !pr.headSha ||
      !fullSha.test(pr.headSha) ||
      !pr.baseRef
    ) {
      stop('BLOCKED_EVIDENCE', 'pr', 'CLEANUP_PR_EVIDENCE_INCOMPLETE');
      return false;
    }
    if (pr.merged !== true) {
      stop('BLOCKED_NOT_MERGED', 'merged', 'CLEANUP_PR_NOT_MERGED');
      return false;
    }
    if (evaluatePRBasePolicy(pr, { required_base_ref: 'main' })) {
      stop('BLOCKED_BASE_BRANCH', 'base', 'CLEANUP_NONCANONICAL_BASE');
      return false;
    }
    if (
      pr.baseRepoFullName.toLowerCase() !== result.repository.toLowerCase() ||
      pr.headRepoFullName.toLowerCase() !== result.repository.toLowerCase()
    ) {
      stop('BLOCKED_FORK', 'repository', 'CLEANUP_REPOSITORY_MISMATCH');
      return false;
    }
    if (result.branch && (result.branch !== pr.headRef || result.expectedSha !== pr.headSha)) {
      stop('BLOCKED_SHA_DRIFT', 'target', 'CLEANUP_PR_TARGET_CHANGED');
      return false;
    }
    result.branch = pr.headRef;
    result.expectedSha = pr.headSha;
    if (broker) {
      const target = brokerSessionTarget(broker);
      if (target.ref !== `refs/heads/${pr.headRef}` || target.expectedSha !== pr.headSha) {
        stop('BLOCKED_SHA_DRIFT', 'permit_target', 'CLEANUP_PERMIT_TARGET_MISMATCH');
        return false;
      }
    }
    pass('pr');
    const defaultBranch = await within(deps.getDefaultBranch(options), signal);
    if (!defaultBranch || !validBranch(defaultBranch)) throw new Error('DEFAULT_BRANCH_INVALID');
    if (reserved(result.branch, defaultBranch)) {
      stop('BLOCKED_BRANCH_RESERVED', 'reserved', 'CLEANUP_BRANCH_RESERVED');
      return false;
    }
    pass('reserved');
    const sha = await within(deps.readRemoteBranchSha(gitInput()), signal);
    if (sha === null || sha === '') {
      result.observedRefState = 'ABSENT';
      result.observedSha = undefined;
      result.state = 'ALREADY_ABSENT';
      result.reason = 'CLEANUP_REF_ABSENT';
      result.checks.push({
        name: 'protection/dependencies',
        status: 'N/A',
        detail: 'Remote ref absent',
      });
      return false;
    }
    if (!fullSha.test(sha)) throw new Error('REMOTE_SHA_INVALID');
    result.observedSha = sha;
    result.observedRefState = 'PRESENT';
    if (sha !== result.expectedSha) {
      stop('BLOCKED_SHA_DRIFT', 'sha', 'CLEANUP_SHA_DRIFT');
      return false;
    }
    pass('sha');
    if (await within(deps.isBranchProtected(result.branch, options), signal)) {
      stop('BLOCKED_BRANCH_RESERVED', 'protection', 'CLEANUP_BRANCH_PROTECTED');
      return false;
    }
    pass('protection');
    const prs = await within(deps.listOpenPRsForBranch(result.branch, options), signal);
    if (prs.length > 0) {
      stop('BLOCKED_DEPENDENCY', 'open_prs', 'CLEANUP_OPEN_PR_DEPENDENCY');
      return false;
    }
    pass('open_prs');
    const marker = parseTaskLinkMarker(pr.body);
    if (marker.state === 'INVALID') {
      stop('BLOCKED_EVIDENCE', 'task', 'CLEANUP_INVALID_TASK_LINK');
      return false;
    }
    const taskBranch = result.branch.match(/^agent\/([^/]+)\/(TASK-[^/]+)\/(RUN-[^/]+)$/);
    if (marker.state === 'ABSENT') {
      if (taskBranch || /\/(TASK-|RUN-)/.test(result.branch)) {
        stop('BLOCKED_EVIDENCE', 'task', 'CLEANUP_TASK_LINK_MISSING');
        return false;
      }
      result.checks.push({
        name: 'task',
        status: 'N/A',
        detail: 'No task association observed; not a global absence proof',
      });
    } else {
      const m = marker.metadata;
      if (
        taskBranch &&
        (taskBranch[1] !== m.agent_id || taskBranch[2] !== m.task_id || taskBranch[3] !== m.run_id)
      ) {
        stop('BLOCKED_EVIDENCE', 'task', 'CLEANUP_TASK_LINK_MISMATCH');
        return false;
      }
      if (
        (await within(deps.claimRefPresent(m.issue_number, options), signal)) ||
        deps.hasLocalTaskDependency(input.rootDir, m)
      ) {
        stop('BLOCKED_DEPENDENCY', 'task', 'CLEANUP_TASK_DEPENDENCY');
        return false;
      }
      pass('task');
    }
    result.state = 'CLEANUP_READY';
    result.reason = 'CLEANUP_EVIDENCE_READY';
    result.evidenceTimestamp = new Date().toISOString();
    return true;
  };
  const record = async (phase: 'requested' | 'outcome') => {
    // This private worker cannot write the broker ledger. Its process was
    // admitted only after the broker fsynced intent, and the broker persists
    // the returned receipt. Do not label a worker-local callback as durable.
    if (broker && matchesBrokerSession(broker, input)) return;
    if (!audit) throw new Error('CLEANUP_AUDIT_REQUIRED');
    remaining();
    await within(
      audit({
        mode: input.execute ? 'execute' : 'preview',
        phase,
        operationId: result.operationId,
        repository: result.repository,
        prNumber: result.prNumber,
        branch: result.branch,
        expectedSha: result.expectedSha,
        observedSha: result.observedSha,
        observedRefState: result.observedRefState,
        state: result.state,
        attempted: result.attempted,
        executor:
          input.context.kind === 'agent' ? input.context.principal.registry_id : 'human-cli',
        authorizationSource:
          input.context.kind === 'agent' ? 'registry:pr.cleanup_branch' : 'human-cli:--execute',
        evidenceTimestamp: result.evidenceTimestamp,
      }),
      signal,
    );
    result.auditStatus = 'RECORDED';
  };
  try {
    const ready = await observe();
    if (!input.execute) return result;
    if (!ready && result.state !== 'ALREADY_ABSENT') return result;
    if (!ready) {
      try {
        await record('outcome');
      } catch {
        result.auditStatus = 'FAILED';
        result.reason = 'CLEANUP_AUDIT_FAILED';
      }
      return result;
    }
    try {
      await record('requested');
    } catch {
      result.auditStatus = 'FAILED';
      return stop('BLOCKED_AUDIT', 'audit', 'CLEANUP_INTENT_NOT_DURABLE');
    }
    try {
      // Revalidate AFTER durable intent: audit callbacks may await human or disk work.
      if (await observe()) {
        // Keep a bounded tail for terminal audit; delivery reserves its own ref readback.
        const auditBudget = Math.min(2_000, Math.max(20, Math.floor(timeout / 5)));
        const transportBudget = remaining() - auditBudget;
        if (transportBudget <= 0) throw new Error('CLEANUP_DEADLINE');
        const transport = {
          ...gitInput(),
          timeoutMs: transportBudget,
          expectedSha: result.expectedSha!,
        };
        result.attempted = true; // Conservative if transport throws without a receipt.
        const deletion = await deps.deleteRemoteBranchIfAt(transport);
        result.attempted = deletion.attempted;
        result.observedSha = deletion.observedSha;
        result.observedRefState = deletion.observedRefState;
        result.state =
          deletion.state === 'ABSENT'
            ? 'ALREADY_ABSENT'
            : deletion.state === 'STALE'
              ? 'BLOCKED_SHA_DRIFT'
              : deletion.state;
        result.reason = `CLEANUP_${deletion.state}`;
      }
    } catch (error) {
      if (broker && error instanceof CleanupBrokerSendDeniedError) {
        result.attempted = false;
        result.state = 'BLOCKED_AUTHORIZATION';
        result.reason = 'CLEANUP_BROKER_SEND_NOT_ADMITTED';
      } else {
        result.state = result.attempted ? 'RECONCILIATION_REQUIRED' : 'BLOCKED_EVIDENCE';
        if (result.attempted) {
          result.observedRefState = 'UNKNOWN';
          result.observedSha = undefined;
        }
        result.reason = 'CLEANUP_EXECUTION_EVIDENCE_UNAVAILABLE';
      }
    }
    try {
      await record('outcome');
    } catch {
      result.auditStatus = 'FAILED';
      result.reason = 'CLEANUP_OUTCOME_AUDIT_FAILED';
    }
    return result;
  } catch {
    result = stop('BLOCKED_EVIDENCE', 'evidence', 'CLEANUP_LIVE_EVIDENCE_UNAVAILABLE');
    return result;
  }
}
