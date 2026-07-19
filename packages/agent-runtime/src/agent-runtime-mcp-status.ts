import { createRunStore } from './run-store.js';
import { readTranscript } from './transcript.js';
import type { AgentRunEvent } from './types.js';
import { buildMcpServerDescriptors, validateMcpToolNamespace } from './bridge-mcp-scope.js';
import { findAgentRuntimeRegistryEntry } from './agent-runtime-registry.js';
import { normalizeToolName } from './tool-name.js';

export type AgentRuntimeMcpStatus = 'PASS' | 'FAIL' | 'WARN';

export interface AgentRuntimeMcpStatusOptions {
  rootDir?: string;
  provider?: 'aby';
  agentId?: string;
  runId?: string;
  availableServers?: string[];
}

export interface AgentRuntimeMcpToolEvidence {
  type: AgentRunEvent['type'];
  toolName: string;
  normalizedToolName: string;
  timestamp: string;
}

export interface AgentRuntimeMcpStatusReport {
  provider: 'aby';
  status: AgentRuntimeMcpStatus;
  scopeNote: string;
  agentId?: string;
  runId?: string;
  requiredServers: string[];
  availableServers: string[];
  missingRequiredServers: string[];
  descriptors: Array<{ name: string; required: boolean; tools?: string[] }>;
  invalidTools: Array<{ tool: string; reason: string }>;
  toolEvidence: AgentRuntimeMcpToolEvidence[];
  remediations: string[];
}

export function getAgentRuntimeMcpStatus(
  options: AgentRuntimeMcpStatusOptions = {},
): AgentRuntimeMcpStatusReport {
  const rootDir = options.rootDir ?? process.cwd();
  const provider = options.provider ?? 'aby';
  if (provider !== 'aby') {
    throw new Error(`Unsupported agent runtime provider: ${provider}`);
  }

  const agent = options.agentId ? findAgentRuntimeRegistryEntry(options.agentId, rootDir) : null;
  const run = options.runId ? createRunStore(rootDir).getRun(options.runId) : null;
  const transcript = options.runId ? readTranscript(options.runId, rootDir) : [];
  const startEvent = transcript.find((event) => event.type === 'start');
  const availabilityEvent = [...transcript]
    .reverse()
    .find((event) => event.type === 'progress' && event.data.step === 'bridge_mcp_availability');

  const requiredServers = uniqueSorted([
    ...readStringArray(agent?.requiredMcpServers),
    ...readStringArray(startEvent?.data.requiredMcpServers),
    ...readStringArray(availabilityEvent?.data.required),
  ]);
  const availableServers = uniqueSorted([
    ...(options.availableServers ?? []),
    ...readStringArray(agent?.mcpServers),
    ...readStringArray(startEvent?.data.mcpServers),
    ...readStringArray(availabilityEvent?.data.available),
  ]);
  const missingRequiredServers = requiredServers.filter(
    (server) => !availableServers.includes(server),
  );
  const toolEvidence = extractMcpToolEvidence(transcript);
  const normalizedTools = toolEvidence.map((event) => event.normalizedToolName);
  const namespaceValidation = validateMcpToolNamespace(normalizedTools, availableServers);
  const invalidTools = namespaceValidation.invalid;

  const status: AgentRuntimeMcpStatus =
    missingRequiredServers.length > 0 || invalidTools.length > 0
      ? 'FAIL'
      : requiredServers.length === 0 && availableServers.length === 0 && toolEvidence.length === 0
        ? 'WARN'
        : 'PASS';

  return {
    provider,
    status,
    scopeNote: 'OpenSlack validates MCP descriptors and namespaces; Aby owns MCP client lifecycle.',
    agentId: agent?.agentId ?? run?.agentId ?? options.agentId,
    runId: options.runId,
    requiredServers,
    availableServers,
    missingRequiredServers,
    descriptors: [
      ...buildMcpServerDescriptors(requiredServers, { required: true }),
      ...buildMcpServerDescriptors(
        availableServers.filter((server) => !requiredServers.includes(server)),
        { required: false },
      ),
    ].map((descriptor) => ({
      name: descriptor.name,
      required: descriptor.required !== false,
      tools: descriptor.tools,
    })),
    invalidTools,
    toolEvidence,
    remediations: remediationForMcp(
      status,
      options.agentId,
      options.runId,
      missingRequiredServers,
      invalidTools,
    ),
  };
}

function extractMcpToolEvidence(transcript: AgentRunEvent[]): AgentRuntimeMcpToolEvidence[] {
  const evidence: AgentRuntimeMcpToolEvidence[] = [];
  for (const event of transcript) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    const raw = event.data.toolName ?? event.data.tool;
    if (typeof raw !== 'string') continue;
    const normalized = normalizeToolName(raw);
    if (!normalized.startsWith('mcp.')) continue;
    evidence.push({
      type: event.type,
      toolName: raw,
      normalizedToolName: normalized,
      timestamp: event.timestamp,
    });
  }
  return evidence;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function remediationForMcp(
  status: AgentRuntimeMcpStatus,
  agentId: string | undefined,
  runId: string | undefined,
  missing: string[],
  invalid: Array<{ tool: string; reason: string }>,
): string[] {
  if (status === 'PASS') return ['MCP descriptors and transcript evidence are consistent.'];
  const remediations: string[] = [];
  if (!agentId && !runId) {
    remediations.push('Pass --agent <agentId> or --run <runId> to inspect a concrete MCP scope.');
  }
  if (missing.length > 0) {
    remediations.push(`Make required MCP servers available before launch: ${missing.join(', ')}.`);
  }
  if (invalid.length > 0) {
    remediations.push(
      'Fix MCP tool namespaces so they use mcp.<server>.<tool> for available servers.',
    );
  }
  if (remediations.length === 0) {
    remediations.push('No MCP descriptors or transcript evidence were recorded.');
  }
  return remediations;
}
