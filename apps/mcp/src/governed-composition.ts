import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types as nodeTypes } from 'node:util';
import {
  authorizeAgentAction,
  type AgentPermissionSnapshot,
  type RiskZone,
} from '@openslack/kernel';
import {
  createBoundEventAppender,
  type BoundCollaborationEventAppender,
} from '@openslack/collaboration';
import {
  createGovernanceAuthorityHttpClient,
  createGovernedActionExecutionRegistry,
  createGovernedPlanService,
  createRoutedGovernedPlanStore,
  governedPlanAuthorityRoot,
  governedPlanStoreRoot,
  hashGovernedValue,
  LocalGovernedPlanStore,
  type CanonicalGovernedPlan,
  type GovernedActionExecutionContext,
  type GovernedJsonValue,
  type GovernedPlanBindingContext,
  type GovernedPlanHostAuthority,
  type GovernedPlanStore,
} from '@openslack/operator';
import { parseRuntimeIdentityText, resolveAgentPrincipal } from '@openslack/runtime';
import {
  createPreviewedScenarioInstance,
  createOpenSlackHostScenarioCatalog,
  discoverScenarioPacks,
  initializeScenarioInstanceStoreRoot,
  loadScenarioPack,
  LocalScenarioInstanceStore,
  previewScenario,
  rehydrateScenarioInstantiationPlan,
  transitionScenarioInstance,
  type LoadedScenarioDefinition,
  type ScenarioHostCatalog,
  type ScenarioInstantiationPlan,
} from '@openslack/scenario-runtime';
import {
  assertContractDeliveryLiteWorkflowPlan,
  compileWorkflowStartPlan,
  CONTRACT_DELIVERY_LITE_ADAPTER_ID,
  CONTRACT_DELIVERY_LITE_CAPABILITIES,
  CONTRACT_DELIVERY_LITE_EXECUTOR_ID,
  CONTRACT_DELIVERY_LITE_WORKFLOW_HASH,
  CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
  CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION,
  createContractDeliveryLiteWorkflowResolverEntry,
  createSealedWorkflowPlanResolver,
  rehydrateWorkflowStartPlan,
  type SealedWorkflowPlanResolver,
  type WorkflowStartPlan,
  WorkflowPlanError,
} from '@openslack/workflows';
import {
  parseAgentRegistryText,
  validateWorkspace,
  type ParsedAgentRegistryEntry,
} from '@openslack/workspace';
import { parse as parseYaml } from 'yaml';
import { createGovernedPlanCollaborationAuditSink } from './audit.js';
import {
  CONTRACT_DELIVERY_REHEARSAL_BUILD_SOURCE_PATH,
  executeContractDeliveryLiteWorkflow,
} from './contract-delivery-rehearsal.js';
import { OpenSlackMcpToolError } from './errors.js';
import {
  createOpenSlackGovernedMutationPort,
  type OpenSlackGovernedMutationPort,
} from './mutations.js';

const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const MAX_BINDING_FILE_BYTES = 2 * 1024 * 1024;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SCENARIO_INSTANTIATE_ACTION_POLICY = Object.freeze({
  actionId: 'scenario.instantiate',
  riskZone: 'yellow',
} as const satisfies { readonly actionId: string; readonly riskZone: RiskZone });
const ACTION_ID = SCENARIO_INSTANTIATE_ACTION_POLICY.actionId;
const WORKFLOW_ACTION_ID = 'workflow.start';
const BUILD_SOURCE_PATH = fileURLToPath(import.meta.url);
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface CreateOpenSlackAgentBoundMutationCompositionOptions {
  readonly workspaceRoot: string;
  readonly principalRef: string;
  readonly provider?: 'cli' | 'slack' | 'github' | 'webhook';
  readonly workspaceIdAssertion?: string;
  readonly governanceAuthority?: GovernedPlanAuthorityCompositionOptions;
}

export interface GovernedPlanAuthorityCompositionOptions {
  readonly backend: 'go' | 'ts-local';
  readonly routingEpoch: number;
  readonly tenantId: string;
  readonly origin?: string;
  readonly networkMode?: 'loopback' | 'internal';
  readonly expectedBuildSha?: string;
  readonly callerId?: string;
  readonly expiresAt?: string;
}

export interface OpenSlackAgentBoundMutationComposition {
  readonly authority: GovernedPlanHostAuthority;
  readonly governedMutations: OpenSlackGovernedMutationPort;
  readonly governedPlanRoot: string;
  readonly scenarioInstanceRoot: string;
  readonly scenarioIds: readonly string[];
}

export class OpenSlackGovernedCompositionError extends Error {
  readonly code:
    | 'GOVERNED_COMPOSITION_INPUT_INVALID'
    | 'GOVERNED_COMPOSITION_WORKSPACE_INVALID'
    | 'GOVERNED_COMPOSITION_PRINCIPAL_UNAVAILABLE'
    | 'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH'
    | 'GOVERNED_COMPOSITION_PERMISSION_DENIED'
    | 'GOVERNED_COMPOSITION_SCENARIO_UNAVAILABLE'
    | 'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE';

  constructor(code: OpenSlackGovernedCompositionError['code'], message: string) {
    super(message);
    this.name = 'OpenSlackGovernedCompositionError';
    this.code = code;
  }
}

interface RootBinding {
  readonly path: string;
  readonly real: string;
  readonly stat: Stats;
}

interface CurrentPrincipalBinding {
  readonly actorId: string;
  readonly stableSnapshot: Readonly<Record<string, unknown>>;
  readonly snapshot: AgentPermissionSnapshot;
  readonly registryFileHash: string;
  readonly runtimeIdentityFileHash: string;
}

interface WorkspaceBinding {
  readonly workspaceId: string;
  readonly configHash: string;
}

function fail(code: OpenSlackGovernedCompositionError['code'], message: string): never {
  throw new OpenSlackGovernedCompositionError(code, message);
}

function inspectCompositionOptions(
  value: CreateOpenSlackAgentBoundMutationCompositionOptions,
): Readonly<
  Required<
    Pick<
      CreateOpenSlackAgentBoundMutationCompositionOptions,
      'workspaceRoot' | 'principalRef' | 'provider'
    >
  > &
    Pick<
      CreateOpenSlackAgentBoundMutationCompositionOptions,
      'workspaceIdAssertion' | 'governanceAuthority'
    >
> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) {
    return fail('GOVERNED_COMPOSITION_INPUT_INVALID', 'Governed composition options are invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = [
    'workspaceRoot',
    'principalRef',
    'provider',
    'workspaceIdAssertion',
    'governanceAuthority',
  ];
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length < 2 ||
    keys.length > allowed.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    ) ||
    !descriptors.workspaceRoot ||
    !descriptors.principalRef
  ) {
    return fail('GOVERNED_COMPOSITION_INPUT_INVALID', 'Governed composition options are invalid.');
  }
  const workspaceRoot = descriptors.workspaceRoot.value;
  const principalRef = descriptors.principalRef.value;
  const provider = descriptors.provider?.value ?? 'cli';
  const workspaceIdAssertion = descriptors.workspaceIdAssertion?.value;
  const governanceAuthorityValue = descriptors.governanceAuthority?.value;
  let governanceAuthority: GovernedPlanAuthorityCompositionOptions | undefined;
  if (governanceAuthorityValue !== undefined) {
    if (
      !governanceAuthorityValue ||
      typeof governanceAuthorityValue !== 'object' ||
      nodeTypes.isProxy(governanceAuthorityValue)
    ) {
      return fail(
        'GOVERNED_COMPOSITION_INPUT_INVALID',
        'Governed composition options are invalid.',
      );
    }
    const authorityDescriptors = Object.getOwnPropertyDescriptors(governanceAuthorityValue);
    const authorityAllowed = [
      'backend',
      'routingEpoch',
      'tenantId',
      'origin',
      'networkMode',
      'expectedBuildSha',
      'callerId',
      'expiresAt',
    ];
    if (
      Reflect.ownKeys(authorityDescriptors).some(
        (key) =>
          typeof key !== 'string' ||
          !authorityAllowed.includes(key) ||
          !authorityDescriptors[key]?.enumerable ||
          !Object.hasOwn(authorityDescriptors[key]!, 'value'),
      )
    ) {
      return fail(
        'GOVERNED_COMPOSITION_INPUT_INVALID',
        'Governed composition options are invalid.',
      );
    }
    governanceAuthority = Object.freeze(
      Object.fromEntries(
        authorityAllowed.flatMap((key) =>
          authorityDescriptors[key] === undefined
            ? []
            : ([[key, authorityDescriptors[key]!.value]] as const),
        ),
      ) as unknown as GovernedPlanAuthorityCompositionOptions,
    );
  }
  if (
    typeof workspaceRoot !== 'string' ||
    typeof principalRef !== 'string' ||
    !SAFE_REFERENCE.test(principalRef) ||
    !['cli', 'slack', 'github', 'webhook'].includes(provider) ||
    (workspaceIdAssertion !== undefined &&
      (typeof workspaceIdAssertion !== 'string' || !SAFE_AUTHORITY.test(workspaceIdAssertion)))
  ) {
    return fail('GOVERNED_COMPOSITION_INPUT_INVALID', 'Governed composition options are invalid.');
  }
  return Object.freeze({
    workspaceRoot,
    principalRef,
    provider: provider as 'cli' | 'slack' | 'github' | 'webhook',
    ...(workspaceIdAssertion === undefined ? {} : { workspaceIdAssertion }),
    ...(governanceAuthority === undefined ? {} : { governanceAuthority }),
  });
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
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

function bindRoot(workspaceRootValue: string): RootBinding {
  if (
    typeof workspaceRootValue !== 'string' ||
    !isAbsolute(workspaceRootValue) ||
    resolve(workspaceRootValue) !== workspaceRootValue ||
    workspaceRootValue.includes('\0')
  ) {
    return fail(
      'GOVERNED_COMPOSITION_INPUT_INVALID',
      'Governed composition requires a normalized absolute workspace root.',
    );
  }
  let stat: Stats;
  let real: string;
  try {
    stat = lstatSync(workspaceRootValue);
    real = realpathSync.native(workspaceRootValue);
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'Governed composition workspace root is unavailable.',
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(workspaceRootValue, real)) {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'Governed composition requires a canonical non-symbolic workspace root.',
    );
  }
  return Object.freeze({ path: workspaceRootValue, real, stat });
}

function assertRootStable(binding: RootBinding): void {
  const current = lstatSync(binding.path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameIdentity(binding.stat, current) ||
    !samePath(binding.real, realpathSync.native(binding.path))
  ) {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'Governed composition workspace identity changed.',
    );
  }
}

function readStableFile(path: string, maxBytes = MAX_BINDING_FILE_BYTES): Buffer {
  const initial = lstatSync(path);
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size < 1 ||
    initial.size > maxBytes ||
    !samePath(path, realpathSync.native(path))
  ) {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'A governed binding file is missing, unsafe, or oversized.',
    );
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!stableIdentity(initial, opened)) {
      return fail(
        'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
        'A governed binding file changed before read.',
      );
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const final = lstatSync(path);
    if (
      bytes.length !== opened.size ||
      !stableIdentity(opened, after) ||
      !stableIdentity(after, final) ||
      !samePath(path, realpathSync.native(path))
    ) {
      return fail(
        'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
        'A governed binding file changed during read.',
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function currentWorkspace(binding: RootBinding): WorkspaceBinding {
  assertRootStable(binding);
  let validation: ReturnType<typeof validateWorkspace>;
  try {
    validation = validateWorkspace(binding.real);
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'The canonical OpenSlack workspace configuration is unavailable.',
    );
  }
  if (!validation.valid || !validation.config) {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'The canonical OpenSlack workspace configuration is invalid.',
    );
  }
  const configBytes = readStableFile(join(binding.real, 'openslack.yaml'));
  let parsed: unknown;
  try {
    parsed = parseYaml(decoder.decode(configBytes));
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'The canonical OpenSlack workspace configuration could not be decoded.',
    );
  }
  let exactConfig = false;
  try {
    exactConfig = hashGovernedValue(parsed) === hashGovernedValue(validation.config);
  } catch {
    exactConfig = false;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).schema !== 'openslack.workspace.v1' ||
    typeof (parsed as Record<string, unknown>).workspace_id !== 'string' ||
    (parsed as Record<string, unknown>).workspace_id !== validation.config.workspace_id ||
    !exactConfig ||
    !SAFE_AUTHORITY.test(validation.config.workspace_id)
  ) {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'The workspace authority binding is invalid.',
    );
  }
  return Object.freeze({
    workspaceId: validation.config.workspace_id,
    configHash: createHash('sha256').update(configBytes).digest('hex'),
  });
}

