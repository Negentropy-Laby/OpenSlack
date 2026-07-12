// Validate + index
export { buildIndex } from './indexer.js';
export type { WorkspaceIndex } from './indexer.js';
export { validateWorkspace } from './validate.js';
export type { WorkspaceConfig, ValidationResult, ValidationError } from './types.js';

// Schemas
export { schemas, workspaceSchema, agentRegistrySchema, agentRegistryV2Schema, evolutionTaskSchema, taskSchema, leaseSchema, runRecordSchema } from './schemas/index.js';

// Module Registry
export { readModules, validateModules, getModuleById, getTotalTests, getTotalTestFiles } from './module-registry.js';
export type { ProductModule, ModulesRegistry, RegistryValidationResult } from './module-registry.js';

// Agent Registry Parser
export { parseAgentRegistry } from './agent-registry-parser.js';
export type { ParsedAgentRegistryEntry } from './agent-registry-parser.js';

// Registry Migration
export { migrateV1ToV2, migrateRegistry } from './registry-migrate.js';
export type { MigrationResult } from './registry-migrate.js';

// Subagent Parser
export { parseSubagentMarkdown, discoverSubagents, resolveSubagent } from './subagent-parser.js';

// Installed product / workspace path contract
export {
  createEmbeddedAssetResolver,
  findWorkspaceRoot,
  resolveWorkspaceContext,
  WorkspaceContextError,
} from './workspace-context.js';
export type {
  AssetResolver,
  ProductAssetId,
  ResolveWorkspaceContextOptions,
  WorkspaceContext,
} from './workspace-context.js';

// Idempotent ordinary-repository initialization
export { applyWorkspaceInit, planWorkspaceInit, renderWorkspaceInitPlan } from './init.js';
export type { WorkspaceInitInput, WorkspaceInitOperation, WorkspaceInitPlan } from './init.js';
