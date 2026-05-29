import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd())

function scriptPath(name: string): string {
  return resolve(repoRoot, 'scripts', name)
}

describe('bot-auth wrapper scripts', () => {
  it('bot-gh.sh exists', () => {
    expect(existsSync(scriptPath('bot-gh.sh'))).toBe(true)
  })

  it('bot-gh-pr-create.sh exists', () => {
    expect(existsSync(scriptPath('bot-gh-pr-create.sh'))).toBe(true)
  })

  it('bot-gh.ps1 exists', () => {
    expect(existsSync(scriptPath('bot-gh.ps1'))).toBe(true)
  })

  it('bot-gh-pr-create.ps1 exists', () => {
    expect(existsSync(scriptPath('bot-gh-pr-create.ps1'))).toBe(true)
  })

  it('bot-gh-token.js exists', () => {
    expect(existsSync(scriptPath('bot-gh-token.js'))).toBe(true)
  })
})
