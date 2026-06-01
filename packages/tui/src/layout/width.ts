/**
 * width.ts -- Terminal-aware visible width measurement.
 *
 * Uses stringWidth to correctly count CJK (2 cells), emoji (2 cells),
 * and ANSI escape sequences (0 cells) for terminal column alignment.
 */
import { stringWidth } from '../ink/stringWidth.js'

/**
 * Return the visible terminal width of a string.
 * CJK characters count as 2, emoji as 2, ANSI escapes as 0.
 */
export function visibleWidth(text: string): number {
  return stringWidth(text)
}
