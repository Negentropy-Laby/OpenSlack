/**
 * Terminal-specific text layout engine.
 *
 * Implements a two-phase prepare → layout pipeline adapted from the pretext
 * project's browser text layout, but using terminal cell widths (stringWidth)
 * instead of canvas measurement. Handles CJK kinsoku, emoji grapheme clusters,
 * NBSP/NNBSP word boundaries, ZWSP break opportunities, soft hyphens, and
 * tab expansion.
 *
 * Pretext's segment classification and line-breaking logic are reimplemented
 * for terminal constraints. No browser APIs are used.
 *
 * Portions derived from pretext (https://github.com/nicolo-ribaudo/pretext)
 * are used under the MIT License.
 */

import { getGraphemeSegmenter, getWordSegmenter } from '../utils/intl.js';
import { stringWidth } from './stringWidth.js';

// ── Unicode constants ──

const KINSOKU_START = new Set([
  0x3001, // 、
  0x3002, // 。
  0xff0c, // ，
  0xff0e, // ．
  0xff1a, // ：
  0xff1b, // ；
  0xff01, // ！
  0xff1f, // ？
  0x30fb, // ・
  0xff09, // ）
  0x3011, // 】
  0x300f, // 』
  0x300d, // 」
  0xff3d, // ］
  0xff5d, // ｝
  0x300b, // 》
  0x3015, // 〕
  0x2019, // '
  0x201d, // "
  0x2026, // …
  0x00b7, // ·
  0x30a0, // ゠
  0x2015, // ―
]);

const KINSOKU_END = new Set([
  0x2018, // '
  0x201c, // "
  0xff08, // （
  0x3010, // 【
  0x3014, // 〔
  0xff3b, // ［
  0xff5b, // ｛
  0x300a, // 《
  0x300c, // 「
  0x300e, // 『
  0xff0f, // ／
  0x3016, // 〖
  0x3018, // 〘
  0x301d, // 〝
]);

function isCJK(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff)
  );
}

function isBreakableSpace(cp: number): boolean {
  return cp === 0x0020 || cp === 0x0009;
}

function isNonBreakableSpace(cp: number): boolean {
  return cp === 0x00a0 || cp === 0x202f || cp === 0x2060 || cp === 0xfeff;
}

function isZeroWidthBreak(cp: number): boolean {
  return cp === 0x200b;
}

function isSoftHyphen(cp: number): boolean {
  return cp === 0x00ad;
}

function isHardBreak(cp: number): boolean {
  return cp === 0x000a;
}

const TAB_STOP = 8;

// ── Types ──

export type TerminalSegmentKind =
  | 'text'
  | 'space'
  | 'tab'
  | 'glue'
  | 'zero-width-break'
  | 'soft-hyphen'
  | 'hard-break';

export interface TerminalSegment {
  kind: TerminalSegmentKind;
  text: string;
  width: number;
}

export interface PreparedTerminalText {
  segments: TerminalSegment[];
  source: string;
}

export interface TerminalLayoutLine {
  text: string;
  width: number;
  softWrap: boolean;
}

type LineItem = {
  segmentIndex: number;
  kind: TerminalSegmentKind;
  text: string;
  width: number;
};

function lineFromItems(items: LineItem[]): { text: string; width: number } {
  return {
    text: items.map((item) => item.text).join(''),
    width: items.reduce((sum, item) => sum + item.width, 0),
  };
}

// ── Prepare phase ──

