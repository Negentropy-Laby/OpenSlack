export { classifyPaths } from './zones.js';
export { evaluatePolicy } from './policy-engine.js';
export { classifySelfEvolutionPR } from './self/classify-pr.js';
export { decideMerge } from './self/merge-decider.js';
export { authorizeAgentAction, resolvePermissionSnapshot } from './agent-authorizer.js';
export type { PRClassification } from './self/classify-pr.js';
export type { MergeInput, ReviewResult as MergeReviewResult } from './self/merge-decider.js';
export type { RiskZone, PolicyDefinition, PolicyResult, ZoneDefinition } from './types.js';

export type {
  ActionVerdict,
  AgentRegistryIdentity,
  AgentPermissions,
  AgentRegistryEntry,
  AgentRuntimeIdentity,
  AgentPrincipal,
  AgentPermissionSnapshot,
  AuthorizationDecision,
  AuthorizationEvidence,
  AuthorizationResult,
  SubagentDefinition,
  PermissionMode,
} from './types.js';

export type {
  EvolutionTask,
  EvolutionExperiment,
  SelfValidationResult,
  FitnessScore,
  EvolutionStatus,
  EvolutionSource,
  ProblemStatement,
  Hypothesis,
  EvolutionRisk,
  EvolutionConstraints,
  ValidationPlan,
  OutputContract,
  RollbackPlan,
  CheckResult,
  ProtectedPathResult,
  MergeDecision,
} from './self/types.js';
