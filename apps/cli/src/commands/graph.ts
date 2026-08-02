import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  GraphAuthorityHttpPublisher,
  GraphAuthorityPublishError,
  GraphContractError,
  GraphStoreError,
  LocalGraphStore,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  StrictGraphJsonError,
  buildAndPublishGraphSnapshot,
  graphSnapshotBuildProfile,
  type BuildAndPublishGraphSnapshotInput,
  type GraphAuthorityHttpPublisherOptions,
  type GraphSnapshotPublisherPort,
  type PublishedGraphBuildSnapshot,
} from '@openslack/organization-graph';
import { resolveWorkspaceContext } from '@openslack/workspace';

const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const READ_CHUNK_BYTES = 64 * 1024;

export type GraphSnapshotCommandErrorCode =
  | 'GRAPH_SOURCE_REQUIRED'
  | 'GRAPH_SOURCE_CONFLICT'
  | 'GRAPH_SOURCE_FILE_UNSAFE'
  | 'GRAPH_SOURCE_FILE_TOO_LARGE'
  | 'GRAPH_SOURCE_STDIN_FAILED'
  | 'GRAPH_SCENARIO_UNSUPPORTED'
  | 'GRAPH_OUTPUT_FORMAT_INVALID'
  | 'GRAPH_AUTHORITY_ARGUMENT_INVALID';

export class GraphSnapshotCommandError extends Error {
  constructor(
    readonly code: GraphSnapshotCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GraphSnapshotCommandError';
  }
}

export interface GraphSourceFileReadTestHooks {
  readonly afterBoundedRead?: () => void | Promise<void>;
}

export interface GraphCommandDependencies {
  readonly workspaceRoot: string;
  readonly createStore?: (root: string) => GraphSnapshotPublisherPort;
  readonly createAuthorityPublisher?: (
    options: GraphAuthorityHttpPublisherOptions,
  ) => GraphSnapshotPublisherPort;
  readonly buildSnapshot?: (
    input: BuildAndPublishGraphSnapshotInput,
  ) => Promise<PublishedGraphBuildSnapshot>;
  readonly readSourceFile?: (path: string, maxBytes: number) => Promise<Buffer>;
  readonly readStdin?: (maxBytes: number) => Promise<Buffer>;
}

interface GraphSnapshotBuildOptions {
  scenario: string;
  from?: string;
  fromStdin?: boolean;
  scenarioInstance?: string;
  expectedCursor?: string;
  format: string;
  authorityBackend?: 'go' | 'ts-local';
  authorityRoutingEpoch?: string;
  authorityTenant?: string;
  authorityOrigin?: string;
  authorityNetwork?: 'loopback' | 'internal';
  authorityBuildSha?: string;
}

