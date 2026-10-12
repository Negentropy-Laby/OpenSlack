import { parseCleanupSelectedBindings } from './internal/cleanup-selected-bindings.js';
import { cleanupByteDigest as sha } from './internal/cleanup-document-bytes.js';
import { isSensitiveCleanupInput } from './internal/cleanup-validation.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import { parseRuntimeIdentityText } from '@openslack/workspace';
import { agentRegistryV2Schema, workspaceSchema } from '@openslack/workspace';
import { parseAgentRegistryText } from '@openslack/workspace';
import { authorizeAgentAction, resolvePermissionSnapshot } from '@openslack/kernel';
import {
  assertCleanupDescriptorSupport,
  CleanupDirectoryAnchor,
  CleanupFileBoundaryError,
  withCleanupFile,
} from './internal/cleanup-file-boundary.js';

const MAX_INPUT = 2 * 1024 * 1024;
import {
  CLEANUP_REGISTRY_SHA256 as REGISTRY_SHA256,
  CLEANUP_RUNTIME_BINDING,
  CLEANUP_ADMIN_BINDINGS,
  CLEANUP_GOVERNANCE_BINDING,
} from './internal/cleanup-administration-contract.js';
const RECORD_PATH = '.openslack/outbox/cleanup-operations/workspace-isolation-check.json';
const FIXED = CLEANUP_RUNTIME_BINDING;

