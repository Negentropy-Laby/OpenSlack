import { describe, expect, it } from 'vitest';
import type { PluginHostError } from '../findings.js';
import {
  HOST_LIFECYCLE_TRANSITIONS,
  PluginLifecycleController,
  SealedHostBinding,
} from '../lifecycle.js';

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as PluginHostError).findings[0]?.code;
  }
  return undefined;
}

describe('PluginLifecycleController', () => {
  it('uses the host-owned transition sequence and immutable snapshots', () => {
    let tick = 0;
    const controller = new PluginLifecycleController(
      'reader',
      () => `2026-07-16T00:00:0${tick++}.000Z`,
    );

    expect(controller.snapshot).toEqual({
      pluginId: 'reader',
      state: 'discovered',
      observedAt: '2026-07-16T00:00:00.000Z',
    });
    controller.transition('integrity_verified');
    controller.transition('validated');
    controller.transition('registered');
    const activated = controller.transition('activated', { reason: 'host policy allowed' });
    expect(activated.state).toBe('activated');
    expect(activated.previousState).toBe('registered');
    expect(activated.reason).toBe('host policy allowed');
    expect(Object.isFrozen(activated)).toBe(true);
  });

  it('rejects skipped, same-state, and terminal transitions with one stable code', () => {
    const skipped = new PluginLifecycleController('skipped');
    expect(errorCode(() => skipped.transition('registered'))).toBe(
      'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
    );
    expect(errorCode(() => skipped.transition('discovered'))).toBe(
      'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
    );

    const removed = new PluginLifecycleController('removed');
    removed.transition('removed');
    expect(errorCode(() => removed.transition('activated'))).toBe(
      'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
    );
  });

  it('keeps the Red matrix frozen independently of the authoring contract', () => {
    expect(Object.isFrozen(HOST_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(HOST_LIFECYCLE_TRANSITIONS.discovered)).toBe(true);
    expect(() =>
      (HOST_LIFECYCLE_TRANSITIONS.removed as unknown as string[]).push('activated'),
    ).toThrow(TypeError);
  });
});

describe('SealedHostBinding', () => {
  it('fails before binding, seals exactly once, and does not expose reset or force', () => {
    const binding = new SealedHostBinding<{ compositionId: string }>();
    expect(errorCode(() => binding.get())).toBe('PLUGIN_HOST_NOT_BOUND');

    const sealed = binding.bind({ compositionId: 'cli' });
    expect(binding.isBound).toBe(true);
    expect(binding.get()).toBe(sealed);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(errorCode(() => binding.bind({ compositionId: 'replacement' }))).toBe(
      'PLUGIN_HOST_ALREADY_BOUND',
    );
    expect('reset' in binding).toBe(false);
    expect('force' in binding).toBe(false);
  });

  it('gives independent host instances independent one-shot bindings', () => {
    const first = new SealedHostBinding<{ id: string }>();
    const second = new SealedHostBinding<{ id: string }>();
    first.bind({ id: 'first' });
    second.bind({ id: 'second' });
    expect(first.get().id).toBe('first');
    expect(second.get().id).toBe('second');
  });

  it('rejects accessor and symbol-bearing bindings without invoking getters', () => {
    let invoked = false;
    const accessor = {} as { value: string };
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        invoked = true;
        return 'unsafe';
      },
    });
    expect(errorCode(() => new SealedHostBinding().bind(accessor))).toBe(
      'PLUGIN_HOST_BINDING_INVALID',
    );
    expect(invoked).toBe(false);

    const symbol = { value: 'safe', [Symbol('hidden')]: true };
    expect(errorCode(() => new SealedHostBinding().bind(symbol))).toBe(
      'PLUGIN_HOST_BINDING_INVALID',
    );
  });
});