function commandFail(code: GraphSnapshotCommandErrorCode, message: string): never {
  throw new GraphSnapshotCommandError(code, message);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableIdentity(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

async function boundedHandleRead(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const result = await handle.read(chunk, 0, chunk.length, total);
    if (result.bytesRead === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, result.bytesRead)));
    total += result.bytesRead;
    if (total > maxBytes) {
      commandFail(
        'GRAPH_SOURCE_FILE_TOO_LARGE',
        `Graph source exceeds the ${maxBytes}-byte input ceiling.`,
      );
    }
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedGraphSourceFile(
  configuredPath: string,
  maxBytes = SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes,
  hooks: GraphSourceFileReadTestHooks = {},
): Promise<Buffer> {
  const path = resolve(configuredPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const beforePath = await lstat(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
      return commandFail('GRAPH_SOURCE_FILE_UNSAFE', 'Graph source must be a real regular file.');
    }
    if (beforePath.size > maxBytes) {
      return commandFail(
        'GRAPH_SOURCE_FILE_TOO_LARGE',
        `Graph source exceeds the ${maxBytes}-byte input ceiling.`,
      );
    }
    if (!samePath(await realpath(path), path)) {
      return commandFail(
        'GRAPH_SOURCE_FILE_UNSAFE',
        'Graph source must not resolve through a symbolic link or reparse point.',
      );
    }

    handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const beforeHandle = await handle.stat();
    if (!beforeHandle.isFile() || !sameIdentity(beforePath, beforeHandle)) {
      return commandFail(
        'GRAPH_SOURCE_FILE_UNSAFE',
        'Graph source changed identity before it was read.',
      );
    }
    if (beforeHandle.size > maxBytes) {
      return commandFail(
        'GRAPH_SOURCE_FILE_TOO_LARGE',
        `Graph source exceeds the ${maxBytes}-byte input ceiling.`,
      );
    }

    const bytes = await boundedHandleRead(handle, maxBytes);
    const afterHandle = await handle.stat();
    if (!stableIdentity(beforeHandle, afterHandle) || afterHandle.size !== bytes.length) {
      return commandFail(
        'GRAPH_SOURCE_FILE_UNSAFE',
        'Graph source changed while it was being read.',
      );
    }

    await hooks.afterBoundedRead?.();
    const afterPath = await lstat(path);
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      !stableIdentity(afterHandle, afterPath) ||
      !samePath(await realpath(path), path)
    ) {
      return commandFail(
        'GRAPH_SOURCE_FILE_UNSAFE',
        'Graph source path changed identity during the read.',
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof GraphSnapshotCommandError) throw error;
    return commandFail('GRAPH_SOURCE_FILE_UNSAFE', 'Graph source file could not be read safely.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBoundedGraphSourceStream(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes = SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const value of stream) {
      const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        return commandFail(
          'GRAPH_SOURCE_FILE_TOO_LARGE',
          `Graph source exceeds the ${maxBytes}-byte input ceiling.`,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof GraphSnapshotCommandError) throw error;
    return commandFail('GRAPH_SOURCE_STDIN_FAILED', 'Graph source stdin could not be read.');
  }
  return Buffer.concat(chunks, total);
}

function resolveSourcePath(workspaceRoot: string, sourcePath: string): string {
  return isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workspaceRoot, sourcePath);
}

export function renderGraphSnapshotBuildResult(
  result: PublishedGraphBuildSnapshot,
  format: 'plain' | 'json',
): string {
  const safeResult = {
    scenarioInstanceId: result.scenarioInstanceId,
    previousCursor: result.previousCursor,
    cursor: result.cursor,
    snapshotIntegrityHash: result.snapshotIntegrityHash,
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount,
    ...(result.authorityBackend === undefined ? {} : { authorityBackend: result.authorityBackend }),
    ...(result.routingEpoch === undefined ? {} : { routingEpoch: result.routingEpoch }),
    ...(result.receiptStatus === undefined ? {} : { receiptStatus: result.receiptStatus }),
    ...(result.revision === undefined ? {} : { revision: result.revision }),
  };
  if (format === 'json') return JSON.stringify(safeResult, null, 2);
  return [
    'OpenSlack Graph Snapshot',
    `Scenario instance: ${safeResult.scenarioInstanceId}`,
    `Previous cursor: ${safeResult.previousCursor ?? '<none>'}`,
    `Cursor: ${safeResult.cursor}`,
    `Integrity: ${safeResult.snapshotIntegrityHash}`,
    `Nodes: ${safeResult.nodeCount}`,
    `Edges: ${safeResult.edgeCount}`,
    ...(safeResult.authorityBackend === undefined
      ? []
      : [`Authority backend: ${safeResult.authorityBackend}`]),
    ...(safeResult.routingEpoch === undefined ? [] : [`Routing epoch: ${safeResult.routingEpoch}`]),
    ...(safeResult.receiptStatus === undefined
      ? []
      : [`Durable receipt: ${safeResult.receiptStatus}`]),
    ...(safeResult.revision === undefined ? [] : [`Revision: ${safeResult.revision}`]),
  ].join('\n');
}

export function renderGraphSnapshotBuildError(error: unknown): string {
  if (error instanceof GraphSnapshotCommandError) return `${error.code}: ${error.message}`;
  if (error instanceof StrictGraphJsonError) {
    return `${error.code}: graph snapshot source JSON was rejected.`;
  }
  if (error instanceof GraphContractError) {
    return `${error.code}: graph snapshot source contract was rejected.`;
  }
  if (error instanceof GraphStoreError) {
    if (error.code === 'GRAPH_STORE_COMMITTED_UNVERIFIED') {
      return `${error.code}: graph cursor may be committed; verify current state before retrying.`;
    }
    return `${error.code}: graph snapshot publication was rejected.`;
  }
  if (error instanceof GraphAuthorityPublishError) {
    return `${error.code}: graph authority publication failed closed.`;
  }
  return 'GRAPH_SNAPSHOT_BUILD_FAILED: graph snapshot build failed closed.';
}

export function graphCommands(dependencies: GraphCommandDependencies): Command {
  const command = new Command('graph').description(
    'Build and inspect bounded local Organization Graph projections',
  );
  const snapshot = command.command('snapshot').description('Manage graph snapshots');
  snapshot
    .command('build')
    .description('Build and CAS-publish a graph snapshot from bounded inert source JSON')
    .requiredOption('--scenario <id>', 'Registered declarative scenario')
    .option('--from <path>', 'Read source JSON from an absolute or workspace-relative file')
    .option('--from-stdin', 'Read source JSON from stdin')
    .option('--scenario-instance <id>', 'Require an exact scenario instance')
    .option('--expected-cursor <cursor>', 'Required current cursor when replacing a snapshot')
    .option('--format <format>', 'Output format: plain or json', 'plain')
    .addOption(
      new Option(
        '--authority-backend <backend>',
        'Publish to the Go authority or explicitly retain the ts-local writer',
      ).choices(['go', 'ts-local']),
    )
    .option('--authority-routing-epoch <epoch>', 'Bind durable Go acceptance to one routing epoch')
    .option('--authority-tenant <workspace-id>', 'Assert the canonical workspace/tenant ID')
    .option('--authority-origin <origin>', 'Use one exact credential-free Go authority origin')
    .addOption(
      new Option(
        '--authority-network <mode>',
        'Restrict the authority origin to loopback or explicitly selected internal IPs',
      ).choices(['loopback', 'internal']),
    )
    .option('--authority-build-sha <sha>', 'Bind durable acceptance to one service build SHA')
    .action(async (options: GraphSnapshotBuildOptions) => {
      try {
        if (options.from !== undefined && options.fromStdin) {
          commandFail('GRAPH_SOURCE_CONFLICT', 'Choose exactly one of --from or --from-stdin.');
        }
        if (options.from === undefined && !options.fromStdin) {
          commandFail('GRAPH_SOURCE_REQUIRED', 'Choose exactly one of --from or --from-stdin.');
        }
        const profile = graphSnapshotBuildProfile(options.scenario);
        if (profile === undefined) {
          commandFail(
            'GRAPH_SCENARIO_UNSUPPORTED',
            'Graph snapshot scenario is not registered by the sealed host dispatch.',
          );
        }
        if (options.format !== 'plain' && options.format !== 'json') {
          commandFail(
            'GRAPH_OUTPUT_FORMAT_INVALID',
            'Graph snapshot output format must be plain or json.',
          );
        }

        const sourceBytes =
          options.from === undefined
            ? await (
                dependencies.readStdin ??
                ((maxBytes) => readBoundedGraphSourceStream(process.stdin, maxBytes))
              )(profile.sourceBytes)
            : await (dependencies.readSourceFile ?? readBoundedGraphSourceFile)(
                resolveSourcePath(dependencies.workspaceRoot, options.from),
                profile.sourceBytes,
              );
        const authoritySupplied = [
          options.authorityBackend,
          options.authorityRoutingEpoch,
          options.authorityTenant,
          options.authorityOrigin,
          options.authorityNetwork,
          options.authorityBuildSha,
        ].some((value) => value !== undefined);
        if (authoritySupplied && options.authorityBackend === undefined) {
          commandFail(
            'GRAPH_AUTHORITY_ARGUMENT_INVALID',
            '--authority-backend is required when authority settings are supplied.',
          );
        }
        let store: GraphSnapshotPublisherPort;
        if (options.authorityBackend === 'go') {
          if (
            options.authorityRoutingEpoch === undefined ||
            options.authorityTenant === undefined ||
            options.authorityOrigin === undefined ||
            options.authorityBuildSha === undefined ||
            !/^[1-9]\d*$/u.test(options.authorityRoutingEpoch)
          ) {
            commandFail(
              'GRAPH_AUTHORITY_ARGUMENT_INVALID',
              'Go authority publication requires canonical epoch, tenant, origin, and build SHA.',
            );
          }
          const routingEpoch = Number(options.authorityRoutingEpoch);
          if (!Number.isSafeInteger(routingEpoch)) {
            commandFail(
              'GRAPH_AUTHORITY_ARGUMENT_INVALID',
              'Go authority routing epoch must be a positive safe integer.',
            );
          }
          const workspace = resolveWorkspaceContext({
            workspaceRoot: dependencies.workspaceRoot,
            requireWorkspace: true,
          });
          if (!workspace.config?.workspace_id) {
            commandFail(
              'GRAPH_AUTHORITY_ARGUMENT_INVALID',
              'Go authority publication requires a canonical workspace ID.',
            );
          }
          const create =
            dependencies.createAuthorityPublisher ??
            ((publisherOptions: GraphAuthorityHttpPublisherOptions) =>
              new GraphAuthorityHttpPublisher(publisherOptions));
          store = create({
            origin: options.authorityOrigin,
            networkMode: options.authorityNetwork ?? 'loopback',
            tenantId: workspace.config.workspace_id,
            expectedTenantId: options.authorityTenant,
            routingEpoch,
            expectedBuildSha: options.authorityBuildSha,
          });
        } else {
          if (
            options.authorityBackend === 'ts-local' &&
            (options.authorityRoutingEpoch !== undefined ||
              options.authorityTenant !== undefined ||
              options.authorityOrigin !== undefined ||
              options.authorityNetwork !== undefined ||
              options.authorityBuildSha !== undefined)
          ) {
            commandFail(
              'GRAPH_AUTHORITY_ARGUMENT_INVALID',
              'ts-local publication does not accept Go authority transport settings.',
            );
          }
          const storeRoot = join(dependencies.workspaceRoot, '.openslack.local', 'graph');
          store = (dependencies.createStore ?? ((root) => new LocalGraphStore(root)))(storeRoot);
        }
        const result = await (dependencies.buildSnapshot ?? buildAndPublishGraphSnapshot)({
          scenarioId: profile.scenarioId,
          sourceBytes,
          store,
          expectedCursor: options.expectedCursor ?? null,
          ...(options.scenarioInstance === undefined
            ? {}
            : { expectedScenarioInstanceId: options.scenarioInstance }),
        });
        console.log(renderGraphSnapshotBuildResult(result, options.format as 'plain' | 'json'));
      } catch (error) {
        console.error(renderGraphSnapshotBuildError(error));
        process.exitCode = 1;
      }
    });

  return command;
}
