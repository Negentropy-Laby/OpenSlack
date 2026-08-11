import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  RunStore,
  WORKFLOW_AUDIT_MAX_BYTES,
  WORKFLOW_AUDIT_RECORD_SCHEMA,
  WORKFLOW_BUDGET_SNAPSHOT_SCHEMA,
  isRunStatusTransitionAllowed,
} from '../run-store.js';
import type { RunStoreFs, RunMeta, LogEntry } from '../run-store.js';
import type { PhaseCheckpoint, ExecutionMode } from '../types.js';
import {
  WORKFLOW_CONTROL_RUN_STATES,
  WORKFLOW_CONTROL_STATE_TRANSITIONS,
  validateWorkflowControlTransition,
} from '../workflow-control-contract.js';

// ── In-memory filesystem for tests ──────────────────────────────────────────

function createMemFs(): RunStoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    async mkdir(dir: string) {
      // Just track that the directory "exists" — we check for file existence only
      files.set(dir.endsWith('/') ? dir : `${dir}/`, '');
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async appendFile(path: string, line: string) {
      const existing = files.get(path) ?? '';
      files.set(path, existing + line);
    },
    async exists(path: string) {
      // Check both exact match and as directory (trailing /)
      return files.has(path) || files.has(`${path}/`);
    },
  };
}

function makeStore(): { store: RunStore; fs: ReturnType<typeof createMemFs> } {
  const fs = createMemFs();
  const store = new RunStore({ baseDir: '/test/workflows', fs });
  return { store, fs };
}

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: 'run-001',
    workflowName: 'test-scan',
    mode: 'execute' as ExecutionMode,
    manifestHash: 'abc123',
    args: {},
    startedAt: '2026-05-28T12:00:00.000Z',
    ...overrides,
  };
}

