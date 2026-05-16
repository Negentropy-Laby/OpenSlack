// Re-exports from agent-runtime (backward compat)
export { bootstrapAgent } from './bootstrap.js';
export type { BootstrapCheck, BootstrapResult } from './bootstrap.js';
export { tickAgent } from './tick.js';
export type { TickResult } from './tick.js';

// Re-exports from git-sync (backward compat)
export { proposeWorkspacePR } from './propose.js';
export type { PRProposalInput, PRProposalResult } from './propose.js';
export { createWorktree, cleanupWorktree, checkDirty } from './worktree.js';
export type { WorktreeResult } from './worktree.js';
