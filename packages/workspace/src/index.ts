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

