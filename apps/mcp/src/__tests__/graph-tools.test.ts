import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRAPH_SNAPSHOT_SCHEMA,
  LocalGraphStore,
  deriveGraphEdgeId,
  deriveGraphNodeId,
  sealGraphSnapshot,
  type GraphNode,
  type GraphReadMirrorPort,
  type GraphSnapshot,
} from '@openslack/organization-graph';
import { OPENSLACK_READ_TOOL_NAMES, validateOpenSlackMcpResultV2 } from '@openslack/qoder-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalDemoResetPort,
  createOpenSlackMcpContext,
  type OperatorApplicationContextPort,
} from '../context.js';
import { OpenSlackMcpCore } from '../core.js';

const roots: string[] = [];
const now = '2026-07-27T03:00:00.000Z';
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'openslack-mcp-graph-'));
  roots.push(value);
  return value;
}

function operator(): OperatorApplicationContextPort {
  return Object.freeze({}) as unknown as OperatorApplicationContextPort;
}

function addLockedScenarioPack(workspaceRoot: string, scenarioId: string): void {
  const scenarioRoot = join(workspaceRoot, 'scenarios');
  const pack = join(scenarioRoot, scenarioId);
  cpSync(join(repositoryRoot, 'scenarios', 'software-delivery'), pack, { recursive: true });
  if (scenarioId === 'software-delivery') return;

  const manifestPath = join(pack, 'scenario.yaml');
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, 'utf8').replace('id: software-delivery', `id: ${scenarioId}`),
    'utf8',
  );
  const lockPath = join(pack, 'scenario.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    scenarioId: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  lock.scenarioId = scenarioId;
  for (const entry of lock.files) {
    const bytes = readFileSync(join(pack, ...entry.path.split('/')));
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

function node(
  scenarioInstanceId: string,
  objectId: string,
  generatedAt: string,
  type = 'core.work_item',
): GraphNode {
  const authorityRef = {
    provider: 'github' as const,
    objectType: 'issue',
    objectId,
    version: `v-${objectId}`,
    observedAt: generatedAt,
  };
  return {
    id: deriveGraphNodeId({ scenarioInstanceId, type, authorityRef }),
    type,
    scenarioDefinitionId: 'software-delivery',
    scenarioInstanceId,
    title: `Work ${objectId}`,
    status: 'open',
    authorityRef,
    owners: [{ id: 'owner-1', kind: 'human' }],
    properties: { rank: objectId },
    sourceEventIds: [`event-${objectId}`],
    evidenceRefs: [`event:${objectId}`],
    projectorVersion: 'openslack.software_delivery.v1',
    validFrom: generatedAt,
  };
}

function snapshot(generatedAt = now): GraphSnapshot {
  const scenarioInstanceId = 'scenario-graph-1';
  const first = node(scenarioInstanceId, '1', generatedAt);
  const second = node(scenarioInstanceId, '2', generatedAt, 'reviewable_deliverable');
  const edgeType = 'produces';
  return sealGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor: 'cursor-1',
    scenarioInstanceId,
    generatedAt,
    projectorVersion: 'openslack.software_delivery.v1',
    nodes: [first, second],
    edges: [
      {
        id: deriveGraphEdgeId({
          scenarioInstanceId,
          type: edgeType,
          from: first.id,
          to: second.id,
        }),
        type: edgeType,
        from: first.id,
        to: second.id,
        scenarioInstanceId,
        sourceEventIds: ['event-edge'],
        evidenceRefs: ['event:edge'],
        projectorVersion: 'openslack.software_delivery.v1',
        validFrom: generatedAt,
      },
    ],
    completeness: {
      sourcesRequested: ['github'],
      sourcesObserved: ['github'],
      missingSources: [],
      warnings: [],
    },
  });
}

async function coreWithSnapshot(
  workspaceRoot: string,
  graphSnapshot: GraphSnapshot,
  graphMaxAgeMs = 24 * 60 * 60 * 1_000,
  graphReadMirror?: GraphReadMirrorPort,
): Promise<OpenSlackMcpCore> {
  await new LocalGraphStore(join(workspaceRoot, '.openslack.local', 'graph')).publishSnapshot(
    graphSnapshot,
    { expectedCursor: null },
  );
  return new OpenSlackMcpCore(
    createOpenSlackMcpContext({
      workspaceRoot,
      operator: operator(),
      clock: () => new Date(now),
      correlationIdFactory: (() => {
        let id = 0;
        return () => `mcp:graph-${++id}`;
      })(),
      graphMaxAgeMs,
      ...(graphReadMirror === undefined ? {} : { graphReadMirror }),
    }),
  );
}

