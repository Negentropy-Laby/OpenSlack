import { isAbsolute, join } from 'node:path';
import { statSync } from 'node:fs';
import { BridgeProcessAdapter, type BridgeProcessAdapterOptions } from './bridge-adapter.js';
import type { ProviderRegistration } from './provider-registry.js';
import { RuntimeMisconfiguredError } from './types.js';
import { hashHarnessNodeExecutable, hashHarnessPluginArtifacts } from './harness-artifacts.js';

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

/** Register the opt-in SDK peer without replacing the existing provider registry. */
export function createDeepSeekHarnessProvider(
  deployment?: DeepSeekHarnessDeployment,
  authorizeTool?: BridgeProcessAdapterOptions['authorizeTool'],
  availableMcpServers: string[] = [],
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
      if (deployment.nodeVersion !== '24.18.1' || process.versions.node !== deployment.nodeVersion ||
        deployment.nodeExecutable !== process.execPath || hashHarnessNodeExecutable(process.execPath) !== deployment.nodeSha256 ||
        hashHarnessPluginArtifacts(deployment.pluginRoot) !== deployment.pluginBuildHash) {
        throw new RuntimeMisconfiguredError('Harness Node identity or external plugin artifacts differ from the approved deployment.');
      }
      const peer = join(deployment.pluginRoot, 'dist/startup.js');
      try {
        if (!statSync(peer).isFile() || !statSync(deployment.workerPatch).isFile() || !statSync(deployment.workerBinding).isFile() ||
            !statSync(deployment.dshHome).isDirectory()) throw new Error('missing deployment input');
      } catch {
        throw new RuntimeMisconfiguredError('Build the matching Harness peer and provide an approved home and worker patch before dispatch.');
      }
      return {
        providerId: 'deepseek-harness',
        transport: 'process',
        adapter: new BridgeProcessAdapter({
          command: process.execPath,
          args: [peer, '--harness-root', deployment.harnessRoot, '--home', deployment.dshHome, '--agent', deployment.agentId,
            '--provider', deployment.provider, '--model', deployment.model,
            '--patch', deployment.workerPatch, '--binding', deployment.workerBinding,
            '--timeout-ms', String(deployment.timeoutMs)],
          // The model cannot select this binding or replace its task/run/principal.
          timeoutMs: deployment.timeoutMs,
          confirmProcessExit: true,
          exitGraceMs: deployment.exitGraceMs,
          authorizeTool,
          availableMcpServers,
        }),
      };
    },
  };
}