export function prepareTerminalText(
  text: string,
  _options?: { trim?: boolean },
): PreparedTerminalText {
  const segments: TerminalSegment[] = [];
  let currentRun = '';
  let currentKind: TerminalSegmentKind | null = null;

  function flushRun(): void {
    if (currentRun.length === 0) return;
    const kind = currentKind!;
    let width: number;

    if (kind === 'tab') {
      let col = 0;
      for (const s of segments) col += s.width;
      width = TAB_STOP - (col % TAB_STOP);
      if (width === 0) width = TAB_STOP;
    } else if (kind === 'zero-width-break' || kind === 'hard-break') {
      width = 0;
    } else {
      width = stringWidth(currentRun);
    }

    segments.push({ kind, text: currentRun, width });
    currentRun = '';
    currentKind = null;
  }

  function classifyAndAppend(char: string, cp: number): void {
    let kind: TerminalSegmentKind;
    if (isHardBreak(cp)) kind = 'hard-break';
    else if (isSoftHyphen(cp)) kind = 'soft-hyphen';
    else if (isZeroWidthBreak(cp)) kind = 'zero-width-break';
    else if (isNonBreakableSpace(cp)) kind = 'glue';
    else if (cp === 0x0009) kind = 'tab';
    else if (isBreakableSpace(cp)) kind = 'space';
    else kind = 'text';

    const forceSingleSegment = kind === 'text' && (KINSOKU_START.has(cp) || KINSOKU_END.has(cp));

    if (forceSingleSegment && currentRun.length > 0) {
      flushRun();
    }

    if (currentKind !== null && currentKind !== kind) {
      flushRun();
    }
    currentKind = kind;
    currentRun += char;
    if (forceSingleSegment) {
      flushRun();
    }
  }

  const wordSegmenter = getWordSegmenter();
  for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
    if (isWordLike) {
      let hasCJK = false;
      for (const char of segment) {
        const cp = char.codePointAt(0)!;
        if (isCJK(cp)) {
          hasCJK = true;
          break;
        }
      }

      if (hasCJK) {
        flushRun();
        const graphemeSegmenter = getGraphemeSegmenter();
        for (const { segment: grapheme } of graphemeSegmenter.segment(segment)) {
          const cp = grapheme.codePointAt(0)!;
          classifyAndAppend(grapheme, cp);
          // Flush each CJK grapheme as its own segment for per-character breaking
          flushRun();
        }
      } else {
        // Non-CJK word: treat as single text unit unless it has soft-hyphen/ZWSP
        let hasSpecial = false;
        for (const char of segment) {
          const cp = char.codePointAt(0)!;
          if (isSoftHyphen(cp) || isZeroWidthBreak(cp)) {
            hasSpecial = true;
            break;
          }
        }

        if (hasSpecial) {
          flushRun();
          for (const char of segment) {
            const cp = char.codePointAt(0)!;
            classifyAndAppend(char, cp);
          }
          flushRun();
        } else {
          if (currentKind !== null && currentKind !== 'text') {
            flushRun();
          }
          currentKind = 'text';
          currentRun += segment;
        }
      }
    } else {
      flushRun();
      for (const char of segment) {
        const cp = char.codePointAt(0)!;
        classifyAndAppend(char, cp);
      }
      flushRun();
    }
  }
  flushRun();

  return { segments, source: text };
}

// ── Layout phase ──

