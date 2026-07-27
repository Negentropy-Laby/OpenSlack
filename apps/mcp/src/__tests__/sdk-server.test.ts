import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildBusinessOutcomeProjection } from '@openslack/collaboration';
import { OPENSLACK_READ_TOOL_NAMES, type OpenSlackReadToolName } from '@openslack/qoder-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOpenSlackMcpContext,
  type OpenSlackReadModelPorts,
  type OperatorApplicationContextPort,
} from '../context.js';
import { createOpenSlackMcpServer } from '../server.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function argsFor(name: OpenSlackReadToolName): Record<string, unknown> {
  if (name === 'openslack_get_work_room') return { roomId: 'pr:312' };
  if (name === 'openslack_get_workflow_progress') return { runId: 'RUN-1' };
  if (name === 'openslack_get_pr_readiness') return { prNumber: 312 };
  return {};
}

describe('official MCP SDK integration', () => {
  it('initializes, lists exactly nine tools, and calls every tool', async () => {
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
      expect(listed.tools).toHaveLength(9);

      for (const name of OPENSLACK_READ_TOOL_NAMES) {
        const result = await client.callTool({ name, arguments: argsFor(name) });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          schema: 'openslack.mcp_result.v1',
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
