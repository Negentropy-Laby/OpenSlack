/**
 * sanitize-unicode.test.ts -- Unit tests for sanitizeTerminalText with CJK, emoji, and mixed content.
 *
 * Validates that the sanitizer:
 * - Preserves CJK characters (Chinese, Japanese, Korean)
 * - Preserves emoji characters
 * - Removes ANSI escape sequences
 * - Removes OSC hyperlink sequences
 * - Handles mixed content correctly
 */
import { describe, it, expect } from 'vitest';
import { sanitizeTerminalText } from '../sanitize.js';

describe('sanitizeTerminalText — CJK preservation', () => {
  it('preserves Chinese characters', () => {
    const input = '检查系统状态';
    expect(sanitizeTerminalText(input)).toBe('检查系统状态');
  });

  it('preserves Japanese hiragana and katakana', () => {
    const input = 'こんにちは テスト';
    expect(sanitizeTerminalText(input)).toBe('こんにちは テスト');
  });

  it('preserves Korean hangul', () => {
    const input = '시스템 상태 확인';
    expect(sanitizeTerminalText(input)).toBe('시스템 상태 확인');
  });

  it('preserves CJK mixed with ASCII', () => {
    const input = 'PR #42: 修复认证流程中的边界情况';
    expect(sanitizeTerminalText(input)).toBe('PR #42: 修复认证流程中的边界情况');
  });

  it('preserves fullwidth characters', () => {
    const input = 'ＰＲ＃４２';
    expect(sanitizeTerminalText(input)).toBe('ＰＲ＃４２');
  });
});

describe('sanitizeTerminalText — emoji preservation', () => {
  it('preserves simple emoji', () => {
    const input = 'Status: ✓ All checks passed';
    expect(sanitizeTerminalText(input)).toBe('Status: ✓ All checks passed');
  });

  it('preserves multi-codepoint emoji (flags, skin tones)', () => {
    // US flag emoji is U+1F1FA U+1F1F8
    const input = 'Deploy 🇺🇸 region';
    expect(sanitizeTerminalText(input)).toBe('Deploy 🇺🇸 region');
  });

  it('preserves emoji in PR title', () => {
    const input = 'feat: 🎉 Add new dashboard feature 🚀';
    expect(sanitizeTerminalText(input)).toBe('feat: 🎉 Add new dashboard feature 🚀');
  });

  it('preserves emoji mixed with CJK', () => {
    const input = '✅ 检查通过 🎉 完璧';
    expect(sanitizeTerminalText(input)).toBe('✅ 检查通过 🎉 完璧');
  });
});

describe('sanitizeTerminalText — ANSI removal', () => {
  it('removes ANSI color codes from mixed content', () => {
    const input = '\x1b[31m检查系统\x1b[0m 正常';
    expect(sanitizeTerminalText(input)).toBe('检查系统 正常');
  });

  it('removes ANSI bold/bright sequences with CJK text', () => {
    const input = '\x1b[1m日本語テスト\x1b[0m';
    expect(sanitizeTerminalText(input)).toBe('日本語テスト');
  });

  it('removes ANSI 256-color sequences', () => {
    const input = '\x1b[38;5;196m韩国어\x1b[0m';
    expect(sanitizeTerminalText(input)).toBe('韩国어');
  });

  it('removes ANSI truecolor (24-bit) sequences', () => {
    const input = '\x1b[38;2;255;0;0m中文文本\x1b[0m';
    expect(sanitizeTerminalText(input)).toBe('中文文本');
  });

  it('removes CSI cursor movement sequences', () => {
    const input = 'text\x1b[3Cbefore日本語\x1b[1Aafter';
    expect(sanitizeTerminalText(input)).toBe('textbefore日本語after');
  });

  it('removes CSI erase sequences', () => {
    const input = '한국\x1b[2K어テスト\x1b[Kdone';
    expect(sanitizeTerminalText(input)).toBe('한국어テストdone');
  });

  it('removes multiple ANSI sequences from mixed content', () => {
    const input = '\x1b[1m\x1b[31m🎉 检查\x1b[0m\x1b[32m通过\x1b[0m';
    expect(sanitizeTerminalText(input)).toBe('🎉 检查通过');
  });
});

describe('sanitizeTerminalText — OSC hyperlink removal', () => {
  it('removes OSC 8 hyperlinks preserving link text', () => {
    // OSC 8 format: ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST
    const input = 'click \x1b]8;;https://example.com\x07here\x1b]8;;\x07 for details';
    expect(sanitizeTerminalText(input)).toBe('click here for details');
  });

  it('removes OSC 8 hyperlinks with CJK link text', () => {
    const input = '链接: \x1b]8;;https://example.com\x07点击这里\x1b]8;;\x07';
    expect(sanitizeTerminalText(input)).toBe('链接: 点击这里');
  });

  it('removes OSC with BEL terminator', () => {
    const input = 'text\x1b]0;window-title\x07more';
    expect(sanitizeTerminalText(input)).toBe('textmore');
  });

  it('removes OSC with ST terminator', () => {
    const input = 'text\x1b]0;title\x1b\\more';
    expect(sanitizeTerminalText(input)).toBe('textmore');
  });

  it('removes OSC 52 clipboard sequences', () => {
    const input = 'hello\x1b]52;c=base64data\x07world';
    expect(sanitizeTerminalText(input)).toBe('helloworld');
  });
});

describe('sanitizeTerminalText — mixed content', () => {
  it('handles ANSI + CJK + emoji together', () => {
    const input = '\x1b[32m✅ 检查通过 🎉\x1b[0m — システム正常';
    expect(sanitizeTerminalText(input)).toBe('✅ 检查通过 🎉 — システム正常');
  });

  it('handles long URL with ANSI injection', () => {
    const url = 'https://github.com/Negentropy-Laby/OpenSlack/pull/127/checks';
    const input = `\x1b[31m${url}\x1b[0m`;
    expect(sanitizeTerminalText(input)).toBe(url);
  });

  it('handles CJK with embedded control characters', () => {
    const input = 'テスト\x00文字\x0b列';
    expect(sanitizeTerminalText(input)).toBe('テスト文字列');
  });

  it('handles tab and newline preservation with CJK', () => {
    const input = '項目1\t項目2\n項目3';
    expect(sanitizeTerminalText(input)).toBe('項目1\t項目2\n項目3');
  });

  it('handles empty string', () => {
    expect(sanitizeTerminalText('')).toBe('');
  });

  it('handles pure ANSI with no readable content', () => {
    const input = '\x1b[31m\x1b[1m\x1b[0m';
    expect(sanitizeTerminalText(input)).toBe('');
  });

  it('handles surrogate-pair emoji correctly', () => {
    // Rocket emoji (U+1F680) is a surrogate pair in UTF-16
    const input = 'Launch 🚀 sequence';
    expect(sanitizeTerminalText(input)).toBe('Launch 🚀 sequence');
  });

  it('handles ZWJ emoji sequences', () => {
    // Woman technologist: woman + ZWJ + laptop
    const input = 'Developer 👩‍💻 at work';
    expect(sanitizeTerminalText(input)).toBe('Developer 👩‍💻 at work');
  });

  it('removes OSC hyperlink preserving surrounding CJK text', () => {
    const input = '前\x1b]8;;https://example.com/very/long/path\x07中\x1b]8;;\x07後';
    expect(sanitizeTerminalText(input)).toBe('前中後');
  });
});
