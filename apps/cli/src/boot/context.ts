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
import { PluginHost, type ReviewedBundledPluginRegistration } from '@openslack/plugin-host';

import { createCollaborationConversationAdapter } from './conversation-adapter.js';
import { createOperatorActionTargetCatalog } from './operator-action-adapter.js';
import { createUnconfiguredPluginPolicy } from './plugin-policy.js';

export interface OperatorApplicationContext {
  readonly actionRegistry: ActionRegistryPort;
  readonly llmProviderRegistry: LLMPlannerProviderRegistryPort;
  readonly conversationStore: ConversationStoreBindingPort;
}

export interface OpenSlackCliContext {
  readonly workspaceRoot: string;
  readonly pluginHost: PluginHost;
  readonly operator: OperatorApplicationContext;
}

export interface OpenSlackCliContextOptions {
  readonly workspaceRoot?: string;
  readonly openslackVersion: string;
  readonly pluginPolicy?: HostPolicyPort<HostPlanStep>;
  readonly llmProviders?: readonly LLMPlannerProvider[];
  readonly conversationStoreAdapter?: ConversationStoreAdapter;
  readonly bundledPlugins?: readonly ReviewedBundledPluginRegistration[];
}

/** Build one sealed, instance-scoped application graph for a CLI process. */
export function createOpenSlackCliContext(
  options: OpenSlackCliContextOptions,
): OpenSlackCliContext {
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
  pluginHost.seal();

  return Object.freeze({
    workspaceRoot,
    pluginHost,
    operator: Object.freeze({ actionRegistry, llmProviderRegistry, conversationStore }),
  });
}
