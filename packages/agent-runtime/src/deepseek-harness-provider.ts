import { isAbsolute, join } from 'node:path';
import { statSync } from 'node:fs';
import { BridgeProcessAdapter, type BridgeProcessAdapterOptions } from './bridge-adapter.js';
import type { ProviderRegistration } from './provider-registry.js';
import { RuntimeMisconfiguredError } from './types.js';
import { hashHarnessNodeExecutable, hashHarnessPluginArtifacts, HARNESS_NATIVE_SUPERVISOR_FILE,
  inspectHarnessArtifactObservation, type HarnessArtifactObservation } from './harness-artifacts.js';
import { readHarnessFile } from './harness-read.js';
import { BRIDGE_CHUNK_EXTENSION } from './bridge-wire.js';
import { RUN_ID_RE } from './run-id.js';
import { HARNESS_CLEANUP_BUDGET, assertHarnessCleanupBudget } from './bridge-cleanup.js';

/** Trusted deployment settings. Never populate these fields from a model or MCP arguments. */
export interface DeepSeekHarnessDeployment {
  harnessRoot: string;
  pluginRoot: string;
  pluginBuildHash: string;
  nodeExecutable: string;
  nodeVersion: '24.18.1';
  nodeSha256: string;
  dshHome: string;
  agentId: string;
  provider: string;
  model: string;
  /** Host-authored per-execution scope patch; loaded before the first prompt. */
  workerPatch: string;
  /** Immutable host-created task binding outside the worker's writable scope. */
  workerBinding: string;
  /** Existing built OpenSlack CLI used for the per-run agent-bound callback server. */
  callbackMcp?: { cliModule: string; workspaceRoot: string; principalRef: string };
  timeoutMs: number;
  exitGraceMs: number;
}

/** Stable operator-safe filesystem evidence, without upstream paths or messages. */
export function classifyHarnessDeploymentFailure(cause: unknown): RuntimeMisconfiguredError {
  let code = 'INPUT_INVALID';
  try {
    const value = cause && typeof cause === 'object' ? Object.getOwnPropertyDescriptor(cause, 'code')?.value : undefined;
    if (typeof value === 'string' && /^E[A-Z0-9_]{1,31}$/.test(value)) code = value;
  } catch { /* an exotic thrown value is never evaluated for diagnostics */ }
  const error = new RuntimeMisconfiguredError(code === 'ENOENT'
    ? 'A required Harness deployment input is missing; build the matching peer and provision its approved inputs.'
    : `A Harness deployment input is unavailable (${code}); verify filesystem access and input integrity before retrying.`);
  Object.defineProperty(error, 'filesystemCode', { value: code, enumerable: false });
  return error;
}

