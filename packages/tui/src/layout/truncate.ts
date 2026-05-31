/**
 * truncate.ts -- Terminal-aware string truncation.
 *
 * Truncates a string to fit within a given number of terminal columns,
 * accounting for CJK (2 cells), emoji (2 cells), and ANSI escapes (0 cells).
 */
import { stringWidth } from '../ink/stringWidth.js'

/**
 * Truncate `text` so its visible width does not exceed `maxWidth` terminal columns.
 * Appends `ellipsis` (default '...') when truncated.
 * Returns the original string unchanged if it already fits.
 */
export function truncateVisible(text: string, maxWidth: number, ellipsis: string = '...'): string {
  const totalWidth = stringWidth(text)
  if (totalWidth <= maxWidth) return text

  const ellipsisWidth = stringWidth(ellipsis)
  if (maxWidth <= ellipsisWidth) {
    // Can't even fit the ellipsis; return as much as possible
    return text.slice(0, maxWidth)
  }

  const targetWidth = maxWidth - ellipsisWidth
  let accumulated = 0
  let cutIndex = 0

  for (const char of text) {
    // Skip ANSI escape sequences
    if (char === '\x1B') {
      // Find the end of the escape sequence
      const rest = text.slice(cutIndex)
      const match = rest.match(/^\x1B\[[0-9;]*[A-Za-z]/)
      if (match) {
        cutIndex += match[0].length
        continue
      }
    }

    const charWidth = stringWidth(char)
    if (accumulated + charWidth > targetWidth) break
    accumulated += charWidth
    cutIndex += char.length
  }

  return text.slice(0, cutIndex) + ellipsis
}
