import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('QW2 MCP source boundary', () => {
  it('uses the official stdio SDK and reserves stdout for protocol frames', () => {
    const server = readFileSync(join(sourceRoot, 'server.ts'), 'utf8');
    const index = readFileSync(join(sourceRoot, 'index.ts'), 'utf8');
    const combined = `${server}\n${index}`;

    expect(server).toContain('@modelcontextprotocol/sdk/server/stdio.js');
    expect(combined).not.toContain('console.log');
    expect(combined).not.toMatch(/createServer|listen\s*\(/);
  });

  it('does not import CLI internals or expose shell/command passthrough', () => {
    const files = ['context.ts', 'core.ts', 'server.ts', 'index.ts', 'tools/index.ts'];
    const source = files.map((path) => readFileSync(join(sourceRoot, path), 'utf8')).join('\n');

    expect(source).not.toMatch(/apps\/cli|@openslack\/cli/);
    expect(source).not.toMatch(/child_process|execFile|spawn|run_shell|rawCommand/);
    expect(source).not.toMatch(/github\.approve|pr\.approve|direct_merge/);
  });

  it('uses bounded read-model adapters instead of mutating or skip-invalid legacy stores', () => {
    const context = readFileSync(join(sourceRoot, 'context.ts'), 'utf8');
    const boundedRead = readFileSync(join(sourceRoot, 'bounded-read.ts'), 'utf8');

    expect(context).not.toMatch(/\b(?:readEvents|listHandoffs|listDecisions|readModules)\s*\(/);
    expect(context).not.toMatch(/\b(?:mkdirSync|writeFileSync|unlinkSync|renameSync)\b/);
    expect(context).toContain('readBoundedDirectoryFilesSync');
    expect(context).toContain('readBoundedJsonlFileSync');
    expect(boundedRead).toContain('opendirSync');
    expect(boundedRead).toContain('O_NOFOLLOW');
    expect(boundedRead).toContain('mtimeNs');
    expect(boundedRead).toContain('ctimeNs');
  });

  it('caps CODEOWNERS matching below the MCP read deadline budget', () => {
    const context = readFileSync(join(sourceRoot, 'context.ts'), 'utf8');

    expect(context).toMatch(/maxCodeownerMatchOperations:\s*50_000/);
  });
});
