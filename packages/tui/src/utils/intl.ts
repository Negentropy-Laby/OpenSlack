/**
 * Shared Intl object instances with lazy initialization.
 *
 * Ported from Aby for use by the termio parser's grapheme segmentation
 * and the terminal text layout engine's word segmentation.
 */

let graphemeSegmenter: Intl.Segmenter | null = null;
let wordSegmenter: Intl.Segmenter | null = null;

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });
  }
  return graphemeSegmenter;
}

export function getWordSegmenter(): Intl.Segmenter {
  if (!wordSegmenter) {
    wordSegmenter = new Intl.Segmenter(undefined, {
      granularity: 'word',
    });
  }
  return wordSegmenter;
}
