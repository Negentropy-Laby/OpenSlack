import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isTuiSupported } from '../capabilities.js'

const originalIsTTY = process.stdout.isTTY
const originalColumns = process.stdout.columns
const originalRows = process.stdout.rows

describe('isTuiSupported', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR
    delete process.env.OPENSLACK_TUI
    delete process.env.CI
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
  })

  function mockStdout(isTTY: boolean, columns: number, rows: number) {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true })
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true })
  }

  it('returns false for non-TTY stdout', () => {
    mockStdout(false, 80, 24)
    expect(isTuiSupported()).toBe(false)
  })

  it('returns false in CI environment', () => {
    mockStdout(true, 80, 24)
    process.env.CI = 'true'
    expect(isTuiSupported()).toBe(false)
  })

  it('returns false when NO_COLOR is set', () => {
    mockStdout(true, 80, 24)
    process.env.NO_COLOR = '1'
    expect(isTuiSupported()).toBe(false)
  })

  it('returns false when OPENSLACK_TUI=0', () => {
    mockStdout(true, 80, 24)
    process.env.OPENSLACK_TUI = '0'
    expect(isTuiSupported()).toBe(false)
  })

  it('returns true for valid TTY with adequate size', () => {
    mockStdout(true, 80, 24)
    expect(isTuiSupported()).toBe(true)
  })

  it('returns false for terminal too small', () => {
    mockStdout(true, 20, 5)
    expect(isTuiSupported()).toBe(false)
  })
})
