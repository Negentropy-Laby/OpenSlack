import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createActionRegistry,
  createConversationStoreBinding,
  createLLMPlannerProviderRegistry,
  listRegisteredActions,
  type ActionRegistryPort,
  type ConversationStoreAdapter,
  type ConversationStoreBindingPort,
  type LLMPlannerProvider,
  type LLMPlannerProviderRegistryPort,
} from '@openslack/operator';
import type { HostPlanStep, HostPolicyPort } from '@openslack/plugin-api';
import {
  lockPathForWorkspace,
  PluginHost,
  type ReviewedBundledPluginRegistration,
} from '@openslack/plugin-host';

import { createCollaborationConversationAdapter } from './conversation-adapter.js';
import { createOperatorActionTargetCatalog } from './operator-action-adapter.js';
import {
  createPluginActionRunner,
  type ActivationEvidenceResolver,
  type PluginActionRunnerPort,
} from './plugin-action-runner.js';
import { createUnconfiguredPluginPolicy } from './plugin-policy.js';

export interface OperatorApplicationContext {
  readonly actionRegistry: ActionRegistryPort;
  readonly llmProviderRegistry: LLMPlannerProviderRegistryPort;
  readonly conversationStore: ConversationStoreBindingPort;
}

export interface OpenSlackCliContext {
  readonly workspaceRoot: string;
  readonly pluginHost: PluginHost;
  readonly pluginActions: PluginActionRunnerPort;
  readonly operator: OperatorApplicationContext;
}

export interface OpenSlackCliContextOptions {
  readonly workspaceRoot?: string;
  readonly openslackVersion: string;
  readonly pluginPolicy?: HostPolicyPort<HostPlanStep>;
  readonly llmProviders?: readonly LLMPlannerProvider[];
  readonly conversationStoreAdapter?: ConversationStoreAdapter;
  readonly bundledPlugins?: readonly ReviewedBundledPluginRegistration[];
  readonly resolvePluginActivationEvidence?: ActivationEvidenceResolver;
}

function buildOpenSlackCliContextGraph(options: OpenSlackCliContextOptions): OpenSlackCliContext {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const actionRegistry = createActionRegistry(listRegisteredActions());
  const llmProviderRegistry = createLLMPlannerProviderRegistry(options.llmProviders);
  const conversationStore = createConversationStoreBinding();
  conversationStore.bind(
    options.conversationStoreAdapter ?? createCollaborationConversationAdapter(workspaceRoot),
  );

  const pluginHost = new PluginHost({
    policy: options.pluginPolicy ?? createUnconfiguredPluginPolicy(),
    binding: {
      compositionId: 'openslack.cli',
      openslackVersion: options.openslackVersion,
      gateIds: ['host.read-only', 'host.bundled'],
      targets: createOperatorActionTargetCatalog(actionRegistry),
    },
    bundledPlugins: options.bundledPlugins,
  });
  const pluginActions = createPluginActionRunner({
    host: pluginHost,
    actionRegistry,
    resolveActivationEvidence: options.resolvePluginActivationEvidence,
  });

  return Object.freeze({
    workspaceRoot,
    pluginHost,
    pluginActions,
    operator: Object.freeze({ actionRegistry, llmProviderRegistry, conversationStore }),
  });
}

/** Build one sealed, instance-scoped application graph without workspace plugin loading. */
export function createOpenSlackCliContext(
  options: OpenSlackCliContextOptions,
): OpenSlackCliContext {
  const context = buildOpenSlackCliContextGraph(options);
  context.pluginHost.seal();
  return context;
}

/**
 * Build the proof route for locked workspace manifests.
 *
 * Loading is completed before the single host is sealed. The unsealed graph is
 * never returned, and ordinary CLI entrypoints keep the synchronous no-load
 * composition path.
 */
export async function createWorkspacePluginOpenSlackCliContext(
  options: OpenSlackCliContextOptions,
): Promise<OpenSlackCliContext> {
  const context = buildOpenSlackCliContextGraph(options);
  if (existsSync(lockPathForWorkspace(context.workspaceRoot))) {
    await context.pluginHost.loadWorkspacePlugins({ workspaceRoot: context.workspaceRoot });
  }
  context.pluginHost.seal();
  return context;
}
