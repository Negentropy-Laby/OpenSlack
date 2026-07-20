import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripMetaExport, createSecureSandbox, executeAmbientScript } from '../ambient-runner.js';

describe('claude-ambient-runner', () => {
  // ── stripMetaExport ─────────────────────────────────────────────────────────

  describe('stripMetaExport', () => {
    it('removes the meta export from source', () => {
      const source = `
export const meta = {
  name: "test",
  description: "Test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

phase("Scan")
log("Running")
`;
      const result = stripMetaExport(source);
      expect(result).not.toContain('export const meta');
      expect(result).toContain('phase("Scan")');
      expect(result).toContain('log("Running")');
    });

    it('removes meta with type annotation', () => {
      const source = `
export const meta: WorkflowMeta = {
  name: "typed",
  description: "Typed",
  phases: [{ title: "Scan", detail: "Scan" }]
}

phase("Scan")
`;
      const result = stripMetaExport(source);
      expect(result).not.toContain('export const meta');
      expect(result).toContain('phase("Scan")');
    });

    it('removes meta with trailing semicolon', () => {
      const source = `export const meta = { name: "test", description: "Test", phases: [{ title: "A", detail: "B" }] };\nphase("A")`;
      const result = stripMetaExport(source);
      expect(result).not.toContain('export const meta');
      expect(result).toContain('phase("A")');
    });

    it('handles nested braces in meta', () => {
      const source = `
export const meta = {
  name: "nested",
  description: "Nested",
  phases: [
    { title: "Scan", detail: "Scan" },
    { title: "Report", detail: "Report" }
  ],
  permissions: { github: ["issues:read"] }
}

phase("Scan")
`;
      const result = stripMetaExport(source);
      expect(result).not.toContain('export const meta');
      expect(result).toContain('phase("Scan")');
    });

    it('returns source unchanged if no meta export', () => {
      const source = `phase("Scan")\nlog("No meta")`;
      expect(stripMetaExport(source)).toBe(source);
    });

    it('returns source unchanged for unbalanced braces', () => {
      const source = `export const meta = { name: "test"\nphase("Scan")`;
      // Unbalanced — no closing }, so stripMetaExport returns source unchanged
      expect(stripMetaExport(source)).toBe(source);
    });
  });

  // ── executeAmbientScript ────────────────────────────────────────────────────

  describe('executeAmbientScript', () => {
    function makeStubs() {
      return {
        phase: vi.fn(),
        log: vi.fn(),
        agent: vi.fn(async () => ({ result: 'ok' })),
        parallel: vi.fn(async (tasks: Array<() => Promise<unknown>>) =>
          Promise.all(tasks.map((t) => t())),
        ),
        pipeline: vi.fn(
          async (items: unknown[], fn: (item: unknown, idx: number) => Promise<unknown>) =>
            Promise.all(items.map((item, idx) => fn(item, idx))),
        ),
        workflow: vi.fn(async () => ({ done: true })),
        args: { targetPath: '/test' },
        budget: {
          tokensUsed: 0,
          tokensRemaining: 5000,
          costUsd: 0,
          agentCalls: 0,
          total: 5000,
          spent: () => 0,
          remaining: () => 5000,
        },
      };
    }

    it('runs basic ambient script with phase/log/agent stubs', async () => {
      const stubs = makeStubs();
      const sourceBody = `
export const meta = {
  name: "basic",
  description: "Basic",
  phases: [{ title: "Scan", detail: "Scan" }]
}

phase("Scan")
log("Starting scan")
const result = await agent("scan code", { label: "scan:basic", phase: "Scan" })
log("Done")
`;
      await executeAmbientScript(sourceBody, stubs);
      expect(stubs.phase).toHaveBeenCalledWith('Scan');
      expect(stubs.log).toHaveBeenCalledWith('Starting scan');
      expect(stubs.agent).toHaveBeenCalledWith('scan code', { label: 'scan:basic', phase: 'Scan' });
      expect(stubs.log).toHaveBeenCalledWith('Done');
    });

    it('runs ambient script with args access', async () => {
      const stubs = makeStubs();
      stubs.args = { targetPath: '/custom/path' };
      const sourceBody = `
export const meta = {
  name: "args-test",
  description: "Args",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const path = args.targetPath
log("Target: " + path)
`;
      await executeAmbientScript(sourceBody, stubs);
      expect(stubs.log).toHaveBeenCalledWith('Target: /custom/path');
    });

    it('runs ambient script with parallel', async () => {
      const stubs = makeStubs();
      const sourceBody = `
export const meta = {
  name: "parallel-test",
  description: "Parallel",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const results = await parallel([
  () => agent("task a", { label: "a", phase: "Scan" }),
  () => agent("task b", { label: "b", phase: "Scan" }),
])
log("Parallel count: " + results.length)
`;
      await executeAmbientScript(sourceBody, stubs);
      expect(stubs.parallel).toHaveBeenCalled();
      expect(stubs.log).toHaveBeenCalledWith('Parallel count: 2');
    });

    it('runs ambient script with pipeline', async () => {
      const stubs = makeStubs();
      const sourceBody = `
export const meta = {
  name: "pipeline-test",
  description: "Pipeline",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const items = ["a", "b", "c"]
const results = await pipeline(items, (item, idx) => {
  return agent("process " + item, { label: "proc:" + item, phase: "Scan" })
})
log("Pipeline count: " + results.length)
`;
      await executeAmbientScript(sourceBody, stubs);
      expect(stubs.pipeline).toHaveBeenCalled();
      expect(stubs.log).toHaveBeenCalledWith('Pipeline count: 3');
    });

    // ── budget API in sandbox ─────────────────────────────────────────────────

    describe('budget API', () => {
      it('exposes budget.total in sandbox', async () => {
        const stubs = makeStubs();
        stubs.budget = {
          tokensUsed: 100,
          tokensRemaining: 900,
          costUsd: 0.05,
          agentCalls: 2,
          total: 1000,
          spent: () => 100,
          remaining: () => 900,
        };
        const sourceBody = `
export const meta = {
  name: "budget-total",
  description: "Budget total",
  phases: [{ title: "Scan", detail: "Scan" }]
}

log("Total: " + budget.total)
log("Spent: " + budget.spent())
log("Remaining: " + budget.remaining())
`;
        await executeAmbientScript(sourceBody, stubs);
        expect(stubs.log).toHaveBeenCalledWith('Total: 1000');
        expect(stubs.log).toHaveBeenCalledWith('Spent: 100');
        expect(stubs.log).toHaveBeenCalledWith('Remaining: 900');
      });
    });

    // ── Security: blocked globals ─────────────────────────────────────────────

    describe('security sandboxing', () => {
      it('blocks Date.now() call', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "date-now",
  description: "Date now test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const now = Date.now()
`;
        await expect(executeAmbientScript(sourceBody, stubs)).rejects.toThrow(
          'Date.now() is forbidden in sandbox',
        );
      });

      it('blocks argless new Date()', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "new-date",
  description: "New date test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const d = new Date()
`;
        await expect(executeAmbientScript(sourceBody, stubs)).rejects.toThrow(
          'Date() without arguments is forbidden in sandbox',
        );
      });

      it('allows new Date() with arguments', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "date-args",
  description: "Date with args test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const d = new Date("2025-01-01")
log("Date: " + d.toISOString().slice(0, 4))
`;
        await executeAmbientScript(sourceBody, stubs);
        expect(stubs.log).toHaveBeenCalledWith('Date: 2025');
      });

      it('blocks Math.random()', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "math-random",
  description: "Math random test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const r = Math.random()
`;
        await expect(executeAmbientScript(sourceBody, stubs)).rejects.toThrow();
      });

      it('allows Math.floor and other safe Math methods', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "math-safe",
  description: "Safe math test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const v = Math.floor(3.7)
log("Floor: " + v)
`;
        await executeAmbientScript(sourceBody, stubs);
        expect(stubs.log).toHaveBeenCalledWith('Floor: 3');
      });

      it('blocks process access', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "process-access",
  description: "Process test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const p = process.env
`;
        await expect(executeAmbientScript(sourceBody, stubs)).rejects.toThrow();
      });

      it('blocks require access', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "require-access",
  description: "Require test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const fs = require("fs")
`;
        await expect(executeAmbientScript(sourceBody, stubs)).rejects.toThrow();
      });

      it('blocks global access (resolved to undefined)', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "global-access",
  description: "Global test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const g = global
log("global is: " + g)
`;
        // global is set to undefined in sandbox, so accessing it returns undefined
        await executeAmbientScript(sourceBody, stubs);
        expect(stubs.log).toHaveBeenCalledWith('global is: undefined');
      });

      it('blocks globalThis access (resolved to undefined)', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "globalthis-access",
  description: "GlobalThis test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const g = globalThis
log("globalThis is: " + g)
`;
        // globalThis is set to undefined in sandbox
        await executeAmbientScript(sourceBody, stubs);
        expect(stubs.log).toHaveBeenCalledWith('globalThis is: undefined');
      });

      it('blocks Buffer access', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "buffer-access",
  description: "Buffer test",
  phases: [{ title: "Scan", detail: "Scan" }]
}

const b = Buffer.from("test")
`;
        await expect(executeAmbientScript(sourceBody, stubs)).rejects.toThrow();
      });
    });

    // ── Timeout enforcement ───────────────────────────────────────────────────

    describe('timeout enforcement', () => {
      it('enforces timeout on long-running scripts', async () => {
        const stubs = makeStubs();
        const sourceBody = `
export const meta = {
  name: "slow",
  description: "Slow script",
  phases: [{ title: "Scan", detail: "Scan" }]
}

await new Promise(resolve => setTimeout(resolve, 5000))
log("Should not reach here")
`;
        await expect(executeAmbientScript(sourceBody, stubs, { timeout: 200 })).rejects.toThrow();
      });
    });
  });

  // ── createSecureSandbox ─────────────────────────────────────────────────────

  describe('createSecureSandbox', () => {
    it('includes safe globals', () => {
      const sandbox = createSecureSandbox({});
      expect(sandbox.Object).toBe(Object);
      expect(sandbox.Array).toBe(Array);
      expect(sandbox.JSON).toBe(JSON);
      expect(sandbox.Promise).toBe(Promise);
      expect(sandbox.Map).toBe(Map);
      expect(sandbox.Set).toBe(Set);
    });

    it('includes DSL globals from parameter', () => {
      const phase = vi.fn();
      const sandbox = createSecureSandbox({ phase, customKey: 42 });
      expect(sandbox.phase).toBe(phase);
      expect(sandbox.customKey).toBe(42);
    });

    it('sets blocked globals to undefined', () => {
      const sandbox = createSecureSandbox({});
      expect(sandbox.require).toBeUndefined();
      expect(sandbox.process).toBeUndefined();
      expect(sandbox.global).toBeUndefined();
      expect(sandbox.globalThis).toBeUndefined();
      expect(sandbox.Buffer).toBeUndefined();
      expect(sandbox.__filename).toBeUndefined();
      expect(sandbox.__dirname).toBeUndefined();
      expect(sandbox.eval).toBeUndefined();
      expect(sandbox.Function).toBeUndefined();
    });

    it('provides console mapped to log', () => {
      const log = vi.fn();
      const sandbox = createSecureSandbox({ log });
      expect(typeof (sandbox.console as Record<string, unknown>).log).toBe('function');
      expect(typeof (sandbox.console as Record<string, unknown>).warn).toBe('function');
      expect(typeof (sandbox.console as Record<string, unknown>).error).toBe('function');
    });
  });
});
