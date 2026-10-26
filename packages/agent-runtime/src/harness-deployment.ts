import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createBoundEventAppender, createEvent } from '@openslack/collaboration';
import { resolveAgentPrincipal } from '@openslack/runtime';
import { HarnessTaskHost, type ApprovedHarnessTask } from './harness-task-host.js';
import { createHarnessTaskAuthority, type HarnessTaskAuthorityOptions } from './harness-task-authority.js';
import { createHarnessTaskExecution, type HarnessTaskExecutionOptions, type HarnessTextVerification } from './harness-task-execution.js';
import { hashHarnessInput } from './harness-admission.js';
import { createRunStore, readRunStateSnapshot } from './run-store.js';

/** Administrator-authored nonsecret deployment. No runtime identity or task is created by this configuration. */
export interface HarnessDeploymentFile {
  schema: 'openslack.harness_deployment.v1';
  workspaceId: string;
  identityRoot: string;
  principal: Omit<HarnessTaskAuthorityOptions, 'identityRoot' | 'source' | 'claimMode'>;
  execution: HarnessTaskExecutionOptions['deployment'];
  /** Existing approved local task descriptors. A GitHub claim-backed task must use an appropriate live source port instead. */
  tasks: Record<string, { path: string; sha256: string }>;
}

/** A bounded task already approved by the deployment owner, not a model-authored intent. */
export interface HarnessWorkspaceTaskFile {
  schema: 'openslack.harness_workspace_task.v1';
  sourceKind: 'approved-workspace-task';
  claimRequired: false;
  task: Omit<ApprovedHarnessTask, 'principalHash'>;
  allowedPaths: string[];
  forbiddenPaths: string[];
  verification: HarnessTextVerification;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path: string): unknown {
  if (!isAbsolute(path)) throw new Error('Harness configuration paths must be absolute');
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Harness configuration cannot traverse a link');
    if (parent === dirname(parent)) break;
  }
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 512 * 1024) throw new Error('Invalid Harness configuration file');
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(file);
    if (before.ino !== entry.ino || before.dev !== entry.dev || !before.isFile() || before.size > 512 * 1024) throw new Error('Harness configuration changed');
    const bytes = readFileSync(file);
    const after = fstatSync(file);
    if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Harness configuration changed');
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(file); }
}

