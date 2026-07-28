import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GraphStoreError,
  LocalGraphStore,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
} from '@openslack/organization-graph';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  graphCommands,
  readBoundedGraphSourceFile,
  readBoundedGraphSourceStream,
} from '../commands/graph.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'organization-graph',
  'src',
  '__tests__',
  'fixtures',
  'software-delivery-source.json',
);
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'openslack-graph-cli-'));
  roots.push(value);
  return value;
}

function fixture(): Buffer {
  return readFileSync(fixturePath);
}

function changedFixture(cursor: string): Buffer {
  const source = JSON.parse(fixture().toString('utf8')) as Record<string, unknown>;
  source.cursor = cursor;
  source.generatedAt = '2026-07-28T03:00:00.000Z';
  return Buffer.from(JSON.stringify(source), 'utf8');
}

async function run(
  workspaceRoot: string,
  args: string[],
  dependencies: Partial<Parameters<typeof graphCommands>[0]> = {},
): Promise<void> {
  await graphCommands({ workspaceRoot, ...dependencies }).parseAsync(
    ['snapshot', 'build', ...args],
    { from: 'user' },
  );
}

describe('graph snapshot build command', () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('registers only the explicit snapshot build surface', () => {
    const graph = graphCommands({ workspaceRoot: root() });
    expect(graph.commands.map((command) => command.name())).toEqual(['snapshot']);
    expect(graph.commands[0]!.commands.map((command) => command.name())).toEqual(['build']);
    expect(graph.commands[0]!.commands[0]!.options.map((option) => option.long)).toEqual([
      '--scenario',
      '--from',
      '--from-stdin',
      '--scenario-instance',
      '--expected-cursor',
      '--format',
    ]);
  });

  it('requires exactly one bounded input source', async () => {
    const workspaceRoot = root();
    const readSourceFile = vi.fn(async () => fixture());
    const readStdin = vi.fn(async () => fixture());
    await run(
      workspaceRoot,
      ['--scenario', 'software-delivery', '--from', 'source.json', '--from-stdin'],
      { readSourceFile, readStdin },
    );
    expect(stderr).toHaveBeenLastCalledWith(
      'GRAPH_SOURCE_CONFLICT: Choose exactly one of --from or --from-stdin.',
    );
    expect(readSourceFile).not.toHaveBeenCalled();
    expect(readStdin).not.toHaveBeenCalled();

    process.exitCode = undefined;
    stderr.mockClear();
    await run(workspaceRoot, ['--scenario', 'software-delivery'], {
      readSourceFile,
      readStdin,
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'GRAPH_SOURCE_REQUIRED: Choose exactly one of --from or --from-stdin.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects unsupported scenarios and output formats before reading input', async () => {
    const workspaceRoot = root();
    const readSourceFile = vi.fn(async () => fixture());
    await run(workspaceRoot, ['--scenario', 'other', '--from', 'source.json'], {
      readSourceFile,
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'GRAPH_SCENARIO_UNSUPPORTED: Only software-delivery is registered for snapshot build.',
    );
    expect(readSourceFile).not.toHaveBeenCalled();

    process.exitCode = undefined;
    stderr.mockClear();
    await run(
      workspaceRoot,
      ['--scenario', 'software-delivery', '--from', 'source.json', '--format', 'yaml'],
      { readSourceFile },
    );
    expect(stderr).toHaveBeenLastCalledWith(
      'GRAPH_OUTPUT_FORMAT_INVALID: Graph snapshot output format must be plain or json.',
    );
    expect(readSourceFile).not.toHaveBeenCalled();
  });

  it('publishes a workspace-relative file and renders path-free JSON matching store readback', async () => {
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'source.json'), fixture());
    await run(workspaceRoot, [
      '--scenario',
      'software-delivery',
      '--from',
      'source.json',
      '--scenario-instance',
      'scenario-software-delivery-fixture',
      '--format',
      'json',
    ]);

    expect(stderr).not.toHaveBeenCalled();
    const output = String(stdout.mock.calls[0]![0]);
    const result = JSON.parse(output) as {
      scenarioInstanceId: string;
      previousCursor: string | null;
      cursor: string;
      snapshotIntegrityHash: string;
      nodeCount: number;
      edgeCount: number;
    };
    expect(Object.keys(result).sort()).toEqual(
      [
        'cursor',
        'edgeCount',
        'nodeCount',
        'previousCursor',
        'scenarioInstanceId',
        'snapshotIntegrityHash',
      ].sort(),
    );
    expect(output).not.toContain(workspaceRoot);
    const readback = await new LocalGraphStore(
      join(workspaceRoot, '.openslack.local', 'graph'),
    ).readCurrentSnapshot(result.scenarioInstanceId);
    expect(result).toMatchObject({
      cursor: readback.cursor,
      snapshotIntegrityHash: readback.integrityHash,
      nodeCount: readback.nodes.length,
      edgeCount: readback.edges.length,
    });
  });

  it('reads stdin through the same byte ceiling and publishes the first cursor only from null', async () => {
    const workspaceRoot = root();
    const readStdin = vi.fn(async (maxBytes: number) => {
      expect(maxBytes).toBe(SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes);
      return fixture();
    });
    await run(
      workspaceRoot,
      ['--scenario', 'software-delivery', '--from-stdin', '--format', 'plain'],
      { readStdin },
    );
    expect(readStdin).toHaveBeenCalledOnce();
    expect(String(stdout.mock.calls[0]![0])).toContain('Previous cursor: <none>');
  });

  it('requires a matching explicit expected cursor for every replacement', async () => {
    const workspaceRoot = root();
    const sourcePath = join(workspaceRoot, 'source.json');
    writeFileSync(sourcePath, fixture());
    await run(workspaceRoot, ['--scenario', 'software-delivery', '--from', sourcePath]);

    stdout.mockClear();
    writeFileSync(sourcePath, changedFixture('fixture-cursor-002'));
    await run(workspaceRoot, ['--scenario', 'software-delivery', '--from', sourcePath]);
    expect(stderr).toHaveBeenLastCalledWith(
      'GRAPH_STORE_CURSOR_CONFLICT: graph snapshot publication was rejected.',
    );
    const store = new LocalGraphStore(join(workspaceRoot, '.openslack.local', 'graph'));
    expect(await store.currentCursor('scenario-software-delivery-fixture')).toBe(
      'fixture-cursor-001',
    );

    process.exitCode = undefined;
    stderr.mockClear();
    await run(workspaceRoot, [
      '--scenario',
      'software-delivery',
      '--from',
      sourcePath,
      '--expected-cursor',
      'fixture-cursor-001',
      '--format',
      'json',
    ]);
    expect(stderr).not.toHaveBeenCalled();
    expect(await store.currentCursor('scenario-software-delivery-fixture')).toBe(
      'fixture-cursor-002',
    );

    writeFileSync(sourcePath, changedFixture('fixture-cursor-003'));
    await run(workspaceRoot, [
      '--scenario',
      'software-delivery',
      '--from',
      sourcePath,
      '--expected-cursor',
      'fixture-cursor-001',
    ]);
    expect(stderr).toHaveBeenLastCalledWith(
      'GRAPH_STORE_CURSOR_CONFLICT: graph snapshot publication was rejected.',
    );
    expect(await store.currentCursor('scenario-software-delivery-fixture')).toBe(
      'fixture-cursor-002',
    );
  });

  it('renders committed-unverified as a reconciliation warning without leaking details', async () => {
    const workspaceRoot = root();
    const buildSnapshot = vi.fn(async () => {
      throw new GraphStoreError(
        'GRAPH_STORE_COMMITTED_UNVERIFIED',
        `secret source at ${workspaceRoot}`,
      );
    });
    await run(workspaceRoot, ['--scenario', 'software-delivery', '--from-stdin'], {
      readStdin: async () => fixture(),
      buildSnapshot,
    });
    const rendered = String(stderr.mock.calls[0]![0]);
    expect(rendered).toBe(
      'GRAPH_STORE_COMMITTED_UNVERIFIED: graph cursor may be committed; verify current state before retrying.',
    );
    expect(rendered).not.toContain(workspaceRoot);
    expect(rendered).not.toContain('secret');
  });
});

describe('bounded graph source readers', () => {
  afterEach(() => {
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it('reads a stable regular file with exact bytes', async () => {
    const sourcePath = join(root(), 'source.json');
    writeFileSync(sourcePath, fixture());
    await expect(readBoundedGraphSourceFile(sourcePath)).resolves.toEqual(fixture());
  });

  it('rejects an over-ceiling file and stream on the ceiling plus one byte', async () => {
    const sourcePath = join(root(), 'source.json');
    writeFileSync(sourcePath, Buffer.alloc(SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes + 1, 0x20));
    await expect(readBoundedGraphSourceFile(sourcePath)).rejects.toMatchObject({
      code: 'GRAPH_SOURCE_FILE_TOO_LARGE',
    });

    async function* source(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes);
      yield Buffer.from([0x20]);
    }
    await expect(readBoundedGraphSourceStream(source())).rejects.toMatchObject({
      code: 'GRAPH_SOURCE_FILE_TOO_LARGE',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link source instead of following it',
    async () => {
      const workspaceRoot = root();
      const target = join(workspaceRoot, 'target.json');
      const link = join(workspaceRoot, 'source.json');
      writeFileSync(target, fixture());
      symlinkSync(target, link, 'file');
      await expect(readBoundedGraphSourceFile(link)).rejects.toMatchObject({
        code: 'GRAPH_SOURCE_FILE_UNSAFE',
      });
    },
  );

  it('rejects a path identity replacement after the bounded read', async () => {
    const workspaceRoot = root();
    const sourcePath = join(workspaceRoot, 'source.json');
    const originalPath = join(workspaceRoot, 'original.json');
    writeFileSync(sourcePath, fixture());
    await expect(
      readBoundedGraphSourceFile(sourcePath, SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes, {
        afterBoundedRead: () => {
          renameSync(sourcePath, originalPath);
          writeFileSync(sourcePath, fixture());
        },
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_SOURCE_FILE_UNSAFE' });
  });
});
