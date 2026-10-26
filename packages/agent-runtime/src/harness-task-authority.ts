import { isAbsolute, relative } from 'node:path';
import { authorizeAgentAction, compilePathGlob, type AgentPrincipal } from '@openslack/kernel';
import { resolveAgentPrincipal } from '@openslack/runtime';
import { hashHarnessInput } from './harness-admission.js';
import { readRunStateSnapshot } from './run-store.js';
import type { ApprovedHarnessTask, HarnessTaskHostOptions } from './harness-task-host.js';
import { hashHarnessTask } from './harness-task-host.js';
import type { BridgeProcessAdapterOptions } from './bridge-adapter.js';
import { buildHarnessTaskPermissionProfile } from './harness-permissions.js';

/** Formal task source data. allowedPaths belongs to the approved source, not to dispatch arguments. */
export interface HarnessApprovedTaskSource {
  read(taskId: string): Promise<{
    task: Omit<ApprovedHarnessTask, 'principalHash'>;
    allowedPaths: string[];
    forbiddenPaths: string[];
    /** Required by the formal task source; deployment cannot waive an applicable claim. */
    claimRequired: boolean;
    /** Digest of semantic approved task content; not request ID, heartbeat time or a temporary worktree path. */
    sourceDigest: string;
  }>;
  readLease?(taskId: string): Promise<{ owners: AgentPrincipal[]; expiresAt: string; claimRef: string }>;
}

/** Supplied after provisioning. This resolver never creates, copies, renews or replaces identity. */
export interface HarnessTaskAuthorityOptions {
  identityRoot: string;
  agentId: string;
  uid: string;
  principalId: string;
  runtimeRunId: string;
  provider: 'cli' | 'slack' | 'github' | 'webhook';
  claimMode: 'required' | 'not_applicable';
  source: HarnessApprovedTaskSource;
}

