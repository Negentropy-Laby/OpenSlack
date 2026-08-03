import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  WORKFLOW_RUNNER_DESCRIPTOR_LIMITS,
  canonicalWorkflowRunnerDescriptorJson,
  hashWorkflowRunnerDescriptor,
  validateWorkflowRunnerExecutionDescriptor,
  type WorkflowRunnerExecutionDescriptor,
} from './workflow-runner-descriptor.js';
import { parseWorkflowEffectJson } from './workflow-effect-json.js';

export class WorkflowRunnerDescriptorStoreError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_ALREADY_EXISTS'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_CONFLICT'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_NOT_FOUND'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerDescriptorStoreError';
  }
}

export interface WorkflowRunnerDescriptorPathSecurity {
  readonly platform: NodeJS.Platform;
  harden(path: string, directory: boolean): Promise<void>;
  assertOwnerOnly(path: string, directory: boolean, stat: BigIntStats): Promise<void>;
}

const SAFE_FILE = /^[0-9a-f]{64}\.json$/u;
const TEMP_FILE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WINDOWS_SID = /^S-\d(?:-\d+)+$/u;
const SYSTEM_SID = 'S-1-5-18';
const WINDOWS_SECURITY_MODULE_IMPORT =
  'Import-Module -Name (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop';
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
let cachedWindowsSid: string | undefined;

function storeFail(
  code: WorkflowRunnerDescriptorStoreError['code'],
  message: string,
  path?: string,
): never {
  throw new WorkflowRunnerDescriptorStoreError(code, message, path);
}

function statIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.size, stat.mode].join(':');
}

function descriptorFileName(descriptorRef: string): string {
  return `${createHash('sha256').update(descriptorRef, 'utf8').digest('hex')}.json`;
}

function parseWindowsAcl(value: string): {
  owner: string;
  protected: boolean;
  reparse: boolean;
  allow: readonly string[];
  deny: readonly string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return storeFail(
      'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
      'Descriptor-store Windows ACL output is invalid.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return storeFail(
      'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
      'Descriptor-store Windows ACL output is invalid.',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.owner !== 'string' ||
    !WINDOWS_SID.test(record.owner.toUpperCase()) ||
    typeof record.protected !== 'boolean' ||
    typeof record.reparse !== 'boolean' ||
    !Array.isArray(record.allow) ||
    !Array.isArray(record.deny) ||
    !record.allow.every(
      (item) => typeof item === 'string' && WINDOWS_SID.test(item.toUpperCase()),
    ) ||
    !record.deny.every((item) => typeof item === 'string' && WINDOWS_SID.test(item.toUpperCase()))
  ) {
    return storeFail(
      'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
      'Descriptor-store Windows ACL output is invalid.',
    );
  }
  return {
    owner: record.owner.toUpperCase(),
    protected: record.protected,
    reparse: record.reparse,
    allow: Object.freeze(record.allow.map((item) => String(item).toUpperCase())),
    deny: Object.freeze(record.deny.map((item) => String(item).toUpperCase())),
  };
}

function currentWindowsSid(): string {
  if (cachedWindowsSid) return cachedWindowsSid;
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  )
    .trim()
    .toUpperCase();
  if (!WINDOWS_SID.test(output)) {
    return storeFail(
      'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
      'Current Windows SID is unavailable.',
    );
  }
  cachedWindowsSid = output;
  return cachedWindowsSid;
}

function inspectWindowsAcl(path: string): ReturnType<typeof parseWindowsAcl> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    WINDOWS_SECURITY_MODULE_IMPORT,
    '$p = $env:OPENSLACK_WORKFLOW_RUNNER_PATH',
    '$item = Get-Item -LiteralPath $p -Force',
    '$acl = Get-Acl -LiteralPath $p',
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    '$allow = @($acl.Access | Where-Object { $_.AccessControlType -eq "Allow" } | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })',
    '$deny = @($acl.Access | Where-Object { $_.AccessControlType -eq "Deny" } | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })',
    '$reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)',
    '[pscustomobject]@{ owner=$owner; protected=$acl.AreAccessRulesProtected; reparse=$reparse; allow=$allow; deny=$deny } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');
  const output = execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, OPENSLACK_WORKFLOW_RUNNER_PATH: path },
    },
  );
  return parseWindowsAcl(output);
}

