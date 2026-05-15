export { classifyPaths } from './zones.js';
export { evaluatePolicy } from './policy-engine.js';
export { classifySelfEvolutionPR } from './self/classify-pr.js';
export { decideMerge } from './self/merge-decider.js';
export type { PRClassification } from './self/classify-pr.js';
export type { MergeInput, ReviewResult as MergeReviewResult } from './self/merge-decider.js';
export type { RiskZone, PolicyDefinition, PolicyResult, ZoneDefinition, MergeDecision, SelfValidationResult } from './types.js';
