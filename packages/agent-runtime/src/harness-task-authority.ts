import { isAbsolute, relative } from 'node:path';
import { authorizeAgentAction, compilePathGlob, type AgentPrincipal } from '@openslack/kernel';
import { resolveAgentPrincipal } from '@openslack/runtime';
import { hashHarnessInput } from './harness-admission.js';
import { readRunStateSnapshotWhenAvailable } from './run-store.js';
import type { ApprovedHarnessTask, HarnessTaskHostOptions } from './harness-task-host.js';
import { hashHarnessTask } from './harness-task-host.js';
import type { AdapterExecutionContext } from './adapter.js';
import { buildHarnessTaskPermissionProfile } from './harness-permissions.js';
import { assertHarnessNotStopped } from './harness-stop.js';
import { HARNESS_CALLBACK_TOOLS } from './bridge-wire.js';
import { assertHarnessTaskEligibility, bindHarnessToolEligibility, createHarnessTaskEligibility,
  type HarnessEligibilityPhase, type HarnessEligibilityRestriction, type HarnessTaskEligibility, type HarnessToolEligibility } from './harness-eligibility.js';

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
  authorize(task: ApprovedHarnessTask, phase: HarnessEligibilityPhase): Promise<HarnessTaskEligibility>;
  authorizeTool(context: AdapterExecutionContext, toolName: string, input: unknown): Promise<HarnessToolEligibility>;
  readTaskForReconciliation: HarnessTaskHostOptions['readTask'];
  observeExecutionEligibility(task: ApprovedHarnessTask): Promise<boolean>;
  principalId: string;
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
  const assertLeaseCurrent = (value: HarnessEligibilityRestriction): void => {
    if (value.mode === 'required' && Date.now() >= value.expiresAt) throw new Error('Harness task claim lease expired during authorization');
  };
  const lease = async (taskId: string, expected: AgentPrincipal): Promise<HarnessEligibilityRestriction> => {
    if (binding.claimMode === 'not_applicable') return { mode: 'not_applicable' };
    const current = await binding.source.readLease!(taskId);
    if (current.owners.length !== 1 || hashHarnessInput(current.owners[0]) !== hashHarnessInput(expected) ||
      !current.claimRef || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) {
      throw new Error('Harness task claim owner or lease is not valid');
    }
    return { mode: 'required', expiresAt: Date.parse(current.expiresAt) };
  };
  const readTask: HarnessTaskHostOptions['readTask'] = async taskId => {
    const before = principal();
    const value = await source(taskId);
    const observedLease = await lease(taskId, before.principal);
    const after = principal();
    if (hash(before) !== hash(after)) throw new Error('Harness permissions changed during task resolution');
    assertLeaseCurrent(observedLease);
    return { ...value.task, sourceDigest: value.sourceDigest, principalId: binding.principalId, principalHash: hash(after) };
  };
  // Observation is deliberately separate: no claim renewal and no active lease is required to read history.
  const readTaskForReconciliation: HarnessTaskHostOptions['readTask'] = async taskId => {
    const before = principal();
    const value = await source(taskId);
    const after = principal();
    if (hash(before) !== hash(after)) throw new Error('Harness permissions changed during history observation');
    return { ...value.task, sourceDigest: value.sourceDigest, principalId: binding.principalId, principalHash: hash(after) };
  };
  const authorize = async (input: ApprovedHarnessTask, phase: HarnessEligibilityPhase): Promise<HarnessTaskEligibility> => {
    const task = structuredClone(input);
    const before = principal();
    if (hash(before) !== task.principalHash) throw new Error('Harness task permission snapshot changed');
    const value = await source(task.taskId);
    if (value.sourceDigest !== task.sourceDigest) throw new Error('Approved task content changed');
    const taskHash = hashHarnessTask(task);
    if (hashHarnessTask({ ...value.task, sourceDigest: value.sourceDigest, principalId: binding.principalId,
      principalHash: hash(before) }) !== taskHash) throw new Error('Harness task differs from the formal source');
    const action = phase === 'report' ? 'harness.task.report' : 'harness.task.dispatch';
    const decision = authorizeAgentAction({ snapshot: before.snapshot, action, riskZone: 'yellow',
      changedPaths: [...task.scope.readPaths, ...task.scope.writePaths] });
    if (decision.decision !== 'allow') throw new Error('Harness task is outside principal authorization');
    if (task.request.permissionProfile.allowedTools.includes('mcp.openslack.openslack_preview_workflow') &&
      authorizeAgentAction({ snapshot: before.snapshot, action: 'harness.task.report', riskZone: 'yellow',
        changedPaths: [...task.scope.readPaths, ...task.scope.writePaths] }).decision !== 'allow') {
      throw new Error('Required Harness report capability is outside principal authorization');
    }
    const observedLease = await lease(task.taskId, before.principal);
    if (hash(principal()) !== hash(before)) throw new Error('Harness permissions changed during authorization');
    return createHarnessTaskEligibility({ taskId: task.taskId, taskHash, principalId: binding.principalId, principalHash: task.principalHash, phase }, observedLease);
  };
  return {
    readTask, authorize, readTaskForReconciliation, principalId: binding.principalId,
    async observeExecutionEligibility(task) { try { await authorize(structuredClone(task), 'execute'); return true; } catch { return false; } },
    async authorizeTool(context, toolName, input) {
      context.signal?.throwIfAborted();
      const toolInput = structuredClone(input);
      const callback = Object.entries(HARNESS_CALLBACK_TOOLS).find(([, value]) => value.bridge === toolName)?.[0];
      const row = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : undefined;
      if (!row || !context.worktreePath || context.agentId !== binding.agentId ||
        (!callback && (!['Read', 'Write', 'Edit'].includes(toolName) || typeof row.file_path !== 'string' || !isAbsolute(row.file_path)))) throw new Error('Unsupported Harness tool authorization');
      if (callback === 'query' && (Object.keys(row).some(key => !['objectKind', 'objectId', 'limit'].includes(key)) || row.objectKind !== 'workflow' || row.objectId !== context.runId)) throw new Error('Harness callback query is outside the current run');
      if (callback === 'preview' && (row.workflowId !== 'harness.task.report' || !row.input || typeof row.input !== 'object' || !('runId' in row.input) || row.input.runId !== context.runId)) throw new Error('Harness callbacks cannot dispatch or report another run');
      if ((callback === 'confirm' || callback === 'cancel') && (Object.keys(row).join(',') !== 'planId' || typeof row.planId !== 'string' || !row.planId.startsWith('GPLAN-'))) throw new Error('Harness callback confirmation must use its private current-task vault');
      const state = await readRunStateSnapshotWhenAvailable(context.runId, binding.identityRoot,
        context.executionDeadline ?? Date.now() + 1000);
      if (!state?.harnessExecution || state.harnessExecution.stopRequestedAt || state.status !== 'running' || state.worktreePath !== context.worktreePath) {
        throw new Error('Harness tool is not bound to the live canonical run');
      }
      assertHarnessNotStopped(binding.identityRoot, state);
      const lifecycle = state.harnessExecution.lifecycle;
      const cutoff = Date.parse(lifecycle?.executionDeadlineAt ?? lifecycle?.deadlineAt ?? '');
      if (!lifecycle || lifecycle.phase !== 'started' || !Number.isFinite(cutoff) || Date.now() >= cutoff ||
        lifecycle.ownerGeneration !== context.runState.harnessExecution?.lifecycle?.ownerGeneration) throw new Error('Harness tool execution binding or deadline is invalid');
      const task = await readTask(state.harnessExecution.taskId);
      if (task.principalHash !== state.harnessExecution.principalHash ||
        hashHarnessTask(task) !== state.harnessExecution.requestHash) throw new Error('Harness run task or principal changed');
      if (!task.request.permissionProfile.allowedTools.includes(toolName) || task.request.permissionProfile.deniedTools.includes(toolName)) throw new Error('Harness task does not declare this tool');
      const path = callback ? undefined : relative(context.worktreePath, row.file_path as string).replaceAll('\\', '/');
      if (!callback && !(toolName === 'Read' ? task.scope.readPaths : task.scope.writePaths).includes(path!)) {
        throw new Error('Harness file action is outside the task grant');
      }
      const phase = callback ? 'report' : 'execute';
      const eligibility = await authorize(task, phase);
      const currentRun = await readRunStateSnapshotWhenAvailable(context.runId, binding.identityRoot,
        context.executionDeadline ?? Date.now() + 1000);
      const currentPrincipal = principal();
      if (currentRun?.status !== 'running' || currentRun.harnessExecution?.stopRequestedAt || currentRun.worktreePath !== context.worktreePath ||
        currentRun.harnessExecution?.requestHash !== state.harnessExecution.requestHash || currentRun.harnessExecution.lifecycle?.phase !== 'started' ||
        currentRun.harnessExecution.lifecycle.ownerGeneration !== lifecycle.ownerGeneration || Date.now() >= cutoff || hash(currentPrincipal) !== task.principalHash) {
        throw new Error('Harness tool ownership changed during authorization');
      }
      assertHarnessNotStopped(binding.identityRoot, currentRun);
      const decision = authorizeAgentAction({ snapshot: currentPrincipal.snapshot, action: callback ? 'harness.task.report' : 'harness.task.dispatch',
        changedPaths: callback ? [...task.scope.readPaths, ...task.scope.writePaths] : [path!], riskZone: 'yellow' });
      context.signal?.throwIfAborted();
      if (decision.decision !== 'allow') throw new Error('Live Harness tool authorization denied');
      assertHarnessTaskEligibility(eligibility, { taskId: task.taskId, taskHash: hashHarnessTask(task), principalId: binding.principalId, principalHash: task.principalHash, phase });
      return bindHarnessToolEligibility(eligibility, { runId: context.runId, generation: lifecycle.ownerGeneration, toolName,
        targetPath: callback ? `mcp:${toolName}` : row.file_path as string });
    },
  };
}
