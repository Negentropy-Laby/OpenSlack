import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
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
    const script = readFileSync(scriptPath('bot-gh-pr-create.sh'), 'utf8')
    expect(script).toContain('pr workflow-governance')
    expect(script).toContain('OPENSLACK_GITHUB_APP_PRIVATE_KEY')
    expect(script).not.toContain('GITHUB_TOKEN="$token"')
  })

  it('bot-gh.ps1 exists', () => {
    expect(existsSync(scriptPath('bot-gh.ps1'))).toBe(true)
  })

  it('bot-gh-pr-create.ps1 exists', () => {
    expect(existsSync(scriptPath('bot-gh-pr-create.ps1'))).toBe(true)
    const script = readFileSync(scriptPath('bot-gh-pr-create.ps1'), 'utf8')
    expect(script).toContain('pr workflow-governance')
    expect(script).toContain('OPENSLACK_GITHUB_APP_PRIVATE_KEY')
    expect(script).not.toContain('$env:GITHUB_TOKEN = $token')
  })

  it('bot-gh-token.js exists', () => {
    expect(existsSync(scriptPath('bot-gh-token.js'))).toBe(true)
  })
})
