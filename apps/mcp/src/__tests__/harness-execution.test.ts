import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CollaborationEvent } from '@openslack/collaboration';
import { createOpenSlackMcpContext, type OperatorApplicationContextPort } from '../context.js';
import { OpenSlackMcpCore } from '../core.js';
import { readHarnessExecutionProjection } from '../harness-execution.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(runId = 'RUN-TEST') {
  const root = mkdtempSync(join(tmpdir(), 'mcp-harness-execution-'));
  roots.push(root);
  const directory = join(root, '.openslack.local/agents/runs', runId);
  mkdirSync(directory, { recursive: true });
  const state = { runId, status: 'completed', agentId: 'fixture', startedAt: new Date().toISOString(),
    tokensUsed: 0, tokensRemaining: null, toolCalls: 0, transcriptPath: join(directory, 'transcript.jsonl'), harnessExecution: {
    schema: 'openslack.harness_execution.v1', taskId: 'TASK-1', acceptance: 'verified',
    summary: 'Host verified fixture.', evidenceRefs: ['artifact:fixture'], principalHash: 'not-for-projection',
  } };
  writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
  const event: CollaborationEvent = {
    schema: 'openslack.collaboration_event.v1', id: 'EVT-HARNESS-1', timestamp: new Date().toISOString(),
    type: 'workflow.started', actor: { kind: 'agent', id: 'fixture' }, object: { kind: 'workflow', id: runId },
    source: { kind: 'openslack', ref: `run:${runId}` }, summary: 'Task admitted; acceptance pending.',
    visibility: 'workspace', redacted: true, containsSensitiveData: false,
  };
  return { root, runId, directory, state, event };
}

describe('Harness activity readback', () => {
  it('requires an already visible same-run workflow anchor and never reads arbitrary paths', () => {
    const { root, runId, event } = fixture();
    expect(readHarnessExecutionProjection(root, runId, [])).toBeUndefined();
    expect(readHarnessExecutionProjection(root, '../other', [event])).toBeUndefined();
    const projection = readHarnessExecutionProjection(root, runId, [event]);
    expect(projection).toEqual({ taskId: 'TASK-1', runId, status: 'completed', acceptance: 'verified',
      summary: 'Host verified fixture.', evidenceRefs: ['artifact:fixture'] });
    expect(projection).not.toHaveProperty('principalHash');
  });

  it('uses the canonical RunStore grammar without silently dropping a longer valid run ID', () => {
    const { root, runId, event } = fixture(`RUN-${'A'.repeat(129)}`);
    expect(readHarnessExecutionProjection(root, runId, [event])).toMatchObject({ runId, acceptance: 'verified' });
  });

  it('retains old records and orphan temp bytes without constructing a maintenance-capable store', () => {
    const { root, runId, directory, event } = fixture();
    const temporary = join(directory, 'run.json.historical.tmp');
    writeFileSync(temporary, 'preserve original bytes');
    const before = readFileSync(join(directory, 'run.json'));
    readHarnessExecutionProjection(root, runId, [event]);
    expect(readFileSync(join(directory, 'run.json'))).toEqual(before);
    expect(readFileSync(temporary, 'utf8')).toBe('preserve original bytes');
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it('cannot expose completed if canonical acceptance is not verified', () => {
    const { root, runId, directory, state, event } = fixture();
    state.harnessExecution.acceptance = 'indeterminate';
    writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
    expect(() => readHarnessExecutionProjection(root, runId, [event])).toThrow('HARNESS_RUN_BINDING_INVALID');
  });

  it('passes the optional execution projection through the actual existing MCP tool', async () => {
    const { root, runId, event } = fixture();
    const events = join(root, '.openslack.local/collaboration/events.jsonl');
    mkdirSync(join(events, '..'), { recursive: true });
    writeFileSync(events, `${JSON.stringify(event)}\n`);
    const context = createOpenSlackMcpContext({ workspaceRoot: root, operator: {} as OperatorApplicationContextPort });
    const core = new OpenSlackMcpCore(context);
    const result = await core.callTool('openslack_get_activity', { objectKind: 'workflow', objectId: runId });
    expect(result.structuredContent.data).toMatchObject({ execution: { taskId: 'TASK-1', runId, acceptance: 'verified' } });
    expect(core.listTools()).toHaveLength(12);
    expect(JSON.stringify(result)).not.toContain('not-for-projection');
    const ordinary = await core.callTool('openslack_get_activity', {});
    expect(ordinary.structuredContent.data).not.toHaveProperty('execution');
  });

  it.each(['locked', 'corrupt'] as const)('reports a visible %s run as read-unavailable without inventing business state or exposing private bytes', async reason => {
    const { root, runId, directory, event } = fixture();
    if (reason === 'locked') writeFileSync(join(directory, 'run.transaction.lock'), 'private writer bytes');
    else writeFileSync(join(directory, 'run.json'), '{broken private state');
    const before = readdirSync(directory).map(name => [name, readFileSync(join(directory, name)).toString('base64')]);
    expect(readHarnessExecutionProjection(root, runId, [])).toBeUndefined();
    const projection = readHarnessExecutionProjection(root, runId, [event]);
    expect(projection).toEqual({ runId, readStatus: 'unavailable', reason });
    expect(projection).not.toHaveProperty('status');
    expect(projection).not.toHaveProperty('acceptance');
    const events = join(root, '.openslack.local/collaboration/events.jsonl');
    mkdirSync(join(events, '..'), { recursive: true });
    writeFileSync(events, `${JSON.stringify(event)}\n`);
    const result = await new OpenSlackMcpCore(createOpenSlackMcpContext({ workspaceRoot: root,
      operator: {} as OperatorApplicationContextPort })).callTool('openslack_get_activity', { objectKind: 'workflow', objectId: runId });
    expect(result.structuredContent.data).toMatchObject({ execution: projection });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(readdirSync(directory).map(name => [name, readFileSync(join(directory, name)).toString('base64')])).toEqual(before);
  });
});
