/**
 * wrap.ts -- Terminal-aware word wrapping.
 *
 * Word-wraps text to a given number of terminal columns,
 * correctly measuring CJK (2 cells), emoji (2 cells), and ANSI escapes (0 cells).
 */
import { stringWidth } from '../ink/stringWidth.js';
import sliceAnsi from '../utils/slice-ansi.js';

function breakLongToken(token: string, width: number): string[] {
  const totalWidth = stringWidth(token);
  if (totalWidth <= width) return [token];

  const parts: string[] = [];
  let start = 0;
  while (start < totalWidth) {
    const next = Math.min(start + width, totalWidth);
    const part = sliceAnsi(token, start, next);
    if (!part) break;
    parts.push(part);
    start += stringWidth(part);
  }

  return parts.length > 0 ? parts : [token];
}

/**
 * Word-wrap a single line to `width` terminal columns.
 * Preserves existing newlines in the input by wrapping each line independently.
 */
export function wrapVisible(text: string, width: number): string {
  if (width <= 0) return text;

  return text
    .split('\n')
    .map((line) => {
      if (line.length === 0) return '';
      const words = line.split(/\s+/);
      const result: string[] = [];
      let current = '';
      for (const word of words) {
        if (word.length === 0) continue;
        if (stringWidth(word) > width) {
          if (current.length > 0) {
            result.push(current);
            current = '';
          }

          const parts = breakLongToken(word, width);
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            if (i === parts.length - 1) {
              current = part;
            } else {
              result.push(part);
            }
          }
          continue;
        }

        if (current.length === 0) {
          current = word;
        } else if (stringWidth(current) + 1 + stringWidth(word) <= width) {
          current += ' ' + word;
        } else {
          result.push(current);
          current = word;
        }
      }
      if (current.length > 0) result.push(current);
      return result.join('\n');
    })
    .join('\n');
}

/**
 * Wrap text with subsequent lines indented by `indent` spaces.
 * The first line is not indented.
 */
export function wrapIndentVisible(text: string, indent: number, width: number): string {
  const inner = width - indent;
  if (inner <= 0) return text;
  const pad = ' '.repeat(indent);
  return wrapVisible(text, inner)
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}