/** Production authority binding for the task host and its pre-effect Bridge callbacks. */
export function createHarnessTaskAuthority(options: HarnessTaskAuthorityOptions): {
  readTask: HarnessTaskHostOptions['readTask'];
  authorize: HarnessTaskHostOptions['authorize'];
  authorizeTool: NonNullable<BridgeProcessAdapterOptions['authorizeTool']>;
} {
  const binding = { ...options };
  if (!isAbsolute(binding.identityRoot) || !binding.agentId || !binding.uid || !binding.runtimeRunId ||
    !binding.principalId || (binding.claimMode === 'required' && !binding.source.readLease)) {
    throw new Error('Harness production authority is incomplete; provisioning must precede live dispatch');
  }
  const principal = () => {
    const resolved = resolveAgentPrincipal({ root: binding.identityRoot, agentId: binding.agentId, provider: binding.provider });
    if ('error' in resolved || resolved.principalId !== binding.principalId ||
      resolved.principal.runtime_uid !== binding.uid || resolved.principal.run_id !== binding.runtimeRunId ||
      resolved.principal.registry_id !== binding.agentId || resolved.principal.provider !== binding.provider) {
      throw new Error('Approved Harness runtime principal is unavailable or changed');
    }
    return resolved;
  };
  const hash = (value: ReturnType<typeof principal>) => hashHarnessInput({
    principal: value.principal, principalId: value.principalId,
    permissions: value.snapshot.permissions, source: value.snapshot.source,
  });
  const source = async (taskId: string) => {
    const value = structuredClone(await binding.source.read(taskId));
    if (value.task.taskId !== taskId || !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
      typeof value.claimRequired !== 'boolean' || (value.claimRequired && binding.claimMode !== 'required') ||
      value.task.request.agentId !== binding.agentId || value.task.request.resolvedConfig.agentId !== binding.agentId) {
      throw new Error('Approved task source or execution identity changed');
    }
    if (hashHarnessInput(value.task.request.permissionProfile) !==
      hashHarnessInput(buildHarnessTaskPermissionProfile(value.task.request.resolvedConfig))) {
      throw new Error('Harness task capability declaration is not canonical');
    }
    const paths = [...value.task.scope.readPaths, ...value.task.scope.writePaths];
    for (const path of paths) {
      if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') ||
        !value.allowedPaths.some(pattern => compilePathGlob(pattern)(path)) ||
        [...value.forbiddenPaths, ...value.task.scope.forbiddenPaths].some(pattern => compilePathGlob(pattern)(path))) {
        throw new Error('File is outside the formal task scope');
      }
    }
    return value;
  };
  const lease = async (taskId: string, expected: AgentPrincipal): Promise<void> => {
    if (binding.claimMode === 'not_applicable') return;
    const current = await binding.source.readLease!(taskId);
    if (current.owners.length !== 1 || hashHarnessInput(current.owners[0]) !== hashHarnessInput(expected) ||
      !current.claimRef || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) {
      throw new Error('Harness task claim owner or lease is not valid');
    }
  };
  const readTask: HarnessTaskHostOptions['readTask'] = async taskId => {
    const before = principal();
    const value = await source(taskId);
    await lease(taskId, before.principal);
    const after = principal();
    if (hash(before) !== hash(after)) throw new Error('Harness permissions changed during task resolution');
    return { ...value.task, sourceDigest: value.sourceDigest, principalId: binding.principalId, principalHash: hash(after) };
  };
  const authorize: HarnessTaskHostOptions['authorize'] = async (task, phase) => {
    const before = principal();
    if (hash(before) !== task.principalHash) throw new Error('Harness task permission snapshot changed');
    const value = await source(task.taskId);
    if (value.sourceDigest !== task.sourceDigest) throw new Error('Approved task content changed');
    if (hashHarnessTask({ ...value.task, sourceDigest: value.sourceDigest, principalId: binding.principalId,
      principalHash: hash(before) }) !== hashHarnessTask(task)) throw new Error('Harness task differs from the formal source');
    const action = phase === 'report' ? 'harness.task.report' : 'harness.task.dispatch';
    const decision = authorizeAgentAction({ snapshot: before.snapshot, action, riskZone: 'yellow',
      changedPaths: [...task.scope.readPaths, ...task.scope.writePaths] });
    if (decision.decision !== 'allow') throw new Error('Harness task is outside principal authorization');
    if (task.request.permissionProfile.allowedTools.includes('mcp.openslack.openslack_preview_workflow') &&
      authorizeAgentAction({ snapshot: before.snapshot, action: 'harness.task.report', riskZone: 'yellow',
        changedPaths: [...task.scope.readPaths, ...task.scope.writePaths] }).decision !== 'allow') {
      throw new Error('Required Harness report capability is outside principal authorization');
    }
    await lease(task.taskId, before.principal);
    if (hash(principal()) !== hash(before)) throw new Error('Harness permissions changed during authorization');
  };
  return {
    readTask, authorize,
    async authorizeTool(context, toolName, input) {
      context.signal?.throwIfAborted();
      if (!['Read', 'Write', 'Edit'].includes(toolName) || !input || typeof input !== 'object' ||
        !('file_path' in input) || typeof input.file_path !== 'string' || !isAbsolute(input.file_path) ||
        !context.worktreePath || context.agentId !== binding.agentId) throw new Error('Unsupported Harness file authorization');
      const state = readRunStateSnapshot(context.runId, binding.identityRoot);
      if (!state?.harnessExecution || state.harnessExecution.stopRequestedAt || state.status !== 'running' || state.worktreePath !== context.worktreePath) {
        throw new Error('Harness tool is not bound to the live canonical run');
      }
      const task = await readTask(state.harnessExecution.taskId);
      if (task.principalHash !== state.harnessExecution.principalHash ||
        hashHarnessTask(task) !== state.harnessExecution.requestHash) throw new Error('Harness run task or principal changed');
      const path = relative(context.worktreePath, input.file_path).replaceAll('\\', '/');
      if (!(toolName === 'Read' ? task.scope.readPaths : task.scope.writePaths).includes(path)) {
        throw new Error('Harness file action is outside the task grant');
      }
      await authorize(task, 'execute');
      const currentRun = readRunStateSnapshot(context.runId, binding.identityRoot);
      const currentPrincipal = principal();
      if (currentRun?.status !== 'running' || currentRun.harnessExecution?.stopRequestedAt || currentRun.worktreePath !== context.worktreePath ||
        currentRun.harnessExecution?.requestHash !== state.harnessExecution.requestHash || hash(currentPrincipal) !== task.principalHash) {
        throw new Error('Harness tool ownership changed during authorization');
      }
      const decision = authorizeAgentAction({ snapshot: currentPrincipal.snapshot, action: 'harness.task.dispatch',
        changedPaths: [path], riskZone: 'yellow' });
      context.signal?.throwIfAborted();
      if (decision.decision !== 'allow') throw new Error('Live Harness file authorization denied');
    },
  };
}
