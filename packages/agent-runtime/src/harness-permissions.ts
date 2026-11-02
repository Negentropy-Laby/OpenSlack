import { buildPermissionProfile, validatePermissionProfile } from './permissions.js';
import { normalizeToolNames } from './tool-name.js';
import type { AgentPermissionProfile, ResolvedAgentConfig } from './types.js';
import { PermissionDeniedError } from './types.js';
import { HARNESS_CALLBACK_TOOLS } from './bridge-wire.js';

const native = ['Read', 'Write', 'Edit'];
const callbacks: readonly string[] = Object.values(HARNESS_CALLBACK_TOOLS).map(tool => tool.bridge);

/** Explicit worker capability declaration, not principal authority. Existing provider baselines remain unchanged. */
export function buildHarnessTaskPermissionProfile(config: ResolvedAgentConfig): AgentPermissionProfile {
  if (config.runtimeProvider !== 'deepseek-harness' || !config.tools?.length) {
    throw new PermissionDeniedError('harness.profile', 'Harness requires an explicit provider and native/callback tool declaration');
  }
  const requested = normalizeToolNames(config.tools);
  const profile = buildPermissionProfile(config);
  for (const name of requested) {
    if ((!native.includes(name) && !callbacks.includes(name)) || profile.deniedTools.includes(name) ||
      (native.includes(name) && !profile.allowedTools.includes(name))) {
      throw new PermissionDeniedError('harness.profile', 'A required Harness capability is unsupported or denied');
    }
  }
  const result = { ...profile, allowedTools: [...profile.allowedTools, ...requested.filter(name => callbacks.includes(name))] };
  if (!validatePermissionProfile(result).valid) throw new PermissionDeniedError('harness.profile', 'Unsafe Harness capability declaration');
  return result;
}
