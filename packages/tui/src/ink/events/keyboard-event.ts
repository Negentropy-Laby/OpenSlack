import type { ParsedKey } from '../parse-keypress.js';
import { TerminalEvent } from './terminal-event.js';

/**
 * Keyboard input event.
 *
 * Extends the dispatcher's `TerminalEvent` contract rather than the bare
 * `Event` stub, so the dispatcher can set `target` / `currentTarget` /
 * `eventPhase` on it and handlers can call `preventDefault()` and read
 * `defaultPrevented`. It is constructed from a parsed key, so `key` and the
 * modifier flags are taken from the parser instead of being cast into place.
 */
export class KeyboardEvent extends TerminalEvent {
  /** The parsed key name, falling back to the raw sequence for plain input. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly option: boolean;
  readonly fn: boolean;
  /** True when this key is a bare printable character rather than a named key. */
  readonly printable: boolean;

  constructor(parsedKey: ParsedKey) {
    super('keydown');
    this.key = parsedKey.name ?? parsedKey.sequence ?? parsedKey.raw ?? '';
    this.ctrl = parsedKey.ctrl;
    this.meta = parsedKey.meta;
    this.shift = parsedKey.shift;
    this.option = parsedKey.option;
    this.fn = parsedKey.fn;
    this.printable = parsedKey.name === undefined;
  }
}

/**
 * The key names that activate a control. The vendored parser emits `return` and
 * `space`; a bare `' '` sequence is accepted as well so an unmapped space never
 * silently fails to activate.
 */
export function isActivationKey(event: KeyboardEvent): boolean {
  return event.key === 'return' || event.key === 'space' || event.key === ' ';
}
