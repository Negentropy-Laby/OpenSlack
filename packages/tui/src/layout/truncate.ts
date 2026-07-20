/**
 * truncate.ts -- Terminal-aware string truncation.
 *
 * Truncates a string to fit within a given number of terminal columns,
 * accounting for CJK (2 cells), emoji (2 cells), and ANSI escapes (0 cells).
 */
import { stringWidth } from '../ink/stringWidth.js';
import sliceAnsi from '../utils/slice-ansi.js';

/** Regex to match a complete ANSI escape sequence at the start of a string. */
const ANSI_ESCAPE_RE = /^\x1B\[[0-9;]*[A-Za-z]/;

/**
 * Truncate `text` so its visible width does not exceed `maxWidth` terminal columns.
 * Appends `ellipsis` (default '...') when truncated.
 * Returns the original string unchanged if it already fits.
 */
export function truncateVisible(text: string, maxWidth: number, ellipsis: string = '...'): string {
  const totalWidth = stringWidth(text);
  if (totalWidth <= maxWidth) return text;

  const ellipsisWidth = stringWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) {
    // Can't even fit the ellipsis; return as much visible content as possible
    return sliceAnsi(text, 0, maxWidth);
  }

  const targetWidth = maxWidth - ellipsisWidth;
  let accumulated = 0;
  let cutIndex = 0;

  // Index-based loop: advance i past full ANSI escapes so accumulated stays in sync
  let i = 0;
  while (i < text.length) {
    // Skip ANSI escape sequences (0 visible width)
    if (text[i] === '\x1B') {
      const rest = text.slice(i);
      const match = rest.match(ANSI_ESCAPE_RE);
      if (match) {
        cutIndex += match[0].length;
        i += match[0].length;
        continue;
      }
    }

    // Decode full code point (handles surrogate pairs)
    const codePoint = text.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    const charWidth = stringWidth(char);

    if (accumulated + charWidth > targetWidth) break;
    accumulated += charWidth;
    cutIndex += char.length;
    i += char.length;
  }

  return text.slice(0, cutIndex) + ellipsis;
}
