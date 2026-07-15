export const DECLARATIVE_PLUGIN_CAPABILITIES = [
  'host.actions.read',
  'host.workflows.read',
  'workspace.read',
  'github.issues.read',
  'github.pull_requests.read',
  'github.checks.read',
  'collaboration.read',
] as const;

export type DeclarativePluginCapability = (typeof DECLARATIVE_PLUGIN_CAPABILITIES)[number];

export const BUNDLED_PLUGIN_CAPABILITIES = [
  ...DECLARATIVE_PLUGIN_CAPABILITIES,
  'host.actions.plan',
  'host.workflows.contribute',
  'prms.blockers.append',
  'github.issues.write',
  'github.pull_requests.comment',
  'github.pull_requests.merge.request',
  'collaboration.write',
  'workflow.execute',
] as const;

export type BundledPluginCapability = (typeof BUNDLED_PLUGIN_CAPABILITIES)[number];
export type PluginCapability = BundledPluginCapability;

export function isDeclarativePluginCapability(
  value: unknown,
): value is DeclarativePluginCapability {
  return (
    typeof value === 'string' &&
    (DECLARATIVE_PLUGIN_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isBundledPluginCapability(value: unknown): value is BundledPluginCapability {
  return (
    typeof value === 'string' && (BUNDLED_PLUGIN_CAPABILITIES as readonly string[]).includes(value)
  );
}
