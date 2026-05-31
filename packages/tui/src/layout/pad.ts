/**
 * pad.ts -- Terminal-aware string padding.
 *
 * Pads a string to a given number of terminal columns,
 * correctly measuring CJK (2 cells), emoji (2 cells), and ANSI escapes (0 cells).
 */
import { stringWidth } from '../ink/stringWidth.js'

/**
 * Pad `text` on the right with spaces so its visible width equals `maxWidth`.
 * If the text is already wider, returns it unchanged.
 */
export function padVisible(text: string, maxWidth: number): string {
  const currentWidth = stringWidth(text)
  if (currentWidth >= maxWidth) return text
  return text + ' '.repeat(maxWidth - currentWidth)
}

/**
 * Pad `text` on the left with spaces so its visible width equals `maxWidth`.
 * If the text is already wider, returns it unchanged.
 */
export function padVisibleStart(text: string, maxWidth: number): string {
  const currentWidth = stringWidth(text)
  if (currentWidth >= maxWidth) return text
  return ' '.repeat(maxWidth - currentWidth) + text
}
