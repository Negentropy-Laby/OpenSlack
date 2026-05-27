import { Event } from './event.js'

/**
 * Keyboard input event stub.
 * Full implementation to be ported when keyboard handling is needed.
 */
export class KeyboardEvent extends Event {
  readonly key: string
  readonly meta: boolean = false
  readonly ctrl: boolean = false
  readonly shift: boolean = false

  constructor(key: string) {
    super()
    this.key = key
  }
}
