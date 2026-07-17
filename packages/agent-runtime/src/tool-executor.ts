import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { classifyPaths } from '@openslack/kernel';
import type { RunRecorder } from './recorder.js';
import type { ToolGuard } from './adapter.js';
import {
  AgentLimitExceededError,
  ProviderTimeoutError,
  ToolArgumentInvalidError,
} from './types.js';
import {
  isSourceCodeRepositoryPath,
  isSensitiveRepositoryPath,
  redactProjectedSensitiveText,
  redactSensitiveText,
  redactSensitiveValue,
} from './sensitive-data.js';

export type RepositoryToolName = 'repo.read' | 'repo.search' | 'repo.apply_patch' | 'repo.diff';

export interface RepositoryToolDefinition {
  name: RepositoryToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolExecutionResult {
  ok: true;
  data: Record<string, unknown>;
  truncated?: boolean;
}

export interface ToolExecutor {
  listDefinitions(): RepositoryToolDefinition[];
  execute(
    toolName: string,
    input: unknown,
    control?: ToolExecutionControl,
  ): Promise<ToolExecutionResult>;
}

export interface ToolExecutionControl {
  signal?: AbortSignal;
  deadlineAt?: number;
  maxResultBytes?: number;
}

export interface RepositoryToolExecutorOptions {
  rootPath: string;
  toolGuard: ToolGuard;
  recorder: RunRecorder;
  runId: string;
  maxReadBytes?: number;
  maxSearchFiles?: number;
  maxSearchMatches?: number;
  maxSearchDirectories?: number;
  maxPatchBytes?: number;
  maxDiffBytes?: number;
}

const DEFINITIONS: RepositoryToolDefinition[] = [
  {
    name: 'repo.read',
    description: 'Read a bounded UTF-8 text file inside the selected worktree.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'repo.search',
    description: 'Search bounded text files inside the selected worktree for a literal string.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'repo.apply_patch',
    description: 'Replace one exact text occurrence in a worktree file, or create a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },
  {
    name: 'repo.diff',
    description: 'Return a bounded git diff for the selected worktree.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

export class RepositoryToolExecutor implements ToolExecutor {
  private readonly rootPath: string;
  private readonly maxReadBytes: number;
  private readonly maxSearchFiles: number;
  private readonly maxSearchMatches: number;
  private readonly maxSearchDirectories: number;
  private readonly maxPatchBytes: number;
  private readonly maxDiffBytes: number;

  constructor(private readonly options: RepositoryToolExecutorOptions) {
    this.rootPath = realpathSync(resolve(options.rootPath));
    this.maxReadBytes = options.maxReadBytes ?? 64 * 1024;
    this.maxSearchFiles = options.maxSearchFiles ?? 500;
    this.maxSearchMatches = options.maxSearchMatches ?? 100;
    this.maxSearchDirectories = options.maxSearchDirectories ?? 500;
    this.maxPatchBytes = options.maxPatchBytes ?? 256 * 1024;
    this.maxDiffBytes = options.maxDiffBytes ?? 128 * 1024;
  }

  listDefinitions(): RepositoryToolDefinition[] {
    return DEFINITIONS.filter((definition) => this.options.toolGuard.isAllowed(definition.name));
  }

  async execute(
    toolName: string,
    input: unknown,
    control: ToolExecutionControl = {},
  ): Promise<ToolExecutionResult> {
    assertToolExecutionActive(control);
    if (!DEFINITIONS.some((definition) => definition.name === toolName)) {
      throw new ToolArgumentInvalidError(toolName, 'Unknown repository tool.');
    }
    const args = validateArguments(toolName as RepositoryToolName, input);
    // Authorization is enforced inside the executor, after typed parsing and
    // before any filesystem/process side effect.
    this.options.toolGuard.check(toolName);
    this.options.recorder.toolCall(this.options.runId, toolName, redactToolInput(toolName, args));

    let result: ToolExecutionResult;
    switch (toolName as RepositoryToolName) {
      case 'repo.read':
        result = this.read(args, control);
        break;
      case 'repo.search':
        result = this.search(args, control);
        break;
      case 'repo.apply_patch':
        result = this.applyPatch(args, control);
        break;
      case 'repo.diff':
        result = this.diff(args, control);
        break;
    }

    const safeResult = redactRepositoryToolResult(toolName as RepositoryToolName, result);
    const boundedResult = boundToolResult(safeResult, control.maxResultBytes);
    this.options.recorder.toolResult(this.options.runId, toolName, boundedResult);
    return boundedResult;
  }

  private read(args: Record<string, unknown>, control: ToolExecutionControl): ToolExecutionResult {
    const relativePath = readString(args.path, 'path', 'repo.read');
    const path = this.resolveSafePath(relativePath, false);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ToolArgumentInvalidError('repo.read', 'Path must reference a regular file.');
    }
    const raw = readFilePrefix(path, this.maxReadBytes, control);
    const truncated = stat.size > this.maxReadBytes;
    const decoded = decodeRepositoryText(raw);
    const normalizedPath = normalizeRelative(relativePath);
    const context =
      decoded.validUtf8 && !decoded.containsNull && isSourceCodeRepositoryPath(normalizedPath)
        ? 'source-code'
        : 'generic';
    return {
      ok: true,
      data: {
        path: normalizedPath,
        content: redactSensitiveText(decoded.value, { context }).value,
        bytes: stat.size,
      },
      truncated,
    };
  }

  private search(
    args: Record<string, unknown>,
    control: ToolExecutionControl,
  ): ToolExecutionResult {
    const query = readString(args.query, 'query', 'repo.search');
    if (query.length > 500) {
      throw new ToolArgumentInvalidError('repo.search', 'query exceeds 500 characters.');
    }
    const startRelative = readOptionalString(args.path, 'path', 'repo.search') ?? '.';
    const start = this.resolveSafePath(startRelative, false);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let filesScanned = 0;

    for (const filePath of this.walkFiles(start, control)) {
      assertToolExecutionActive(control);
      if (filesScanned >= this.maxSearchFiles || matches.length >= this.maxSearchMatches) break;
      filesScanned += 1;
      let text: string;
      let projectionContext: 'generic' | 'source-code' = 'generic';
      try {
        const stat = lstatSync(filePath);
        if (!stat.isFile() || stat.size > this.maxReadBytes) continue;
        const raw = readFilePrefix(filePath, this.maxReadBytes, control);
        const decoded = decodeRepositoryText(raw);
        if (decoded.containsNull) continue;
        text = decoded.value;
        const normalizedPath = normalizeRelative(relative(this.rootPath, filePath));
        projectionContext =
          decoded.validUtf8 && isSourceCodeRepositoryPath(normalizedPath)
            ? 'source-code'
            : 'generic';
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        matches.push({
          path: normalizeRelative(relative(this.rootPath, filePath)),
          line: index + 1,
          text: redactSensitiveText(lines[index].slice(0, 500), {
            context: projectionContext,
          }).value,
        });
        if (matches.length >= this.maxSearchMatches) break;
      }
    }

    return {
      ok: true,
      data: { query: redactSensitiveText(query).value, matches, filesScanned },
      truncated: filesScanned >= this.maxSearchFiles || matches.length >= this.maxSearchMatches,
    };
  }

  private applyPatch(
    args: Record<string, unknown>,
    control: ToolExecutionControl,
  ): ToolExecutionResult {
    const relativePath = readString(args.path, 'path', 'repo.apply_patch');
    const normalizedPath = normalizeRelative(relativePath);
    if (classifyPaths([normalizedPath]) === 'red') {
      throw new ToolArgumentInvalidError(
        'repo.apply_patch',
        'Red Zone paths require a separate human-governed change path.',
      );
    }
    const oldText = readStringAllowEmpty(args.oldText, 'oldText', 'repo.apply_patch');
    const newText = readStringAllowEmpty(args.newText, 'newText', 'repo.apply_patch');
    if (Buffer.byteLength(oldText) + Buffer.byteLength(newText) > this.maxPatchBytes) {
      throw new ToolArgumentInvalidError(
        'repo.apply_patch',
        'Patch exceeds the configured byte limit.',
      );
    }
    const path = this.resolveSafePath(relativePath, true);
    const exists = existsSync(path);
    const existingStat = exists ? lstatSync(path) : undefined;
    if (existingStat && (!existingStat.isFile() || existingStat.size > this.maxPatchBytes)) {
      throw new ToolArgumentInvalidError(
        'repo.apply_patch',
        'Existing file exceeds the editable byte limit.',
      );
    }
    const currentRaw = exists ? readFilePrefix(path, this.maxPatchBytes, control) : Buffer.alloc(0);
    if (currentRaw.includes(0)) {
      throw new ToolArgumentInvalidError('repo.apply_patch', 'Binary files cannot be edited.');
    }
    const current = currentRaw.toString('utf-8');
    let updated: string;
    if (!exists) {
      if (oldText !== '') {
        throw new ToolArgumentInvalidError(
          'repo.apply_patch',
          'Creating a file requires an empty oldText value.',
        );
      }
      updated = newText;
    } else {
      if (oldText === '') {
        throw new ToolArgumentInvalidError(
          'repo.apply_patch',
          'oldText must be non-empty when editing an existing file.',
        );
      }
      const first = current.indexOf(oldText);
      if (first < 0 || current.indexOf(oldText, first + oldText.length) >= 0) {
        throw new ToolArgumentInvalidError(
          'repo.apply_patch',
          'oldText must match exactly one occurrence.',
        );
      }
      updated = `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
    }
    if (Buffer.byteLength(updated) > this.maxPatchBytes) {
      throw new ToolArgumentInvalidError(
        'repo.apply_patch',
        'Updated file exceeds the byte limit.',
      );
    }

    mkdirSync(dirname(path), { recursive: true });
    const existingMode = existingStat?.mode;
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      assertToolExecutionActive(control);
      writeFileSync(temp, updated, { encoding: 'utf-8', flag: 'wx' });
      if (existingMode !== undefined) chmodSync(temp, existingMode);
      renameSync(temp, path);
    } finally {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // Best-effort cleanup; the target is published only by rename.
      }
    }
    return {
      ok: true,
      data: {
        path: normalizedPath,
        created: !exists,
        bytes: Buffer.byteLength(updated),
      },
    };
  }

  private diff(args: Record<string, unknown>, control: ToolExecutionControl): ToolExecutionResult {
    const relativePath = readOptionalString(args.path, 'path', 'repo.diff');
    const commandArgs = ['diff', '--no-ext-diff', '--'];
    const safeTrackedPaths = this.listSafeTrackedDiffPaths(control);
    if (relativePath) {
      this.resolveSafePath(relativePath, true);
      const filter = normalizeRelative(relativePath);
      commandArgs.push(
        ...safeTrackedPaths.filter((path) => path === filter || path.startsWith(`${filter}/`)),
      );
    } else {
      commandArgs.push(...safeTrackedPaths);
    }
    let output = '';
    let bufferExceeded = false;
    if (commandArgs.length > 3) {
      const result = spawnSync('git', commandArgs, {
        cwd: this.rootPath,
        encoding: 'utf-8',
        windowsHide: true,
        maxBuffer: this.maxDiffBytes * 2,
        timeout: remainingToolTimeout(control),
      });
      bufferExceeded = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
        throw new ProviderTimeoutError();
      }
      if ((result.error && !bufferExceeded) || (result.status !== 0 && !bufferExceeded)) {
        throw new ToolArgumentInvalidError(
          'repo.diff',
          'Unable to read git diff for the worktree.',
        );
      }
      output = String(result.stdout ?? '');
    }
    const untrackedFiles = this.listUntrackedFiles(relativePath, control);
    return {
      ok: true,
      data: {
        diff: redactSensitiveText(truncateUtf8(Buffer.from(output), this.maxDiffBytes).value, {
          context: 'diff',
        }).value,
        untrackedFiles,
      },
      truncated: bufferExceeded || Buffer.byteLength(output) > this.maxDiffBytes,
    };
  }

  private listSafeTrackedDiffPaths(control: ToolExecutionControl): string[] {
    assertToolExecutionActive(control);
    const names = spawnSync('git', ['diff', '--name-only', '-z', '--'], {
      cwd: this.rootPath,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: remainingToolTimeout(control),
    });
    if ((names.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      throw new ProviderTimeoutError();
    }
    if (names.error || names.status !== 0) {
      throw new ToolArgumentInvalidError('repo.diff', 'Unable to enumerate git diff paths.');
    }
    return String(names.stdout ?? '')
      .split('\0')
      .filter(Boolean)
      .map(normalizeRelative)
      .filter((path) => !isSensitiveRepositoryPath(path) && classifyPaths([path]) !== 'black')
      .slice(0, this.maxSearchFiles);
  }

  private listUntrackedFiles(
    pathFilter: string | undefined,
    control: ToolExecutionControl,
  ): Array<{ path: string; bytes: number }> {
    assertToolExecutionActive(control);
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'];
    if (pathFilter) args.push(normalizeRelative(pathFilter));
    const status = spawnSync('git', args, {
      cwd: this.rootPath,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: Math.max(this.maxDiffBytes, 64 * 1024),
      timeout: remainingToolTimeout(control),
    });
    if ((status.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      throw new ProviderTimeoutError();
    }
    if (status.error || status.status !== 0) return [];
    const files: Array<{ path: string; bytes: number }> = [];
    for (const record of String(status.stdout ?? '').split('\0')) {
      assertToolExecutionActive(control);
      if (!record.startsWith('?? ')) continue;
      const path = normalizeRelative(record.slice(3));
      if (isSensitiveRepositoryPath(path) || classifyPaths([path]) === 'black') continue;
      try {
        const absolutePath = this.resolveSafePath(path, false);
        const stat = lstatSync(absolutePath);
        if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path, bytes: stat.size });
      } catch {
        // A racy or inaccessible untracked path is omitted from evidence.
      }
      if (files.length >= this.maxSearchMatches) break;
    }
    return files;
  }

  private *walkFiles(start: string, control: ToolExecutionControl): Generator<string> {
    const stat = lstatSync(start);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      yield start;
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const stack = [start];
    let directoriesScanned = 0;
    while (stack.length > 0) {
      assertToolExecutionActive(control);
      directoriesScanned += 1;
      if (directoriesScanned > this.maxSearchDirectories) {
        throw new AgentLimitExceededError('Repository search directory limit was exceeded.');
      }
      const directory = stack.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assertToolExecutionActive(control);
        if (entry.name === '.git' || entry.name === '.openslack.local') continue;
        const path = resolve(directory, entry.name);
        const relativePath = normalizeRelative(relative(this.rootPath, path));
        if (isSensitiveRepositoryPath(relativePath) || classifyPaths([relativePath]) === 'black') {
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile()) yield path;
      }
    }
  }

  private resolveSafePath(pathValue: string, allowMissing: boolean): string {
    if (pathValue.includes('\0') || isAbsolute(pathValue)) {
      throw new ToolArgumentInvalidError('repository', 'Path must be a relative worktree path.');
    }
    const inputSegments = pathValue.replace(/\\/g, '/').split('/');
    if (inputSegments.includes('..')) {
      throw new ToolArgumentInvalidError(
        'repository',
        'Parent-directory path segments are not allowed.',
      );
    }
    const normalized = normalizeRelative(pathValue);
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      if (normalized === '.' && !allowMissing) return this.rootPath;
      throw new ToolArgumentInvalidError('repository', 'Path escapes the selected worktree.');
    }
    if (isSensitiveRepositoryPath(normalized) || classifyPaths([normalized]) === 'black') {
      throw new ToolArgumentInvalidError('repository', 'Black Zone paths are inaccessible.');
    }
    const candidate = resolve(this.rootPath, normalized);
    const rel = normalizeRelative(relative(this.rootPath, candidate));
    if (rel.startsWith('../') || isAbsolute(rel)) {
      throw new ToolArgumentInvalidError('repository', 'Path escapes the selected worktree.');
    }

    const existingAncestor = findExistingAncestor(candidate);
    const realAncestor = realpathSync(existingAncestor);
    const ancestorRelative = normalizeRelative(relative(this.rootPath, realAncestor));
    if (ancestorRelative.startsWith('../') || isAbsolute(ancestorRelative)) {
      throw new ToolArgumentInvalidError(
        'repository',
        'Path resolves through a symlink outside the worktree.',
      );
    }
    if (!allowMissing && !existsSync(candidate)) {
      throw new ToolArgumentInvalidError('repository', `Path does not exist: ${normalized}`);
    }
    return candidate;
  }
}

function readObject(value: unknown, toolName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolArgumentInvalidError(toolName, 'Tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

const TOOL_ARGUMENT_KEYS: Record<RepositoryToolName, { required: string[]; optional: string[] }> = {
  'repo.read': { required: ['path'], optional: [] },
  'repo.search': { required: ['query'], optional: ['path'] },
  'repo.apply_patch': { required: ['path', 'oldText', 'newText'], optional: [] },
  'repo.diff': { required: [], optional: ['path'] },
};

function validateArguments(toolName: RepositoryToolName, value: unknown): Record<string, unknown> {
  const args = readObject(value, toolName);
  const contract = TOOL_ARGUMENT_KEYS[toolName];
  const allowed = new Set([...contract.required, ...contract.optional]);
  const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ToolArgumentInvalidError(toolName, 'Tool arguments contain unknown fields.');
  }
  const missing = contract.required.filter((key) => !(key in args));
  if (missing.length > 0) {
    throw new ToolArgumentInvalidError(toolName, 'Tool arguments are missing required fields.');
  }
  return args;
}

function readString(value: unknown, field: string, toolName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolArgumentInvalidError(toolName, `${field} must be a non-empty string.`);
  }
  return value;
}

function readStringAllowEmpty(value: unknown, field: string, toolName: string): string {
  if (typeof value !== 'string') {
    throw new ToolArgumentInvalidError(toolName, `${field} must be a string.`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string, toolName: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, field, toolName);
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function findExistingAncestor(path: string): string {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

function truncateUtf8(input: Buffer, maxBytes: number): { value: string; truncated: boolean } {
  if (input.byteLength <= maxBytes) return { value: input.toString('utf-8'), truncated: false };
  return { value: input.subarray(0, maxBytes).toString('utf-8'), truncated: true };
}

function decodeRepositoryText(input: Buffer): {
  value: string;
  validUtf8: boolean;
  containsNull: boolean;
} {
  const containsNull = input.includes(0);
  try {
    return {
      value: new TextDecoder('utf-8', { fatal: true }).decode(input),
      validUtf8: true,
      containsNull,
    };
  } catch {
    return {
      value: input.toString('utf-8'),
      validUtf8: false,
      containsNull,
    };
  }
}

function readFilePrefix(path: string, maxBytes: number, control: ToolExecutionControl): Buffer {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    let offset = 0;
    while (offset < maxBytes) {
      assertToolExecutionActive(control);
      const bytesRead = readSync(handle, buffer, offset, maxBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(handle);
  }
}

function assertToolExecutionActive(control: ToolExecutionControl): void {
  if (control.signal?.aborted) {
    throw control.signal.reason instanceof Error
      ? control.signal.reason
      : new Error('Agent run aborted.');
  }
  if (control.deadlineAt !== undefined && Date.now() >= control.deadlineAt) {
    throw new ProviderTimeoutError();
  }
}

function remainingToolTimeout(control: ToolExecutionControl): number {
  assertToolExecutionActive(control);
  return control.deadlineAt === undefined ? 30_000 : Math.max(1, control.deadlineAt - Date.now());
}

function boundToolResult(
  result: ToolExecutionResult,
  maxResultBytes: number | undefined,
): ToolExecutionResult {
  if (maxResultBytes === undefined || Buffer.byteLength(JSON.stringify(result)) <= maxResultBytes) {
    return result;
  }
  const bounded: ToolExecutionResult = {
    ok: true,
    data: { summary: 'Tool result exceeded the configured byte limit.' },
    truncated: true,
  };
  if (Buffer.byteLength(JSON.stringify(bounded)) > maxResultBytes) {
    throw new AgentLimitExceededError('Agent tool-result byte limit was exceeded.');
  }
  return bounded;
}

function redactToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== 'repo.apply_patch') {
    return redactSensitiveValue(input) as Record<string, unknown>;
  }
  return {
    path: input.path,
    oldTextBytes: typeof input.oldText === 'string' ? Buffer.byteLength(input.oldText) : undefined,
    newTextBytes: typeof input.newText === 'string' ? Buffer.byteLength(input.newText) : undefined,
  };
}

function redactRepositoryToolResult(
  toolName: RepositoryToolName,
  result: ToolExecutionResult,
): ToolExecutionResult {
  if (toolName === 'repo.read') {
    const { content, ...metadata } = result.data;
    return {
      ...result,
      data: {
        ...(redactSensitiveValue(metadata) as Record<string, unknown>),
        content: redactProjectedSensitiveText(String(content ?? '')).value,
      },
    };
  }
  if (toolName === 'repo.search') {
    const matches = Array.isArray(result.data.matches)
      ? result.data.matches.map((value) => {
          const match =
            value && typeof value === 'object' && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : {};
          const { text, ...metadata } = match;
          return {
            ...(redactSensitiveValue(metadata) as Record<string, unknown>),
            text: redactProjectedSensitiveText(String(text ?? '')).value,
          };
        })
      : [];
    return {
      ...result,
      data: {
        ...result.data,
        query: redactSensitiveText(String(result.data.query ?? '')).value,
        matches,
      },
    };
  }
  if (toolName === 'repo.diff') {
    const { diff, ...metadata } = result.data;
    return {
      ...result,
      data: {
        ...(redactSensitiveValue(metadata) as Record<string, unknown>),
        diff: redactProjectedSensitiveText(String(diff ?? '')).value,
      },
    };
  }
  return redactSensitiveValue(result) as ToolExecutionResult;
}