function validateRegistryAuthority(
  registry: ParsedAgentRegistryEntry | null,
  principalRef: string,
): ParsedAgentRegistryEntry {
  if (
    !registry ||
    registry.agent_id !== principalRef ||
    registry.identity.status !== 'active' ||
    registry.employment.status !== 'active' ||
    typeof registry.identity.uid !== 'string' ||
    !SAFE_AUTHORITY.test(registry.identity.uid) ||
    typeof registry.identity.principal_id !== 'string' ||
    !SAFE_AUTHORITY.test(registry.identity.principal_id) ||
    !registry.permissions ||
    !registry.permissions.paths ||
    !Array.isArray(registry.permissions.paths.allow) ||
    !Array.isArray(registry.permissions.paths.deny) ||
    !registry.permissions.actions ||
    typeof registry.permissions.actions !== 'object' ||
    !['green', 'yellow', 'red', 'black'].includes(registry.permissions.max_risk_zone) ||
    Object.values(registry.permissions.actions).some(
      (value) => !['allow', 'ask', 'deny'].includes(value),
    )
  ) {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH',
      'The agent registry entry does not satisfy the governed authority contract.',
    );
  }
  return registry;
}

function principalProjection(
  registry: ParsedAgentRegistryEntry,
  runtime: NonNullable<ReturnType<typeof parseRuntimeIdentityText>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    principal: Object.freeze({
      registry_id: registry.agent_id,
      runtime_uid: runtime.agent_uid,
      run_id: runtime.run_id,
      provider: runtime.provider,
      ...(runtime.authenticated_github_identity
        ? {
            authenticated_github_identity: Object.freeze({
              login: runtime.authenticated_github_identity.login,
              is_bot: runtime.authenticated_github_identity.is_bot,
            }),
          }
        : {}),
    }),
    permissions: Object.freeze({
      paths: Object.freeze({
        allow: Object.freeze([...registry.permissions.paths.allow]),
        deny: Object.freeze([...registry.permissions.paths.deny]),
      }),
      actions: Object.freeze({ ...registry.permissions.actions }),
      github: Object.freeze({ ...registry.permissions.github }),
      max_risk_zone: registry.permissions.max_risk_zone,
    }),
    source:
      registry._source_schema === 'openslack.agent_registry.v1' ? 'registry_v1' : 'registry_v2',
  });
}

function stablePermissionSnapshot(
  snapshot: AgentPermissionSnapshot,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    principal: Object.freeze({
      registryId: snapshot.principal.registry_id,
      runtimeUid: snapshot.principal.runtime_uid,
      runId: snapshot.principal.run_id,
      provider: snapshot.principal.provider,
      ...(snapshot.principal.authenticated_github_identity
        ? {
            authenticatedGitHubIdentity: Object.freeze({
              login: snapshot.principal.authenticated_github_identity.login,
              isBot: snapshot.principal.authenticated_github_identity.is_bot,
            }),
          }
        : {}),
    }),
    registryEntryAgentId: snapshot.registry_entry_agent_id,
    permissions: Object.freeze({
      paths: Object.freeze({
        allow: Object.freeze([...snapshot.permissions.paths.allow]),
        deny: Object.freeze([...snapshot.permissions.paths.deny]),
      }),
      actions: Object.freeze({ ...snapshot.permissions.actions }),
      github: Object.freeze({ ...snapshot.permissions.github }),
      maxRiskZone: snapshot.permissions.max_risk_zone,
    }),
    source: snapshot.source,
  });
}

function resolveCurrentPrincipal(
  root: string,
  principalRef: string,
  provider: 'cli' | 'slack' | 'github' | 'webhook',
): CurrentPrincipalBinding {
  const registryPath = join(root, '.openslack', 'agents', 'registry', `${principalRef}.yaml`);
  const runtimeIdentityPath = join(
    root,
    '.openslack.local',
    'agents',
    principalRef,
    'identity.yaml',
  );
  let registryBytes: Buffer;
  let runtimeIdentityBytes: Buffer;
  try {
    registryBytes = readStableFile(registryPath);
    runtimeIdentityBytes = readStableFile(runtimeIdentityPath);
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_UNAVAILABLE',
      'The principal binding files are missing or unsafe.',
    );
  }
  let parsedRegistry: ParsedAgentRegistryEntry | null;
  try {
    parsedRegistry = parseAgentRegistryText(decoder.decode(registryBytes), principalRef);
  } catch {
    parsedRegistry = null;
  }
  const registry = validateRegistryAuthority(parsedRegistry, principalRef);
  let runtimeIdentity: ReturnType<typeof parseRuntimeIdentityText>;
  try {
    runtimeIdentity = parseRuntimeIdentityText(decoder.decode(runtimeIdentityBytes));
  } catch {
    runtimeIdentity = null;
  }
  if (
    !runtimeIdentity ||
    runtimeIdentity.agent_id !== principalRef ||
    runtimeIdentity.agent_uid !== registry.identity.uid ||
    runtimeIdentity.provider !== provider
  ) {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH',
      'The stable runtime identity does not match its active registry entry.',
    );
  }
  let resolved: ReturnType<typeof resolveAgentPrincipal>;
  try {
    resolved = resolveAgentPrincipal({ root, agentId: principalRef, provider });
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_UNAVAILABLE',
      'The current agent principal could not be resolved safely.',
    );
  }
  if ('error' in resolved) {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_UNAVAILABLE',
      'The current agent principal could not be resolved.',
    );
  }
  if (
    resolved.principal.registry_id !== principalRef ||
    resolved.principal.runtime_uid !== registry.identity.uid ||
    resolved.principal.provider !== provider ||
    resolved.snapshot.registry_entry_agent_id !== principalRef ||
    resolved.snapshot.source !==
      (registry._source_schema === 'openslack.agent_registry.v1' ? 'registry_v1' : 'registry_v2') ||
    !SAFE_AUTHORITY.test(resolved.principal.run_id)
  ) {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH',
      'The runtime principal does not match its active registry entry.',
    );
  }
  let currentRegistryBytes: Buffer;
  let currentRuntimeIdentityBytes: Buffer;
  try {
    currentRegistryBytes = readStableFile(registryPath);
    currentRuntimeIdentityBytes = readStableFile(runtimeIdentityPath);
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_UNAVAILABLE',
      'The principal binding files changed during resolution.',
    );
  }
  const registryFileHash = createHash('sha256').update(registryBytes).digest('hex');
  const runtimeIdentityFileHash = createHash('sha256').update(runtimeIdentityBytes).digest('hex');
  if (
    createHash('sha256').update(currentRegistryBytes).digest('hex') !== registryFileHash ||
    createHash('sha256').update(currentRuntimeIdentityBytes).digest('hex') !==
      runtimeIdentityFileHash ||
    hashGovernedValue({
      principal: resolved.principal,
      permissions: resolved.snapshot.permissions,
      source: resolved.snapshot.source,
    }) !== hashGovernedValue(principalProjection(registry, runtimeIdentity))
  ) {
    return fail(
      'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH',
      'The resolved principal does not match the stable binding files.',
    );
  }
  const actorId = `agent-principal:sha256:${hashGovernedValue({
    principalId: registry.identity.principal_id,
    registryId: resolved.principal.registry_id,
    runtimeUid: resolved.principal.runtime_uid,
    runId: resolved.principal.run_id,
    provider: resolved.principal.provider,
  })}`;
  return Object.freeze({
    actorId,
    snapshot: resolved.snapshot,
    stableSnapshot: stablePermissionSnapshot(resolved.snapshot),
    registryFileHash,
    runtimeIdentityFileHash,
  });
}

