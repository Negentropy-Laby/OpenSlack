import { describe, it, expect } from 'vitest'
import { sanitizeTerminalText } from '../sanitize.js'

describe('sanitizeTerminalText', () => {
  it('strips OSC 52 clipboard injection', () => {
    expect(sanitizeTerminalText('hello\x1b]52;c=test\x07world')).toBe('helloworld')
  })

  it('strips screen clear CSI', () => {
    expect(sanitizeTerminalText('text\x1b[2Jmore')).toBe('textmore')
  })

  it('strips cursor home CSI', () => {
    expect(sanitizeTerminalText('a\x1b[Hb')).toBe('ab')
  })

  it('strips ANSI color CSI', () => {
    expect(sanitizeTerminalText('a\x1b[31mb')).toBe('ab')
  })

  it('strips window title OSC', () => {
    expect(sanitizeTerminalText('x\x1b]0;title\x07y')).toBe('xy')
  })

  it('strips C0 bell', () => {
    expect(sanitizeTerminalText('a\x07b')).toBe('ab')
  })

  it('strips alternate screen CSI', () => {
    expect(sanitizeTerminalText('\x1b[?1049htext')).toBe('text')
  })

  it('strips cursor hide CSI', () => {
    expect(sanitizeTerminalText('\x1b[?25ltext')).toBe('text')
  })

  it('strips device attributes CSI', () => {
    expect(sanitizeTerminalText('\x1b[>0ctext')).toBe('text')
  })

  it('strips CSI with intermediate bytes', () => {
    expect(sanitizeTerminalText('\x1b[?1$ctext')).toBe('text')
  })

  it('preserves newlines', () => {
    expect(sanitizeTerminalText('a\nb')).toBe('a\nb')
  })

  it('preserves tabs', () => {
    expect(sanitizeTerminalText('a\tb')).toBe('a\tb')
  })

  it('preserves unicode', () => {
    expect(sanitizeTerminalText('日本語 🎉')).toBe('日本語 🎉')
  })

  it('handles empty string', () => {
    expect(sanitizeTerminalText('')).toBe('')
  })
})