function hardenWindowsPath(path: string, sid: string, directory: boolean): void {
  // Set-Acl may demand SeSecurityPrivilege because it can attempt to persist
  // inherited SACL metadata even when only the DACL changed. icacls writes the
  // protected DACL directly and works for a non-elevated owner.
  const rights = directory ? '(OI)(CI)F' : 'F';
  execFileSync('icacls.exe', [path, '/setowner', `*${sid}`], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  execFileSync(
    'icacls.exe',
    [path, '/inheritance:r', '/grant:r', `*${sid}:${rights}`, `*${SYSTEM_SID}:${rights}`],
    {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    },
  );
}

export function createWorkflowRunnerDescriptorPathSecurity(
  platform: NodeJS.Platform = process.platform,
): WorkflowRunnerDescriptorPathSecurity {
  const windowsSid = platform === 'win32' ? currentWindowsSid() : undefined;
  return Object.freeze({
    platform,
    async harden(path: string, directory: boolean): Promise<void> {
      if (platform === 'win32') hardenWindowsPath(path, windowsSid!, directory);
      else await chmod(path, directory ? 0o700 : 0o600);
    },
    async assertOwnerOnly(path: string, directory: boolean, stat: BigIntStats): Promise<void> {
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
        return storeFail(
          'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
          'Descriptor-store path has an unsafe type.',
          path,
        );
      }
      if (platform === 'win32') {
        const acl = inspectWindowsAcl(path);
        const allowed = new Set([windowsSid!, SYSTEM_SID]);
        if (
          acl.reparse ||
          !acl.protected ||
          acl.owner !== windowsSid ||
          acl.deny.length > 0 ||
          !acl.allow.includes(windowsSid!) ||
          acl.allow.some((sid) => !allowed.has(sid))
        ) {
          return storeFail(
            'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
            'Descriptor-store Windows path is not owner-only or is a reparse point.',
            path,
          );
        }
      } else {
        const expectedUid =
          typeof process.getuid === 'function' ? BigInt(process.getuid()) : stat.uid;
        if ((Number(stat.mode) & 0o077) !== 0 || stat.uid !== expectedUid) {
          return storeFail(
            'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
            'Descriptor-store POSIX path is not owner-only.',
            path,
          );
        }
      }
    },
  });
}

async function assertStablePath(
  path: string,
  directory: boolean,
  security: WorkflowRunnerDescriptorPathSecurity,
): Promise<BigIntStats> {
  await assertNoWindowsReparseComponents(path, security);
  const before = await lstat(path, { bigint: true });
  await security.assertOwnerOnly(path, directory, before);
  const canonical = await realpath(path);
  if (security.platform === 'win32') {
    const canonicalStat = await lstat(canonical, { bigint: true });
    if (statIdentity(before) !== statIdentity(canonicalStat)) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
        'Descriptor-store path resolves to a different filesystem object.',
        path,
      );
    }
  } else if (canonical !== resolve(path)) {
    return storeFail(
      'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
      'Descriptor-store path is non-canonical.',
      path,
    );
  }
  const after = await lstat(path, { bigint: true });
  if (statIdentity(before) !== statIdentity(after)) {
    return storeFail(
      'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
      'Descriptor-store path changed during validation.',
      path,
    );
  }
  return after;
}

async function assertNoWindowsReparseComponents(
  path: string,
  security: WorkflowRunnerDescriptorPathSecurity,
): Promise<void> {
  if (security.platform !== 'win32') return;
  const root = parse(path).root;
  const components = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    const linked = await lstat(current, { bigint: true });
    const canonical = await realpath(current);
    const resolved = await lstat(canonical, { bigint: true });
    if (linked.isSymbolicLink() || statIdentity(linked) !== statIdentity(resolved)) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
        'Descriptor-store path contains a reparse component.',
        current,
      );
    }
  }
}