function authorizeScenarioMutation(binding: CurrentPrincipalBinding): void {
  const decision = authorizeAgentAction({
    snapshot: binding.snapshot,
    action: SCENARIO_INSTANTIATE_ACTION_POLICY.actionId,
    riskZone: SCENARIO_INSTANTIATE_ACTION_POLICY.riskZone,
  });
  if (decision.decision !== 'allow') {
    throw new OpenSlackMcpToolError(
      'GOVERNED_ACTION_NOT_AUTHORIZED',
      'The current agent principal is not granted this governed Scenario mutation.',
      'blocked',
    );
  }
}

function authorizeContractDeliveryWorkflow(binding: CurrentPrincipalBinding): void {
  for (const action of CONTRACT_DELIVERY_LITE_CAPABILITIES) {
    const decision = authorizeAgentAction({
      snapshot: binding.snapshot,
      action,
      riskZone: 'yellow',
    });
    if (decision.decision !== 'allow') {
      throw new OpenSlackMcpToolError(
        'GOVERNED_ACTION_NOT_AUTHORIZED',
        'The current agent principal is not granted the reviewed local Workflow capability.',
        'blocked',
      );
    }
  }
}

function ensureChild(parent: string, child: string): void {
  if (!contained(parent, child)) {
    return fail(
      'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE',
      'Governed local state must remain inside the workspace.',
    );
  }
  try {
    mkdirSync(child, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const symbolic = lstatSync(child);
  const actual = statSync(child);
  const real = realpathSync.native(child);
  if (
    symbolic.isSymbolicLink() ||
    !symbolic.isDirectory() ||
    !actual.isDirectory() ||
    !samePath(child, real) ||
    !contained(parent, real)
  ) {
    return fail(
      'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE',
      'Governed local state directory is unsafe.',
    );
  }
}

function scenarioPlanFromActionInput(value: GovernedJsonValue): ScenarioInstantiationPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_SCENARIO_PLAN_INVALID',
      'The persisted Scenario action is invalid.',
    );
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'scenarioPlan') {
    throw new OpenSlackMcpToolError(
      'GOVERNED_SCENARIO_PLAN_INVALID',
      'The persisted Scenario action has an invalid shape.',
    );
  }
  return (value as unknown as { readonly scenarioPlan: ScenarioInstantiationPlan }).scenarioPlan;
}

function workflowPlanFromActionInput(value: GovernedJsonValue): WorkflowStartPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_WORKFLOW_PLAN_INVALID',
      'The persisted Workflow action is invalid.',
    );
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'workflowPlan') {
    throw new OpenSlackMcpToolError(
      'GOVERNED_WORKFLOW_PLAN_INVALID',
      'The persisted Workflow action has an invalid shape.',
    );
  }
  return (value as unknown as { readonly workflowPlan: WorkflowStartPlan }).workflowPlan;
}

function definitionBinding(
  definition: LoadedScenarioDefinition,
  scenarioRoot: string,
): Readonly<Record<string, unknown>> {
  const lockBytes = readStableFile(
    join(scenarioRoot, definition.manifest.id, 'scenario.lock.json'),
  );
  return Object.freeze({
    id: definition.manifest.id,
    version: definition.manifest.version,
    definitionHash: definition.definitionHash,
    lockFileHash: createHash('sha256').update(lockBytes).digest('hex'),
    files: Object.freeze(
      definition.files.map((file) =>
        Object.freeze({
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
        }),
      ),
    ),
  });
}

function risk(value: 'none' | 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  return value === 'none' ? 'low' : value;
}

function asScenarioInput(value: Readonly<Record<string, unknown>>): {
  readonly scenarioId: string;
  readonly input: Readonly<Record<string, unknown>>;
} {
  if (nodeTypes.isProxy(value)) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_SCENARIO_INPUT_INVALID',
      'The governed Scenario preview input is invalid.',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never) ||
    Reflect.ownKeys(descriptors).length !== 2 ||
    !descriptors.scenarioId?.enumerable ||
    !Object.hasOwn(descriptors.scenarioId, 'value') ||
    !descriptors.input?.enumerable ||
    !Object.hasOwn(descriptors.input, 'value') ||
    typeof descriptors.scenarioId.value !== 'string' ||
    !descriptors.input.value ||
    typeof descriptors.input.value !== 'object' ||
    Array.isArray(descriptors.input.value)
  ) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_SCENARIO_INPUT_INVALID',
      'The governed Scenario preview input is invalid.',
    );
  }
  return Object.freeze({
    scenarioId: descriptors.scenarioId.value,
    input: descriptors.input.value as Readonly<Record<string, unknown>>,
  });
}

function asWorkflowInput(value: Readonly<Record<string, unknown>>): {
  readonly workflowId: string;
  readonly input: unknown;
} {
  if (nodeTypes.isProxy(value)) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_WORKFLOW_INPUT_INVALID',
      'The governed Workflow preview input is invalid.',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never) ||
    Reflect.ownKeys(descriptors).length !== 2 ||
    !descriptors.workflowId?.enumerable ||
    !Object.hasOwn(descriptors.workflowId, 'value') ||
    !descriptors.input?.enumerable ||
    !Object.hasOwn(descriptors.input, 'value') ||
    typeof descriptors.workflowId.value !== 'string'
  ) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_WORKFLOW_INPUT_INVALID',
      'The governed Workflow preview input is invalid.',
    );
  }
  return Object.freeze({
    workflowId: descriptors.workflowId.value,
    input: descriptors.input.value,
  });
}

