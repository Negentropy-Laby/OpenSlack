import { Event } from './event.js'

/**
 * Resize event stub.
 * Full implementation to be ported when resize handling is needed.
 */
export class ResizeEvent extends Event {
  readonly columns: number
  readonly rows: number

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
}
