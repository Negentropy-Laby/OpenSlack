export { classifyDeclaredScopes, classifyPaths } from './zones.js';
export {
  compilePathGlob,
  matchesPathGlob,
  pathGlobCovers,
  pathGlobsIntersect,
} from './path-glob.js';
export type { PathGlobMatcher } from './path-glob.js';
export {
  highestRiskZone,
  isRiskZone,
  isTaskRiskLevel,
  taskRiskLevelToZone,
  RISK_ZONES,
  TASK_RISK_LEVELS,
} from './risk.js';
export { evaluatePolicy } from './policy-engine.js';
export { classifySelfEvolutionPR } from './self/classify-pr.js';
export { decideMerge } from './self/merge-decider.js';
export { authorizeAgentAction, resolvePermissionSnapshot } from './agent-authorizer.js';
export type { PRClassification } from './self/classify-pr.js';
export type { MergeInput, ReviewResult as MergeReviewResult } from './self/merge-decider.js';
export type {
  RiskZone,
  TaskRiskLevel,
  PolicyDefinition,
  PolicyResult,
  ZoneDefinition,
} from './types.js';

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