export function layoutTerminalText(
  prepared: PreparedTerminalText,
  columns: number,
): TerminalLayoutLine[] {
  if (columns < 1) columns = 1;
  const { segments } = prepared;

  if (segments.length === 0) {
    return [{ text: '', width: 0, softWrap: false }];
  }

  const lines: TerminalLayoutLine[] = [];
  // Current line being built
  let lineText = '';
  let lineWidth = 0;
  let lineItems: LineItem[] = [];
  // Snapshot at last break opportunity
  let lastBreakIdx = -1;
  let snapText = '';
  let snapWidth = 0;
  let snapItemCount = 0;
  // Whether the NEXT line emitted will be a soft-wrap continuation
  let nextIsSoftWrap = false;

  function emitLine(text: string, width: number, softWrap: boolean): void {
    lines.push({ text, width, softWrap });
  }

  function appendLineItem(
    segmentIndex: number,
    kind: TerminalSegmentKind,
    text: string,
    width: number,
  ): void {
    lineItems.push({ segmentIndex, kind, text, width });
    lineText += text;
    lineWidth += width;
  }

  function resetCurrentLine(): void {
    lineText = '';
    lineWidth = 0;
    lineItems = [];
    lastBreakIdx = -1;
    snapText = '';
    snapWidth = 0;
    snapItemCount = 0;
  }

  function setCurrentLineFromItems(items: LineItem[]): void {
    lineItems = items.slice();
    lineText = lineItems.map((item) => item.text).join('');
    lineWidth = lineItems.reduce((sum, item) => sum + item.width, 0);
  }

  function resetBreakSnapshot(): void {
    lastBreakIdx = -1;
    snapText = '';
    snapWidth = 0;
    snapItemCount = 0;
  }

  function rememberBreak(segmentIndex: number): void {
    lastBreakIdx = segmentIndex;
    snapText = lineText;
    snapWidth = lineWidth;
    snapItemCount = lineItems.length;
  }

  function tabExpansion(): { text: string; width: number } {
    const spaces = TAB_STOP - (lineWidth % TAB_STOP) || TAB_STOP;
    return { text: ' '.repeat(spaces), width: spaces };
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;

    // Hard break: emit current line, reset for next (not soft-wrapped)
    if (seg.kind === 'hard-break') {
      emitLine(lineText, lineWidth, nextIsSoftWrap);
      resetCurrentLine();
      nextIsSoftWrap = false;
      continue;
    }

    // Zero-width break: just record a break opportunity
    if (seg.kind === 'zero-width-break') {
      rememberBreak(i);
      continue;
    }

    // Soft hyphen: record break opportunity (if broken, '-' is appended)
    if (seg.kind === 'soft-hyphen') {
      rememberBreak(i);
      continue;
    }

    // Compute segment text and width
    let segText: string;
    let segWidth: number;
    if (seg.kind === 'tab') {
      const tab = tabExpansion();
      segText = tab.text;
      segWidth = tab.width;
    } else {
      segText = seg.text;
      segWidth = seg.width;
    }

    // Does it fit?
    if (lineWidth + segWidth <= columns) {
      appendLineItem(i, seg.kind, segText, segWidth);

      // Space is a break opportunity (break before the next word)
      if (seg.kind === 'space') {
        rememberBreak(i);
      }
    } else if (lastBreakIdx >= 0) {
      // Doesn't fit, but we have a break opportunity — use it
      const breakAtIdx = lastBreakIdx;
      const breakSeg = segments[lastBreakIdx]!;

      // Build the line up to the break
      let breakLineText = snapText;
      let breakLineWidth = snapWidth;
      let breakItemCount = snapItemCount;

      // If break is at a soft hyphen, show '-' at line end
      if (breakSeg.kind === 'soft-hyphen') {
        breakLineText += '-';
        breakLineWidth += 1;
      } else if (breakSeg.kind === 'zero-width-break') {
        // ZWSP: no visible character at break
      }
      // If break is at space, trailing space is already in snapText

      const adjusted = adjustBreakForKinsoku(lineItems, breakItemCount, columns);
      breakItemCount = adjusted.breakItemCount;
      if (adjusted.changed) {
        const adjustedLine = lineFromItems(lineItems.slice(0, breakItemCount));
        breakLineText = adjustedLine.text;
        breakLineWidth = adjustedLine.width;
      }

      emitLine(breakLineText, breakLineWidth, nextIsSoftWrap);
      nextIsSoftWrap = true;

      // Reset and replay segments from after the break to current
      let resumeIdx = breakAtIdx + 1;
      if (breakItemCount < snapItemCount) {
        resumeIdx = lineItems[breakItemCount]!.segmentIndex;
      } else if (breakItemCount > snapItemCount) {
        resumeIdx = lineItems[breakItemCount - 1]!.segmentIndex + 1;
      }
      resetCurrentLine();

      // Determine resume index — start after the break segment
      // Skip leading spaces after a space break (they're the break point itself)
      if (breakItemCount === snapItemCount && segments[breakAtIdx]!.kind === 'space') {
        while (resumeIdx < segments.length && segments[resumeIdx]!.kind === 'space') {
          resumeIdx++;
        }
      }

      // Replay from resumeIdx to i (inclusive)
      for (let j = resumeIdx; j <= i; j++) {
        const rseg = segments[j]!;
        if (rseg.kind === 'hard-break') continue;
        if (rseg.kind === 'zero-width-break') {
          rememberBreak(j);
          continue;
        }
        if (rseg.kind === 'soft-hyphen') {
          rememberBreak(j);
          continue;
        }

        let rt: string;
        let rw: number;
        if (rseg.kind === 'tab') {
          const tab = tabExpansion();
          rt = tab.text;
          rw = tab.width;
        } else {
          rt = rseg.text;
          rw = rseg.width;
        }

        if (lineWidth + rw <= columns) {
          appendLineItem(j, rseg.kind, rt, rw);
          if (rseg.kind === 'space') {
            rememberBreak(j);
          }
        } else if (rw > columns) {
          // Segment wider than columns: grapheme-break
          if (lineText.length > 0) {
            emitLine(lineText, lineWidth, true);
          }
          const broken = breakAtGraphemeBoundaries(rt, columns);
          for (let bi = 0; bi < broken.length; bi++) {
            const piece = broken[bi]!;
            emitLine(piece, stringWidth(piece), true);
          }
          resetCurrentLine();
        } else {
          // Doesn't fit: start new line with this segment
          if (lineText.length > 0) {
            emitLine(lineText, lineWidth, true);
          }
          resetCurrentLine();
          appendLineItem(j, rseg.kind, rt, rw);
        }
      }
    } else {
      // No break opportunity — need to force break
      if (segWidth > columns) {
        // Segment itself wider than columns: grapheme-break it
        if (lineText.length > 0) {
          emitLine(lineText, lineWidth, nextIsSoftWrap);
          nextIsSoftWrap = true;
        }
        const broken = breakAtGraphemeBoundaries(segText, columns);
        for (let bi = 0; bi < broken.length; bi++) {
          const piece = broken[bi]!;
          const pw = stringWidth(piece);
          emitLine(piece, pw, nextIsSoftWrap);
          nextIsSoftWrap = true;
        }
        resetCurrentLine();
      } else {
        const adjusted = adjustForcedBreakForKinsoku(
          lineItems,
          i,
          seg.kind,
          segText,
          segWidth,
          columns,
        );
        emitLine(adjusted.line.text, adjusted.line.width, nextIsSoftWrap);
        nextIsSoftWrap = true;
        setCurrentLineFromItems(adjusted.nextItems);
      }
    }
  }

  // Flush remaining
  if (lineText.length > 0 || lineWidth > 0) {
    emitLine(lineText, lineWidth, nextIsSoftWrap);
  }

  // Trailing hard break → emit empty line
  const lastSeg = segments[segments.length - 1]!;
  if (lastSeg.kind === 'hard-break') {
    lines.push({ text: '', width: 0, softWrap: false });
  }

  // Strip soft hyphens from output (they're invisible unless at break)
  for (const line of lines) {
    if (line.text.includes('­')) {
      line.text = line.text.replaceAll('­', '');
      line.width = stringWidth(line.text);
    }
  }

  return lines;
}