export interface VerifyCleanupWorkspaceInput {
  workspace: string;
  selectedBindings: string;
  selectedBindingsSHA256: string;
}
interface BlockingIssue {
  code: string;
  role: string;
}
interface DirectoryFact {
  path: string;
  uid: number;
  gid: number;
  mode: string;
}
export interface CleanupWorkspaceObservation {
  schema: 'openslack.cleanup_workspace_observation.v1';
  recordedAt: string;
  status: 'PASS' | 'BLOCKED';
  scope: 'readonly-parsed-identity-and-path-evidence';
  workspace: { path: string; workspaceId?: string; sha256?: string; directories: DirectoryFact[] };
  selection?: { sha256: string; priorInputSHA256: string; approvalNotInherited: true };
  osIdentity: {
    actualUid?: number;
    actualGid?: number;
    supplementaryGids?: number[];
    expectedUid?: number;
    expectedGid?: number;
    matched: boolean;
  };
  identity: {
    state: 'NOT_OBSERVED' | 'MISSING' | 'INVALID' | 'MISMATCH' | 'MATCHED';
    sha256?: string;
    runId?: string;
  };
  registry: {
    state: 'NOT_OBSERVED' | 'INVALID' | 'MISMATCH' | 'MATCHED';
    sha256?: string;
    fixedBytes?: boolean;
  };
  pathAuthorization: {
    decision: 'NOT_EVALUATED' | 'allow' | 'ask' | 'deny';
    rule?: string;
    recordPath: string;
    immutableSnapshot: boolean;
    executionContextCreated: false;
  };
  outbox: {
    state: 'NOT_OBSERVED' | 'NOT_CREATED' | 'PRESENT';
    recordDirectory?: 'NOT_CREATED' | 'PRESENT';
  };
  blockingIssues: BlockingIssue[];
  effects: {
    filesystemWrites: false;
    identityCreated: false;
    brokerQueried: false;
    credentialsRead: false;
    approvalRecorded: false;
    executionContextCreated: false;
  };
}
class WorkspaceRefusal extends Error {
  constructor(
    readonly code: string,
    readonly role: string,
  ) {
    super(code);
  }
}
function refuse(code: string, role: string): never {
  throw new WorkspaceRefusal(code, role);
}
function insist(value: unknown, code: string, role: string): asserts value {
  if (!value) refuse(code, role);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safePath(path: string, role: string): string {
  insist(
    typeof path === 'string' &&
      path.length <= 4096 &&
      isAbsolute(path) &&
      !/[\u0000-\u001f\u007f]/.test(path) &&
      !path.split('/').includes('..') &&
      path.split('/').length <= 64,
    'WORKSPACE_PATH_INVALID',
    role,
  );
  const canonical = resolve(path);
  insist(
    !/^\/(?:proc|dev)(?:\/|$)/.test(canonical) && !isSensitiveCleanupInput(canonical),
    'WORKSPACE_PATH_UNSAFE',
    role,
  );
  return canonical;
}
function selection(raw: Buffer): {
  selected: Readonly<Record<string, string>>;
  priorInputSHA256: string;
} {
  let parsed: ReturnType<typeof parseCleanupSelectedBindings>;
  try {
    parsed = parseCleanupSelectedBindings(raw, MAX_INPUT);
  } catch {
    return refuse('WORKSPACE_SELECTION_INVALID', 'selection');
  }
  const chosen = parsed.selected;
  for (const [key, text] of Object.entries(FIXED))
    insist(chosen[key] === text, 'WORKSPACE_SELECTED_BINDING_MISMATCH', 'selection');
  for (const key of ['agent_uid', 'agent_gid', 'broker_uid', 'broker_gid'])
    insist(
      /^[1-9][0-9]*$/.test(chosen[key] ?? '') && Number.isSafeInteger(Number(chosen[key])),
      'WORKSPACE_SELECTION_INVALID',
      'selection',
    );
  insist(
    chosen.broker_uid !== chosen.agent_uid &&
      `${chosen.qualification_repository_owner}/${chosen.qualification_repository_name}` ===
        CLEANUP_ADMIN_BINDINGS.repository &&
      chosen.qualification_repository_numeric_id === CLEANUP_ADMIN_BINDINGS.repositoryId &&
      chosen.qualification_repository_default_branch === CLEANUP_GOVERNANCE_BINDING.defaultBranch,
    'WORKSPACE_SELECTED_BINDING_MISMATCH',
    'selection',
  );
  return parsed;
}
function yaml(raw: Buffer, role: string): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    const document = parseDocument(text, { uniqueKeys: true });
    insist(document.errors.length === 0, 'WORKSPACE_SOURCE_INVALID', role);
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    insist(object(value), 'WORKSPACE_SOURCE_INVALID', role);
    return value;
  } catch {
    return refuse('WORKSPACE_SOURCE_INVALID', role);
  }
}
function boundaryCode(error: unknown, role: string): string {
  if (error instanceof WorkspaceRefusal) return error.code;
  if (
    (error as NodeJS.ErrnoException).code === 'ENOENT' ||
    (error instanceof CleanupFileBoundaryError && error.code === 'NOT_FOUND')
  )
    return role === 'identity' ? 'WORKSPACE_IDENTITY_MISSING' : 'WORKSPACE_SOURCE_MISSING';
  if (error instanceof CleanupFileBoundaryError) return `WORKSPACE_${error.code}`;
  return 'WORKSPACE_READ_FAILED';
}
function capture<T>(path: string, role: string, consume: (bytes: Buffer) => T): T {
  try {
    return withCleanupFile(safePath(path, role), MAX_INPUT, consume);
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw error;
    return refuse(boundaryCode(error, role), role);
  }
}
interface DirectoryCheck {
  anchor: CleanupDirectoryAnchor;
  private: boolean;
  role: string;
}
function directoryStamp(anchor: CleanupDirectoryAnchor): Stats {
  // The proc path is constructed only from the owned anchor, never accepted as input.
  const fd = openSync(
    `${dirname(anchor.path('directory-proof'))}/.`,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}
function checkDirectory(check: DirectoryCheck, uid: number, gid: number): DirectoryFact {
  check.anchor.verify();
  const stamp = directoryStamp(check.anchor);
  const stickyRootParent = !check.private && stamp.uid === 0 && (stamp.mode & 0o1000) !== 0;
  insist(
    stamp.isDirectory() &&
      (check.private
        ? stamp.uid === uid && stamp.gid === gid && (stamp.mode & 0o077) === 0
        : (stamp.uid === 0 || stamp.uid === uid) &&
          ((stamp.mode & 0o022) === 0 || stickyRootParent)),
    'WORKSPACE_DIRECTORY_UNSAFE',
    check.role,
  );
  check.anchor.verify();
  return {
    path: check.anchor.absolute,
    uid: stamp.uid,
    gid: stamp.gid,
    mode: (stamp.mode & 0o7777).toString(8).padStart(4, '0'),
  };
}

/** Parsed evidence only: never returns a principal/snapshot as an execution grant. */
export function verifyCleanupWorkspace(
  input: VerifyCleanupWorkspaceInput,
): CleanupWorkspaceObservation {
  const result: CleanupWorkspaceObservation = {
    schema: 'openslack.cleanup_workspace_observation.v1',
    recordedAt: new Date().toISOString(),
    status: 'BLOCKED',
    scope: 'readonly-parsed-identity-and-path-evidence',
    workspace: { path: input.workspace, directories: [] },
    osIdentity: { matched: false },
    identity: { state: 'NOT_OBSERVED' },
    registry: { state: 'NOT_OBSERVED' },
    pathAuthorization: {
      decision: 'NOT_EVALUATED',
      recordPath: RECORD_PATH,
      immutableSnapshot: false,
      executionContextCreated: false,
    },
    outbox: { state: 'NOT_OBSERVED' },
    blockingIssues: [],
    effects: {
      filesystemWrites: false,
      identityCreated: false,
      brokerQueried: false,
      credentialsRead: false,
      approvalRecorded: false,
      executionContextCreated: false,
    },
  };
  const directories: DirectoryCheck[] = [];
  const add = (code: string, role: string) => {
    if (!result.blockingIssues.some((issue) => issue.code === code && issue.role === role))
      result.blockingIssues.push({ code, role });
  };
  try {
    insist(
      process.platform === 'linux' &&
        typeof process.getuid === 'function' &&
        typeof process.getgid === 'function',
      'WORKSPACE_PLATFORM_UNSUPPORTED',
      'platform',
    );
    insist(
      process.getuid() > 0 && process.geteuid!() > 0,
      'WORKSPACE_OS_IDENTITY_MISMATCH',
      'osIdentity',
    );
    assertCleanupDescriptorSupport();
    const root = safePath(input.workspace, 'workspace');
    insist(
      /^[a-f0-9]{64}$/.test(input.selectedBindingsSHA256),
      'WORKSPACE_ARGUMENT_INVALID',
      'selection',
    );
    capture(input.selectedBindings, 'selection', (selectedBytes) => {
      insist(
        sha(selectedBytes) === input.selectedBindingsSHA256,
        'WORKSPACE_SELECTION_DIGEST_MISMATCH',
        'selection',
      );
      const parsed = selection(selectedBytes),
        chosen = parsed.selected;
      result.selection = {
        sha256: sha(selectedBytes),
        priorInputSHA256: parsed.priorInputSHA256,
        approvalNotInherited: true,
      };
      const uid = process.getuid!(),
        gid = process.getgid!(),
        groups = process.getgroups!();
      result.osIdentity = {
        actualUid: uid,
        actualGid: gid,
        supplementaryGids: groups,
        expectedUid: Number(chosen.agent_uid),
        expectedGid: Number(chosen.agent_gid),
        matched: false,
      };
      insist(
        uid > 0 &&
          uid === Number(chosen.agent_uid) &&
          gid === Number(chosen.agent_gid) &&
          process.geteuid!() === uid &&
          process.getegid!() === gid &&
          groups.every((group) => group === gid),
        'WORKSPACE_OS_IDENTITY_MISMATCH',
        'osIdentity',
      );
      result.osIdentity.matched = true;
      const directory = (path: string, privateDirectory: boolean, role: string) => {
        let anchor: CleanupDirectoryAnchor;
        try {
          anchor = CleanupDirectoryAnchor.open(path);
        } catch (error) {
          return refuse(boundaryCode(error, role), role);
        }
        const check = { anchor, private: privateDirectory, role };
        directories.push(check);
        result.workspace.directories.push(checkDirectory(check, uid, gid));
        return anchor;
      };
      for (let path = dirname(root); ; path = dirname(path)) {
        directory(path, false, 'workspace');
        if (path === '/') break;
      }
      directory(root, true, 'workspace');
      const state = directory(join(root, '.openslack'), true, 'workspace');
      directory(join(root, '.openslack.local'), true, 'identity');
      for (const path of [
        join(root, '.openslack/agents'),
        join(root, '.openslack/agents/registry'),
        join(root, '.openslack.local/agents'),
        join(root, '.openslack.local/agents', FIXED.agent_id),
      ])
        directory(path, false, 'identity');
      let outboxPresent = false;
      try {
        lstatSync(state.path('outbox'));
        outboxPresent = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (outboxPresent) {
        const outbox = directory(join(root, '.openslack/outbox'), true, 'outbox');
        result.outbox = { state: 'PRESENT', recordDirectory: 'NOT_CREATED' };
        try {
          lstatSync(outbox.path('cleanup-operations'));
          directory(join(root, '.openslack/outbox/cleanup-operations'), true, 'outbox');
          result.outbox.recordDirectory = 'PRESENT';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } else result.outbox = { state: 'NOT_CREATED', recordDirectory: 'NOT_CREATED' };
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const validateWorkspace = ajv.compile(workspaceSchema),
        validateRegistry = ajv.compile(agentRegistryV2Schema);
      capture(join(root, 'openslack.yaml'), 'workspace', (workspaceBytes) => {
        const config = yaml(workspaceBytes, 'workspace');
        insist(validateWorkspace(config), 'WORKSPACE_CONFIG_INVALID', 'workspace');
        const remote = config.canonical_remote as Record<string, unknown>,
          paths = config.workspace as Record<string, unknown>;
        insist(
          config.workspace_id === chosen.workspace_id &&
            `${remote.owner}/${remote.repo}` === CLEANUP_GOVERNANCE_BINDING.repository &&
            remote.default_branch === 'main' &&
            paths.root === '.' &&
            paths.state_root === '.openslack',
          'WORKSPACE_CONFIG_BINDING_MISMATCH',
          'workspace',
        );
        result.workspace.workspaceId = config.workspace_id as string;
        result.workspace.sha256 = sha(workspaceBytes);
        capture(
          join(root, '.openslack/agents/registry', `${FIXED.agent_id}.yaml`),
          'registry',
          (registryBytes) => {
            result.registry = {
              state: 'INVALID',
              sha256: sha(registryBytes),
              fixedBytes: sha(registryBytes) === REGISTRY_SHA256,
            };
            if (!result.registry.fixedBytes) add('WORKSPACE_REGISTRY_BYTES_MISMATCH', 'registry');
            insist(
              validateRegistry(yaml(registryBytes, 'registry')),
              'WORKSPACE_REGISTRY_INVALID',
              'registry',
            );
            let registry: ReturnType<typeof parseAgentRegistryText>;
            try {
              registry = parseAgentRegistryText(registryBytes.toString('utf8'), FIXED.agent_id);
            } catch {
              return refuse('WORKSPACE_REGISTRY_INVALID', 'registry');
            }
            insist(
              registry &&
                registry._source_schema === 'openslack.agent_registry.v2' &&
                registry.agent_id === FIXED.agent_id &&
                registry.identity.uid === chosen.runtime_uid_claim &&
                registry.identity.principal_id === chosen.principal_id &&
                registry.identity.status === 'active' &&
                registry.employment.status === 'active' &&
                `${registry.repositories.workspace_repo.owner}/${registry.repositories.workspace_repo.repo}` ===
                  CLEANUP_GOVERNANCE_BINDING.repository &&
                registry.repositories.workspace_repo.default_branch === 'main' &&
                registry.repositories.allowed_product_repos?.length === 1 &&
                registry.repositories.allowed_product_repos[0] ===
                  CLEANUP_ADMIN_BINDINGS.repository,
              'WORKSPACE_REGISTRY_BINDING_MISMATCH',
              'registry',
            );
            result.registry.state = result.registry.fixedBytes ? 'MATCHED' : 'MISMATCH';
            capture(
              join(root, '.openslack.local/agents', FIXED.agent_id, 'identity.yaml'),
              'identity',
              (identityBytes) => {
                result.identity = { state: 'INVALID', sha256: sha(identityBytes) };
                const shape = yaml(identityBytes, 'identity');
                insist(
                  Object.keys(shape).every((key) =>
                    [
                      'schema',
                      'agent_id',
                      'agent_uid',
                      'run_id',
                      'provider',
                      'started_at',
                      'public_key_jwk',
                      'key_id',
                      'key_generated_at',
                      'authenticated_github_identity',
                    ].includes(key),
                  ),
                  'WORKSPACE_IDENTITY_INVALID',
                  'identity',
                );
                const identity = parseRuntimeIdentityText(identityBytes.toString('utf8'));
                insist(identity, 'WORKSPACE_IDENTITY_INVALID', 'identity');
                result.identity = {
                  state: 'MISMATCH',
                  sha256: sha(identityBytes),
                  runId: identity.run_id,
                };
                insist(
                  identity.agent_id === chosen.agent_id &&
                    identity.agent_uid === chosen.runtime_uid_claim &&
                    identity.run_id === chosen.run_id &&
                    identity.provider === 'cli',
                  'WORKSPACE_IDENTITY_BINDING_MISMATCH',
                  'identity',
                );
                result.identity.state = 'MATCHED';
                const snapshot = resolvePermissionSnapshot({ registry, runtimeIdentity: identity });
                insist(
                  snapshot &&
                    Object.isFrozen(snapshot) &&
                    Object.isFrozen(snapshot.permissions) &&
                    Object.isFrozen(snapshot.permissions.paths.allow) &&
                    Object.isFrozen(snapshot.permissions.paths.deny),
                  'WORKSPACE_PERMISSION_SNAPSHOT_INVALID',
                  'authorization',
                );
                const authorization = authorizeAgentAction({
                  snapshot,
                  action: 'pr.cleanup_branch_scoped.v1',
                  changedPaths: [RECORD_PATH],
                  riskZone: 'yellow',
                });
                result.pathAuthorization = {
                  decision: authorization.decision,
                  rule: authorization.evidence.rule,
                  recordPath: RECORD_PATH,
                  immutableSnapshot: true,
                  executionContextCreated: false,
                };
                insist(
                  authorization.decision === 'allow',
                  'WORKSPACE_RECORD_PATH_DENIED',
                  'authorization',
                );
                // Revalidation reports drift; it does not claim to make a whole workspace snapshot atomic.
                for (const check of directories) checkDirectory(check, uid, gid);
              },
            );
          },
        );
      });
    });
    result.status = result.blockingIssues.length === 0 ? 'PASS' : 'BLOCKED';
  } catch (error) {
    const role = error instanceof WorkspaceRefusal ? error.role : 'workspace';
    add(boundaryCode(error, role), role);
    if (role === 'identity' && result.identity.state === 'NOT_OBSERVED')
      result.identity.state =
        boundaryCode(error, role) === 'WORKSPACE_IDENTITY_MISSING' ? 'MISSING' : 'INVALID';
  } finally {
    for (const check of [...directories].reverse()) check.anchor.close();
  }
  return result;
}
