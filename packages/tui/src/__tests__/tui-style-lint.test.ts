import { describe, it, expect } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Belt-and-suspenders enforcement: no TUI source file may use .padEnd( or
 * .padStart( outside of comments. These methods count UTF-16 code units, not
 * terminal cells, and break CJK / emoji alignment.
 *
 * The ESLint no-restricted-properties rule in eslint.config.js provides
 * compile-time enforcement; this test catches anything that slips through.
 */

const FORBIDDEN = ['.padEnd(', '.padStart('] as const

const TUI_SRC = join(import.meta.dirname, '..')
const SELF_FILE = __filename

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(full))
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(full)
    }
  }

  return files
}

function stripComments(source: string): string {
  // Remove single-line comments
  let result = source.replace(/\/\/.*$/gm, '')
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '')
  return result
}

describe('TUI style lint: no padEnd / padStart', () => {
  it('no source file contains .padEnd( or .padStart(', async () => {
    const files = await collectSourceFiles(TUI_SRC)
    const violations: string[] = []

    for (const file of files) {
      // Skip this test file itself (it legitimately contains the forbidden strings)
      if (file === SELF_FILE) continue

      const source = await readFile(file, 'utf-8')
      const codeOnly = stripComments(source)

      for (const forbidden of FORBIDDEN) {
        if (codeOnly.includes(forbidden)) {
          const rel = relative(TUI_SRC, file)
          violations.push(`${rel}: contains ${forbidden}`)
        }
      }
    }

    expect(violations, `Found forbidden padEnd/padStart usage:\n${violations.join('\n')}`).toEqual([])
  })
})
