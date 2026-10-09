// @openslack/core — Task state machine, claim broker, risk engine, router
export { ClaimBroker, FileClaimBroker } from './claim-broker.js';
export type { Lease, ClaimRequest, ClaimResult } from './claim-broker.js';
export { inferWorkflowPatternId } from './workflow-pattern-inference.js';
export type { WorkflowPatternId } from './workflow-pattern-inference.js';

export {
  normalizeProcessEnvironment,
  executableCandidates,
  bashCandidates,
  probeBash,
  createProcessResolver,
} from './process-discovery.js';

export { decodeStrictJSON } from './strict-json.js';
export {
  parseTaskLinkMarker,
  issueClaimRef,
  isReservedCleanupBranch,
  isValidCleanupBranch,
  isFullGitObjectId,
  type TaskLinkMetadata,
  type TaskLinkResult,
} from './task-link.js';
export { validateGitHubNetwork, githubProxyBypassed } from './github-network.js';
