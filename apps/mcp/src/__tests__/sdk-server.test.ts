import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildBusinessOutcomeProjection } from '@openslack/collaboration';
import {
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  LocalGraphStore,
  buildAndPublishGraphSnapshot,
} from '@openslack/organization-graph';
import { OPENSLACK_READ_TOOL_NAMES, type OpenSlackReadToolName } from '@openslack/qoder-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOpenSlackMcpContext,
  type OpenSlackReadModelPorts,
  type OperatorApplicationContextPort,
} from '../context.js';
import { createOpenSlackMcpServer } from '../server.js';

const roots: string[] = [];
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function argsFor(name: OpenSlackReadToolName): Record<string, unknown> {
  if (name === 'openslack_get_work_room') return { roomId: 'pr:312' };
  if (name === 'openslack_get_workflow_progress') return { runId: 'RUN-1' };
  if (name === 'openslack_get_pr_readiness') return { prNumber: 312 };
  if (name === 'openslack_query_graph') return { scenarioInstanceId: 'scenario-1' };
  if (name === 'openslack_explain_graph')
    return { scenarioInstanceId: 'scenario-1', targetId: 'node-1' };
  return {};
}

describe('official MCP SDK integration', () => {
  it('reads and explains the composite story through three bounded stock-profile windows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-mcp-sdk-graph-'));
    roots.push(root);
    const store = new LocalGraphStore(join(root, '.openslack.local', 'graph'));
    const published = await buildAndPublishGraphSnapshot({
      scenarioId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
      sourceBytes: readFileSync(
        join(
          repositoryRoot,
          'packages',
          'organization-graph',
          'src',
          'fixtures',
          'contract-to-delivery-source.json',
        ),
      ),
      store,
      expectedCursor: null,
      expectedScenarioInstanceId: 'scenario-contract-delivery-001',
    });
    const readback = await store.readCurrentSnapshot(published.scenarioInstanceId);
    expect(readback.integrityHash).toBe(published.snapshotIntegrityHash);

    const context = createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: Object.freeze({}) as unknown as OperatorApplicationContextPort,
      clock: () => new Date('2026-07-27T02:30:00.000Z'),
      correlationIdFactory: () => 'qw2-sdk-graph-fixture',
    });
    const server = createOpenSlackMcpServer(context);
    const client = new Client({ name: 'qw2-sdk-graph-fixture', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.sdkServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(OPENSLACK_READ_TOOL_NAMES);
      expect(listed.tools).toHaveLength(12);

      const rootsByType = ['business.customer', 'business.milestone', 'business.acceptance'].map(
        (type) => readback.nodes.find((node) => node.type === type)?.id,
      );
      expect(rootsByType.every((value) => typeof value === 'string')).toBe(true);
      const observedEdgeTypes = new Set<string>();
      for (const rootNodeId of rootsByType as string[]) {
        const result = await client.callTool({
          name: 'openslack_query_graph',
          arguments: {
            scenarioInstanceId: published.scenarioInstanceId,
            rootNodeIds: [rootNodeId],
            direction: 'both',
            depth: 3,
            maxNodes: 200,
            maxEdges: 500,
            includeEvidence: true,
          },
        });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          schema: 'openslack.mcp_result.v2',
          status: 'completed',
          authority: {
            mode: 'projection',
            sources: ['openslack.organization_graph_snapshot'],
          },
          data: {
            scenarioInstanceId: published.scenarioInstanceId,
            snapshotCursor: published.cursor,
            truncation: { truncated: false },
          },
        });
        const data = (
          result.structuredContent as {
            data: { edges: Array<{ type: string }> };
          }
        ).data;
        for (const edge of data.edges) observedEdgeTypes.add(edge.type);
      }
      for (const edgeType of [
        'accepted_as',
        'assigned_to',
        'approved_by',
        'closes_work_item',
        'contract_delivered_by',
        'contracts_for',
        'delivers_project',
        'executed_by',
        'milestone_contains',
        'produces',
        'realizes',
        'scoped_to',
        'substantiated_by',
        'tracks_milestone',
        'transitioned_by',
      ]) {
        expect(observedEdgeTypes).toContain(edgeType);
      }

      const compositeEdges = readback.edges.filter(
        (edge) => edge.projectorVersion === 'openslack.contract_to_delivery.v1',
      );
      expect(compositeEdges).toHaveLength(12);
      for (const edge of compositeEdges) {
        const explanation = await client.callTool({
          name: 'openslack_explain_graph',
          arguments: {
            scenarioInstanceId: published.scenarioInstanceId,
            targetId: edge.id,
            depth: 3,
          },
        });
        expect(explanation.isError).toBe(false);
        expect(explanation.structuredContent).toMatchObject({
          status: 'completed',
          authority: {
            mode: 'projection',
            sources: ['openslack.organization_graph_snapshot'],
          },
          data: {
            targetKind: 'edge',
            targetId: edge.id,
            snapshotCursor: published.cursor,
            evidenceRefs: expect.arrayContaining(edge.evidenceRefs),
          },
        });
      }
      expect((await store.readCurrentSnapshot(published.scenarioInstanceId)).integrityHash).toBe(
        published.snapshotIntegrityHash,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('initializes, lists exactly twelve tools, and calls every tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-mcp-sdk-'));
    roots.push(root);
    const projection = async () => ({ evidenceRef: 'fixture:read-only' });
    const readers: OpenSlackReadModelPorts = {
      executiveOverview: projection,
      workItems: projection,
      workRoom: projection,
      activity: projection,
      workflowProgress: projection,
      prReadiness: projection,
      pendingApprovals: projection,
      businessOutcomes: projection,
      notificationStatus: projection,
      scenarios: projection,
      graphQuery: projection,
      graphExplain: projection,
    };
    const context = createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: Object.freeze({}) as unknown as OperatorApplicationContextPort,
      readers,
    });
    const server = createOpenSlackMcpServer(context);
    const client = new Client({ name: 'qw2-sdk-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.sdkServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(OPENSLACK_READ_TOOL_NAMES);
      expect(listed.tools).toHaveLength(12);

      for (const name of OPENSLACK_READ_TOOL_NAMES) {
        const result = await client.callTool({ name, arguments: argsFor(name) });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          schema: 'openslack.mcp_result.v2',
          status: 'completed',
        });
        const content = result.content as Array<{ type: string; text?: string }>;
        expect(content[0].type).toBe('text');
        expect(JSON.parse(String(content[0].text))).toEqual(result.structuredContent);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves versioned configured-estimate evidence across the official MCP transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-mcp-sdk-'));
    roots.push(root);
    const assumptionEvidence = 'repo:examples/assumptions.yaml#annualValue@v1';
    const projection = buildBusinessOutcomeProjection({
      generatedAt: '2026-07-26T12:00:00.000Z',
      period: {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-26T12:00:00.000Z',
      },
      events: [],
      evidenceRefs: ['query:collaboration-events:2026-07-01/2026-07-26'],
      estimates: {
        estimatedManualHours: {
          value: 120,
          unit: 'hours',
          assumptionRef: 'repo:examples/assumptions.yaml#annualValue',
          assumptionVersion: 'v1',
        },
      },
    });
    const fallback = async () => ({ evidenceRef: 'fixture:read-only' });
    const context = createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: Object.freeze({}) as unknown as OperatorApplicationContextPort,
      readers: {
        executiveOverview: fallback,
        workItems: fallback,
        workRoom: fallback,
        activity: fallback,
        workflowProgress: fallback,
        prReadiness: fallback,
        pendingApprovals: fallback,
        businessOutcomes: async () => projection,
        notificationStatus: fallback,
        scenarios: fallback,
        graphQuery: fallback,
        graphExplain: fallback,
      },
    });
    const server = createOpenSlackMcpServer(context);
    const client = new Client({ name: 'qw2-outcomes-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.sdkServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'openslack_get_business_outcomes',
        arguments: {},
      });
      const structured = result.structuredContent as {
        data: {
          economics: {
            estimatedManualHours: {
              value: number;
              basis: string;
              evidenceRefs: string[];
            };
          };
          evidenceRefs: string[];
        };
        evidenceRefs: string[];
      };

      expect(structured.data.economics.estimatedManualHours).toMatchObject({
        value: 120,
        basis: 'configured_estimate',
        evidenceRefs: [assumptionEvidence],
      });
      expect(structured.data.evidenceRefs).toContain(assumptionEvidence);
      expect(structured.evidenceRefs).toContain(assumptionEvidence);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(String(content[0].text))).toEqual(structured);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
