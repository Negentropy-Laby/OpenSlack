import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { detectFormatFromSource, loadWorkflow, detectFormat } from '../loader.js';

// Path to fixtures
const FIXTURES_DIR = join(import.meta.dirname, '..', '__fixtures__', 'claude-workflows');

describe('claude-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-claude-loader-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── detectFormatFromSource ──────────────────────────────────────────────────

  describe('detectFormatFromSource', () => {
    it('returns "invalid" for source with no meta export', () => {
      const source = `const meta = { name: 'test' }`;
      expect(detectFormatFromSource(source)).toBe('invalid');
    });

    it('returns "anthropic-compatible" for meta-only module (no preview/run, no ambient usage)', () => {
      const source = `
export const meta = {
  name: 'meta-only',
  description: 'Meta only',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
`;
      expect(detectFormatFromSource(source)).toBe('anthropic-compatible');
    });

    it('returns "openslack-native" for module with export function run', () => {
      const source = `
export const meta = {
  name: 'native',
  description: 'Native',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
export async function run() { return { status: 'ok' } }
`;
      expect(detectFormatFromSource(source)).toBe('openslack-native');
    });

    it('returns "openslack-native" for module with export function preview', () => {
      const source = `
export const meta = {
  name: 'native-preview',
  description: 'Native with preview',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
export async function preview() { return { preview: true } }
`;
      expect(detectFormatFromSource(source)).toBe('openslack-native');
    });

    it('returns "openslack-native" for module with both preview and run', () => {
      const source = `
export const meta = {
  name: 'full-native',
  description: 'Full native',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
export async function preview() { return { preview: true } }
export async function run() { return { status: 'ok' } }
`;
      expect(detectFormatFromSource(source)).toBe('openslack-native');
    });

    it('returns "claude-ambient" for module with top-level phase() call after meta', () => {
      const source = `
export const meta = {
  name: 'ambient',
  description: 'Ambient',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}

phase("Scan")
log("Scanning")
`;
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('returns "claude-ambient" for module with top-level await after meta', () => {
      const source = `
export const meta = {
  name: 'ambient-await',
  description: 'Ambient with await',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}

const result = await agent("prompt", { label: "scan", phase: "Scan" })
`;
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('returns "claude-ambient" for module with top-level agent() call', () => {
      const source = `
export const meta = {
  name: 'ambient-agent',
  description: 'Ambient with agent',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}

const result = agent("prompt", { label: "scan", phase: "Scan" })
`;
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('does NOT detect ambient usage inside export function bodies', () => {
      // phase/log inside an export function should not trigger claude-ambient
      const source = `
export const meta = {
  name: 'not-ambient',
  description: 'Not ambient',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}

export async function run() {
  phase("Scan")
  log("Running")
  return { status: 'ok' }
}
`;
      expect(detectFormatFromSource(source)).toBe('openslack-native');
    });

    it('handles meta with type annotation', () => {
      const source = `
export const meta: WorkflowMeta = {
  name: 'typed',
  description: 'Typed meta',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
`;
      expect(detectFormatFromSource(source)).toBe('anthropic-compatible');
    });

    // ── Fixture-based format detection ────────────────────────────────────────

    it('detects meta-only fixture as "anthropic-compatible"', async () => {
      const source = await readFile(join(FIXTURES_DIR, 'meta-only.js'), 'utf-8');
      expect(detectFormatFromSource(source)).toBe('anthropic-compatible');
    });

    it('detects ambient-basic fixture as "claude-ambient"', async () => {
      const source = await readFile(join(FIXTURES_DIR, 'ambient-basic.js'), 'utf-8');
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('detects ambient-full-lifecycle fixture as "claude-ambient"', async () => {
      const source = await readFile(join(FIXTURES_DIR, 'ambient-full-lifecycle.js'), 'utf-8');
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('detects ambient-pipeline-multistage fixture as "claude-ambient"', async () => {
      const source = await readFile(join(FIXTURES_DIR, 'ambient-pipeline-multistage.js'), 'utf-8');
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('detects ambient-budget fixture as "claude-ambient"', async () => {
      const source = await readFile(join(FIXTURES_DIR, 'ambient-budget.js'), 'utf-8');
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('detects ambient-agent-options fixture as "claude-ambient"', async () => {
      const source = await readFile(join(FIXTURES_DIR, 'ambient-agent-options.js'), 'utf-8');
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });

    it('detects invalid-node-api fixture as "claude-ambient" (meta + ambient usage)', async () => {
      // invalid-node-api has valid meta + top-level require/process usage
      const source = await readFile(join(FIXTURES_DIR, 'invalid-node-api.js'), 'utf-8');
      expect(detectFormatFromSource(source)).toBe('claude-ambient');
    });
  });

  // ── loadWorkflow for claude-ambient scripts ──────────────────────────────────

  describe('loadWorkflow for claude-ambient scripts', () => {
    it('returns format="claude-ambient" with sourceBody (no import)', async () => {
      const filePath = join(FIXTURES_DIR, 'ambient-basic.js');
      const mod = await loadWorkflow(filePath);
      expect(mod.format).toBe('claude-ambient');
      expect(mod.sourceBody).toBeDefined();
      expect(mod.sourceBody).toContain('export const meta');
      expect(mod.sourceBody).toContain("phase('Scan')");
    });

    it('does NOT import claude-ambient scripts (no preview/run exports)', async () => {
      const filePath = join(FIXTURES_DIR, 'ambient-basic.js');
      const mod = await loadWorkflow(filePath);
      // claude-ambient modules should NOT have preview/run imported
      expect(mod.preview).toBeUndefined();
      expect(mod.run).toBeUndefined();
      // But they should have sourceBody
      expect(typeof mod.sourceBody).toBe('string');
    });

    it('extracts meta correctly from ambient fixtures', async () => {
      const filePath = join(FIXTURES_DIR, 'ambient-basic.js');
      const mod = await loadWorkflow(filePath);
      expect(mod.meta.name).toBe('ambient-basic');
      expect(mod.meta.phases).toHaveLength(2);
      expect(mod.meta.phases[0].title).toBe('Scan');
      expect(mod.meta.phases[1].title).toBe('Report');
    });

    it('computes hash for ambient scripts', async () => {
      const filePath = join(FIXTURES_DIR, 'ambient-basic.js');
      const mod = await loadWorkflow(filePath);
      expect(mod.hash).toBeDefined();
      expect(mod.hash).toHaveLength(16); // SHA-256 truncated to 16 hex chars
    });

    it('returns sourceBody for ambient-full-lifecycle fixture', async () => {
      const filePath = join(FIXTURES_DIR, 'ambient-full-lifecycle.js');
      const mod = await loadWorkflow(filePath);
      expect(mod.format).toBe('claude-ambient');
      expect(mod.sourceBody).toContain('parallel');
      expect(mod.sourceBody).toContain('pipeline');
      expect(mod.sourceBody).toContain('budget');
    });
  });

  // ── loadWorkflow for openslack-native modules ───────────────────────────────

  describe('loadWorkflow for openslack-native modules', () => {
    it('still imports openslack-native modules normally', async () => {
      const filePath = join(tmpDir, 'native-test.mjs');
      writeFileSync(
        filePath,
        `
export const meta = {
  name: 'native-test',
  description: 'Native test',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
export async function preview() { return { preview: true } }
export async function run() { return { status: 'ok' } }
`,
      );
      const mod = await loadWorkflow(filePath);
      expect(mod.format).toBe('openslack-native');
      expect(mod.preview).toBeInstanceOf(Function);
      expect(mod.run).toBeInstanceOf(Function);
      // No sourceBody for native modules
      expect(mod.sourceBody).toBeUndefined();
    });

    it('still imports anthropic-compatible modules (meta-only)', async () => {
      const filePath = join(tmpDir, 'compat-test.mjs');
      writeFileSync(
        filePath,
        `
export const meta = {
  name: 'compat-test',
  description: 'Compat test',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
`,
      );
      const mod = await loadWorkflow(filePath);
      // meta-only without ambient usage => detectFormat returns 'anthropic-compatible'
      // but detectFormat on the imported module will see meta only => 'anthropic-compatible'
      expect(mod.format).toBe('anthropic-compatible');
      expect(mod.preview).toBeUndefined();
      expect(mod.run).toBeUndefined();
      expect(mod.sourceBody).toBeUndefined();
    });
  });

  // ── loadWorkflow rejects invalid modules ─────────────────────────────────────

  describe('loadWorkflow rejects invalid modules', () => {
    it('rejects files with no meta export', async () => {
      const filePath = join(tmpDir, 'no-meta.mjs');
      writeFileSync(filePath, `// no meta export`);
      await expect(loadWorkflow(filePath)).rejects.toThrow('no "export const meta');
    });

    it('rejects files with dynamic meta', async () => {
      const filePath = join(FIXTURES_DIR, 'invalid-dynamic-meta.js');
      await expect(loadWorkflow(filePath)).rejects.toThrow();
    });
  });
});
