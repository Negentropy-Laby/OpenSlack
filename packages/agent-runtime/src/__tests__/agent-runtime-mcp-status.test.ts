import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendTranscriptEvent,
  createRunStore,
  getAgentRuntimeMcpStatus,
} from '../index.js';
import { buildPermissionProfile } from '../permissions.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-status-test-'));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe('getAgentRuntimeMcpStatus', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('fails when an agent requires a missing MCP server', () => {
    const registryDir = join(root, '.openslack', 'agents', 'registry');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'aby.yaml'),
      [
        'schema: openslack.agent_registry.v1',
        'agent_id: anthropic_architect_aby',
        'vendor:',
        '  provider: aby',
        '  runtime: aby_assistant',
        'mcp:',
        '  required:',
        '    - github',
      ].join('\n'),
      'utf-8',
    );

    const report = getAgentRuntimeMcpStatus({
      rootDir: root,
      agentId: 'anthropic_architect_aby',
    });

    expect(report.status).toBe('FAIL');
    expect(report.missingRequiredServers).toEqual(['github']);
    expect(report.remediations.join('\n')).toContain('github');
  });

  it('normalizes MCP bridge separators from transcript tool evidence', () => {
    const store = createRunStore(root);
    const run = store.createRun({
      runId: 'RUN-20260603-MCPTEST',
      agentId: 'anthropic_architect_aby',
      prompt: 'mcp test',
      resolvedConfig: {
        agentId: 'anthropic_architect_aby',
        source: 'test',
        runtime: 'aby_assistant',
        requiredMcpServers: ['github'],
        mcpServers: ['github'],
      },
      permissionProfile: buildPermissionProfile({
        agentId: 'anthropic_architect_aby',
        source: 'test',
        permissionMode: 'plan',
      }),
    });
    appendTranscriptEvent(
      run.runId,
      {
        timestamp: new Date().toISOString(),
        type: 'start',
        data: {
          agentId: 'anthropic_architect_aby',
          runtime: 'aby_assistant',
          requiredMcpServers: ['github'],
          mcpServers: ['github'],
        },
      },
      root,
    );
    appendTranscriptEvent(
      run.runId,
      {
        timestamp: new Date().toISOString(),
        type: 'tool_call',
        data: { toolName: 'mcp__GitHub__Search', input: {} },
      },
      root,
    );

    const report = getAgentRuntimeMcpStatus({ rootDir: root, runId: run.runId });

    expect(report.status).toBe('PASS');
    expect(report.toolEvidence[0].normalizedToolName).toBe('mcp.github.search');
    expect(report.invalidTools).toEqual([]);
  });

  it('reports invalid MCP tool namespaces for unavailable servers', () => {
    const store = createRunStore(root);
    const run = store.createRun({
      runId: 'RUN-20260603-MCPBAD',
      agentId: 'anthropic_architect_aby',
      prompt: 'mcp test',
      resolvedConfig: {
        agentId: 'anthropic_architect_aby',
        source: 'test',
        runtime: 'aby_assistant',
        mcpServers: ['github'],
      },
      permissionProfile: buildPermissionProfile({
        agentId: 'anthropic_architect_aby',
        source: 'test',
        permissionMode: 'plan',
      }),
    });
    appendTranscriptEvent(
      run.runId,
      {
        timestamp: new Date().toISOString(),
        type: 'start',
        data: { mcpServers: ['github'] },
      },
      root,
    );
    appendTranscriptEvent(
      run.runId,
      {
        timestamp: new Date().toISOString(),
        type: 'tool_call',
        data: { toolName: 'mcp__filesystem__read', input: {} },
      },
      root,
    );

    const report = getAgentRuntimeMcpStatus({ rootDir: root, runId: run.runId });

    expect(report.status).toBe('FAIL');
    expect(report.invalidTools[0]).toEqual({
      tool: 'mcp.filesystem.read',
      reason: 'MCP server "filesystem" is not available',
    });
  });
});
