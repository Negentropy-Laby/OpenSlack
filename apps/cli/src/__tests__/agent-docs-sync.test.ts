import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd())

function readFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
}

/**
 * Extract the body of a markdown section, given its heading text.
 * Returns everything between the heading line and the next heading
 * of the same or higher level (fewer # characters).
 */
function extractSectionBody(content: string, headingText: string): string {
  // Normalize CRLF to LF before splitting
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let inside = false
  let headingLevel = 0
  const bodyLines: string[] = []

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      const text = match[2].trim()
      if (!inside && text === headingText) {
        inside = true
        headingLevel = level
        continue
      }
      if (inside && level <= headingLevel) {
        break
      }
    }
    if (inside) {
      bodyLines.push(line)
    }
  }

  return bodyLines.join('\n').trim()
}

/**
 * Strip HTML comments from markdown text.
 */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim()
}

describe('cross-document sync', () => {
  const agentsMd = readFile('AGENTS.md')
  const claudeMd = readFile('CLAUDE.md')

  it('Bot-Authenticated PR Creation section body is byte-identical in AGENTS.md and CLAUDE.md', () => {
    const agentsBody = extractSectionBody(agentsMd, 'Bot-Authenticated PR Creation')
    const claudeBody = extractSectionBody(claudeMd, 'Bot-Authenticated PR Creation')

    // Remove mirror annotations before comparing
    const agentsClean = stripHtmlComments(agentsBody)
    const claudeClean = stripHtmlComments(claudeBody)

    expect(agentsClean).toBe(claudeClean)
  })

  it('AGENTS.md contains the Bot-Authenticated PR Creation section', () => {
    const body = extractSectionBody(agentsMd, 'Bot-Authenticated PR Creation')
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('bot-gh-pr-create.sh')
  })

  it('CLAUDE.md contains the Bot-Authenticated PR Creation section', () => {
    const body = extractSectionBody(claudeMd, 'Bot-Authenticated PR Creation')
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('bot-gh-pr-create.sh')
  })
})
