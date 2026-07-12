export type {
  AgentRunStatus,
  AgentRunFailureCode,
  AgentPermissionProfile,
  ResolvedAgentConfig,
  AgentRunRequest,
  AgentRunState,
  AgentRunEvent,
  AgentRunResult,
  WorktreeHandoff,
} from './types.js';

export {
  AgentUnavailableError,
  PermissionDeniedError,
  RuntimeNotConfiguredError,
  RuntimeMisconfiguredError,
  AgentExecutionFailedError,
  getAgentRunFailureCode,
  getAgentRunFailureSummary,
} from './types.js';

export type { AgentRunStore } from './run-store.js';
export { createRunStore, generateRunId } from './run-store.js';

export { appendTranscriptEvent, readTranscript } from './transcript.js';

export {
  buildPermissionProfile,
  isActionAllowed,
  enforceToolScope,
  validatePermissionProfile,
  SUBAGENT_ALWAYS_FORBIDDEN,
} from './permissions.js';

export type { LauncherOptions } from './launcher.js';
export { createOpenSlackAgentLauncher } from './launcher.js';

export type { AgentExecutionAdapter, AdapterExecutionContext, AdapterExecutionResult } from './adapter.js';
export { LocalExecutionAdapter, ToolGuard } from './adapter.js';

export type {
  ProviderRegistration,
  ProviderResolution,
  ProviderTransport,
} from './provider-registry.js';
export { ProviderRegistry, ProviderRegistryError, inferProviderId } from './provider-registry.js';

export type {
  ExternalCommandAdapterOptions,
  ExternalCommandResult,
} from './external-command-adapter.js';
export { ExternalCommandAdapter } from './external-command-adapter.js';

export type { RunRecorder } from './recorder.js';
export { createRunRecorder } from './recorder.js';

export type { ActiveAgentRunControl, AgentRunCancelResult, AgentRunRestartResult } from './control.js';
export {
  AgentRunCancelledError,
  AgentRunRestartRequestedError,
  getActiveAgentRunControl,
  registerActiveAgentRunControl,
  requestAgentRunCancellation,
  requestAgentRunRestart,
} from './control.js';

// Bridge contract (AR-2.5A)
export type {
  BridgeSessionState,
  BridgeErrorKind,
  BridgeCapabilityDescriptor,
  BridgeEnvelope,
  BridgeEnvelopeKind,
  BridgeErrorPayload,
  AgentRunBridgeRequestPayload,
  BridgeContract,
  BridgeSessionConfig,
} from './bridge-contract.js';
export {
  BRIDGE_PROTOCOL_VERSION,
  BridgeSessionStateMachine,
  BridgeStateError,
  buildBridgeEnvelope,
  validateBridgeEnvelope,
} from './bridge-contract.js';
export type { BuildAgentRunBridgeRequestOptions } from './agent-run-bridge-request.js';
export { buildAgentRunBridgeRequestPayload } from './agent-run-bridge-request.js';

// Bridge adapter (AR-2.5B)
export type { BridgeProcessAdapterOptions, FakeBridgeAdapterOptions } from './bridge-adapter.js';
export {
  BridgeProcessAdapter,
  FakeBridgeAdapter,
  BridgeAdapterError,
} from './bridge-adapter.js';

// Bridge lifecycle (AR-2.5C)
export type { BridgeSessionSummary } from './types.js';
export { BridgeLifecycleMapper } from './bridge-lifecycle.js';

// Bridge permission guard (AR-2.5D)
export { BridgePermissionGuard } from './bridge-permission-guard.js';

// Bridge worktree guard (AR-2.5E)
export type { BridgeWorktreeConfig } from './bridge-contract.js';
export { BridgeWorktreeGuard } from './bridge-worktree-guard.js';

// MCP scope (AR-2.6)
export type { BridgeMcpServerDescriptor } from './bridge-contract.js';
export type { McpServerNegotiationResult } from './bridge-mcp-scope.js';
export {
  negotiateMcpServers,
  validateRequiredMcpServers,
  extractMcpToolsFromProfile,
  validateMcpToolNamespace,
  buildMcpServerDescriptors,
} from './bridge-mcp-scope.js';

// Bridge factory (AR-2.7)
export type { BridgeMode, BridgeFactoryOptions } from './bridge-factory.js';
export { BridgeFactory, createBridgeAdapter, BridgeFactoryError } from './bridge-factory.js';

export type {
  AbyBridgeRuntimeConfig,
  BridgeRuntimeResolver,
  BridgeRuntimeResolverOptions,
} from './bridge-runtime-resolver.js';
export {
  BridgeRuntimeConfigError,
  createBridgeRuntimeResolver,
  isAbyRuntime,
  loadAbyBridgeRuntimeConfig,
} from './bridge-runtime-resolver.js';

export type {
  AgentRuntimeDoctorCheck,
  AgentRuntimeDoctorCheckStatus,
  AgentRuntimeDoctorProvider,
  AgentRuntimeDoctorStatus,
  AgentRuntimeReadiness,
  AgentRuntimeReadinessReport,
  AgentRuntimeEnvAudit,
  AbyRuntimeConfigSource,
  AbyRuntimeDoctorReport,
  DiagnoseAbyRuntimeOptions,
} from './agent-runtime-doctor.js';
export { diagnoseAbyRuntime, diagnoseAgentRuntime } from './agent-runtime-doctor.js';

export type { BridgeEnvAudit } from './bridge-env.js';
export {
  auditBridgeEnv,
  buildBridgeProcessEnv,
  buildSafeBridgeEnv,
  isSafeBridgeEnvKey,
} from './bridge-env.js';

export type {
  AgentRuntimeRegistryEntry,
} from './agent-runtime-registry.js';
export {
  findAgentRuntimeRegistryEntry,
  listAgentRuntimeRegistryEntries,
  listAbyRuntimeAgents,
} from './agent-runtime-registry.js';

export type {
  AbyRuntimeSetupConfigPreview,
  AbyRuntimeSetupMode,
  AbyRuntimeSetupReport,
  AbyRuntimeSetupStatus,
  SetupAbyRuntimeOptions,
} from './agent-runtime-setup.js';
export { setupAbyRuntime } from './agent-runtime-setup.js';

export type {
  AbyRuntimeSmokeReport,
  AbyRuntimeSmokeStatus,
  RunAbyRuntimeSmokeOptions,
} from './agent-runtime-smoke.js';
export { runAbyRuntimeSmoke } from './agent-runtime-smoke.js';

export type {
  AgentRuntimeMcpStatus,
  AgentRuntimeMcpStatusOptions,
  AgentRuntimeMcpStatusReport,
  AgentRuntimeMcpToolEvidence,
} from './agent-runtime-mcp-status.js';
export { getAgentRuntimeMcpStatus } from './agent-runtime-mcp-status.js';

export { normalizeToolName, normalizeToolNames } from './tool-name.js';