describe('default graph read adapters', () => {
  it('lists only exact-byte locked definitions accepted by the sealed catalog', async () => {
    const workspaceRoot = root();
    const scenarioRoot = join(workspaceRoot, 'scenarios');
    mkdirSync(scenarioRoot, { recursive: true });
    cpSync(
      join(repositoryRoot, 'scenarios', 'software-delivery'),
      join(scenarioRoot, 'software-delivery'),
      { recursive: true },
    );
    cpSync(
      join(repositoryRoot, 'scenarios', 'contract-to-delivery-lite'),
      join(scenarioRoot, 'contract-to-delivery-lite'),
      { recursive: true },
    );
    const core = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        clock: () => new Date(now),
        correlationIdFactory: () => 'mcp:scenario-list',
      }),
    );
    const result = await core.callTool('openslack_list_scenarios', {});
    expect(result.structuredContent).toMatchObject({
      status: 'completed',
      authority: {
        mode: 'projection',
        sources: ['openslack.locked_scenario_pack'],
      },
      data: {
        scenarios: [
          {
            id: 'contract-to-delivery-lite',
            version: '1.0.0',
            definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          {
            id: 'software-delivery',
            version: '1.0.0',
            definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        ],
        blockedCounts: [],
      },
    });
  });

  it('discovers once per context and observes new Packs only after context recreation', async () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'scenarios'), { recursive: true });
    addLockedScenarioPack(workspaceRoot, 'software-delivery');
    const firstCore = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        clock: () => new Date(now),
        correlationIdFactory: () => 'mcp:single-scan',
      }),
    );

    const first = await firstCore.callTool('openslack_list_scenarios', {});
    expect(
      (first.structuredContent.data as { scenarios: Array<{ id: string }> }).scenarios.map(
        (scenario) => scenario.id,
      ),
    ).toEqual(['software-delivery']);

    addLockedScenarioPack(workspaceRoot, 'second-pack');
    const cached = await firstCore.callTool('openslack_list_scenarios', {});
    expect(
      (cached.structuredContent.data as { scenarios: Array<{ id: string }> }).scenarios.map(
        (scenario) => scenario.id,
      ),
    ).toEqual(['software-delivery']);

    const restartedCore = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        clock: () => new Date(now),
        correlationIdFactory: () => 'mcp:after-restart',
      }),
    );
    const restarted = await restartedCore.callTool('openslack_list_scenarios', {});
    expect(
      (restarted.structuredContent.data as { scenarios: Array<{ id: string }> }).scenarios.map(
        (scenario) => scenario.id,
      ),
    ).toEqual(['second-pack', 'software-delivery']);
  });

  it('projects only bounded blocked-code counts and keeps accepted Packs available', async () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'scenarios'), { recursive: true });
    addLockedScenarioPack(workspaceRoot, 'software-delivery');
    mkdirSync(join(workspaceRoot, 'scenarios', 'Invalid_ID'));
    mkdirSync(join(workspaceRoot, 'scenarios', 'broken-pack'));
    writeFileSync(join(workspaceRoot, 'scenarios', 'ordinary-file'), 'not a pack\n', 'utf8');
    const core = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        clock: () => new Date(now),
        correlationIdFactory: () => 'mcp:blocked-counts',
      }),
    );

    const result = await core.callTool('openslack_list_scenarios', {});
    expect(result.structuredContent).toMatchObject({
      status: 'completed',
      data: {
        scenarios: [{ id: 'software-delivery' }],
        blockedCounts: [
          { code: 'SCENARIO_PACK_FILE_SET_MISMATCH', count: 1 },
          { code: 'SCENARIO_PACK_FILE_UNSAFE', count: 1 },
          { code: 'SCENARIO_PACK_SOURCE_INVALID', count: 1 },
        ],
      },
    });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toContain(workspaceRoot);
    expect(serialized).not.toContain('Invalid_ID');
    expect(serialized).not.toContain('ordinary-file');
  });

  it('returns SOURCE_EVIDENCE_UNAVAILABLE when discovery accepts no Pack', async () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'scenarios'), { recursive: true });
    const core = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        clock: () => new Date(now),
        correlationIdFactory: () => 'mcp:no-scenarios',
      }),
    );

    const result = await core.callTool('openslack_list_scenarios', {});
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      governance: { blocker: 'SOURCE_EVIDENCE_UNAVAILABLE' },
    });
  });

  it('returns an explicit blocker when current graph evidence is absent', async () => {
    const graphReadMirror: GraphReadMirrorPort = {
      observeQuery: vi.fn(),
      observeExplain: vi.fn(),
    };
    const core = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot: root(),
        operator: operator(),
        clock: () => new Date(now),
        correlationIdFactory: () => 'mcp:absent',
        graphReadMirror,
      }),
    );
    const result = await core.callTool('openslack_query_graph', {
      scenarioInstanceId: 'scenario-graph-1',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      schema: 'openslack.mcp_result.v2',
      status: 'blocked',
      governance: { blocker: 'SOURCE_EVIDENCE_UNAVAILABLE' },
    });
    expect(graphReadMirror.observeQuery).not.toHaveBeenCalled();
    expect(graphReadMirror.observeExplain).not.toHaveBeenCalled();
  });

  it('blocks stale evidence without creating authority state', async () => {
    const workspaceRoot = root();
    const stale = snapshot('2026-07-25T00:00:00.000Z');
    const graphReadMirror: GraphReadMirrorPort = {
      observeQuery: vi.fn(),
      observeExplain: vi.fn(),
    };
    const core = await coreWithSnapshot(workspaceRoot, stale, 60 * 60 * 1_000, graphReadMirror);
    const result = await core.callTool('openslack_query_graph', {
      scenarioInstanceId: stale.scenarioInstanceId,
    });
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      governance: { blocker: 'SOURCE_EVIDENCE_STALE' },
    });
    expect(graphReadMirror.observeQuery).not.toHaveBeenCalled();
    expect(graphReadMirror.observeExplain).not.toHaveBeenCalled();
  });

  it('enforces truncation, query-bound cursors, depth, and the 512 KiB wire bound', async () => {
    const workspaceRoot = root();
    const current = snapshot();
    const core = await coreWithSnapshot(workspaceRoot, current);
    const first = await core.callTool('openslack_query_graph', {
      scenarioInstanceId: current.scenarioInstanceId,
      maxNodes: 1,
      maxEdges: 1,
      maxResponseBytes: 16 * 1_024,
      depth: 3,
      includeEvidence: true,
    });
    expect(validateOpenSlackMcpResultV2(first.structuredContent)).toBe(true);
    expect(Buffer.byteLength(first.content[0].text, 'utf8')).toBeLessThanOrEqual(512 * 1_024);
    const data = first.structuredContent.data as {
      nodes: unknown[];
      truncation: { truncated: boolean };
      nextCursor?: string;
    };
    expect(data.nodes).toHaveLength(1);
    expect(data.truncation.truncated).toBe(true);
    expect(data.nextCursor).toEqual(expect.any(String));

    const mismatch = await core.callTool('openslack_query_graph', {
      scenarioInstanceId: current.scenarioInstanceId,
      maxNodes: 1,
      maxEdges: 1,
      maxResponseBytes: 16 * 1_024,
      depth: 2,
      includeEvidence: true,
      cursor: data.nextCursor,
    });
    expect(mismatch.structuredContent).toMatchObject({
      status: 'failed',
      error: { code: 'READ_PROJECTION_FAILED' },
    });
    await expect(
      core.callTool('openslack_query_graph', {
        scenarioInstanceId: current.scenarioInstanceId,
        depth: 4,
      }),
    ).rejects.toThrow(/at most 3/);
  });

  it('explains bounded provenance from the current snapshot', async () => {
    const workspaceRoot = root();
    const current = snapshot();
    const core = await coreWithSnapshot(workspaceRoot, current);
    const target = current.nodes[0]!;
    const result = await core.callTool('openslack_explain_graph', {
      scenarioInstanceId: current.scenarioInstanceId,
      targetId: target.id,
      depth: 3,
    });
    expect(result.structuredContent).toMatchObject({
      status: 'completed',
      authority: {
        mode: 'projection',
        sources: ['openslack.organization_graph_snapshot'],
        observedAt: now,
      },
      data: {
        targetKind: 'node',
        targetId: target.id,
        snapshotCursor: current.cursor,
      },
    });
  });

  it('mirror-reads query and explain while returning only the cloned TypeScript authority', async () => {
    const workspaceRoot = root();
    const current = snapshot();
    const observeQuery = vi.fn(async (input, authority) => {
      input.scenarioInstanceId = 'malicious-mirror-scope';
      authority.nodes.splice(0);
      return {} as never;
    });
    const observeExplain = vi.fn(async (input, authority) => {
      input.targetId = 'malicious-mirror-target';
      authority.sourceEventIds.splice(0);
      return {} as never;
    });
    const core = await coreWithSnapshot(workspaceRoot, current, undefined, {
      observeQuery,
      observeExplain,
    });
    const queryInput = {
      scenarioInstanceId: current.scenarioInstanceId,
      rootNodeIds: [current.nodes[0]!.id],
      depth: 1,
    };
    const query = await core.callTool('openslack_query_graph', queryInput);
    const explainInput = {
      scenarioInstanceId: current.scenarioInstanceId,
      targetId: current.nodes[0]!.id,
      depth: 3,
    };
    const explain = await core.callTool('openslack_explain_graph', explainInput);

    expect(core.listTools()).toHaveLength(12);
    expect(query.structuredContent).toMatchObject({
      status: 'completed',
      data: { scenarioInstanceId: current.scenarioInstanceId },
    });
    expect(
      (query.structuredContent.data as { nodes: Array<{ id: string }> }).nodes.map(
        (item) => item.id,
      ),
    ).toContain(current.nodes[0]!.id);
    expect(explain.structuredContent).toMatchObject({
      status: 'completed',
      data: {
        scenarioInstanceId: current.scenarioInstanceId,
        targetId: current.nodes[0]!.id,
        sourceEventIds: current.nodes[0]!.sourceEventIds,
      },
    });
    expect(observeQuery).toHaveBeenCalledOnce();
    expect(observeQuery.mock.calls[0]?.[0]).not.toBe(queryInput);
    expect(observeExplain).toHaveBeenCalledOnce();
    expect(observeExplain.mock.calls[0]?.[0]).not.toBe(explainInput);
  });

  it('keeps mirror exceptions observational for both graph read tools', async () => {
    const workspaceRoot = root();
    const current = snapshot();
    const graphReadMirror: GraphReadMirrorPort = {
      observeQuery: vi.fn(async () => {
        throw new Error('mirror query failed');
      }),
      observeExplain: vi.fn(async () => {
        throw new Error('mirror explain failed');
      }),
    };
    const core = await coreWithSnapshot(workspaceRoot, current, undefined, graphReadMirror);

    const query = await core.callTool('openslack_query_graph', {
      scenarioInstanceId: current.scenarioInstanceId,
    });
    const explain = await core.callTool('openslack_explain_graph', {
      scenarioInstanceId: current.scenarioInstanceId,
      targetId: current.nodes[0]!.id,
    });

    expect(query.structuredContent.status).toBe('completed');
    expect(explain.structuredContent.status).toBe('completed');
  });

  it('advertises an optional exact thirteenth reset tool only for an injected local port', async () => {
    const workspaceRoot = root();
    const fixtureRoot = join(workspaceRoot, '.openslack.local', 'demo', 'fixture-1');
    mkdirSync(fixtureRoot, { recursive: true });
    let resetCount = 0;
    const production = new OpenSlackMcpCore(
      createOpenSlackMcpContext({ workspaceRoot, operator: operator() }),
    );
    expect(production.listTools().map((tool) => tool.name)).toEqual(OPENSLACK_READ_TOOL_NAMES);

    const demo = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        demoMode: true,
        correlationIdFactory: () => 'mcp:demo-reset',
        demoReset: createLocalDemoResetPort({
          workspaceRoot,
          fixtureRoot,
          demoMode: true,
          reset: () => ({ resetCount: ++resetCount }),
        }),
      }),
    );
    expect(demo.listTools()).toHaveLength(13);
    expect(demo.listTools().at(-1)?.name).toBe('openslack_demo_reset');
    const result = await demo.callTool('openslack_demo_reset', {});
    expect(result.structuredContent).toMatchObject({
      schema: 'openslack.mcp_result.v2',
      status: 'completed',
      authority: { mode: 'governed_mutation', sources: ['openslack.local_demo_fixture'] },
      data: { resetCount: 1 },
    });
    expect(resetCount).toBe(1);
  });

  it('binds a frozen canonical fixture invocation and never re-reads raw demo getters', async () => {
    const workspaceRoot = root();
    const fixtureRoot = join(workspaceRoot, '.openslack.local', 'demo', 'fixture-1');
    mkdirSync(fixtureRoot, { recursive: true });
    let getterHits = 0;
    let invocationRoot = '';
    let invocationFrozen = false;
    const demoReset = createLocalDemoResetPort({
      workspaceRoot,
      fixtureRoot,
      demoMode: true,
      reset: (invocation) => {
        invocationRoot = invocation.root;
        invocationFrozen = Object.isFrozen(invocation);
        return Object.defineProperty({ reset: true }, 'generatedAt', {
          enumerable: true,
          get() {
            getterHits += 1;
            return now;
          },
        });
      },
    });
    const result = await new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        demoMode: true,
        demoReset,
      }),
    ).callTool('openslack_demo_reset', {});

    expect(result.structuredContent).toMatchObject({
      status: 'completed',
      data: { reset: true, generatedAt: '[UNSAFE_PROPERTY]' },
    });
    expect(getterHits).toBe(0);
    expect(invocationRoot).toBe(fixtureRoot);
    expect(invocationFrozen).toBe(true);
    expect(Object.isFrozen(result.structuredContent.data)).toBe(true);
  });

  it('requires explicit demo mode and a nominal factory-created existing child root', () => {
    const workspaceRoot = root();
    const demoRoot = join(workspaceRoot, '.openslack.local', 'demo');
    const fixtureRoot = join(demoRoot, 'fixture-1');
    mkdirSync(fixtureRoot, { recursive: true });
    const nominal = createLocalDemoResetPort({
      workspaceRoot,
      fixtureRoot,
      demoMode: true,
      reset: () => ({}),
    });

    expect(() =>
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        demoReset: nominal,
      }),
    ).toThrow(/demoMode=true/);
    expect(() =>
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        demoMode: true,
        demoReset: { reset: () => ({}) },
      }),
    ).toThrow(/createLocalDemoResetPort/);
    expect(() =>
      createOpenSlackMcpContext({
        workspaceRoot: root(),
        operator: operator(),
        demoMode: true,
        demoReset: nominal,
      }),
    ).toThrow(/createLocalDemoResetPort/);
    expect(() =>
      createLocalDemoResetPort({
        workspaceRoot,
        fixtureRoot: demoRoot,
        demoMode: true,
        reset: () => ({}),
      }),
    ).toThrow(/non-empty child/);
    expect(() =>
      createLocalDemoResetPort({
        workspaceRoot,
        fixtureRoot: join(demoRoot, 'missing'),
        demoMode: true,
        reset: () => ({}),
      }),
    ).toThrow();
  });

  it('aborts timed-out demo reset and returns reconciliation_required even if it finishes late', async () => {
    vi.useFakeTimers();
    try {
      const workspaceRoot = root();
      const fixtureRoot = join(workspaceRoot, '.openslack.local', 'demo', 'fixture-1');
      mkdirSync(fixtureRoot, { recursive: true });
      let observedAbort = false;
      let completedLate = false;
      const demoReset = createLocalDemoResetPort({
        workspaceRoot,
        fixtureRoot,
        demoMode: true,
        reset: ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                observedAbort = true;
              },
              { once: true },
            );
            setTimeout(() => {
              completedLate = true;
              resolve({ completedLate: true });
            }, 200);
          }),
      });
      const pending = new OpenSlackMcpCore(
        createOpenSlackMcpContext({
          workspaceRoot,
          operator: operator(),
          demoMode: true,
          demoReset,
        }),
        { timeoutMs: 100 },
      ).callTool('openslack_demo_reset', {});
      await vi.advanceTimersByTimeAsync(101);
      const result = await pending;

      expect(observedAbort).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        status: 'blocked',
        data: { outcome: 'reconciliation_required' },
        governance: { blocker: 'DEMO_RESET_RECONCILIATION_REQUIRED' },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(completedLate).toBe(true);
      expect(result.structuredContent.status).toBe('blocked');
    } finally {
      vi.useRealTimers();
    }
  });
});
