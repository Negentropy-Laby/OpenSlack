// Validate + index
export { buildIndex } from './indexer.js';
export type { WorkspaceIndex } from './indexer.js';
export { validateWorkspace } from './validate.js';
export type { WorkspaceConfig, ValidationResult, ValidationError } from './types.js';

// Schemas
export { schemas, workspaceSchema, agentRegistrySchema, evolutionTaskSchema, taskSchema, leaseSchema, runRecordSchema } from './schemas/index.js';

// Golden Evals
export { runEvalSuite, runGoldenEval, generateScorecard } from './evals/runner.js';
export { loadGoldenSuite } from './evals/suites/golden.js';
export type { EvalCase, EvalSuite, EvalResult, EvalAssertion, EvalSetup, EvalScenario } from './evals/types.js';
