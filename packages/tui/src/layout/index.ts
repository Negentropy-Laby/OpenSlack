/**
 * layout/index.ts -- Unified terminal layout primitives.
 *
 * All functions use stringWidth for correct CJK/emoji/ANSI column measurement.
 * Views should use these primitives instead of raw padEnd/padStart or manual
 * column calculation.
 */
export { visibleWidth } from './width.js';
export { truncateVisible } from './truncate.js';
export { wrapVisible, wrapIndentVisible } from './wrap.js';
export { padVisible, padVisibleStart } from './pad.js';
