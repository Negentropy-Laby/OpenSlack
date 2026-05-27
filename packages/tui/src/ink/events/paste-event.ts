import { Event } from './event.js'

/**
 * Paste event stub.
 * Full implementation to be ported when paste handling is needed.
 */
export class PasteEvent extends Event {
  readonly text: string

  constructor(text: string) {
    super()
    this.text = text
  }
}
