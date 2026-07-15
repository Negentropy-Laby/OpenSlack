export const PLUGIN_LIFECYCLE_STATES = [
  'discovered',
  'integrity_verified',
  'validated',
  'registered',
  'activated',
  'degraded',
  'disabled',
  'deprecated',
  'removed',
] as const;

export type PluginLifecycleState = (typeof PLUGIN_LIFECYCLE_STATES)[number];

export const PLUGIN_LIFECYCLE_TRANSITIONS: Readonly<
  Record<PluginLifecycleState, readonly PluginLifecycleState[]>
> = {
  discovered: ['integrity_verified', 'disabled', 'removed'],
  integrity_verified: ['validated', 'disabled', 'removed'],
  validated: ['registered', 'disabled', 'removed'],
  registered: ['activated', 'disabled', 'deprecated', 'removed'],
  activated: ['degraded', 'disabled', 'deprecated'],
  degraded: ['activated', 'disabled', 'deprecated'],
  disabled: ['registered', 'deprecated', 'removed'],
  deprecated: ['disabled', 'removed'],
  removed: [],
};

export interface PluginLifecycleSnapshot {
  readonly pluginId: string;
  readonly state: PluginLifecycleState;
  readonly previousState?: PluginLifecycleState;
  readonly observedAt: string;
  readonly reason?: string;
}