async function assertPlanMatchesDefinitions(
  plan: CanonicalGovernedPlan,
  definitions: ReadonlyMap<string, LoadedScenarioDefinition>,
  authority: GovernedPlanHostAuthority,
  workflowResolver: SealedWorkflowPlanResolver,
  scenarioInstanceRoot: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (plan.actions.length !== 1) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_ACTION_NOT_AUTHORIZED',
      'The governed action plan is not registered for this composition.',
      'blocked',
    );
  }
  if (plan.kind === ACTION_ID && plan.actions[0]?.actionId === ACTION_ID) {
    const persisted = scenarioPlanFromActionInput(plan.actions[0].input);
    const current = definitions.get(persisted.definitionId);
    if (
      !current ||
      current.definitionHash !== persisted.definitionHash ||
      persisted.actorId !== authority.actorId ||
      persisted.workspaceId !== authority.workspaceId
    ) {
      throw new OpenSlackMcpToolError(
        'GOVERNED_SCENARIO_BINDING_CHANGED',
        'The locked Scenario definition or host authority changed before mutation.',
        'blocked',
      );
    }
    return Object.freeze({
      kind: ACTION_ID,
      definitionId: current.manifest.id,
      definitionHash: current.definitionHash,
    });
  }
  if (
    plan.kind !== WORKFLOW_ACTION_ID ||
    plan.actions[0]?.actionId !== CONTRACT_DELIVERY_LITE_EXECUTOR_ID
  ) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_ACTION_NOT_AUTHORIZED',
      'The governed action plan is not registered for this composition.',
      'blocked',
    );
  }
  const persisted = workflowPlanFromActionInput(plan.actions[0].input);
  const restored = rehydrateWorkflowStartPlan(persisted, {
    resolver: workflowResolver,
    planHash: persisted.planHash,
    actorId: authority.actorId,
    workspaceId: authority.workspaceId,
    correlationId: persisted.correlationId,
    workflowHash: CONTRACT_DELIVERY_LITE_WORKFLOW_HASH,
    now: new Date().toISOString(),
  });
  const workflowInput = assertContractDeliveryLiteWorkflowPlan(restored);
  const definition = definitions.get('contract-to-delivery-lite');
  const scenario = await new LocalScenarioInstanceStore(
    scenarioInstanceRoot,
    workflowInput.scenarioCorrelationId,
  ).readWithRevision(workflowInput.scenarioInstanceId);
  if (
    !definition ||
    !scenario ||
    scenario.instance.state !== 'active' ||
    scenario.instance.definitionId !== definition.manifest.id ||
    scenario.instance.definitionHash !== definition.definitionHash
  ) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_WORKFLOW_BINDING_CHANGED',
      'The reviewed Workflow or active Scenario binding changed before mutation.',
      'blocked',
    );
  }
  return Object.freeze({
    kind: WORKFLOW_ACTION_ID,
    workflowPlanHash: restored.planHash,
    workflowResolverHash: workflowResolver.integrityHash,
    scenarioInstanceId: scenario.instance.id,
    scenarioInstanceRevision: scenario.revision,
    scenarioDefinitionHash: definition.definitionHash,
  });
}

