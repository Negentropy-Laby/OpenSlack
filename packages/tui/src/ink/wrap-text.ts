import sliceAnsi from '../utils/slice-ansi.js';
import { stringWidth } from './stringWidth.js';
import type { Styles } from './styles.js';
import { hasTerminalControlSequence } from './terminal-control-sequences.js';
import { wrapTerminalText } from './terminal-text-layout.js';
import { wrapAnsi } from './wrapAnsi.js';

const ELLIPSIS = '…';

// sliceAnsi may include a boundary-spanning wide char (e.g. CJK at position
// end-1 with width 2 overshoots by 1). Retry with a tighter bound once.
function sliceFit(text: string, start: number, end: number): string {
  const s = sliceAnsi(text, start, end);
  return stringWidth(s) > end - start ? sliceAnsi(text, start, end - 1) : s;
}

function truncate(text: string, columns: number, position: 'start' | 'middle' | 'end'): string {
  if (columns < 1) return '';
  if (columns === 1) return ELLIPSIS;

  const length = stringWidth(text);
  if (length <= columns) return text;

  if (position === 'start') {
    return ELLIPSIS + sliceFit(text, length - columns + 1, length);
  }
  if (position === 'middle') {
    const half = Math.floor(columns / 2);
    return (
      sliceFit(text, 0, half) + ELLIPSIS + sliceFit(text, length - (columns - half) + 1, length)
    );
  }
  return sliceFit(text, 0, columns - 1) + ELLIPSIS;
}

export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: Styles['textWrap'],
): string {
  if (wrapType === 'wrap' || wrapType === 'wrap-trim') {
    const trim = wrapType === 'wrap-trim';
    // Use terminal layout for plain text; fall back to wrapAnsi for ANSI
    if (!hasTerminalControlSequence(text)) {
      return wrapTerminalText(text, maxWidth, { trim }).wrapped;
    }
    return wrapAnsi(text, maxWidth, { trim, hard: true });
  }

  if (wrapType?.startsWith('truncate')) {
    let position: 'end' | 'middle' | 'start' = 'end';

    if (wrapType === 'truncate-middle') {
      position = 'middle';
    }

    if (wrapType === 'truncate-start') {
      position = 'start';
    }

    return truncate(text, maxWidth, position);
  }

  return text;
}
