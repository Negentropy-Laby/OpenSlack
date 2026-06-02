import type { ResolvedAgentConfig, AgentPermissionProfile } from './types.js';

/**
 * Actions that subagents are NEVER allowed to perform,
 * regardless of permission mode or declared tools.
 */
const SUBAGENT_ALWAYS_FORBIDDEN = new Set([
  'github.pr.approve',
  'github.pr.merge',
  'ruleset.bypass',
  'secrets.read',
  'agent.registry.write',
  'workflow.trust.upgrade',
]);

/**
 * Tool baselines for each permission mode.
 * These define the maximum set of tools available in each mode
 * before applying allowlist/denylist.
 */
const MODE_BASELINES: Record<string, string[]> = {
  plan: ['Read', 'Grep', 'Glob', 'Find'],
  acceptEdits: ['Read', 'Grep', 'Glob', 'Find', 'Edit', 'Write'],
  default: ['Read', 'Grep', 'Glob', 'Find', 'Edit', 'Write', 'Bash'],
  strict: ['Read', 'Grep', 'Glob', 'Find', 'Edit', 'Write', 'Bash'],
};

/**
 * Build a permission profile from a resolved agent config.
 *
 * FAIL CLOSED:
 * - bypassPermissions mode → treated as 'strict' with minimal tools
 * - Empty/missing mode → treated as 'strict'
 */
export function buildPermissionProfile(
  resolvedConfig: ResolvedAgentConfig,
): AgentPermissionProfile {
  const mode = resolvedConfig.permissionMode ?? 'strict';

  // Default to strict if mode is somehow invalid
  const effectiveMode = MODE_BASELINES[mode] ? mode : 'strict';

  const baseline = MODE_BASELINES[effectiveMode] ?? MODE_BASELINES.strict;

  // Apply tools allowlist: if specified, intersect with baseline
  let allowedTools: string[];
  if (resolvedConfig.tools && resolvedConfig.tools.length > 0) {
    allowedTools = baseline.filter((t) => resolvedConfig.tools!.includes(t));
  } else {
    allowedTools = [...baseline];
  }

  // Apply disallowedTools denylist
  const deniedTools = resolvedConfig.disallowedTools ?? [];
  allowedTools = allowedTools.filter((t) => !deniedTools.includes(t));

  // Add hardcoded forbidden actions to denied list
  const allDenied = [...deniedTools, ...SUBAGENT_ALWAYS_FORBIDDEN];

  return {
    allowedTools,
    deniedTools: [...new Set(allDenied)],
    permissionMode: effectiveMode as AgentPermissionProfile['permissionMode'],
    canApprovePR: false,
    canMerge: false,
    canReadSecrets: false,
    canBypassRulesets: false,
    acceptEdits: effectiveMode === 'acceptEdits',
    isReadOnly: effectiveMode === 'plan',
  };
}

/**
 * Check if a specific action is allowed by the permission profile.
 */
export function isActionAllowed(profile: AgentPermissionProfile, action: string): boolean {
  if (profile.deniedTools.includes(action)) return false;
  if (SUBAGENT_ALWAYS_FORBIDDEN.has(action)) return false;
  return profile.allowedTools.includes(action);
}

/**
 * Enforce tool scope: given a list of requested tools, return which are allowed
 * and which are denied.
 */
export function enforceToolScope(
  profile: AgentPermissionProfile,
  requestedTools: string[],
): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];

  for (const tool of requestedTools) {
    if (isActionAllowed(profile, tool)) {
      allowed.push(tool);
    } else {
      denied.push(tool);
    }
  }

  return { allowed, denied };
}

/**
 * Validate that a permission profile does not contain any forbidden actions
 * in its allowed tools list. Used as a final safety check before execution.
 */
export function validatePermissionProfile(profile: AgentPermissionProfile): {
  valid: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  for (const tool of profile.allowedTools) {
    if (SUBAGENT_ALWAYS_FORBIDDEN.has(tool)) {
      violations.push(`Forbidden tool in allowed list: ${tool}`);
    }
  }

  if (profile.canApprovePR !== false) {
    violations.push('canApprovePR must be false');
  }
  if (profile.canMerge !== false) {
    violations.push('canMerge must be false');
  }
  if (profile.canReadSecrets !== false) {
    violations.push('canReadSecrets must be false');
  }
  if (profile.canBypassRulesets !== false) {
    violations.push('canBypassRulesets must be false');
  }

  return { valid: violations.length === 0, violations };
}
