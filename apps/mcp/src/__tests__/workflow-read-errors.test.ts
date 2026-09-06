import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkflowRunReadError,
  WORKFLOW_RUN_READ_POLICIES,
  type WorkflowRunReadCode,
} from '@openslack/workflows';
import { safeToolError } from '../errors.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenSlackMcpContext, type OperatorApplicationContextPort } from '../context.js';
import { OpenSlackMcpCore } from '../core.js';
import { validateOpenSlackMcpResultV2 } from '@openslack/qoder-adapter';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(reader?: () => Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-read-errors-'));
  roots.push(root);
  const core = new OpenSlackMcpCore(
    createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: {} as OperatorApplicationContextPort,
      ...(reader ? { readers: { workflowProgress: reader } } : {}),
    }),
  );
  return {
    root,
    call: () => core.callTool('openslack_get_workflow_progress', { runId: 'run.review' }),
  };
}

describe('workflow evidence protocol diagnostics', () => {
  it('never executes workflow reader metadata accessors or proxy traps', async () => {
    let hits = 0;
    const trap = () => {
      hits++;
      throw new Error('private getter cause');
    };
    const diagnosticArray = new Array(1);
    Object.defineProperty(diagnosticArray, '0', { enumerable: true, get: trap });
    for (const value of [
      Object.defineProperty({}, 'provenance', { enumerable: true, get: trap }),
      Object.defineProperty({}, 'readDiagnostics', { enumerable: true, get: trap }),
      new Proxy(
        {},
        {
          has: trap,
          get: (_target, key) => (key === 'then' ? undefined : trap()),
          ownKeys: trap,
          getOwnPropertyDescriptor: trap,
        },
      ),
      { readDiagnostics: new Proxy([], { get: trap, ownKeys: trap }) },
      { readDiagnostics: diagnosticArray },
    ]) {
      const result = await fixture(async () => value).call();
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'READ_PROJECTION_FAILED' } },
      });
      expect(JSON.stringify(result)).not.toContain('private getter cause');
    }
    expect(hits).toBe(0);
  });
  it('preserves typed input and reconciliation failures without exposing internal exceptions', () => {
    for (const code of [
      'WORKFLOW_RUN_PROJECTION_ID_INVALID',
      'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
    ] as const) {
      const error = safeToolError(
        new WorkflowRunReadError([{ scope: 'run', runId: 'run.test', code }]),
      );
      expect(error.safeCode).toBe(code);
      expect(error.safeStatus).toBe(code.includes('RECONCILIATION') ? 'blocked' : 'failed');
    }
    expect(safeToolError(new Error('sensitive internal detail')).message).not.toContain(
      'sensitive internal detail',
    );
  });

  it.each(Object.keys(WORKFLOW_RUN_READ_POLICIES) as WorkflowRunReadCode[])(
    'preserves actual read failure semantics for %s in v2',
    async (code) => {
      const diagnostics = [
        { scope: 'run' as const, runId: 'run.review', backend: 'go' as const, code },
      ];
      const { call } = fixture(async () => {
        throw new WorkflowRunReadError(diagnostics, { cause: new Error('private-token-and-path') });
      });
      const result = await call();
      const expected = [
        'WORKFLOW_RUN_PROJECTION_ID_INVALID',
        'WORKFLOW_RUN_EVIDENCE_IO_FAILED',
        'WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR',
      ].includes(code)
        ? 'failed'
        : 'blocked';
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: expected,
        error: { code },
        governance: { blocker: code },
        data: { readDiagnostics: diagnostics },
      });
      expect(validateOpenSlackMcpResultV2(result.structuredContent)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private-token-and-path');
    },
  );

  it('returns the same terminal error across diagnostic permutations', async () => {
    const diagnostics = [
      {
        scope: 'run' as const,
        runId: 'run.review',
        code: 'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE' as const,
      },
      {
        scope: 'run' as const,
        runId: 'run.review',
        code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED' as const,
      },
    ];
    for (const order of [diagnostics, [...diagnostics].reverse()]) {
      const { call } = fixture(async () => {
        throw new WorkflowRunReadError(order);
      });
      const result = await call();
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          status: 'blocked',
          error: { code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED' },
          data: { readDiagnostics: order },
        },
      });
    }
  });

  it('retains comparison evidence through both real DTO boundaries with blocked semantics', async () => {
    const { root, call } = fixture();
    const directory = join(
      root,
      '.openslack.local',
      'workflows',
      'go-recovery-projections',
      'runs',
      'run.review',
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'meta.json'),
      JSON.stringify({
        runId: 'run.review',
        workflowName: 'review-test',
        mode: 'execute',
        manifestHash: 'a'.repeat(64),
        args: {},
        startedAt: '2026-09-05T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(directory, 'status.json'),
      JSON.stringify({
        runId: 'run.review',
        status: 'completed',
        updatedAt: '2026-09-05T00:00:00.000Z',
        phases: [],
      }),
    );
    const result = await call();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        status: 'blocked',
        error: { code: 'WORKFLOW_RUN_UNROUTED_GO_PROJECTION' },
        data: {
          runId: 'run.review',
          status: 'completed',
          provenance: { backend: 'go', selection: 'comparison', authorityVerified: false },
          degraded: true,
          readDiagnostics: [
            {
              scope: 'run',
              runId: 'run.review',
              backend: 'go',
              code: 'WORKFLOW_RUN_UNROUTED_GO_PROJECTION',
            },
          ],
        },
      },
    });
    expect(validateOpenSlackMcpResultV2(result.structuredContent)).toBe(true);
  });

  it('does not infer comparison status from warning text and preserves normal not-found semantics', async () => {
    const { call } = fixture(async () => ({
      provenance: { backend: 'ts-local', selection: 'legacy', authorityVerified: false },
      warnings: ['comparison evidence only'],
    }));
    expect(await call()).toMatchObject({
      isError: false,
      structuredContent: { status: 'completed' },
    });
    expect(await fixture(async () => null).call()).toMatchObject({
      isError: false,
      structuredContent: { status: 'blocked', governance: { blocker: 'WORKFLOW_RUN_NOT_FOUND' } },
    });
  });
  it.each(['log.jsonl', 'agents/result.json'])(
    'retains the nested byte-limit failure for %s through the real MCP reader',
    async (name) => {
      const { root, call } = fixture();
      const directory = join(root, '.openslack.local', 'workflows', 'runs', 'run.review');
      mkdirSync(join(directory, 'agents'), { recursive: true });
      writeFileSync(
        join(directory, 'meta.json'),
        JSON.stringify({
          runId: 'run.review',
          workflowName: 'review-test',
          mode: 'execute',
          manifestHash: 'a'.repeat(64),
          args: {},
          startedAt: '2026-09-05T00:00:00.000Z',
        }),
      );
      writeFileSync(
        join(directory, 'status.json'),
        JSON.stringify({
          runId: 'run.review',
          status: 'completed',
          updatedAt: '2026-09-05T00:00:00.000Z',
          phases: [],
        }),
      );
      writeFileSync(join(directory, name), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
      expect(await call()).toMatchObject({
        isError: true,
        structuredContent: {
          status: 'blocked',
          error: { code: 'WORKFLOW_RUN_EVIDENCE_TOO_LARGE' },
          data: {
            readDiagnostics: [
              {
                scope: 'run',
                runId: 'run.review',
                backend: 'ts-local',
                code: 'WORKFLOW_RUN_EVIDENCE_TOO_LARGE',
              },
            ],
          },
        },
      });
    },
  );
});