/** Register the opt-in SDK peer without replacing the existing provider registry. */
export function createDeepSeekHarnessProvider(
  deployment?: DeepSeekHarnessDeployment,
  authorizeTool?: BridgeProcessAdapterOptions['authorizeTool'],
  availableMcpServers: string[] = [],
  observation?: HarnessArtifactObservation,
): ProviderRegistration {
  return {
    id: 'deepseek-harness',
    resolve(config) {
      if (!deployment) throw new RuntimeMisconfiguredError('DeepSeek Harness deployment is not configured.');
      if (!authorizeTool) throw new RuntimeMisconfiguredError('DeepSeek Harness live host authorization is not configured.');
      if (config.agentId !== deployment.agentId ||
          (config.model !== undefined && config.model !== deployment.model) ||
          (config.bridgeMode !== undefined && config.bridgeMode !== 'process')) {
        throw new RuntimeMisconfiguredError('DeepSeek Harness agent, model or transport does not match the trusted deployment.');
      }
      for (const [name, path] of Object.entries({
        harnessRoot: deployment.harnessRoot, pluginRoot: deployment.pluginRoot,
        nodeExecutable: deployment.nodeExecutable, dshHome: deployment.dshHome,
        workerPatch: deployment.workerPatch,
        workerBinding: deployment.workerBinding,
      })) {
        if (!isAbsolute(path)) throw new RuntimeMisconfiguredError(`DeepSeek Harness ${name} must be an absolute native path.`);
      }
      for (const duration of [deployment.timeoutMs, deployment.exitGraceMs]) {
        if (!Number.isSafeInteger(duration) || duration <= 0) {
          throw new RuntimeMisconfiguredError('DeepSeek Harness time limits must be positive integers.');
        }
      }
      try { assertHarnessCleanupBudget(deployment.exitGraceMs); }
      catch { throw new RuntimeMisconfiguredError('Harness exitGraceMs must be 30000; migrate to the fixed cleanup contract.'); }
      if (deployment.nodeVersion !== '24.18.1' || process.versions.node !== deployment.nodeVersion ||
        deployment.nodeExecutable !== process.execPath) {
        throw new RuntimeMisconfiguredError('Harness Node identity or external plugin artifacts differ from the approved deployment.');
      }
      let nodeHash: string;
      let pluginHash: string;
      try {
        const observed = observation ? inspectHarnessArtifactObservation(observation, deployment.pluginRoot, deployment.nodeExecutable) : undefined;
        nodeHash = observed?.nodeHash ?? hashHarnessNodeExecutable(process.execPath);
        pluginHash = observed?.pluginHash ?? hashHarnessPluginArtifacts(deployment.pluginRoot);
      } catch (cause) {
        throw classifyHarnessDeploymentFailure(cause);
      }
      if (nodeHash !== deployment.nodeSha256 || pluginHash !== deployment.pluginBuildHash) {
        throw new RuntimeMisconfiguredError('Harness Node identity or external plugin artifacts differ from the approved deployment.');
      }
      if (process.platform === 'win32' && process.arch !== 'x64') {
        throw new RuntimeMisconfiguredError('The approved native Harness supervisor requires Windows x64.');
      }
      const peer = join(deployment.pluginRoot, 'dist/startup.js');
      let binding: { runId?: unknown; generation?: unknown };
      try {
        if (!statSync(peer).isFile() || !statSync(deployment.workerPatch).isFile() || !statSync(deployment.workerBinding).isFile() ||
            !statSync(deployment.dshHome).isDirectory()) throw Object.assign(new Error('invalid deployment input'), { code: 'EFTYPE' });
        binding = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readHarnessFile(deployment.workerBinding, 128 * 1024)));
      } catch (cause) {
        throw classifyHarnessDeploymentFailure(cause);
      }
      if (!binding || typeof binding.runId !== 'string' || !RUN_ID_RE.test(binding.runId) ||
        typeof binding.generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(binding.generation)) {
        throw new RuntimeMisconfiguredError('Harness worker binding lacks its canonical run and owner generation.');
      }
      const args = [peer, '--harness-root', deployment.harnessRoot, '--home', deployment.dshHome, '--agent', deployment.agentId,
        '--provider', deployment.provider, '--model', deployment.model,
        '--patch', deployment.workerPatch, '--binding', deployment.workerBinding,
        '--timeout-ms', String(deployment.timeoutMs)];
      const supervisor = process.platform === 'win32'
        ? { protocol: 'openslack.windows_job.v1' as const, runId: binding.runId, generation: binding.generation } : undefined;
      return {
        providerId: 'deepseek-harness',
        transport: 'process',
        policy: { requiresHostAcceptance: true, worktreeForFileWrites: true, preserveWorktree: true },
        adapter: new BridgeProcessAdapter({
          command: supervisor ? join(deployment.pluginRoot, HARNESS_NATIVE_SUPERVISOR_FILE) : process.execPath,
          args: supervisor ? ['--run-id', supervisor.runId, '--generation', supervisor.generation, '--cleanup-ms', String(HARNESS_CLEANUP_BUDGET.totalMs), '--', process.execPath, ...args] : args,
          ...(supervisor ? { supervisor } : {}),
          // The model cannot select this binding or replace its task/run/principal.
          timeoutMs: deployment.timeoutMs,
          confirmProcessExit: true,
          exitGraceMs: HARNESS_CLEANUP_BUDGET.totalMs,
          completionGraceMs: 0,
          wireExtensions: [BRIDGE_CHUNK_EXTENSION],
          requireToolEvidence: true,
          authorizeTool,
          availableMcpServers,
        }),
      };
    },
  };
}
