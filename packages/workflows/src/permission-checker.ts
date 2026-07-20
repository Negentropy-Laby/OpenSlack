import type { WorkflowPermissions, TrustLevel, ExecutionMode } from './types.js';

/**
 * Hardcoded set of actions that are ALWAYS forbidden,
 * regardless of trust level or declared/granted permissions.
 * No permission declaration, trust upgrade, or configuration change
 * can override these.
 *
 * These are forward-looking operation identifiers, not actual
 * `ctx.openslack.*` method names. They represent operations that
 * no workflow may perform under any trust level or configuration.
 *
 * @see manifest-validator.ts for the manifest validation copy
 */
export const ALWAYS_FORBIDDEN = new Set([
  'github.pr.approve', // Agents must never approve PRs -- human approval required
  'github.pr.merge', // Direct merge forbidden; use ctx.openslack.prms.requestMerge()
  'ruleset.bypass', // Branch protection rules cannot be bypassed programmatically
  'secrets.read', // No workflow may read PEM keys, tokens, or credential files
  'kernel.constitution.write', // Self-evolution governance rules are immutable by workflows
  'agent.registry.write', // Agent registry modifications require human authorization
  'workflow.trust.upgrade', // Trust level upgrades require human action, not workflow self-promotion
]);

/**
 * Read-only permissions granted to untrusted workflows.
 */
const UNTRUSTED_READONLY = new Set(['github.issues.read', 'github.prs.read']);

/**
 * Permissions available to trusted workflows in addition to untrusted.
 * These require explicit declaration in the manifest.
 */
const TRUSTED_AVAILABLE = new Set([
  'github.issues.create',
  'github.issues.write',
  'github.prs.create',
  'github.prs.write',
  'git.branch.create',
  'git.branch.write',
  'git.push',
  'filesystem.workspace.write',
  'filesystem.read',
  'openslack.task.create',
  'openslack.prms.doctor',
  'openslack.collaboration.recordEvent',
  'openslack.collaboration.createHandoff',
  'openslack.collaboration.recordDecision',
  'openslack.governance.audit',
]);

/**
 * All permissions available to core workflows (everything trusted has plus runtime APIs).
 */
const CORE_AVAILABLE = new Set([
  ...UNTRUSTED_READONLY,
  ...TRUSTED_AVAILABLE,
  'openslack.task.checkout',
  'openslack.task.sync',
  'openslack.prms.classify',
  'openslack.prms.queue',
  'openslack.prms.requestMerge',
]);

/**
 * Determine if an action is a write action (not read-only).
 */
function isWriteAction(action: string): boolean {
  // Read actions: those ending in .read or explicitly read-related
  if (action.endsWith('.read')) return false;
  // Known read-only patterns
  const readOnlyPatterns = ['issues.read', 'prs.read', 'classify', 'queue', 'doctor'];
  const suffix = action.split('.').slice(1).join('.');
  return !readOnlyPatterns.includes(suffix);
}

/**
 * Resolve the effective permission set based on declared permissions,
 * granted permissions, and trust level.
 *
 * - Untrusted workflows get only read-only access, ignoring declarations.
 * - Trusted/core workflows get the intersection of declared and granted,
 *   minus anything in ALWAYS_FORBIDDEN.
 */
export function resolvePermissions(
  declared: WorkflowPermissions,
  granted: WorkflowPermissions,
  trustLevel: TrustLevel,
): Set<string> {
  if (trustLevel === 'untrusted') {
    return new Set(UNTRUSTED_READONLY);
  }

  const allowed = new Set<string>();
  for (const category of Object.keys(declared) as Array<keyof WorkflowPermissions>) {
    const declaredActions = declared[category] ?? [];
    const grantedActions = granted[category] ?? [];
    for (const action of declaredActions) {
      // Normalize action separators: both `:` and `.` are treated as `.` in keys
      const normalizedAction = action.replace(/:/g, '.');
      const key = `${category}.${normalizedAction}`;
      if (!ALWAYS_FORBIDDEN.has(key) && grantedActions.includes(action)) {
        allowed.add(key);
      }
    }
  }
  return allowed;
}

