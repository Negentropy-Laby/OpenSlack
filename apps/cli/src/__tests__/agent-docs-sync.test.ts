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
  const releaseRunbook = readFile('docs/operations/release-0.2.0.md');
  const cliReference = readFile('docs/user/cli-reference.md');
  const prCommand = readFile('apps/cli/src/commands/pr.ts');

  it('keeps agent docs byte-identical with the default unbound-merge rule', () => {
    // Normalize CRLF to LF for cross-platform comparison
    const agentsNormalized = agentsMd.replace(/\r\n/g, '\n');
    const claudeNormalized = claudeMd.replace(/\r\n/g, '\n');
    expect(agentsNormalized).toBe(claudeNormalized);
    const mergeGate = extractSectionBody(agentsNormalized, 'Review Thread Resolution Gate').replace(
      /\s+/g,
      ' ',
    );
    expect(mergeGate).toContain('By default, do not bind the merge to a head SHA');
    expect(mergeGate).toContain('only when the user explicitly requests');
    expect(mergeGate).toContain('its absence must never block an otherwise governed merge');
    expect(mergeGate).toContain(
      'openslack pr merge <PR_NUMBER> --method merge --match-head-commit <sha>',
    );
    const normalizedRunbook = releaseRunbook.replace(/\s+/g, ' ');
    expect(normalizedRunbook).toContain('The default route must not pass `--match-head-commit`');
    expect(normalizedRunbook).toContain(
      'Head binding is allowed only when the user explicitly requests it for the current merge',
    );
    expect(normalizedRunbook).toContain(
      'PRMS counts an approval only when its review commit matches the live PR head',
    );
    expect(cliReference).toContain(
      'Use `--match-head-commit <sha>` only when the user explicitly requests head',
    );
    expect(prCommand).toContain(".option(\n      '--match-head-commit <sha>'");
    expect(prCommand).toContain('{ expectedHeadSha: options.matchHeadCommit }');
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
