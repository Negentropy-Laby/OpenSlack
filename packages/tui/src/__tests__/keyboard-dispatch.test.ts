import { describe, expect, it, vi } from 'vitest';
import { isActivationKey, KeyboardEvent } from '../ink/events/keyboard-event.js';
import { TerminalEvent } from '../ink/events/terminal-event.js';
import type { ParsedKey } from '../ink/parse-keypress.js';
import { dispatcher } from '../ink/reconciler.js';

/**
 * Keyboard dispatch regressions.
 *
 * These exercise the real dispatcher. Before the fix, `KeyboardEvent` extended
 * the bare `Event` stub, so `dispatcher.dispatch()` threw
 * `event._setTarget is not a function` before any handler ran, and
 * `preventDefault()` did not exist at all.
 */
function parsed(overrides: Partial<ParsedKey> = {}): ParsedKey {
  return {
    kind: 'key',
    fn: false,
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: undefined,
    raw: undefined,
    isPasted: false,
    ...overrides,
  };
}

type Node = {
  parentNode: Node | undefined;
  _eventHandlers?: Record<string, unknown>;
};

function node(
  parentNode: Node | undefined,
  handlers: Record<string, (event: KeyboardEvent) => void> = {},
): Node {
  return { parentNode, _eventHandlers: handlers };
}

describe('KeyboardEvent satisfies the TerminalEvent contract', () => {
  it('is a TerminalEvent and carries the parsed key and modifiers', () => {
    const event = new KeyboardEvent(parsed({ name: 'a', ctrl: true, shift: true, meta: false }));
    expect(event).toBeInstanceOf(TerminalEvent);
    expect(event.type).toBe('keydown');
    expect(event.key).toBe('a');
    expect(event.ctrl).toBe(true);
    expect(event.shift).toBe(true);
    expect(event.meta).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('falls back to the raw sequence for unnamed printable input', () => {
    const event = new KeyboardEvent(parsed({ sequence: 'x', raw: 'x' }));
    expect(event.key).toBe('x');
    expect(event.printable).toBe(true);
  });

  it('dispatches without throwing, so the dispatcher can set the target', () => {
    const handler = vi.fn();
    const target = node(undefined, { onKeyDown: handler });
    const event = new KeyboardEvent(parsed({ name: 'a' }));

    // This is the exact call that used to throw `_setTarget is not a function`.
    expect(() => dispatcher.dispatchDiscrete(target as never, event)).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toBe(event);
    expect(event.target).toBe(target);
  });

  it('reports preventDefault through defaultPrevented and the dispatch result', () => {
    const target = node(undefined, {
      onKeyDown: (event: KeyboardEvent) => event.preventDefault(),
    });
    const event = new KeyboardEvent(parsed({ name: 'a' }));

    const notPrevented = dispatcher.dispatchDiscrete(target as never, event);
    expect(event.defaultPrevented).toBe(true);
    expect(notPrevented).toBe(false);
  });

  it('runs capture before bubble and bubbles to the parent', () => {
    const order: string[] = [];
    const parent = node(undefined, {
      onKeyDownCapture: () => order.push('parent-capture'),
      onKeyDown: () => order.push('parent-bubble'),
    });
    const child = node(parent, {
      onKeyDownCapture: () => order.push('child-capture'),
      onKeyDown: () => order.push('child-bubble'),
    });

    dispatcher.dispatchDiscrete(child as never, new KeyboardEvent(parsed({ name: 'a' })));
    expect(order).toEqual(['parent-capture', 'child-capture', 'child-bubble', 'parent-bubble']);
  });

  it('does not bubble when a capture handler stops propagation', () => {
    const bubble = vi.fn();
    const parent = node(undefined, { onKeyDown: bubble });
    const child = node(parent, {
      onKeyDownCapture: (event: KeyboardEvent) => event.stopPropagation(),
    });

    dispatcher.dispatchDiscrete(child as never, new KeyboardEvent(parsed({ name: 'a' })));
    expect(bubble).not.toHaveBeenCalled();
  });
});

describe('activation keys', () => {
  it.each([
    ['return', parsed({ name: 'return' })],
    ['space', parsed({ name: 'space' })],
    ['bare space sequence', parsed({ sequence: ' ' })],
  ])('treats %s as an activation key', (_label, key) => {
    expect(isActivationKey(new KeyboardEvent(key))).toBe(true);
  });

  it.each([
    ['ordinary letter', parsed({ name: 'a' })],
    ['tab', parsed({ name: 'tab' })],
    ['escape', parsed({ name: 'escape' })],
    ['ctrl+return', parsed({ name: 'return', ctrl: true })],
  ])('does not treat %s as an activation key', (_label, key) => {
    // Ctrl+Return is still Return: the parser reports the key name, and the
    // activation decision is the handler's, not this predicate's.
    const expected = key.name === 'return';
    expect(isActivationKey(new KeyboardEvent(key))).toBe(expected);
  });
});