describe('RunStore', () => {
  // ── Path helpers ────────────────────────────────────────────────────────

  describe('path helpers', () => {
    it('computes runDir correctly', () => {
      const { store } = makeStore();
      expect(store.runDir('run-001')).toBe('/test/workflows/runs/run-001');
    });

    it('computes metaPath correctly', () => {
      const { store } = makeStore();
      expect(store.metaPath('run-001')).toBe('/test/workflows/runs/run-001/meta.json');
    });

    it('computes statusPath correctly', () => {
      const { store } = makeStore();
      expect(store.statusPath('run-001')).toBe('/test/workflows/runs/run-001/status.json');
    });

    it('computes phasePath correctly', () => {
      const { store } = makeStore();
      expect(store.phasePath('run-001', 'Scan')).toBe(
        '/test/workflows/runs/run-001/phases/Scan.json',
      );
    });

    it('computes agentPath correctly', () => {
      const { store } = makeStore();
      expect(store.agentPath('run-001', 'cache-key-1')).toBe(
        '/test/workflows/runs/run-001/agents/cache-key-1.json',
      );
    });

    it('computes pipelineItemPath correctly', () => {
      const { store } = makeStore();
      expect(store.pipelineItemPath('run-001', 'Scan', 3)).toBe(
        '/test/workflows/runs/run-001/pipeline/Scan/3.json',
      );
    });

    it('computes logPath correctly', () => {
      const { store } = makeStore();
      expect(store.logPath('run-001')).toBe('/test/workflows/runs/run-001/log.jsonl');
    });

    it('computes outputPath correctly', () => {
      const { store } = makeStore();
      expect(store.outputPath('run-001')).toBe('/test/workflows/runs/run-001/output.json');
    });
  });

  // ── Initialization ──────────────────────────────────────────────────────

  describe('initRun', () => {
    it('creates directory structure and writes meta + status', async () => {
      const { store, fs } = makeStore();
      const meta = makeMeta();
      await store.initRun('run-001', meta);

      // Check meta.json
      const metaContent = fs.files.get('/test/workflows/runs/run-001/meta.json');
      expect(metaContent).toBeDefined();
      expect(JSON.parse(metaContent!)).toEqual(meta);

      // Check status.json
      const statusContent = fs.files.get('/test/workflows/runs/run-001/status.json');
      expect(statusContent).toBeDefined();
      const status = JSON.parse(statusContent!);
      expect(status.runId).toBe('run-001');
      expect(status.status).toBe('running');
      expect(status.phases).toEqual([]);

      // An explicit empty list is authoritative evidence. Missing evidence
      // must never be projected as a zero approval count by the Go shadow.
      const approvalsContent = fs.files.get('/test/workflows/runs/run-001/pending-approvals.json');
      expect(JSON.parse(approvalsContent!)).toEqual([]);
    });

    it('sets updatedAt to startedAt initially', async () => {
      const { store, fs } = makeStore();
      const meta = makeMeta({ startedAt: '2026-01-01T00:00:00.000Z' });
      await store.initRun('run-001', meta);

      const status = JSON.parse(fs.files.get('/test/workflows/runs/run-001/status.json')!);
      expect(status.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('initializes a closed cumulative budget snapshot with the original limits', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta({ budget: { tokens: 100, costUsd: 2 } }));

      await expect(store.loadBudgetSnapshot('run-001')).resolves.toMatchObject({
        schema: 'openslack.workflow_budget_snapshot.v1',
        runId: 'run-001',
        budget: { tokens: 100, costUsd: 2 },
        revision: 0,
        usage: { tokensUsed: 0, tokensRemaining: 100, costUsd: 2, agentCalls: 0 },
      });
    });
  });

  describe('cumulative budget snapshots', () => {
    it('serializes parallel monotonic updates without losing usage', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta({ budget: { tokens: 100, costUsd: 1 } }));

      const first = store.persistBudgetState('run-001', {
        tokensUsed: 25,
        tokensRemaining: 75,
        costUsd: 1,
        agentCalls: 1,
      });
      const second = store.persistBudgetState('run-001', {
        tokensUsed: 60,
        tokensRemaining: 40,
        costUsd: 1.25,
        agentCalls: 2,
      });
      await Promise.all([first, second]);

      await expect(store.loadBudgetSnapshot('run-001')).resolves.toMatchObject({
        revision: 2,
        usage: {
          tokensUsed: 60,
          tokensRemaining: 40,
          costUsd: 1.25,
          agentCalls: 2,
        },
      });
    });

    it('fails closed on regression, field drift, and non-finite usage', async () => {
      const { store, fs } = makeStore();
      await store.initRun('run-001', makeMeta({ budget: { tokens: 100, costUsd: 1 } }));
      await store.persistBudgetState('run-001', {
        tokensUsed: 20,
        tokensRemaining: 80,
        costUsd: 1,
        agentCalls: 1,
      });
      await expect(
        store.persistBudgetState('run-001', {
          tokensUsed: 10,
          tokensRemaining: 90,
          costUsd: 1,
          agentCalls: 1,
        }),
      ).rejects.toThrow('cannot move backwards');

      const path = store.budgetSnapshotPath('run-001');
      const tampered = JSON.parse(fs.files.get(path)!);
      tampered.unexpected = true;
      fs.files.set(path, JSON.stringify(tampered, null, 2));
      await expect(store.loadBudgetSnapshot('run-001')).rejects.toThrow(
        'unexpected or missing fields',
      );
    });
  });

  describe('strict local audit', () => {
    it('persists only a hash of effect details and validates the sequence', async () => {
      const { store, fs } = makeStore();
      await store.initRun('run-001', makeMeta());

      await store.appendAuditRecord('run-001', 'qualification.audit', 'secret detail');
      const records = await store.readAuditRecords('run-001');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        schema: 'openslack.workflow_audit_record.v1',
        runId: 'run-001',
        sequence: 1,
        operation: 'qualification.audit',
      });
      expect(records[0].detailHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(fs.files.get(store.auditPath('run-001'))).not.toContain('secret detail');
    });

    it('deduplicates sequential and concurrent replay while preserving distinct events', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());

      const first = await store.appendAuditRecord('run-001', 'qualification.audit', '{"a":1}');
      const replay = await store.appendAuditRecord('run-001', 'qualification.audit', '{"a":1}');
      const concurrent = await Promise.all([
        store.appendAuditRecord('run-001', 'qualification.audit', '{"occurrenceId":"2"}'),
        store.appendAuditRecord('run-001', 'qualification.audit', '{"occurrenceId":"2"}'),
      ]);
      await store.appendAuditRecord('run-001', 'qualification.other', '{"a":1}');

      expect(first.duplicate).toBe(false);
      expect(replay).toEqual({ record: first.record, duplicate: true });
      expect(concurrent.filter((result) => result.duplicate)).toHaveLength(1);
      await expect(store.readAuditRecords('run-001')).resolves.toHaveLength(3);
    });

    it('accepts an empty audit file but rejects malformed, drifting, and oversized chains', async () => {
      const { store, fs } = makeStore();
      await store.initRun('run-001', makeMeta());
      const path = store.auditPath('run-001');
      fs.files.set(path, '');
      await expect(store.readAuditRecords('run-001')).resolves.toEqual([]);

      fs.files.set(path, '{"truncated":true}');
      await expect(store.readAuditRecords('run-001')).rejects.toThrow('canonical JSONL framing');

      fs.files.set(
        path,
        `${JSON.stringify({
          runId: 'run-001',
          schema: WORKFLOW_AUDIT_RECORD_SCHEMA,
          sequence: 1,
          operation: 'qualification.audit',
          detailHash: 'a'.repeat(64),
          recordedAt: '2026-08-11T00:00:00.000Z',
        })}\n`,
      );
      await expect(store.readAuditRecords('run-001')).rejects.toThrow('not canonical JSON');

      fs.files.set(
        path,
        `${JSON.stringify({
          schema: WORKFLOW_AUDIT_RECORD_SCHEMA,
          runId: 'run-001',
          sequence: 2,
          operation: 'qualification.audit',
          detailHash: 'a'.repeat(64),
          recordedAt: '2026-08-11T00:00:00.000Z',
        })}\n`,
      );
      await expect(store.readAuditRecords('run-001')).rejects.toThrow('sequence is invalid');

      fs.files.set(path, 'x'.repeat(WORKFLOW_AUDIT_MAX_BYTES + 1));
      await expect(store.readAuditRecords('run-001')).rejects.toThrow('byte limit');
    });

    it('keeps local-only contract schemas aligned with durable TypeScript records', async () => {
      const [budgetSchema, auditSchema] = await Promise.all([
        readFile(
          resolve(
            process.cwd(),
            'packages/workflows/contracts/local-state/v1/workflow-budget-snapshot.schema.json',
          ),
          'utf8',
        ).then((raw) => JSON.parse(raw)),
        readFile(
          resolve(
            process.cwd(),
            'packages/workflows/contracts/local-state/v1/workflow-audit-record.schema.json',
          ),
          'utf8',
        ).then((raw) => JSON.parse(raw)),
      ]);
      expect(budgetSchema.$id).toBe(WORKFLOW_BUDGET_SNAPSHOT_SCHEMA);
      expect(budgetSchema.additionalProperties).toBe(false);
      expect(auditSchema.$id).toBe(WORKFLOW_AUDIT_RECORD_SCHEMA);
      expect(auditSchema.additionalProperties).toBe(false);

      const { store } = makeStore();
      await store.initRun('run-001', makeMeta({ budget: { tokens: 100, costUsd: 1 } }));
      await store.appendAuditRecord('run-001', 'qualification.audit', '{"ok":true}');
      const [snapshot, records] = await Promise.all([
        store.loadBudgetSnapshot('run-001'),
        store.readAuditRecords('run-001'),
      ]);
      const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
      expect(ajv.compile(budgetSchema)(snapshot)).toBe(true);
      expect(ajv.compile(auditSchema)(records[0])).toBe(true);
    });
  });

  // ── Status management ───────────────────────────────────────────────────

  describe('loadStatus', () => {
    it('returns null for non-existent run', async () => {
      const { store } = makeStore();
      const status = await store.loadStatus('nonexistent');
      expect(status).toBeNull();
    });

    it('returns status after init', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const status = await store.loadStatus('run-001');
      expect(status).not.toBeNull();
      expect(status!.status).toBe('running');
    });
  });

  describe('transitionStatus', () => {
    it('matches every frozen contract edge and transitions from running to completed', async () => {
      for (const from of WORKFLOW_CONTROL_RUN_STATES) {
        for (const to of WORKFLOW_CONTROL_RUN_STATES) {
          const contractAllows = (
            WORKFLOW_CONTROL_STATE_TRANSITIONS[from] as readonly string[]
          ).includes(to);
          expect(
            isRunStatusTransitionAllowed(from, to),
            `RunStore parity for ${from} -> ${to}`,
          ).toBe(contractAllows);
          if (contractAllows) {
            expect(() => validateWorkflowControlTransition(from, to)).not.toThrow();
          } else {
            expect(() => validateWorkflowControlTransition(from, to)).toThrowError(
              expect.objectContaining({ code: 'WORKFLOW_CONTROL_INVALID_TRANSITION' }),
            );
          }
        }
      }

      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'completed');
      const status = await store.loadStatus('run-001');
      expect(status!.status).toBe('completed');
    });

    it('transitions from running to paused', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'paused');
      const status = await store.loadStatus('run-001');
      expect(status!.status).toBe('paused');
    });

    it('transitions from running to failed', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'failed');
      const status = await store.loadStatus('run-001');
      expect(status!.status).toBe('failed');
    });

    it('transitions from paused to running', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'paused');
      await store.transitionStatus('run-001', 'running');
      const status = await store.loadStatus('run-001');
      expect(status!.status).toBe('running');
    });

    it('rejects invalid transition: completed to running', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'completed');
      await expect(store.transitionStatus('run-001', 'running')).rejects.toThrow(
        'Invalid status transition',
      );
    });

    it('rejects invalid transition: failed to paused', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'failed');
      await expect(store.transitionStatus('run-001', 'paused')).rejects.toThrow(
        'Invalid status transition',
      );
    });

    it('rejects transition for non-existent run', async () => {
      const { store } = makeStore();
      await expect(store.transitionStatus('nope', 'completed')).rejects.toThrow('not found');
    });

    it('updates updatedAt on transition', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta({ startedAt: '2026-01-01T00:00:00.000Z' }));
      await store.transitionStatus('run-001', 'completed');
      const status = await store.loadStatus('run-001');
      // updatedAt should have changed from the initial startedAt
      expect(status!.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });
  });

  // ── Phase checkpoints ───────────────────────────────────────────────────

  describe('savePhaseCheckpoint / loadPhaseCheckpoint', () => {
    it('saves and loads a phase checkpoint', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const cp: PhaseCheckpoint = {
        phase: 'Scan',
        timestamp: '2026-05-28T12:00:01.000Z',
        status: 'completed',
      };
      await store.savePhaseCheckpoint('run-001', cp);

      const loaded = await store.loadPhaseCheckpoint('run-001', 'Scan');
      expect(loaded).toEqual(cp);
    });

    it('returns null for non-existent phase', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const loaded = await store.loadPhaseCheckpoint('run-001', 'NonExistent');
      expect(loaded).toBeNull();
    });

    it('updates phases array in status.json', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const cp: PhaseCheckpoint = {
        phase: 'Scan',
        timestamp: '2026-05-28T12:00:01.000Z',
        status: 'completed',
      };
      await store.savePhaseCheckpoint('run-001', cp);

      const status = await store.loadStatus('run-001');
      expect(status!.phases).toHaveLength(1);
      expect(status!.phases[0].phase).toBe('Scan');
    });

    it('replaces existing phase in status.phases', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());

      const cp1: PhaseCheckpoint = {
        phase: 'Scan',
        timestamp: '2026-05-28T12:00:01.000Z',
        status: 'completed',
      };
      await store.savePhaseCheckpoint('run-001', cp1);

      const cp2: PhaseCheckpoint = {
        phase: 'Scan',
        timestamp: '2026-05-28T12:00:02.000Z',
        status: 'completed',
        result: { found: 5 },
      };
      await store.savePhaseCheckpoint('run-001', cp2);

      const status = await store.loadStatus('run-001');
      expect(status!.phases).toHaveLength(1);
      expect(status!.phases[0].result).toEqual({ found: 5 });
    });
  });

  // ── Agent result cache ──────────────────────────────────────────────────

  describe('saveAgentResult / loadAgentResult', () => {
    it('saves and loads an agent result', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const result = { data: 'test-result', tokenUsage: 42 };
      await store.saveAgentResult('run-001', 'key1', result);

      const loaded = await store.loadAgentResult('run-001', 'key1');
      expect(loaded).toEqual(result);
    });

    it('returns null for non-existent cache key', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const loaded = await store.loadAgentResult('run-001', 'missing');
      expect(loaded).toBeNull();
    });
  });

  // ── Pipeline item cache ─────────────────────────────────────────────────

  describe('savePipelineItem / loadPipelineItem', () => {
    it('saves and loads a pipeline item', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.savePipelineItem('run-001', 'Scan', 0, { item: 'result' });

      const loaded = await store.loadPipelineItem('run-001', 'Scan', 0);
      expect(loaded).toEqual({ item: 'result' });
    });

    it('returns null for non-existent pipeline item', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const loaded = await store.loadPipelineItem('run-001', 'Scan', 99);
      expect(loaded).toBeNull();
    });
  });

  // ── Logging ─────────────────────────────────────────────────────────────

  describe('appendLog / readLog', () => {
    it('appends and reads log entries', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const entry: LogEntry = {
        ts: '2026-05-28T12:00:00.000Z',
        phase: 'Scan',
        message: 'Starting scan',
        runId: 'run-001',
      };
      await store.appendLog('run-001', entry);

      const logs = await store.readLog('run-001');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual(entry);
    });

    it('returns empty array for run with no logs', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const logs = await store.readLog('run-001');
      expect(logs).toEqual([]);
    });

    it('appends multiple entries in order', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());

      await store.appendLog('run-001', {
        ts: '2026-05-28T12:00:00.000Z',
        message: 'first',
        runId: 'run-001',
      });
      await store.appendLog('run-001', {
        ts: '2026-05-28T12:00:01.000Z',
        message: 'second',
        runId: 'run-001',
      });

      const logs = await store.readLog('run-001');
      expect(logs).toHaveLength(2);
      expect(logs[0].message).toBe('first');
      expect(logs[1].message).toBe('second');
    });
  });

  // ── Output ──────────────────────────────────────────────────────────────

  describe('saveOutput / loadOutput', () => {
    it('saves and loads final output', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const output = { status: 'complete', findings: 3 };
      await store.saveOutput('run-001', output);

      const loaded = await store.loadOutput('run-001');
      expect(loaded).toEqual(output);
    });

    it('returns null when no output saved', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      const loaded = await store.loadOutput('run-001');
      expect(loaded).toBeNull();
    });
  });

  // ── Meta ────────────────────────────────────────────────────────────────

  describe('loadMeta', () => {
    it('returns null for non-existent run', async () => {
      const { store } = makeStore();
      const meta = await store.loadMeta('nope');
      expect(meta).toBeNull();
    });

    it('returns meta after init', async () => {
      const { store } = makeStore();
      const input = makeMeta();
      await store.initRun('run-001', input);
      const meta = await store.loadMeta('run-001');
      expect(meta).toEqual(input);
    });
  });

  // ── runExists ───────────────────────────────────────────────────────────

  describe('runExists', () => {
    it('returns false for non-existent run', async () => {
      const { store } = makeStore();
      expect(await store.runExists('nope')).toBe(false);
    });

    it('returns true after init', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      expect(await store.runExists('run-001')).toBe(true);
    });
  });

  // ── getRunStatus ────────────────────────────────────────────────────────

  describe('getRunStatus', () => {
    it('returns null for non-existent run', async () => {
      const { store } = makeStore();
      const status = await store.getRunStatus('nope');
      expect(status).toBeNull();
    });

    it('returns full RunStatus for initialized run', async () => {
      const { store } = makeStore();
      const meta = makeMeta();
      await store.initRun('run-001', meta);

      const status = await store.getRunStatus('run-001');
      expect(status).not.toBeNull();
      expect(status!.runId).toBe('run-001');
      expect(status!.workflowName).toBe('test-scan');
      expect(status!.mode).toBe('execute');
      expect(status!.status).toBe('running');
      expect(status!.startedAt).toBe(meta.startedAt);
      expect(status!.args).toEqual({});
    });
  });

  // ── setCurrentPhase ────────────────────────────────────────────────────

  describe('setCurrentPhase', () => {
    it('updates the currentPhase in status', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.setCurrentPhase('run-001', 'Verify');

      const status = await store.loadStatus('run-001');
      expect(status!.currentPhase).toBe('Verify');
    });
  });

  // ── Pending Approvals ──────────────────────────────────────────────────

  describe('savePendingApproval / loadPendingApprovals / resolvePendingApproval', () => {
    it('saves and loads pending approvals', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());

      await store.savePendingApproval('run-001', {
        operation: 'openslack.task.createIssue',
        detail: 'Create issue',
        timestamp: '2026-05-28T12:00:00.000Z',
      });

      const approvals = await store.loadPendingApprovals('run-001');
      expect(approvals).toHaveLength(1);
      expect(approvals[0].operation).toBe('openslack.task.createIssue');
      expect(approvals[0].status).toBe('pending');
      expect(approvals[0].id).toBeDefined();
    });

    it('resolves a pending approval', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());

      await store.savePendingApproval('run-001', {
        operation: 'openslack.task.createIssue',
        detail: 'Create issue',
        timestamp: '2026-05-28T12:00:00.000Z',
      });

      const approvals = await store.loadPendingApprovals('run-001');
      await store.resolvePendingApproval('run-001', approvals[0].id, 'approved');

      const resolved = await store.loadPendingApprovals('run-001');
      expect(resolved[0].status).toBe('approved');
    });

    it('throws when resolving non-existent approval', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());

      await expect(
        store.resolvePendingApproval('run-001', 'nonexistent', 'approved'),
      ).rejects.toThrow('Approval nonexistent not found');
    });
  });

  // ── Pause/Resume State Machine ─────────────────────────────────────────

  describe('pause/resume state machine', () => {
    it('transitions running → paused_waiting_approval → resuming → running', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());

      await store.transitionStatus('run-001', 'paused_waiting_approval');
      let status = await store.loadStatus('run-001');
      expect(status!.status).toBe('paused_waiting_approval');

      await store.transitionStatus('run-001', 'resuming');
      status = await store.loadStatus('run-001');
      expect(status!.status).toBe('resuming');

      await store.transitionStatus('run-001', 'running');
      status = await store.loadStatus('run-001');
      expect(status!.status).toBe('running');
    });

    it('transitions paused_waiting_approval → cancelled', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'paused_waiting_approval');

      await store.transitionStatus('run-001', 'cancelled');
      const status = await store.loadStatus('run-001');
      expect(status!.status).toBe('cancelled');
    });

    it('rejects invalid transition from paused_waiting_approval to completed', async () => {
      const { store } = makeStore();
      await store.initRun('run-001', makeMeta());
      await store.transitionStatus('run-001', 'paused_waiting_approval');

      await expect(store.transitionStatus('run-001', 'completed')).rejects.toThrow(
        'Invalid status transition',
      );
    });
  });

  // ── listRunsByStatus ───────────────────────────────────────────────────

  describe('listRunsByStatus', () => {
    it('lists runs with a specific status', async () => {
      const { store, fs } = makeStore();
      await store.initRun('run-001', makeMeta({ runId: 'run-001', workflowName: 'wf-a' }));
      await store.initRun('run-002', makeMeta({ runId: 'run-002', workflowName: 'wf-b' }));
      await store.transitionStatus('run-001', 'paused_waiting_approval');

      // Create index file for listing
      fs.writeFile('/test/workflows/runs/.index', 'run-001\nrun-002\n');

      const paused = await store.listRunsByStatus('paused_waiting_approval');
      expect(paused).toHaveLength(1);
      expect(paused[0].runId).toBe('run-001');
      expect(paused[0].workflowName).toBe('wf-a');

      const running = await store.listRunsByStatus('running');
      expect(running).toHaveLength(1);
      expect(running[0].runId).toBe('run-002');
    });

    it('returns empty array when no runs match', async () => {
      const { store, fs } = makeStore();
      fs.writeFile('/test/workflows/runs/.index', '');

      const result = await store.listRunsByStatus('paused_waiting_approval');
      expect(result).toEqual([]);
    });
  });
});
