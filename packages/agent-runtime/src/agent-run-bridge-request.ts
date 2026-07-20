import type { AgentRunBridgeRequestPayload, BridgeSessionConfig } from './bridge-contract.js';
import type { ResolvedAgentConfig } from './types.js';

export interface BuildAgentRunBridgeRequestOptions {
  sessionId: string;
  config: BridgeSessionConfig;
  resolvedConfig: ResolvedAgentConfig;
  availableMcpServers: string[];
}

/**
 * Build the provider-neutral Agent Run Bridge request sent to an external
 * bridge runtime.
 *
 * The builder serializes the permission profile exactly as provided. Callers
 * must apply `BridgePermissionGuard.filterOutboundTools()` first so
 * `allowedTools` has already had OpenSlack forbidden actions and denied tools
 * removed before crossing the process boundary.
 */
export function buildAgentRunBridgeRequestPayload(
  options: BuildAgentRunBridgeRequestOptions,
): AgentRunBridgeRequestPayload {
  const { sessionId, config, resolvedConfig, availableMcpServers } = options;
  const input = buildInputMessages(config.prompt, resolvedConfig);

  return {
    runId: config.runId,
    agentId: config.agentId,
    sessionId,
    input,
    worktreePath: config.worktreePath,
    allowedTools: config.permissionProfile.allowedTools,
    deniedTools: config.permissionProfile.deniedTools,
    permissionMode: config.permissionProfile.permissionMode,
    model: resolvedConfig.model,
    effort: resolvedConfig.effort,
    maxTurns: resolvedConfig.maxTurns,
    mcp: {
      required: resolvedConfig.requiredMcpServers ?? [],
      available: availableMcpServers,
    },
    metadata: {
      integrationId: 'openslack',
      source: resolvedConfig.source,
      externalRunId: config.runId,
      correlationId: config.metadata?.correlationId ?? config.runId,
      threadId: config.metadata?.threadId,
      budget: config.metadata?.budget,
      resolvedConfig: buildSafeResolvedConfig(resolvedConfig),
      worktree: config.metadata?.worktree ?? undefined,
    },
  };
}

function buildInputMessages(
  prompt: string,
  resolvedConfig: ResolvedAgentConfig,
): AgentRunBridgeRequestPayload['input'] {
  const input: AgentRunBridgeRequestPayload['input'] = [];
  const systemParts = [resolvedConfig.initialPrompt, resolvedConfig.prompt].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  if (systemParts.length > 0) {
    input.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  input.push({ role: 'user', content: prompt });
  return input;
}

function buildSafeResolvedConfig(config: ResolvedAgentConfig): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    agentId: config.agentId,
    source: config.source,
  };

  const optionalStringFields = [
    'runtime',
    'runtimeProvider',
    'provider',
    'model',
    'permissionMode',
    'isolation',
    'prompt',
    'initialPrompt',
    'criticalSystemReminder',
  ] as const;

  for (const field of optionalStringFields) {
    const value = config[field];
    if (typeof value === 'string') safe[field] = value;
  }

  if (typeof config.maxTurns === 'number') safe.maxTurns = config.maxTurns;
  if (typeof config.background === 'boolean') safe.background = config.background;
  if (typeof config.remote === 'boolean') safe.remote = config.remote;
  if (config.effort !== undefined) safe.effort = config.effort;
  if (Array.isArray(config.tools))
    safe.tools = config.tools.filter((item) => typeof item === 'string');
  if (Array.isArray(config.disallowedTools)) {
    safe.disallowedTools = config.disallowedTools.filter((item) => typeof item === 'string');
  }
  if (Array.isArray(config.mcpServers)) {
    safe.mcpServers = config.mcpServers.filter((item) => typeof item === 'string');
  }
  if (Array.isArray(config.requiredMcpServers)) {
    safe.requiredMcpServers = config.requiredMcpServers.filter((item) => typeof item === 'string');
  }
  if (config.hooks) {
    const hooks: Record<string, string> = {};
    if (typeof config.hooks.before === 'string') hooks.before = config.hooks.before;
    if (typeof config.hooks.after === 'string') hooks.after = config.hooks.after;
    if (Object.keys(hooks).length > 0) safe.hooks = hooks;
  }

  return safe;
}
