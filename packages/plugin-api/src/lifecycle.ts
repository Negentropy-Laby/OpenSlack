export const PLUGIN_LIFECYCLE_STATES = Object.freeze([
  'discovered',
  'integrity_verified',
  'validated',
  'registered',
  'activated',
  'degraded',
  'disabled',
  'deprecated',
  'removed',
] as const);

export type PluginLifecycleState = (typeof PLUGIN_LIFECYCLE_STATES)[number];

export const PLUGIN_LIFECYCLE_TRANSITIONS: Readonly<
  Record<PluginLifecycleState, readonly PluginLifecycleState[]>
> = {
  discovered: Object.freeze(['integrity_verified', 'disabled', 'removed']),
  integrity_verified: Object.freeze(['validated', 'disabled', 'removed']),
  validated: Object.freeze(['registered', 'disabled', 'removed']),
  registered: Object.freeze(['activated', 'disabled', 'deprecated', 'removed']),
  activated: Object.freeze(['degraded', 'disabled', 'deprecated']),
  degraded: Object.freeze(['activated', 'disabled', 'deprecated']),
  disabled: Object.freeze(['registered', 'deprecated', 'removed']),
  deprecated: Object.freeze(['disabled', 'removed']),
  removed: Object.freeze([]),
};

Object.freeze(PLUGIN_LIFECYCLE_TRANSITIONS);

export interface PluginLifecycleSnapshot {
  readonly pluginId: string;
  readonly state: PluginLifecycleState;
  readonly previousState?: PluginLifecycleState;
  readonly observedAt: string;
  readonly reason?: string;
}
