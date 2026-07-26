import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENSLACK_READ_TOOL_NAMES, type OpenSlackReadToolName } from '@openslack/qoder-adapter';
import {
  createOpenSlackMcpContext,
  type OpenSlackReadModelPorts,
  type OperatorApplicationContextPort,
} from '../context.js';
import { OpenSlackMcpCore } from '../core.js';
import { OpenSlackMcpProtocolError } from '../errors.js';
import { readBoundedDirectoryFilesSync, readBoundedTextFileSync } from '../bounded-read.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-mcp-'));
  roots.push(root);
  return root;
}

function operatorContext(): OperatorApplicationContextPort {
  return Object.freeze({}) as unknown as OperatorApplicationContextPort;
}

function byteTree(root: string, relative = ''): Record<string, string> {
  const directory = join(root, relative);
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, byteTree(root, child));
    else result[child.replaceAll('\\', '/')] = readFileSync(join(root, child)).toString('base64');
  }
  return result;
}

function readers(overrides: Partial<OpenSlackReadModelPorts> = {}): OpenSlackReadModelPorts {
  return {
    executiveOverview: async () => ({ kind: 'overview', evidenceRef: 'module:registry' }),
    workItems: async () => ({ kind: 'work', evidenceRef: 'event:work' }),
    workRoom: async () => ({ kind: 'room', evidenceRef: 'event:room' }),
    activity: async () => ({ kind: 'activity', evidenceRef: 'event:activity' }),
    workflowProgress: async () => ({ kind: 'workflow', evidenceRef: 'run:1' }),
    prReadiness: async () => ({ kind: 'pr', headSha: 'abc123' }),
    pendingApprovals: async () => ({ kind: 'approvals', evidenceRef: 'plan:1' }),
    businessOutcomes: async () => ({ kind: 'outcomes', evidenceRefs: ['event:outcome'] }),
    notificationStatus: async () => ({
      kind: 'notifications',
      evidenceRef: 'queue:v2',
    }),
    ...overrides,
  };
}

function toolArgs(name: OpenSlackReadToolName): Record<string, unknown> {
  switch (name) {
    case 'openslack_get_work_room':
      return { roomId: 'pr:312' };
    case 'openslack_get_workflow_progress':
      return { runId: 'RUN-1' };
    case 'openslack_get_pr_readiness':
      return { prNumber: 312 };
    default:
      return {};
  }
}