export async function createOpenSlackAgentBoundMutationComposition(
  options: CreateOpenSlackAgentBoundMutationCompositionOptions,
): Promise<OpenSlackAgentBoundMutationComposition> {
  const safeOptions = inspectCompositionOptions(options);
  const provider = safeOptions.provider;
  const rootBinding = bindRoot(safeOptions.workspaceRoot);
  const initialWorkspace = currentWorkspace(rootBinding);
  if (
    safeOptions.workspaceIdAssertion !== undefined &&
    safeOptions.workspaceIdAssertion !== initialWorkspace.workspaceId
  ) {
    return fail(
      'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
      'The workspace assertion does not match canonical openslack.yaml.',
    );
  }
  const initialPrincipal = resolveCurrentPrincipal(
    rootBinding.real,
    safeOptions.principalRef,
    provider,
  );
  try {
    authorizeScenarioMutation(initialPrincipal);
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_PERMISSION_DENIED',
      'The selected principal is not granted scenario.instantiate.',
    );
  }

  const scenarioRoot = join(rootBinding.real, 'scenarios');
  const scenarioCatalog: ScenarioHostCatalog = createOpenSlackHostScenarioCatalog();
  let discovery;
  try {
    discovery = await discoverScenarioPacks({
      scenarioRoot,
      catalog: scenarioCatalog,
    });
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_SCENARIO_UNAVAILABLE',
      'The locked Scenario root could not be discovered safely.',
    );
  }
  if (discovery.accepted.length === 0) {
    return fail(
      'GOVERNED_COMPOSITION_SCENARIO_UNAVAILABLE',
      'No locked Scenario Pack is available to the governed composition.',
    );
  }
  const scenarioIds = Object.freeze(
    discovery.accepted.map((definition) => definition.manifest.id).sort(),
  );
  const initialDefinitions = new Map(
    discovery.accepted.map((definition) => [definition.manifest.id, definition] as const),
  );
  const reviewedWorkflow = createContractDeliveryLiteWorkflowResolverEntry();
  const catalogWorkflow = scenarioCatalog.workflow(CONTRACT_DELIVERY_LITE_WORKFLOW_ID);
  const catalogAdapter = scenarioCatalog.adapter(CONTRACT_DELIVERY_LITE_ADAPTER_ID);
  if (
    !catalogWorkflow ||
    catalogWorkflow.version !== CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION ||
    catalogWorkflow.adapterId !== CONTRACT_DELIVERY_LITE_ADAPTER_ID ||
    JSON.stringify(catalogWorkflow.capabilityIds) !==
      JSON.stringify(CONTRACT_DELIVERY_LITE_CAPABILITIES) ||
    !catalogAdapter ||
    catalogAdapter.kind !== 'workflow' ||
    JSON.stringify(catalogAdapter.capabilityIds) !==
      JSON.stringify(CONTRACT_DELIVERY_LITE_CAPABILITIES)
  ) {
    return fail(
      'GOVERNED_COMPOSITION_SCENARIO_UNAVAILABLE',
      'The reviewed Contract-to-Delivery Workflow catalog binding is unavailable.',
    );
  }
  const workflowResolver = createSealedWorkflowPlanResolver({
    entries: [reviewedWorkflow],
  });

  let audit;
  let planStore: GovernedPlanStore;
  let scenarioInstanceRoot: string;
  let workflowEventAppender: BoundCollaborationEventAppender;
  try {
    audit = createGovernedPlanCollaborationAuditSink(rootBinding.real);
    workflowEventAppender = createBoundEventAppender(rootBinding.real);
    const localRoot = join(rootBinding.real, '.openslack.local');
    ensureChild(rootBinding.real, localRoot);
    const operatorRoot = join(localRoot, 'operator');
    ensureChild(localRoot, operatorRoot);
    const planRoot = governedPlanStoreRoot(rootBinding.real);
    ensureChild(operatorRoot, planRoot);
    const localPlanStore = new LocalGovernedPlanStore(planRoot);
    const authorityPolicy = safeOptions.governanceAuthority ?? {
      backend: 'ts-local' as const,
      routingEpoch: 1,
      tenantId: initialWorkspace.workspaceId,
    };
    if (authorityPolicy.tenantId !== initialWorkspace.workspaceId) {
      return fail(
        'GOVERNED_COMPOSITION_WORKSPACE_INVALID',
        'Governance authority tenant does not match canonical openslack.yaml.',
      );
    }
    const hasTransport = [
      authorityPolicy.origin,
      authorityPolicy.expectedBuildSha,
      authorityPolicy.callerId,
      authorityPolicy.expiresAt,
    ].some((value) => value !== undefined);
    const transport = hasTransport
      ? createGovernanceAuthorityHttpClient({
          origin: authorityPolicy.origin!,
          workspaceId: initialWorkspace.workspaceId,
          callerId: authorityPolicy.callerId!,
          expectedBuildSha: authorityPolicy.expectedBuildSha!,
          expiresAt: authorityPolicy.expiresAt!,
          ...(authorityPolicy.networkMode === undefined
            ? {}
            : { networkMode: authorityPolicy.networkMode }),
        })
      : undefined;
    planStore = await createRoutedGovernedPlanStore({
      routeRoot: governedPlanAuthorityRoot(rootBinding.real),
      localStore: localPlanStore,
      backend: authorityPolicy.backend,
      routingEpoch: authorityPolicy.routingEpoch,
      ...(transport === undefined ? {} : { go: transport }),
    });
    await planStore.recoverAudits?.(audit);
    await planStore.list();
    scenarioInstanceRoot = await initializeScenarioInstanceStoreRoot(rootBinding.real);
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE',
      'Governed plan, Scenario instance, or audit storage could not be initialized safely.',
    );
  }

  const readBuildHash = (): string =>
    createHash('sha256')
      .update(readStableFile(BUILD_SOURCE_PATH))
      .update(readStableFile(CONTRACT_DELIVERY_REHEARSAL_BUILD_SOURCE_PATH))
      .update(CONTRACT_DELIVERY_LITE_WORKFLOW_HASH, 'utf8')
      .digest('hex');
  let initialBuildHash: string;
  try {
    initialBuildHash = readBuildHash();
  } catch {
    return fail(
      'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE',
      'The governed composition build artifact could not be bound safely.',
    );
  }
  const authority = Object.freeze({
    actorId: initialPrincipal.actorId,
    workspaceId: initialWorkspace.workspaceId,
  });

  const loadDefinitions = async (): Promise<ReadonlyMap<string, LoadedScenarioDefinition>> => {
    try {
      const entries = await Promise.all(
        scenarioIds.map(async (scenarioId) => {
          const definition = await loadScenarioPack({
            scenarioRoot,
            scenarioId,
            catalog: scenarioCatalog,
          });
          return [scenarioId, definition] as const;
        }),
      );
      return new Map(entries);
    } catch {
      throw new OpenSlackMcpToolError(
        'GOVERNED_SCENARIO_BINDING_CHANGED',
        'A process-sealed Scenario definition is unavailable or unsafe.',
        'blocked',
      );
    }
  };
  const assertDefinitionSetStable = (
    current: ReadonlyMap<string, LoadedScenarioDefinition>,
  ): void => {
    if (
      current.size !== initialDefinitions.size ||
      scenarioIds.some((id) => {
        const initial = initialDefinitions.get(id);
        const loaded = current.get(id);
        return (
          !initial ||
          !loaded ||
          initial.definitionHash !== loaded.definitionHash ||
          initial.manifest.version !== loaded.manifest.version
        );
      })
    ) {
      throw new OpenSlackMcpToolError(
        'GOVERNED_SCENARIO_BINDING_CHANGED',
        'A process-sealed Scenario definition changed; restart is required.',
        'blocked',
      );
    }
  };

  const assertCurrentAuthority = (): CurrentPrincipalBinding => {
    let currentWorkspaceBinding: WorkspaceBinding;
    try {
      currentWorkspaceBinding = currentWorkspace(rootBinding);
    } catch {
      throw new OpenSlackMcpToolError(
        'GOVERNED_WORKSPACE_BINDING_CHANGED',
        'The canonical workspace binding is unavailable or unsafe.',
        'blocked',
      );
    }
    if (currentWorkspaceBinding.workspaceId !== authority.workspaceId) {
      throw new OpenSlackMcpToolError(
        'GOVERNED_WORKSPACE_BINDING_CHANGED',
        'The canonical workspace authority changed.',
        'blocked',
      );
    }
    let current: CurrentPrincipalBinding;
    try {
      current = resolveCurrentPrincipal(rootBinding.real, safeOptions.principalRef, provider);
    } catch {
      throw new OpenSlackMcpToolError(
        'GOVERNED_PRINCIPAL_BINDING_CHANGED',
        'The current governed principal binding is unavailable or unsafe.',
        'blocked',
      );
    }
    if (current.actorId !== authority.actorId) {
      throw new OpenSlackMcpToolError(
        'GOVERNED_PRINCIPAL_BINDING_CHANGED',
        'The current runtime principal changed.',
        'blocked',
      );
    }
    authorizeScenarioMutation(current);
    return current;
  };

  const registry = createGovernedActionExecutionRegistry([
    {
      actionId: ACTION_ID,
      version: '1.0.0',
      bindingId: `scenario-instance-store:v1:${initialBuildHash.slice(0, 32)}`,
      description: 'Persist one locked Scenario instance through CAS and durable readback.',
      execute: async (input, context: GovernedActionExecutionContext) => {
        const currentPrincipal = assertCurrentAuthority();
        const definitions = await loadDefinitions();
        assertDefinitionSetStable(definitions);
        const persisted = scenarioPlanFromActionInput(input);
        const definition = definitions.get(persisted.definitionId);
        if (!definition) {
          throw new OpenSlackMcpToolError(
            'GOVERNED_SCENARIO_BINDING_CHANGED',
            'The locked Scenario definition is unavailable.',
            'blocked',
          );
        }
        const expected = previewScenario({
          definition,
          catalog: scenarioCatalog,
          input: persisted.normalizedInput,
          targetRefs: persisted.targetRefs,
          actor: {
            id: currentPrincipal.actorId,
            permissions: {
              capabilities: [...scenarioCatalog.capabilityIds()].filter(
                (id) => currentPrincipal.snapshot.permissions.actions[id] === 'allow',
              ),
            },
          },
          workspaceId: context.workspaceId,
          correlationId: context.correlationId,
          createdAt: persisted.createdAt,
          expiresAt: persisted.expiresAt,
        });
        const restored = rehydrateScenarioInstantiationPlan(persisted, {
          planHash: expected.planHash,
          actorId: context.actorId,
          workspaceId: context.workspaceId,
          correlationId: context.correlationId,
          definitionHash: definition.definitionHash,
          now: new Date().toISOString(),
        });
        const store = new LocalScenarioInstanceStore(scenarioInstanceRoot, restored.correlationId);
        const previewed = await store.write(createPreviewedScenarioInstance(restored), {
          expectedRevision: null,
        });
        const instantiating = await store.write(
          transitionScenarioInstance(previewed.instance, {
            state: 'instantiating',
            updatedAt: new Date().toISOString(),
            evidenceRefs: [`plan:${context.planId}`],
          }),
          { expectedRevision: previewed.revision },
        );
        const activated = await store.write(
          transitionScenarioInstance(instantiating.instance, {
            state: 'active',
            updatedAt: new Date().toISOString(),
            evidenceRefs: [
              `plan:${context.planId}`,
              `artifact:scenario-instance:${restored.scenarioInstanceId}`,
            ],
          }),
          { expectedRevision: instantiating.revision },
        );
        const readback = await store.readWithRevision(restored.scenarioInstanceId);
        if (
          !readback ||
          readback.revision !== activated.revision ||
          readback.instance.state !== 'active' ||
          readback.instance.planId !== restored.planId ||
          readback.instance.planHash !== restored.planHash ||
          readback.instance.definitionHash !== definition.definitionHash ||
          readback.instance.correlationId !== context.correlationId
        ) {
          throw new OpenSlackMcpToolError(
            'GOVERNED_SCENARIO_READBACK_UNVERIFIED',
            'The Scenario instance durable readback could not be verified.',
          );
        }
        return {
          status: 'succeeded' as const,
          summary: 'The locked Scenario instance is active and durably verified.',
          data: {
            scenarioInstanceId: readback.instance.id,
            state: readback.instance.state,
            revision: readback.revision,
            definitionHash: readback.instance.definitionHash,
            scenarioPlanHash: readback.instance.planHash,
          },
          evidenceRefs: [
            `artifact:scenario-instance:${readback.instance.id}`,
            `plan:${context.planId}`,
          ],
        };
      },
    },
    {
      actionId: CONTRACT_DELIVERY_LITE_EXECUTOR_ID,
      version: CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION,
      bindingId: `contract-delivery-local:v1:${initialBuildHash.slice(0, 32)}`,
      description:
        'Execute the reviewed credential-free Contract-to-Delivery local rehearsal and persist its evidence.',
      execute: async (input, context: GovernedActionExecutionContext) => {
        const currentPrincipal = assertCurrentAuthority();
        authorizeContractDeliveryWorkflow(currentPrincipal);
        const definitions = await loadDefinitions();
        assertDefinitionSetStable(definitions);
        const persisted = workflowPlanFromActionInput(input);
        const restored = rehydrateWorkflowStartPlan(persisted, {
          resolver: workflowResolver,
          planHash: persisted.planHash,
          actorId: context.actorId,
          workspaceId: context.workspaceId,
          correlationId: context.correlationId,
          workflowHash: CONTRACT_DELIVERY_LITE_WORKFLOW_HASH,
          now: new Date().toISOString(),
        });
        const definition = definitions.get('contract-to-delivery-lite');
        if (!definition) {
          throw new OpenSlackMcpToolError(
            'GOVERNED_WORKFLOW_BINDING_CHANGED',
            'The locked Contract-to-Delivery Scenario definition is unavailable.',
            'blocked',
          );
        }
        const execution = await executeContractDeliveryLiteWorkflow({
          workflowPlan: restored,
          context,
          definition,
          scenarioInstanceRoot,
          eventAppender: workflowEventAppender,
          provider,
        });
        return {
          status: 'succeeded' as const,
          summary:
            'The reviewed Contract-to-Delivery local Workflow completed with durable evidence.',
          data: execution.receipt,
          evidenceRefs: execution.evidenceRefs,
        };
      },
    },
  ]);

  const getBindingSnapshot = async (
    context: GovernedPlanBindingContext,
  ): Promise<{
    readonly sourceVersions: unknown;
    readonly permissionSnapshot: unknown;
    readonly buildNonce: string;
  }> => {
    const currentPrincipal = assertCurrentAuthority();
    let workspace: WorkspaceBinding;
    try {
      workspace = currentWorkspace(rootBinding);
    } catch {
      throw new OpenSlackMcpToolError(
        'GOVERNED_WORKSPACE_BINDING_CHANGED',
        'The canonical workspace binding is unavailable or unsafe.',
        'blocked',
      );
    }
    const definitions = await loadDefinitions();
    assertDefinitionSetStable(definitions);
    if (context.canonicalPlan.kind === WORKFLOW_ACTION_ID) {
      authorizeContractDeliveryWorkflow(currentPrincipal);
    }
    const planSubjectBinding = await assertPlanMatchesDefinitions(
      context.canonicalPlan,
      definitions,
      context.authority,
      workflowResolver,
      scenarioInstanceRoot,
    );
    let buildArtifactHash: string;
    try {
      buildArtifactHash = readBuildHash();
    } catch {
      throw new OpenSlackMcpToolError(
        'GOVERNED_BUILD_BINDING_CHANGED',
        'The governed composition build binding is unavailable or unsafe.',
        'blocked',
      );
    }
    return Object.freeze({
      sourceVersions: Object.freeze({
        workspace: Object.freeze({
          workspaceId: workspace.workspaceId,
          configHash: workspace.configHash,
        }),
        scenarioCatalogHash: scenarioCatalog.integrityHash,
        workflowResolverHash: workflowResolver.integrityHash,
        planSubjectBinding,
        principalSources: Object.freeze({
          registryFileHash: currentPrincipal.registryFileHash,
          runtimeIdentityFileHash: currentPrincipal.runtimeIdentityFileHash,
        }),
        scenarioDefinitions: (() => {
          try {
            return Object.freeze(
              scenarioIds.map((id) => definitionBinding(definitions.get(id)!, scenarioRoot)),
            );
          } catch {
            throw new OpenSlackMcpToolError(
              'GOVERNED_SCENARIO_BINDING_CHANGED',
              'A process-sealed Scenario lock binding is unavailable or unsafe.',
              'blocked',
            );
          }
        })(),
        buildArtifactHash,
        storeBindings: Object.freeze({
          governedPlan: 'openslack.governed_plan.v1',
          scenarioInstance: 'openslack.scenario_instance.v1',
        }),
      }),
      permissionSnapshot: currentPrincipal.stableSnapshot,
      buildNonce: buildArtifactHash,
    });
  };

  const service = createGovernedPlanService({
    store: planStore,
    registry,
    getBindingSnapshot,
    audit,
  });

  const governedMutations = createOpenSlackGovernedMutationPort({
    service,
    authority,
    compileScenario: async ({ input, authority: compilerAuthority, compilation }) => {
      if (
        compilerAuthority.actorId !== authority.actorId ||
        compilerAuthority.workspaceId !== authority.workspaceId
      ) {
        throw new OpenSlackMcpToolError(
          'GOVERNED_PRINCIPAL_BINDING_CHANGED',
          'The governed compiler authority changed.',
          'blocked',
        );
      }
      const currentPrincipal = assertCurrentAuthority();
      const request = asScenarioInput(input);
      if (!scenarioIds.includes(request.scenarioId)) {
        throw new OpenSlackMcpToolError(
          'GOVERNED_SCENARIO_NOT_REGISTERED',
          'The requested Scenario is not registered in this process-sealed composition.',
          'blocked',
        );
      }
      const definition = initialDefinitions.get(request.scenarioId)!;
      const scenarioPlan = previewScenario({
        definition,
        catalog: scenarioCatalog,
        input: request.input,
        targetRefs: [],
        actor: {
          id: currentPrincipal.actorId,
          permissions: {
            capabilities: [...scenarioCatalog.capabilityIds()].filter(
              (id) => currentPrincipal.snapshot.permissions.actions[id] === 'allow',
            ),
          },
        },
        workspaceId: authority.workspaceId,
        correlationId: compilation.correlationId,
        createdAt: compilation.createdAt,
        expiresAt: compilation.expiresAt,
      });
      for (const effect of scenarioPlan.effects) {
        if (effect.kind !== WORKFLOW_ACTION_ID) continue;
        const target = workflowResolver.resolve(effect.workflowId);
        if (
          !target ||
          target.version !== effect.workflowVersion ||
          target.adapterId !== effect.adapterId ||
          JSON.stringify(target.capabilityIds) !== JSON.stringify(effect.capabilityIds)
        ) {
          throw new OpenSlackMcpToolError(
            'GOVERNED_WORKFLOW_TARGET_NOT_REGISTERED',
            'The Scenario requires a Workflow target outside the sealed reviewed resolver.',
            'blocked',
          );
        }
      }
      return {
        kind: ACTION_ID,
        goal: `Instantiate locked Scenario ${scenarioPlan.definitionId}.`,
        input: {
          scenarioId: scenarioPlan.definitionId,
          normalizedInput: scenarioPlan.normalizedInput,
          targetRefs: scenarioPlan.targetRefs,
        },
        actions: [
          {
            actionId: ACTION_ID,
            input: { scenarioPlan },
          },
        ],
        effects: scenarioPlan.effects.map((effect) => ({
          type: effect.kind,
          summary: effect.summary,
          risk: risk(effect.risk),
          target: scenarioPlan.scenarioInstanceId,
        })),
      };
    },
    compileWorkflow: async ({ input, authority: compilerAuthority, compilation }) => {
      if (
        compilerAuthority.actorId !== authority.actorId ||
        compilerAuthority.workspaceId !== authority.workspaceId
      ) {
        throw new OpenSlackMcpToolError(
          'GOVERNED_PRINCIPAL_BINDING_CHANGED',
          'The governed compiler authority changed.',
          'blocked',
        );
      }
      const currentPrincipal = assertCurrentAuthority();
      const request = asWorkflowInput(input);
      let workflowPlan: WorkflowStartPlan;
      try {
        workflowPlan = compileWorkflowStartPlan({
          resolver: workflowResolver,
          workflowId: request.workflowId,
          input: request.input,
          authorityBindings: [],
          actorId: authority.actorId,
          workspaceId: authority.workspaceId,
          correlationId: compilation.correlationId,
          createdAt: compilation.createdAt,
          expiresAt: compilation.expiresAt,
        });
      } catch (error) {
        if (error instanceof WorkflowPlanError && error.code === 'WORKFLOW_PLAN_TARGET_MISSING') {
          throw new OpenSlackMcpToolError(
            'GOVERNED_WORKFLOW_TARGET_NOT_REGISTERED',
            'No sealed reviewed Workflow target is registered for this composition.',
            'blocked',
          );
        }
        throw error;
      }
      authorizeContractDeliveryWorkflow(currentPrincipal);
      const workflowInput = assertContractDeliveryLiteWorkflowPlan(workflowPlan);
      const definition = initialDefinitions.get('contract-to-delivery-lite');
      const scenario = await new LocalScenarioInstanceStore(
        scenarioInstanceRoot,
        workflowInput.scenarioCorrelationId,
      ).readWithRevision(workflowInput.scenarioInstanceId);
      if (
        !definition ||
        !scenario ||
        scenario.instance.state !== 'active' ||
        scenario.instance.definitionId !== definition.manifest.id ||
        scenario.instance.definitionHash !== definition.definitionHash
      ) {
        throw new OpenSlackMcpToolError(
          'GOVERNED_WORKFLOW_SCENARIO_NOT_ACTIVE',
          'The reviewed Workflow requires its active locked Contract-to-Delivery Scenario.',
          'blocked',
        );
      }
      return {
        kind: WORKFLOW_ACTION_ID,
        goal: 'Run the reviewed credential-free Contract-to-Delivery local rehearsal.',
        input: {
          workflowId: workflowPlan.workflow.id,
          normalizedInput: workflowPlan.normalizedInput,
        },
        actions: [
          {
            actionId: CONTRACT_DELIVERY_LITE_EXECUTOR_ID,
            input: { workflowPlan },
          },
        ],
        effects: [
          {
            type: WORKFLOW_ACTION_ID,
            summary: `Start reviewed Workflow ${workflowPlan.workflow.id}.`,
            risk: workflowPlan.risk,
            target: workflowInput.scenarioInstanceId,
          },
        ],
      };
    },
  });

  return Object.freeze({
    authority,
    governedMutations,
    governedPlanRoot: governedPlanStoreRoot(rootBinding.real),
    scenarioInstanceRoot,
    scenarioIds,
  });
}
