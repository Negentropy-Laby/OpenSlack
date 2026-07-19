/**
 * layout.test.ts -- Tests for unified terminal layout primitives.
 */
import { describe, it, expect } from 'vitest';
import {
  visibleWidth,
  truncateVisible,
  wrapVisible,
  wrapIndentVisible,
  padVisible,
  padVisibleStart,
} from './index.js';

describe('visibleWidth', () => {
  it('measures ASCII correctly', () => {
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth('')).toBe(0);
  });

  it('measures CJK as 2 cells each', () => {
    expect(visibleWidth('中文')).toBe(4);
    // Kana count as 2 cells each in stringWidth
    expect(visibleWidth('使用者設定を検証')).toBe(16);
  });

  it('measures emoji', () => {
    // Emoji width varies by stringWidth implementation
    expect(visibleWidth('🎉')).toBeGreaterThanOrEqual(1);
    expect(visibleWidth('✓')).toBeGreaterThanOrEqual(1);
  });

  it('measures mixed content', () => {
    const w = visibleWidth('hello 中文 🎉');
    // Should be at least the ASCII + CJK portion
    expect(w).toBeGreaterThanOrEqual(13);
  });
});

describe('truncateVisible', () => {
  it('does not truncate short strings', () => {
    expect(truncateVisible('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis', () => {
    const result = truncateVisible('hello world this is long', 15);
    expect(visibleWidth(result)).toBeLessThanOrEqual(15);
    expect(result).toContain('...');
  });

  it('handles CJK truncation', () => {
    const result = truncateVisible('中文测试内容需要截断', 10);
    expect(visibleWidth(result)).toBeLessThanOrEqual(10);
    expect(result).toContain('...');
  });

  it('handles exact-width strings', () => {
    expect(truncateVisible('hello', 5)).toBe('hello');
  });

  it('handles very small maxWidth', () => {
    const result = truncateVisible('hello', 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('does not inflate width on ANSI-colored text', () => {
    // \x1B[31m...\x1B[0m wraps "world" in red — 0 visible width for escapes
    const colored = 'hello \x1B[31mworld\x1B[0m this is a long colored string';
    const result = truncateVisible(colored, 20);
    expect(visibleWidth(result)).toBeLessThanOrEqual(20);
    expect(result).toContain('...');
  });

  it('preserves ANSI escapes inside the kept portion', () => {
    const colored = '\x1B[32mhello world\x1B[0m';
    const result = truncateVisible(colored, 15);
    // Should not truncate — "hello world" is 11 visible cols
    expect(result).toBe(colored);
    expect(visibleWidth(result)).toBeLessThanOrEqual(15);
  });

  it('handles very small maxWidth with CJK', () => {
    const result = truncateVisible('中文测试', 2);
    // Should return at most 2 visible columns, not 2 string characters (which would be 4 cols)
    expect(visibleWidth(result)).toBeLessThanOrEqual(2);
  });
});

describe('wrapVisible', () => {
  it('does not wrap short lines', () => {
    expect(wrapVisible('hello world', 80)).toBe('hello world');
  });

  it('wraps long lines at word boundaries', () => {
    const result = wrapVisible('one two three four five six', 15);
    const lines = result.split('\n');
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(15);
    }
  });

  it('preserves existing newlines', () => {
    const result = wrapVisible('hello\nworld', 80);
    expect(result).toBe('hello\nworld');
  });

  it('handles CJK wrapping with spaces', () => {
    // wrapVisible wraps at word boundaries (spaces)
    const text = '这是 一段 中文 文本 需要 在终端 中正确 换行显示';
    const result = wrapVisible(text, 20);
    const lines = result.split('\n');
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it('handles empty string', () => {
    expect(wrapVisible('', 80)).toBe('');
  });

  it('hard-wraps long tokens such as URLs', () => {
    const result = wrapVisible(
      'https://github.com/Negentropy-Laby/OpenSlack/pull/130/files#diff-abc123def456',
      24,
    );
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    }
  });
});

describe('wrapIndentVisible', () => {
  it('indents continuation lines', () => {
    const result = wrapIndentVisible('one two three four five six seven eight', 4, 20);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].startsWith('    ')).toBe(true);
    }
  });

  it('does not indent first line', () => {
    const result = wrapIndentVisible('short', 4, 80);
    expect(result).toBe('short');
  });
});

describe('padVisible', () => {
  it('pads ASCII to target width', () => {
    const result = padVisible('hello', 10);
    expect(visibleWidth(result)).toBe(10);
    expect(result).toBe('hello     ');
  });

  it('does not pad strings already at width', () => {
    expect(padVisible('hello', 5)).toBe('hello');
  });

  it('does not pad strings wider than target', () => {
    expect(padVisible('中文测试', 5)).toBe('中文测试');
  });

  it('pads CJK correctly', () => {
    const result = padVisible('中文', 10);
    expect(visibleWidth(result)).toBe(10);
    expect(result).toBe('中文      ');
  });
});

describe('padVisibleStart', () => {
  it('pads on the left', () => {
    const result = padVisibleStart('hello', 10);
    expect(visibleWidth(result)).toBe(10);
    expect(result).toBe('     hello');
  });

  it('handles CJK left-padding', () => {
    const result = padVisibleStart('中文', 10);
    expect(visibleWidth(result)).toBe(10);
    expect(result).toBe('      中文');
  });
});