/** Load only an explicitly provisioned file; absence leaves the shipped CLI unchanged and performs no writes. */
export function createConfiguredHarnessTaskHost(workspaceRoot: string, principalRef: string,
  callbackBinding?: string): HarnessTaskHost | undefined {
  const path = join(workspaceRoot, '.openslack.local/harness/deployment.json');
  let input: unknown;
  try { input = readJson(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && callbackBinding === undefined) return undefined;
    throw error;
  }
  if (!object(input) || input.schema !== 'openslack.harness_deployment.v1' ||
    typeof input.identityRoot !== 'string' || !isAbsolute(input.identityRoot) ||
    typeof input.workspaceId !== 'string' || !input.workspaceId || !object(input.principal) ||
    input.principal.agentId !== principalRef || !object(input.execution) || !object(input.tasks)) {
    throw new Error('Harness deployment is incomplete or bound to another principal');
  }
  // The authority resolver validates every runtime field through the production registry and identity.
  const config = structuredClone(input) as unknown as HarnessDeploymentFile;
  // This CLI runs in the approved primary workspace. Only the worker's isolated execution tree differs.
  // Cross-workspace identity hosting needs an explicit read-model/authority composition, not an inferred path.
  const sameRoot = process.platform === 'win32'
    ? resolve(config.identityRoot).toLowerCase() === resolve(workspaceRoot).toLowerCase()
    : resolve(config.identityRoot) === resolve(workspaceRoot);
  if (!sameRoot) throw new Error('The configured Harness CLI must run from its approved identity workspace');
  const initialHash = hashHarnessInput(config);
  const current = (): void => {
    if (hashHarnessInput(readJson(path)) !== initialHash) throw new Error('Harness deployment changed; stop and reconcile');
  };
  const taskFile = (taskId: string): HarnessWorkspaceTaskFile => {
    current();
    const descriptor = Object.hasOwn(config.tasks, taskId) ? config.tasks[taskId] : undefined;
    if (!descriptor || typeof descriptor.path !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Task is not in the approved deployment');
    const allowedRoot = join(config.identityRoot, '.openslack.local/harness/tasks');
    const local = relative(allowedRoot, descriptor.path);
    if (!local || isAbsolute(local) || local.split(/[\\/]/).includes('..')) throw new Error('Approved task descriptor is outside its owner directory');
    const value = readJson(descriptor.path);
    if (hashHarnessInput(value) !== descriptor.sha256 || !object(value) || value.schema !== 'openslack.harness_workspace_task.v1' ||
      value.sourceKind !== 'approved-workspace-task' || value.claimRequired !== false || !object(value.task) ||
      value.task.taskId !== taskId || !Array.isArray(value.allowedPaths) || !Array.isArray(value.forbiddenPaths) ||
      [...value.allowedPaths, ...value.forbiddenPaths].some(item => typeof item !== 'string') || !object(value.verification)) {
      throw new Error('Approved task descriptor changed or requires an unsupported source/claim');
    }
    return value as unknown as HarnessWorkspaceTaskFile;
  };
  const authority = createHarnessTaskAuthority({ ...config.principal, identityRoot: config.identityRoot, claimMode: 'not_applicable',
    source: { read(taskId) {
      const value = taskFile(taskId);
      return Promise.resolve({ ...value, sourceDigest: hashHarnessInput(value) });
    } },
  });
  const resolved = resolveAgentPrincipal({ root: config.identityRoot, agentId: principalRef, provider: config.principal.provider });
  if ('error' in resolved || resolved.principalId !== config.principal.principalId ||
    resolved.principal.runtime_uid !== config.principal.uid || resolved.principal.run_id !== config.principal.runtimeRunId) {
    throw new Error('Approved Harness principal is unavailable');
  }
  let callbackRunId: string | undefined;
  if (callbackBinding !== undefined) {
    const value = readJson(callbackBinding);
    if (!object(value) || typeof value.runId !== 'string' || value.principalId !== resolved.principalId) throw new Error('Invalid Harness callback binding');
    const state = readRunStateSnapshot(value.runId, config.identityRoot);
    if (!state?.harnessExecution || state.harnessExecution.taskId !== value.taskId ||
      state.harnessExecution.stopRequestedAt ||
      state.harnessExecution.requestHash !== value.generation || state.worktreePath !== value.root ||
      !['pending', 'running'].includes(state.status)) throw new Error('Harness callback is not bound to the current canonical run');
    const deadline = Date.parse(state.startedAt) + taskFile(state.harnessExecution.taskId).task.timeoutMs;
    if (typeof value.expiresAt !== 'string' || !Number.isFinite(deadline) || Date.parse(value.expiresAt) !== deadline || Date.now() >= deadline) {
      throw new Error('Harness callback deadline is expired or does not match the canonical task');
    }
    callbackRunId = value.runId;
  }
  const store = createRunStore(config.identityRoot, { sweepOrphans: false });
  let appender: ReturnType<typeof createBoundEventAppender> | undefined;
  return new HarnessTaskHost({ identityRoot: config.identityRoot, workspaceId: config.workspaceId, store,
    ...authority, ...(callbackRunId === undefined ? {} : { callbackRunId }),
    prepare: createHarnessTaskExecution({ workspaceRoot, identityRoot: config.identityRoot, store,
      deployment: config.execution, authorizeTool: authority.authorizeTool, verification: taskId => taskFile(taskId).verification }),
    publish(state) {
      appender ??= createBoundEventAppender(workspaceRoot);
      appender.append(createEvent({ type: 'workflow.started', actor: { kind: 'agent', id: principalRef },
        object: { kind: 'workflow', id: state.runId }, source: { kind: 'openslack', ref: `run:${state.runId}` },
        visibility: 'workspace', redacted: true, containsSensitiveData: false,
        summary: 'Harness task admitted; execution and host acceptance pending.' }));
      return Promise.resolve();
    },
  });
}
