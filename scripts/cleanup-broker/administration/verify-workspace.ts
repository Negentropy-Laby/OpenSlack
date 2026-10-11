import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import { decodeStrictJSON } from '../../../packages/core/src/strict-json.js';
import { parseRuntimeIdentityText } from '../../../packages/runtime/src/identity.js';
import {
  agentRegistryV2Schema,
  workspaceSchema,
} from '../../../packages/workspace/src/schemas/index.js';
import { parseAgentRegistryText } from '../../../packages/workspace/src/agent-registry-parser.js';
import {
  authorizeAgentAction,
  resolvePermissionSnapshot,
} from '../../../packages/kernel/src/agent-authorizer.js';
import {
  assertCleanupDescriptorSupport,
  CleanupDirectoryAnchor,
  CleanupFileBoundaryError,
  withCleanupFile,
} from '../../../packages/pr/src/internal/cleanup-file-boundary.js';

const MAX_INPUT = 2 * 1024 * 1024;
const REGISTRY_SHA256 = '33a9b46866fedd768cb859abfd36341159fc0f3a3e306462575f1f34af7e7ebc';
const RECORD_PATH = '.openslack/outbox/cleanup-operations/workspace-isolation-check.json';
const FIXED = {
  agent_id: 'cleanup_qualification_pr418',
  principal_id: 'principal:cleanup_qualification_pr418',
  runtime_uid_claim: 'cleanup_qualification_pr418',
  run_id: 'cleanup-pr418-f8db249a48c8492587e4515a31c60c45',
  workspace_id: 'openslack-self',
} as const;

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
function exact(value: unknown, keys: string[], role: string): Record<string, unknown> {
  insist(
    object(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    'WORKSPACE_SELECTION_INVALID',
    role,
  );
  return value;
}
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
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
    !/^\/(?:proc|dev)(?:\/|$)/.test(canonical) &&
      !/(?:^|\/)(?:credentials|secrets|\.env)(?:\/|$)|\.(?:pem|key)$/i.test(canonical),
    'WORKSPACE_PATH_UNSAFE',
    role,
  );
  return canonical;
}
function decode(raw: Buffer): Record<string, unknown> {
  try {
    const value = decodeStrictJSON(raw, MAX_INPUT);
    insist(object(value), 'WORKSPACE_SELECTION_INVALID', 'selection');
    return value;
  } catch {
    return refuse('WORKSPACE_SELECTION_INVALID', 'selection');
  }
}
function selection(raw: Buffer): Record<string, string> {
  const value = decode(raw);
  if (value.schema === 'openslack.cleanup_admin_selected_bindings.v1')
    exact(value, ['schema', 'selected', 'priorInput'], 'selection');
  else {
    exact(
      value,
      [
        'schema',
        'candidateHead',
        'approvalStatus',
        'priorInput',
        'selected',
        'installationAuthorized',
        'executionAuthorized',
      ],
      'selection',
    );
    insist(
      value.schema === 'openslack.cleanup_handoff_draft.v1' &&
        value.approvalStatus === 'DRAFT' &&
        value.installationAuthorized === false &&
        value.executionAuthorized === false &&
        typeof value.candidateHead === 'string' &&
        /^[a-f0-9]{40}$/.test(value.candidateHead),
      'WORKSPACE_SELECTION_INVALID',
      'selection',
    );
  }
  const prior = exact(value.priorInput, ['source', 'sha256', 'approvalNotInherited'], 'selection');
  insist(
    typeof prior.source === 'string' &&
      prior.source.length > 0 &&
      prior.source.length <= 4096 &&
      typeof prior.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(prior.sha256) &&
      prior.approvalNotInherited === true,
    'WORKSPACE_SELECTION_INVALID',
    'selection',
  );
  insist(
    object(value.selected) && Object.keys(value.selected).length <= 128,
    'WORKSPACE_SELECTION_INVALID',
    'selection',
  );
  const chosen: Record<string, string> = {};
  for (const [key, text] of Object.entries(value.selected)) {
    const statusOnly =
      /^(?:governance_read_credential_provisioned|deletion_app_key_provisioned)$/.test(key) &&
      (text === 'yes' || text === 'no');
    insist(
      /^[a-z][a-z0-9_]{0,127}$/.test(key) &&
        typeof text === 'string' &&
        text.length <= 8192 &&
        !/[\u0000-\u001f\u007f]/.test(text) &&
        (!/(?:password|private_key|token|credential)/i.test(key) || statusOnly),
      'WORKSPACE_SELECTION_INVALID',
      'selection',
    );
    chosen[key] = text;
  }
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
      chosen.qualification_repository_owner === 'Negentropy-Laby' &&
      chosen.qualification_repository_name === 'openslack-cleanup-qualification' &&
      chosen.qualification_repository_numeric_id === '1380965476' &&
      chosen.qualification_repository_default_branch === 'main',
    'WORKSPACE_SELECTED_BINDING_MISMATCH',
    'selection',
  );
  return chosen;
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

export function parseVerifyWorkspaceArguments(args: string[]): VerifyCleanupWorkspaceInput {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    insist(
      ['--workspace', '--selected-bindings', '--selected-bindings-sha256'].includes(key) &&
        value !== undefined &&
        value !== '' &&
        !value.startsWith('--') &&
        !options.has(key),
      'WORKSPACE_ARGUMENT_INVALID',
      'arguments',
    );
    options.set(key, value);
  }
  insist(
    options.size === 3 && /^[a-f0-9]{64}$/.test(options.get('--selected-bindings-sha256')!),
    'WORKSPACE_ARGUMENT_INVALID',
    'arguments',
  );
  return {
    workspace: safePath(options.get('--workspace')!, 'workspace'),
    selectedBindings: safePath(options.get('--selected-bindings')!, 'selection'),
    selectedBindingsSHA256: options.get('--selected-bindings-sha256')!,
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
      const chosen = selection(selectedBytes);
      const prior = decode(selectedBytes).priorInput as Record<string, unknown>;
      result.selection = {
        sha256: sha(selectedBytes),
        priorInputSHA256: prior.sha256 as string,
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
            remote.owner === 'Negentropy-Laby' &&
            remote.repo === 'OpenSlack' &&
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
                registry.repositories.workspace_repo.owner === 'Negentropy-Laby' &&
                registry.repositories.workspace_repo.repo === 'OpenSlack' &&
                registry.repositories.workspace_repo.default_branch === 'main' &&
                registry.repositories.allowed_product_repos?.length === 1 &&
                registry.repositories.allowed_product_repos[0] ===
                  'Negentropy-Laby/openslack-cleanup-qualification',
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyCleanupWorkspace(parseVerifyWorkspaceArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'PASS' ? 0 : 2;
  } catch {
    process.stderr.write(
      'WORKSPACE_ARGUMENT_INVALID: usage: verify-workspace.mjs --workspace <absolute directory> --selected-bindings <strict JSON selection> --selected-bindings-sha256 <SHA256>\n',
    );
    process.exitCode = 2;
  }
}
