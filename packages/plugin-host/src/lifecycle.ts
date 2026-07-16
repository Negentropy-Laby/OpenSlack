import type { PluginLifecycleSnapshot, PluginLifecycleState } from '@openslack/plugin-api';
import { failPluginHost } from './findings.js';

/**
 * This matrix is deliberately owned by the Red host. It must not delegate
 * authorization to the authoring package's runtime constant.
 */
export const HOST_LIFECYCLE_TRANSITIONS: Readonly<
  Record<PluginLifecycleState, readonly PluginLifecycleState[]>
> = Object.freeze({
  discovered: Object.freeze(['integrity_verified', 'disabled', 'removed'] as const),
  integrity_verified: Object.freeze(['validated', 'disabled', 'removed'] as const),
  validated: Object.freeze(['registered', 'disabled', 'removed'] as const),
  registered: Object.freeze(['activated', 'disabled', 'deprecated', 'removed'] as const),
  activated: Object.freeze(['degraded', 'disabled', 'deprecated'] as const),
  degraded: Object.freeze(['activated', 'disabled', 'deprecated'] as const),
  disabled: Object.freeze(['registered', 'deprecated', 'removed'] as const),
  deprecated: Object.freeze(['disabled', 'removed'] as const),
  removed: Object.freeze([] as const),
});

export interface LifecycleTransitionOptions {
  readonly reason?: string;
  readonly observedAt?: string;
}

export type HostClock = () => string;

const DEFAULT_CLOCK: HostClock = () => new Date().toISOString();

function boundedReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const normalized = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized.length <= 512 ? normalized : normalized.slice(0, 512);
}

function freezeSnapshot(snapshot: PluginLifecycleSnapshot): PluginLifecycleSnapshot {
  return Object.freeze(snapshot);
}

export class PluginLifecycleController {
  readonly pluginId: string;
  readonly #clock: HostClock;
  #snapshot: PluginLifecycleSnapshot;

  constructor(pluginId: string, clock: HostClock = DEFAULT_CLOCK) {
    this.pluginId = pluginId;
    this.#clock = clock;
    this.#snapshot = freezeSnapshot({
      pluginId,
      state: 'discovered',
      observedAt: clock(),
    });
  }

  get state(): PluginLifecycleState {
    return this.#snapshot.state;
  }

  get snapshot(): PluginLifecycleSnapshot {
    return this.#snapshot;
  }

  transition(
    nextState: PluginLifecycleState,
    options: LifecycleTransitionOptions = {},
  ): PluginLifecycleSnapshot {
    const previous = this.#snapshot;
    const allowed = HOST_LIFECYCLE_TRANSITIONS[previous.state];
    if (!allowed.includes(nextState)) {
      failPluginHost({
        phase: 'lifecycle',
        code: 'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
        pluginId: this.pluginId,
        summary: `Lifecycle transition ${previous.state} -> ${nextState} is not allowed.`,
      });
    }

    this.#snapshot = freezeSnapshot({
      pluginId: this.pluginId,
      state: nextState,
      previousState: previous.state,
      observedAt: options.observedAt ?? this.#clock(),
      ...(boundedReason(options.reason) === undefined
        ? {}
        : { reason: boundedReason(options.reason) }),
    });
    return this.#snapshot;
  }
}

function copyAndSealBinding<T extends object>(binding: T): Readonly<T> {
  if (binding === null || Array.isArray(binding)) {
    failPluginHost({
      phase: 'binding',
      code: 'PLUGIN_HOST_BINDING_INVALID',
      summary: 'A host binding must be a non-array object.',
    });
  }

  const descriptors = Object.getOwnPropertyDescriptors(binding);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    failPluginHost({
      phase: 'binding',
      code: 'PLUGIN_HOST_BINDING_INVALID',
      summary: 'A host binding cannot contain symbol-keyed fields.',
    });
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) {
      failPluginHost({
        phase: 'binding',
        code: 'PLUGIN_HOST_BINDING_INVALID',
        summary: 'A host binding must contain enumerable data properties only.',
      });
    }
  }

  return Object.freeze(Object.assign(Object.create(null) as T, binding));
}

/** A one-shot, instance-local binding with no reset or force escape. */
export class SealedHostBinding<T extends object> {
  #value: Readonly<T> | undefined;

  get isBound(): boolean {
    return this.#value !== undefined;
  }

  bind(binding: T): Readonly<T> {
    if (this.#value !== undefined) {
      failPluginHost({
        phase: 'binding',
        code: 'PLUGIN_HOST_ALREADY_BOUND',
        summary: 'This host instance is already sealed to a binding.',
      });
    }
    const sealed = copyAndSealBinding(binding);
    this.#value = sealed;
    return sealed;
  }

  get(): Readonly<T> {
    if (this.#value === undefined) {
      failPluginHost({
        phase: 'binding',
        code: 'PLUGIN_HOST_NOT_BOUND',
        summary: 'This host instance has not been bound.',
      });
    }
    return this.#value;
  }
}