/**
 * Move break decisions instead of mutating already-emitted text. This keeps
 * all source characters in either the current line or the replayed next line.
 */
function adjustBreakForKinsoku(
  items: LineItem[],
  breakItemCount: number,
  columns: number,
): { breakItemCount: number; changed: boolean } {
  let nextBreakItemCount = breakItemCount;
  let changed = false;

  while (nextBreakItemCount > 1 && endsWithKinsokuEnd(items[nextBreakItemCount - 1]!.text)) {
    nextBreakItemCount--;
    changed = true;
  }

  while (
    nextBreakItemCount < items.length &&
    startsWithKinsokuStart(items[nextBreakItemCount]!.text)
  ) {
    const line = lineFromItems(items.slice(0, nextBreakItemCount));
    const next = items[nextBreakItemCount]!;
    if (line.width + next.width > columns) break;
    nextBreakItemCount++;
    changed = true;
  }

  return { breakItemCount: nextBreakItemCount, changed };
}

function adjustForcedBreakForKinsoku(
  items: LineItem[],
  segmentIndex: number,
  kind: TerminalSegmentKind,
  text: string,
  width: number,
  columns: number,
): { line: { text: string; width: number }; nextItems: LineItem[] } {
  const incoming = { segmentIndex, kind, text, width };

  if (items.length > 1 && startsWithKinsokuStart(text)) {
    const keptItems = items.slice(0, -1);
    const carried = items[items.length - 1]!;
    if (carried.width + width <= columns) {
      return {
        line: lineFromItems(keptItems),
        nextItems: [carried, incoming],
      };
    }
  }

  if (items.length > 1 && endsWithKinsokuEnd(items[items.length - 1]!.text)) {
    const keptItems = items.slice(0, -1);
    const carried = items[items.length - 1]!;
    return {
      line: lineFromItems(keptItems),
      nextItems: [carried, incoming],
    };
  }

  return {
    line: lineFromItems(items),
    nextItems: [incoming],
  };
}

function startsWithKinsokuStart(text: string): boolean {
  const first = [...text][0];
  return first !== undefined && KINSOKU_START.has(first.codePointAt(0)!);
}

function endsWithKinsokuEnd(text: string): boolean {
  const chars = [...text];
  const last = chars[chars.length - 1];
  return last !== undefined && KINSOKU_END.has(last.codePointAt(0)!);
}

function breakAtGraphemeBoundaries(text: string, columns: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(text)) {
    const gw = stringWidth(grapheme);
    if (currentWidth + gw > columns && current.length > 0) {
      pieces.push(current);
      current = grapheme;
      currentWidth = gw;
    } else {
      current += grapheme;
      currentWidth += gw;
    }
  }

  if (current.length > 0) {
    pieces.push(current);
  }

  return pieces.length > 0 ? pieces : [text];
}

// ── Combined API ──

export interface WrapTerminalTextResult {
  wrapped: string;
  softWrap: boolean[];
  segmentCount: number;
}

export function wrapTerminalText(
  text: string,
  columns: number,
  options: { trim: boolean },
): WrapTerminalTextResult {
  if (text.length === 0) {
    return { wrapped: '', softWrap: [], segmentCount: 0 };
  }

  if (columns < 1) columns = 1;

  const prepared = prepareTerminalText(text, { trim: options.trim });
  let lines = layoutTerminalText(prepared, columns);

  if (options.trim) {
    lines = lines.map((line) => ({
      ...line,
      text: line.text.trim(),
      width: stringWidth(line.text.trim()),
    }));
  }

  const wrapped = lines.map((l) => l.text).join('\n');
  const softWrap = lines.map((l) => l.softWrap);

  return { wrapped, softWrap, segmentCount: prepared.segments.length };
}
