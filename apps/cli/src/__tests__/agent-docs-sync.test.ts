import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd());

function readFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8');
}

/**
 * Extract the body of a markdown section, given its heading text.
 * Returns everything between the heading line and the next heading
 * of the same or higher level (fewer # characters).
 */
function extractSectionBody(content: string, headingText: string): string {
  // Normalize CRLF to LF before splitting
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let inside = false;
  let headingLevel = 0;
  const bodyLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      if (!inside && text === headingText) {
        inside = true;
        headingLevel = level;
        continue;
      }
      if (inside && level <= headingLevel) {
        break;
      }
    }
    if (inside) {
      bodyLines.push(line);
    }
  }

  return bodyLines.join('\n').trim();
}

describe('cross-document sync', () => {
  const agentsMd = readFile('AGENTS.md');
  const claudeMd = readFile('CLAUDE.md');

  it('AGENTS.md and CLAUDE.md are byte-identical', () => {
    // Normalize CRLF to LF for cross-platform comparison
    const agentsNormalized = agentsMd.replace(/\r\n/g, '\n');
    const claudeNormalized = claudeMd.replace(/\r\n/g, '\n');
    expect(agentsNormalized).toBe(claudeNormalized);
  });

  it('merged document contains Bot-Authenticated PR Creation section', () => {
    const body = extractSectionBody(agentsMd, 'Bot-Authenticated PR Creation');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('bot-gh-pr-create.sh');
  });

  it('merged document contains Constitutional Constraints section', () => {
    const body = extractSectionBody(agentsMd, 'Constitutional Constraints');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('No direct push to main');
  });

  it('merged document contains Agent Communication: Approval Gate section', () => {
    const body = extractSectionBody(agentsMd, 'Agent Communication: Approval Gate');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('REVIEW_REQUIRED');
  });

  it('merged document describes fail-safe risk defaults and canonical Red paths', () => {
    const body = extractSectionBody(agentsMd, 'Risk Zones');
    expect(body).toContain('any unmatched path');
    expect(body).toContain('`AGENTS.md`, `CLAUDE.md`');
    expect(body).toContain('Only explicitly listed Green paths');
  });
});