describe('OpenSlack MCP core', () => {
  it('lists exactly the frozen nine read-only tools', () => {
    const context = createOpenSlackMcpContext({
      workspaceRoot: emptyRoot(),
      operator: operatorContext(),
      readers: readers(),
    });
    const core = new OpenSlackMcpCore(context);

    expect(core.listTools().map((tool) => tool.name)).toEqual(OPENSLACK_READ_TOOL_NAMES);
    expect(core.listTools()).toHaveLength(9);
    expect(Object.isFrozen(core.listTools())).toBe(true);
  });

  it('returns matching structured and text output for all nine tools', async () => {
    const context = createOpenSlackMcpContext({
      workspaceRoot: emptyRoot(),
      operator: operatorContext(),
      readers: readers(),
    });
    const core = new OpenSlackMcpCore(context);

    for (const name of OPENSLACK_READ_TOOL_NAMES) {
      const result = await core.callTool(name, toolArgs(name));
      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(result.structuredContent.schema).toBe('openslack.mcp_result.v1');
    }
  });

  it('collects only explicit evidence references and head SHAs, never prose source fields', async () => {
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const context = createOpenSlackMcpContext({
      workspaceRoot: emptyRoot(),
      operator: operatorContext(),
      readers: readers({
        workItems: async () => ({
          source: 'human-readable projection source',
          evidenceRefs: [
            'event:QW2-1',
            'artifact:QW2-2',
            'query:collaboration-events:2026-07-01/2026-07-31?scenario=manufacturing',
            'human-readable projection source',
            '/tmp/private',
            'abc1234',
            'query:https%3A%2F%2Fuser%3Apassword%40example.com',
            'query:https%3A%2F%2Fexample.com%2Fpublic',
            'query:%2Fcustomroot%2Fprivate%2Fcredentials.key',
            'query:%252Fcustomroot%252Fprivate%252Fcredentials.key',
            'query:%252525252Fdeep-root%252525252Fsecret.key',
            'query:C%3A%5Cprivate%5Ccredentials.key',
            'query:%255C%255Cprivate-server%255Cshare%255Ccredentials.key',
            'artifact:file%253A%252F%252F%252Fcustomroot%252Fsecret.txt',
            'query:api_key%3Dencoded-secret-value',
          ],
          items: [
            {
              id: 'unsafe',
              status: 'blocked',
              summary: 'Unsafe evidence must be omitted.',
              evidenceRef: 'query:https%3A%2F%2Fuser%3Apassword%40example.com',
            },
            {
              id: 'valid',
              status: 'done',
              summary: 'Typed evidence remains available.',
              evidenceRef: 'event:QW2-3',
            },
          ],
        }),
        prReadiness: async () => ({
          headSha,
          summary: { prNumber: 1 },
          readiness: { prNumber: 1, headSha },
        }),
      }),
    });
    const core = new OpenSlackMcpCore(context);
    const result = await core.callTool('openslack_list_work_items', {});
    const pr = await core.callTool('openslack_get_pr_readiness', { prNumber: 1 });

    expect(result.structuredContent.evidenceRefs).toEqual([
      'event:QW2-1',
      'artifact:QW2-2',
      'query:collaboration-events:2026-07-01/2026-07-31?scenario=manufacturing',
      'event:QW2-3',
    ]);
    expect(pr.structuredContent.evidenceRefs).toEqual([`commit:${headSha}`]);
    expect(result.structuredContent.evidenceRefs).not.toContain('human-readable projection source');
    expect(result.structuredContent.evidenceRefs).not.toContain('/tmp/private');
    expect(result.structuredContent.evidenceRefs).not.toContain('abc1234');
    const data = result.structuredContent.data as {
      evidenceRefs: string[];
      items: Array<{ evidenceRef?: string }>;
    };
    expect(data.evidenceRefs).toEqual([
      'event:QW2-1',
      'artifact:QW2-2',
      'query:collaboration-events:2026-07-01/2026-07-31?scenario=manufacturing',
    ]);
    expect(data.items[0]).not.toHaveProperty('evidenceRef');
    expect(data.items[1]).toHaveProperty('evidenceRef', 'event:QW2-3');
    expect(JSON.stringify(result.structuredContent)).not.toContain('"evidenceRef":"[REDACTED]"');
  });

  it('rejects unknown tools and unknown or out-of-bound input fields', async () => {
    const context = createOpenSlackMcpContext({
      workspaceRoot: emptyRoot(),
      operator: operatorContext(),
      readers: readers(),
    });
    const core = new OpenSlackMcpCore(context);

    await expect(core.callTool('run_shell', { command: 'git status' })).rejects.toBeInstanceOf(
      OpenSlackMcpProtocolError,
    );
    await expect(core.callTool('openslack_get_activity', { limit: 101 })).rejects.toThrow(
      /at most 100/,
    );
    await expect(core.callTool('openslack_get_activity', { rawCommand: 'status' })).rejects.toThrow(
      /rawCommand is not allowed/,
    );
  });

  it('redacts secret-shaped values and sensitive keys before both outputs', async () => {
    const context = createOpenSlackMcpContext({
      workspaceRoot: emptyRoot(),
      operator: operatorContext(),
      readers: readers({
        activity: async () => ({
          generatedAt: '2026-07-26T00:00:00.000Z',
          events: [
            {
              id: 'EVT-1',
              timestamp: '2026-07-26T00:00:00.000Z',
              type: 'task.blocked',
              actor: { id: 'agent', kind: 'agent', clientSecret: 'must-not-escape' },
              object: {
                id: '42',
                kind: 'issue',
                url: 'https://user:password@example.com/issues/42',
              },
              source: { kind: 'openslack', ref: '/customroot/private/credentials.key' },
              summary:
                'Bearer abcdefghijklmnopqrstuvwxyz Basic YWxhZGRpbjpvcGVuc2VzYW1l AKIAIOSFODNN7EXAMPLE npm_abcdefghijklmnopqrstuvwxyz012345 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123 /home/wsman/private /customroot/private/credentials.key C:\\ArbitraryRoot\\private\\credentials.key file:///C:/Users/WSMAN/private https://user@example.com/private https%3A%2F%2Fuser%3Apassword%40example.com %252Fother-root%252Fprivate%252Ftoken.txt %252525252Fdeep-root%252525252Fsecret.key file%253A%252F%252F%252Fvaried%252Fsecret.txt \\\\private-server\\share\\credentials.key public=https://example.com/overview',
              nextAction: {
                owner: 'human',
                action: 'review',
                command: 'run-arbitrary-command --api_key another-secret',
              },
              metadata: {
                token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                api_key: 'plain-api-secret',
                Cookie: 'session=private-cookie',
                sessionId: 'private-session',
              },
            },
          ],
        }),
      }),
    });
    const result = await new OpenSlackMcpCore(context).callTool('openslack_get_activity', {});
    const serialized = result.content[0].text;

    expect(serialized).not.toContain('must-not-escape');
    expect(serialized).not.toContain('run-arbitrary-command');
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain('user:password@');
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('file:///');
    expect(serialized).not.toContain('C:\\\\Users');
    expect(serialized).not.toContain('/home/wsman');
    expect(serialized).not.toContain('/customroot');
    expect(serialized).not.toContain('ArbitraryRoot');
    expect(serialized).not.toContain('%252Fother-root');
    expect(serialized).not.toContain('%252525252Fdeep-root');
    expect(serialized).not.toContain('https%3A%2F%2Fuser');
    expect(serialized).not.toContain('file%253A');
    expect(serialized).not.toContain('private-server');
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('npm_abcdefghijklmnopqrstuvwxyz');
    expect(serialized).not.toContain('eyJhbGci');
    expect(serialized).toContain('https://example.com/overview');
    expect(serialized).toContain('[REDACTED]');
    expect(JSON.parse(serialized)).toEqual(result.structuredContent);
  });

  it('bounds execution time and result size with safe tool errors', async () => {
    vi.useFakeTimers();
    try {
      const context = createOpenSlackMcpContext({
        workspaceRoot: emptyRoot(),
        operator: operatorContext(),
        readers: readers({
          activity: async () => await new Promise(() => undefined),
          executiveOverview: async () => ({
            modules: Array.from({ length: 100 }, (_, index) => ({
              id: `module-${index}`,
              name: `Module ${index}`,
              status: 'active',
              maturity: 'implemented',
              notes: 'x'.repeat(4_000),
            })),
            dashboard: {},
          }),
        }),
      });
      const core = new OpenSlackMcpCore(context, {
        timeoutMs: 100,
        maxOutputBytes: 16 * 1024,
      });
      const pending = core.callTool('openslack_get_activity', {});
      await vi.advanceTimersByTimeAsync(101);
      const timeout = await pending;
      expect(timeout.isError).toBe(true);
      expect(timeout.structuredContent.error).toMatchObject({
        code: 'READ_PROJECTION_FAILED',
      });

      const oversized = await core.callTool('openslack_get_executive_overview', {});
      expect(oversized.isError).toBe(true);
      expect(oversized.structuredContent.error).toMatchObject({
        code: 'READ_PROJECTION_TOO_LARGE',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an in-flight PR reader when the protocol deadline expires', async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    try {
      const context = createOpenSlackMcpContext({
        workspaceRoot: emptyRoot(),
        operator: operatorContext(),
        readers: readers({
          prReadiness: async ({ signal }) =>
            await new Promise((_, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  observedAbort = true;
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            }),
        }),
      });
      const pending = new OpenSlackMcpCore(context, { timeoutMs: 100 }).callTool(
        'openslack_get_pr_readiness',
        { prNumber: 312 },
      );
      await vi.advanceTimersByTimeAsync(101);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(observedAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create files or directories while default local readers execute', async () => {
    const root = emptyRoot();
    mkdirSync(join(root, '.openslack'), { recursive: true });
    writeFileSync(
      join(root, '.openslack', 'modules.yaml'),
      readFileSync(join(process.cwd(), '.openslack', 'modules.yaml')),
    );
    const before = readdirSync(root, { recursive: true });
    const context = createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: operatorContext(),
      readers: {
        prReadiness: async () => ({ kind: 'pr', headSha: 'abc123' }),
      },
    });
    const core = new OpenSlackMcpCore(context);

    for (const name of OPENSLACK_READ_TOOL_NAMES) {
      await core.callTool(name, toolArgs(name));
    }

    expect(readdirSync(root, { recursive: true })).toEqual(before);
  });

  it('keeps stale agent temp evidence and the entire byte tree unchanged during workflow reads', async () => {
    const root = emptyRoot();
    const workflowRunId = 'RUN-QW2-READONLY';
    const agentRunId = 'RUN-20260726-QW2READ01';
    const workflowDir = join(root, '.openslack.local', 'workflows', 'runs', workflowRunId);
    const resultDir = join(workflowDir, 'agents');
    const agentDir = join(root, '.openslack.local', 'agents', 'runs', agentRunId);
    mkdirSync(resultDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(workflowDir, 'meta.json'),
      JSON.stringify({
        runId: workflowRunId,
        workflowName: 'adversarial-workflow',
        mode: 'dry-run',
        manifestHash: 'fixture-manifest-hash',
        args: { api_key: 'must-not-escape' },
        startedAt: '2026-07-26T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(workflowDir, 'status.json'),
      JSON.stringify({
        runId: workflowRunId,
        status: 'running',
        currentPhase: 'Discover',
        updatedAt: '2026-07-26T00:01:00.000Z',
        phases: [
          {
            phase: 'Discover',
            status: 'completed',
            timestamp: '2026-07-26T00:01:00.000Z',
          },
        ],
      }),
    );
    writeFileSync(
      join(resultDir, 'discover.json'),
      JSON.stringify({
        runId: agentRunId,
        data: { rawToolPayload: 'Bearer should-not-escape' },
        workflowEvidence: {
          agentRunId,
          label: 'data-inventory-agent',
          phase: 'Discover',
          promptSummary: 'Cookie: should-not-escape',
          promptHash: 'fixture-prompt-hash',
          startedAt: '2026-07-26T00:00:00.000Z',
          tokenUsage: 12,
        },
      }),
    );
    writeFileSync(
      join(agentDir, 'run.json'),
      JSON.stringify({
        runId: agentRunId,
        status: 'running',
        agentId: 'data-inventory-agent',
        model: 'fixture-model',
        startedAt: '2026-07-26T00:00:00.000Z',
        tokensUsed: 12,
        tokensRemaining: 88,
        toolCalls: 1,
        worktreePath: 'C:\\private\\worktree',
        transcriptPath: 'C:\\private\\transcript.jsonl',
      }),
    );
    writeFileSync(
      join(agentDir, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'tool_result',
        timestamp: '2026-07-26T00:00:30.000Z',
        data: {
          tool: 'repository.read',
          raw: 'Basic YWxhZGRpbjpvcGVuc2VzYW1l',
          localPath: 'C:\\private\\artifact',
        },
      })}\n`,
    );
    const staleTemp = join(agentDir, 'run.json.stale.tmp');
    writeFileSync(staleTemp, 'stale-but-owned-evidence');
    utimesSync(staleTemp, new Date(0), new Date(0));
    const before = byteTree(root);

    const context = createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: operatorContext(),
      readers: {
        prReadiness: async () => ({ headSha: 'abc123' }),
      },
    });
    const result = await new OpenSlackMcpCore(context).callTool('openslack_get_workflow_progress', {
      runId: workflowRunId,
    });
    const serialized = result.content[0].text;

    expect(result.isError).toBe(false);
    expect(byteTree(root)).toEqual(before);
    expect(serialized).toContain('data-inventory-agent');
    expect(serialized).toContain('repository.read');
    expect(serialized).not.toContain('must-not-escape');
    expect(serialized).not.toContain('should-not-escape');
    expect(serialized).not.toContain('rawToolPayload');
    expect(serialized).not.toContain('worktree');
    expect(serialized).not.toContain('transcript');
    expect(serialized).not.toContain('C:\\\\private');
    expect(serialized).not.toContain('"args"');
  });

  it('fails safe before parsing oversized events, modules, plans, and workflow files', async () => {
    const cases = [
      {
        tool: 'openslack_get_activity' as const,
        args: {},
        path: '.openslack.local/collaboration/events.jsonl',
      },
      {
        tool: 'openslack_get_executive_overview' as const,
        args: {},
        path: '.openslack/modules.yaml',
      },
      {
        tool: 'openslack_list_pending_approvals' as const,
        args: {},
        path: '.openslack.local/operator/plans/PLAN-1.json',
      },
      {
        tool: 'openslack_get_workflow_progress' as const,
        args: { runId: 'RUN-QW2-LARGE' },
        path: '.openslack.local/workflows/runs/RUN-QW2-LARGE/meta.json',
      },
    ];
    for (const fixture of cases) {
      const root = emptyRoot();
      const path = join(root, fixture.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'x'.repeat(2 * 1024 * 1024 + 1));
      const context = createOpenSlackMcpContext({
        workspaceRoot: root,
        operator: operatorContext(),
        readers: { prReadiness: async () => ({ headSha: 'abc123' }) },
      });
      const result = await new OpenSlackMcpCore(context).callTool(fixture.tool, fixture.args);
      expect(result.isError || result.structuredContent.status === 'blocked').toBe(true);
    }
  });

  it('fails safe on non-UTF-8 local projection input', async () => {
    const root = emptyRoot();
    const eventPath = join(root, '.openslack.local', 'collaboration', 'events.jsonl');
    mkdirSync(join(eventPath, '..'), { recursive: true });
    writeFileSync(eventPath, Buffer.from([0xc3, 0x28]));
    const context = createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: operatorContext(),
      readers: { prReadiness: async () => ({ headSha: 'abc123' }) },
    });

    const result = await new OpenSlackMcpCore(context).callTool('openslack_get_activity', {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({ code: 'READ_PROJECTION_FAILED' });
  });

  it('fails closed on malformed or schema-invalid event JSONL and collaboration YAML', async () => {
    const cases: Array<{
      path: string;
      body: string | Buffer;
      tool: OpenSlackReadToolName;
      args: Record<string, unknown>;
    }> = [
      {
        path: '.openslack.local/collaboration/events.jsonl',
        body: '{"broken":',
        tool: 'openslack_get_activity',
        args: {},
      },
      {
        path: '.openslack.local/collaboration/events.jsonl',
        body: '{}\n',
        tool: 'openslack_get_activity',
        args: {},
      },
      {
        path: '.openslack/collaboration/handoffs/invalid.yaml',
        body: 'schema: wrong\\nid: H-1\\n',
        tool: 'openslack_get_executive_overview',
        args: {},
      },
      {
        path: '.openslack/collaboration/decisions/invalid.yaml',
        body: Buffer.from([0xc3, 0x28]),
        tool: 'openslack_get_executive_overview',
        args: {},
      },
    ];

    for (const fixture of cases) {
      const root = emptyRoot();
      const path = join(root, fixture.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, fixture.body);
      const result = await new OpenSlackMcpCore(
        createOpenSlackMcpContext({
          workspaceRoot: root,
          operator: operatorContext(),
          readers: { prReadiness: async () => ({}) },
        }),
      ).callTool(fixture.tool, fixture.args);

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({ code: 'READ_PROJECTION_FAILED' });
    }
  });

  it('fails closed on malformed workflow-run JSONL instead of returning a partial run', async () => {
    const root = emptyRoot();
    const runId = 'RUN-QW2-MALFORMED';
    const runDir = join(root, '.openslack.local', 'workflows', 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({
        runId,
        workflowName: 'fixture',
        mode: 'dry-run',
        manifestHash: 'fixture-manifest-hash',
        args: {},
        startedAt: '2026-07-26T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        runId,
        status: 'running',
        updatedAt: '2026-07-26T00:01:00.000Z',
        phases: [],
      }),
    );
    writeFileSync(join(runDir, 'log.jsonl'), '{"ts":"2026-07-26T00:00:00.000Z"\n');

    const result = await new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot: root,
        operator: operatorContext(),
        readers: { prReadiness: async () => ({}) },
      }),
    ).callTool('openslack_get_workflow_progress', { runId });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({ code: 'READ_PROJECTION_FAILED' });

    writeFileSync(
      join(runDir, 'log.jsonl'),
      `${JSON.stringify({
        ts: '2026-07-26T00:00:30.000Z',
        runId,
        message: 'valid log entry',
      })}\n`,
    );
    writeFileSync(join(runDir, 'pending-approvals.json'), 'null');
    const nullArtifact = await new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot: root,
        operator: operatorContext(),
        readers: { prReadiness: async () => ({}) },
      }),
    ).callTool('openslack_get_workflow_progress', { runId });
    expect(nullArtifact.isError).toBe(true);
    expect(nullArtifact.structuredContent.error).toMatchObject({
      code: 'READ_PROJECTION_FAILED',
    });
  });

  it('bounds directory iteration and refuses symbolic-link inputs', () => {
    const root = emptyRoot();
    const directory = join(root, 'many');
    mkdirSync(directory);
    writeFileSync(join(directory, '1.json'), '{}');
    writeFileSync(join(directory, '2.json'), '{}');
    writeFileSync(join(directory, '3.json'), '{}');

    expect(() =>
      readBoundedDirectoryFilesSync(directory, { extensions: ['.json'], maxItems: 2 }),
    ).toThrow(/LOCAL_INPUT_TOO_MANY_ITEMS/);

    const target = join(root, 'target.json');
    const link = join(root, 'link.json');
    writeFileSync(target, '{}');
    try {
      symlinkSync(target, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') return;
      throw error;
    }
    expect(() => readBoundedTextFileSync(link)).toThrow(/LOCAL_INPUT_NOT_REGULAR_FILE/);
  });

  it('projects default activity through an allowlist and excludes prose source evidence', async () => {
    const root = emptyRoot();
    const eventPath = join(root, '.openslack.local', 'collaboration', 'events.jsonl');
    mkdirSync(join(eventPath, '..'), { recursive: true });
    writeFileSync(
      eventPath,
      `${JSON.stringify({
        id: 'EVT-QW2-1',
        schema: 'openslack.collaboration_event.v1',
        timestamp: '2026-07-26T00:00:00.000Z',
        type: 'task.blocked',
        actor: { id: 'agent-1', kind: 'agent' },
        object: { id: '42', kind: 'issue' },
        source: { kind: 'openslack', ref: 'issue:42' },
        summary: 'Bearer abcdefghijklmnopqrstuvwxyz',
        nextAction: {
          owner: 'human',
          action: 'review',
          command: 'run-arbitrary-command --api_key secret',
        },
        visibility: 'workspace',
        redacted: true,
        containsSensitiveData: false,
        metadata: {
          api_key: 'metadata-secret',
          nested: { Cookie: 'session=private' },
        },
      })}\n`,
    );
    const context = createOpenSlackMcpContext({
      workspaceRoot: root,
      operator: operatorContext(),
      readers: { prReadiness: async () => ({ headSha: 'abc123' }) },
    });
    const result = await new OpenSlackMcpCore(context).callTool('openslack_get_activity', {});
    const serialized = result.content[0].text;
    const structured = result.structuredContent as {
      evidenceRefs: string[];
      data: { events: Array<Record<string, unknown>> };
    };

    expect(result.isError).toBe(false);
    expect(serialized).not.toContain('metadata-secret');
    expect(serialized).not.toContain('run-arbitrary-command');
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain('"command"');
    expect(structured.evidenceRefs).toEqual(['event:EVT-QW2-1']);
    expect(structured.evidenceRefs).not.toContain('issue:42');
    expect(structured.data.events[0]).toHaveProperty('evidenceRef', 'event:EVT-QW2-1');
  });
});
