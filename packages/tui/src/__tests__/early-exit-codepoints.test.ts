import { describe, expect, it } from 'vitest';
import { hasMultipleCodepoints } from '../ink/termio/parser.js';
import { getEmojiWidth } from '../ink/stringWidth.js';

/**
 * A string-like value that records how many code points were actually
 * requested. Passing it where a `string` is expected lets these tests assert
 * that the checks stop early instead of draining the input.
 *
 * This is an iteration-count assertion, not a timing assertion: the previous
 * implementation used `[...str]`, which necessarily drains the iterator, so a
 * bound on the number of reads distinguishes the two without measuring time.
 */
function instrumented(value: string): { input: string; reads: () => number } {
  let reads = 0;
  const wrapper = new String(value);
  Object.defineProperty(wrapper, Symbol.iterator, {
    value: function* () {
      for (const codePoint of value) {
        reads += 1;
        yield codePoint;
      }
    },
  });
  return { input: wrapper as unknown as string, reads: () => reads };
}

/** The full-expansion form, used as the result reference. */
const expand = (str: string): boolean => [...str].length > 1;

describe('hasMultipleCodepoints early exit', () => {
  it('reads at most two code points for a long input', () => {
    const { input, reads } = instrumented('abcdefghij');
    expect(hasMultipleCodepoints(input)).toBe(true);
    expect(reads()).toBe(2);
  });

  it('reads one code point and then observes the end for a single code point', () => {
    const { input, reads } = instrumented('a');
    expect(hasMultipleCodepoints(input)).toBe(false);
    expect(reads()).toBe(1);
  });

  it('never reads more than two code points, whatever the length', () => {
    for (const value of ['', 'a', 'ab', 'abc', 'x'.repeat(10_000)]) {
      const { input, reads } = instrumented(value);
      hasMultipleCodepoints(input);
      expect(reads()).toBeLessThanOrEqual(2);
    }
  });

  it('counts code points rather than UTF-16 units', () => {
    expect(hasMultipleCodepoints('\u{1F1E6}')).toBe(false);
    expect(hasMultipleCodepoints('\u{1F1E6}\u{1F1E7}')).toBe(true);
    expect(hasMultipleCodepoints('\u{1F600}')).toBe(false);
    expect(hasMultipleCodepoints('e\u0301')).toBe(true);
  });

  it('returns the same result as the full-expansion form', () => {
    for (const value of ['', 'a', 'ab', 'abc', '\u{1F1E6}', '\u{1F1E6}\u{1F1E7}', 'e\u0301']) {
      expect(hasMultipleCodepoints(value)).toBe(expand(value));
    }
  });

  it('discriminates: the full-expansion form drains the whole iterator', () => {
    // Guards against a vacuous pass. If the instrumented input stopped
    // recording reads, the early-exit assertions above would be meaningless.
    const { input, reads } = instrumented('abcdefghij');
    expand(input);
    expect(reads()).toBe(10);
  });
});

describe('getEmojiWidth early exit', () => {
  const SINGLE = '\u{1F1E6}';
  const PAIR = '\u{1F1E6}\u{1F1E7}';

  it('reads at most two code points for a regional-indicator run', () => {
    const { input, reads } = instrumented(PAIR);
    expect(getEmojiWidth(input)).toBe(2);
    expect(reads()).toBe(2);
  });

  it('reads one code point and then observes the end for a single indicator', () => {
    const { input, reads } = instrumented(SINGLE);
    expect(getEmojiWidth(input)).toBe(1);
    expect(reads()).toBe(1);
  });

  it('never reads more than two code points for a long indicator run', () => {
    const { input, reads } = instrumented(SINGLE.repeat(50));
    expect(getEmojiWidth(input)).toBe(2);
    expect(reads()).toBeLessThanOrEqual(2);
  });

  it('keeps the existing width results', () => {
    expect(getEmojiWidth(SINGLE)).toBe(1);
    expect(getEmojiWidth(PAIR)).toBe(2);
    expect(getEmojiWidth(SINGLE.repeat(3))).toBe(2);
  });
});