async function ensureDirectory(
  path: string,
  parent: string | undefined,
  security: WorkflowRunnerDescriptorPathSecurity,
): Promise<void> {
  if (parent !== undefined) await assertStablePath(parent, true, security);
  let created = false;
  if (parent === undefined) {
    return ensureRootDirectory(path, security);
  } else {
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (created) await security.harden(path, true);
  await assertStablePath(path, true, security);
}

async function ensureRootDirectory(
  path: string,
  security: WorkflowRunnerDescriptorPathSecurity,
): Promise<void> {
  const missing: string[] = [];
  let ancestor = path;
  while (true) {
    const exists = await lstat(ancestor, { bigint: true }).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (exists) break;
    missing.unshift(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
        'Descriptor-store root has no verifiable existing ancestor.',
        path,
      );
    }
    ancestor = parent;
  }

  await assertStablePath(ancestor, true, security);
  let parent = ancestor;
  for (const segment of missing) {
    await assertStablePath(parent, true, security);
    let created = false;
    try {
      await mkdir(segment, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (created) await security.harden(segment, true);
    await assertStablePath(segment, true, security);
    parent = segment;
  }
}

async function readBoundedFile(
  path: string,
  security: WorkflowRunnerDescriptorPathSecurity,
): Promise<Buffer> {
  const before = await assertStablePath(path, false, security);
  if (before.size > BigInt(WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxDescriptorBytes + 1)) {
    return storeFail(
      'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
      'Descriptor file exceeds its byte limit.',
      path,
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (statIdentity(before) !== statIdentity(opened)) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
        'Descriptor file identity changed before read.',
        path,
      );
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
        'Descriptor file ended unexpectedly.',
        path,
      );
    }
    const after = await handle.stat({ bigint: true });
    if (statIdentity(opened) !== statIdentity(after)) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
        'Descriptor file changed during read.',
        path,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export class WorkflowRunnerDescriptorStore {
  readonly #root: string;
  readonly #descriptors: string;
  readonly #security: WorkflowRunnerDescriptorPathSecurity;

  constructor(
    root: string,
    security: WorkflowRunnerDescriptorPathSecurity = createWorkflowRunnerDescriptorPathSecurity(),
  ) {
    if (!isAbsolute(root) || resolve(root) !== root || root.includes('\0')) {
      storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
        'Descriptor-store root must be a normalized absolute path.',
        root,
      );
    }
    this.#root = root;
    this.#descriptors = join(root, 'descriptors');
    this.#security = security;
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.#root, undefined, this.#security);
    await ensureDirectory(this.#descriptors, this.#root, this.#security);
    const entries = await readdir(this.#descriptors);
    for (const entry of entries) {
      const path = join(this.#descriptors, entry);
      if (TEMP_FILE.test(entry)) {
        await assertStablePath(path, false, this.#security);
        await rm(path, { force: true });
        continue;
      }
      if (!SAFE_FILE.test(entry)) {
        storeFail(
          'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
          'Descriptor-store directory contains an unknown entry.',
          path,
        );
      }
      await assertStablePath(path, false, this.#security);
    }
  }

  descriptorPath(descriptorRef: string): string {
    return join(this.#descriptors, descriptorFileName(descriptorRef));
  }

  async create(descriptorValue: WorkflowRunnerExecutionDescriptor): Promise<{
    readonly descriptor: WorkflowRunnerExecutionDescriptor;
    readonly descriptorHash: string;
    readonly duplicate: boolean;
  }> {
    const descriptor = validateWorkflowRunnerExecutionDescriptor(descriptorValue);
    await this.initialize();
    const path = this.descriptorPath(descriptor.descriptorRef);
    const body = Buffer.from(`${canonicalWorkflowRunnerDescriptorJson(descriptor)}\n`, 'utf8');
    const existing = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) return this.#compareExisting(path, body, descriptor);

    const temporaryPath = join(this.#descriptors, `.tmp-${randomUUID()}`);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < body.length) {
        const result = await handle.write(body, offset, body.length - offset, offset);
        offset += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.#security.harden(temporaryPath, false);
    await assertStablePath(temporaryPath, false, this.#security);
    try {
      await link(temporaryPath, path);
      await this.#security.harden(path, false);
      await assertStablePath(path, false, this.#security);
      return Object.freeze({
        descriptor,
        descriptorHash: hashWorkflowRunnerDescriptor(descriptor),
        duplicate: false,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.#compareExisting(path, body, descriptor);
      }
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #compareExisting(
    path: string,
    expectedBytes: Buffer,
    descriptor: WorkflowRunnerExecutionDescriptor,
  ): Promise<{
    readonly descriptor: WorkflowRunnerExecutionDescriptor;
    readonly descriptorHash: string;
    readonly duplicate: boolean;
  }> {
    const existingBytes = await readBoundedFile(path, this.#security);
    if (!existingBytes.equals(expectedBytes)) {
      storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_CONFLICT',
        'Descriptor reference is already bound to different exact bytes.',
        path,
      );
    }
    return Object.freeze({
      descriptor,
      descriptorHash: hashWorkflowRunnerDescriptor(descriptor),
      duplicate: true,
    });
  }

  async read(descriptorRef: string, now?: string): Promise<WorkflowRunnerExecutionDescriptor> {
    await this.initialize();
    const path = this.descriptorPath(descriptorRef);
    const bytes = await readBoundedFile(path, this.#security).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return storeFail(
          'WORKFLOW_RUNNER_DESCRIPTOR_STORE_NOT_FOUND',
          'Descriptor is not present.',
          path,
        );
      }
      throw error;
    });
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a || bytes.includes(0x0d)) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
        'Descriptor file must contain canonical JSON followed by one LF.',
        path,
      );
    }
    let parsed: unknown;
    try {
      parsed = parseWorkflowEffectJson(bytes.subarray(0, -1), {
        maxDepth: 12,
        maxNodes: 4_096,
        maxStringLength: WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxStringBytes,
      });
    } catch {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
        'Descriptor file contains invalid JSON.',
        path,
      );
    }
    const descriptor = validateWorkflowRunnerExecutionDescriptor(parsed, now);
    if (descriptor.descriptorRef !== descriptorRef) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
        'Descriptor path and record reference differ.',
        path,
      );
    }
    const canonical = Buffer.from(`${canonicalWorkflowRunnerDescriptorJson(descriptor)}\n`, 'utf8');
    if (!bytes.equals(canonical)) {
      return storeFail(
        'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
        'Descriptor file is not canonical.',
        path,
      );
    }
    return descriptor;
  }
}