/**
 * Resolve the trust level for a workflow based on its location and configuration.
 *
 * - Workflows in builtins/ directory -> 'core'
 * - Workflows with explicit trust assignment -> that level
 * - All others (including .claude/workflows/ legacy paths) -> 'untrusted'
 */
export function resolveTrustLevel(options: {
  /** Whether the workflow is in the builtins directory */
  isBuiltin: boolean;
  /** Explicitly assigned trust level (from config or CLI) */
  assignedLevel?: TrustLevel;
}): TrustLevel {
  if (options.isBuiltin) return 'core';
  if (options.assignedLevel) return options.assignedLevel;
  return 'untrusted';
}

/**
 * Get the full set of permissions available for a given trust level.
 * This represents the maximum permissions a workflow at that level could
 * possibly have (before intersecting with declared/granted).
 */
export function getPermissionsForTrustLevel(level: TrustLevel): Set<string> {
  switch (level) {
    case 'untrusted':
      return new Set(UNTRUSTED_READONLY);
    case 'trusted':
      return new Set([...UNTRUSTED_READONLY, ...TRUSTED_AVAILABLE]);
    case 'core':
      return new Set(CORE_AVAILABLE);
    default:
      return new Set(UNTRUSTED_READONLY);
  }
}

/**
 * Result of a full permission check.
 */
export interface PermissionCheckResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Human-readable reason if denied */
  reason?: string;
}

/**
 * Full 5-step permission check as specified in the security model.
 *
 * 1. Check action against hardcoded forbidden list (ALWAYS_FORBIDDEN)
 * 2. Check execution mode allows the operation
 * 3. Check trust level allows the operation
 * 4. Check declared permissions include the action
 * 5. Return allowed result
 */
export function fullCheckPermission(options: {
  /** The action to check (e.g., 'github.issues.create') */
  action: string;
  /** The current trust level */
  trustLevel: TrustLevel;
  /** The current execution mode */
  mode: ExecutionMode;
  /** The workflow's declared permissions */
  declared: WorkflowPermissions;
  /** The workflow's granted permissions */
  granted: WorkflowPermissions;
}): PermissionCheckResult {
  const { action, trustLevel, mode, declared, granted } = options;

  // Step 1: Hardcoded blocklist
  if (ALWAYS_FORBIDDEN.has(action)) {
    return { allowed: false, reason: 'Permanently forbidden' };
  }

  // Step 2: Execution mode restrictions
  if (mode === 'validate') {
    return { allowed: false, reason: 'No operations allowed in validate mode' };
  }
  if (mode === 'preview' && isWriteAction(action)) {
    return { allowed: false, reason: 'Write operations not allowed in preview mode' };
  }
  if (mode === 'dry-run') {
    return { allowed: false, reason: 'Simulated in dry-run mode (not actually executed)' };
  }

  // Step 3: Trust level restrictions
  if (trustLevel === 'untrusted' && isWriteAction(action)) {
    return { allowed: false, reason: 'Write operations require trusted level or above' };
  }

  // Step 4: Declared permissions
  const effectivePermissions = resolvePermissions(declared, granted, trustLevel);
  if (!effectivePermissions.has(action)) {
    return { allowed: false, reason: `Permission "${action}" not in effective permission set` };
  }

  // Step 5: Allowed
  return { allowed: true };
}

/**
 * Check whether a specific action is permitted by the given permission set.
 * Always returns false for actions in ALWAYS_FORBIDDEN.
 */
export function checkPermission(permissions: Set<string>, action: string): boolean {
  if (ALWAYS_FORBIDDEN.has(action)) {
    return false;
  }
  return permissions.has(action);
}

/**
 * Intersect parent and child permission sets for nested workflow calls.
 * The child can only use permissions that both the parent has AND the child
 * requests, minus anything in ALWAYS_FORBIDDEN.
 */
export function intersectPermissions(parent: Set<string>, child: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const perm of child) {
    if (parent.has(perm) && !ALWAYS_FORBIDDEN.has(perm)) {
      result.add(perm);
    }
  }
  return result;
}
