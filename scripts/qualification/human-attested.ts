import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  bindLocalHumanSubject,
  createLocalHumanAttestationProvider,
  LocalWorkflowEffectApprovalStore,
} from '../../packages/workflows/src/index.js';
import {
  OPENSLACK_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
} from '../../packages/qoder-adapter/src/index.js';
import {
  assertCanonicalTimestamp,
  assertExactRecord,
  assertSensitiveDataAbsent,
  candidateRevision,
  GIT_OBJECT_ID,
  QualificationError,
  SHA256,
  sha256Bytes,
} from './common.js';

export const HUMAN_ATTESTED_QUALIFICATION_SCHEMA =
  'openslack.human_attested_profile_qualification.v1' as const;
export const HUMAN_ATTESTED_QUALIFICATION_CLAIM = 'HUMAN_ATTESTED_PROFILE_LOCAL_PASS' as const;
export const HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL = 'human:founder' as const;
export const HUMAN_ATTESTED_QUALIFICATION_AGENT = 'qoder_qualification_agent' as const;
export const HUMAN_ATTESTED_QUALIFICATION_WORKSPACE = 'qoder-human-attested-qualification' as const;

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
const WORKSPACE_PREFIX = 'openslack-human-attested-qualification-';
const RUN_ID = 'run-qoder-human-attested-qualification';
const APPROVAL_ID = 'approval-qoder-human-attested-synthetic-effect';
const CORRELATION_ID = 'correlation-qoder-human-attested-qualification';
const WORKFLOW_ID = 'qualification.synthetic.low-risk';
const DECISION_REASON =
  'Approve the isolated synthetic local effect after reviewing its exact bounded evidence.';
const EXPECTED_TOOLS = Object.freeze([
  ...OPENSLACK_READ_TOOL_NAMES,
  ...OPENSLACK_MUTATION_TOOL_NAMES,
]);
const AUDIT_EVENT = /^WFAPPROVAL-AUDIT-[0-9a-f]{64}$/;

export interface HumanAttestedQualificationOptions {
  readonly humanPrincipal: string;
  readonly confirmed: true;
}

export interface HumanAttestedQualificationReceipt {
  readonly schema: typeof HUMAN_ATTESTED_QUALIFICATION_SCHEMA;
  readonly status: 'completed';
  readonly claim: typeof HUMAN_ATTESTED_QUALIFICATION_CLAIM;
  readonly candidate: {
    readonly commit: string;
    readonly tree: string;
  };
  readonly profile: {
    readonly toolCount: 17;
    readonly toolNames: readonly string[];
  };
  readonly principal: {
    readonly agentRef: typeof HUMAN_ATTESTED_QUALIFICATION_AGENT;
    readonly humanPrincipalId: typeof HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL;
    readonly osSubjectProvider: 'windows_os_subject' | 'posix_os_subject';
  };
  readonly transport: {
    readonly mcp: 'stdio';
    readonly humanAttestation: 'CON' | '/dev/tty';
    readonly separated: true;
  };
  readonly decision: {
    readonly runId: typeof RUN_ID;
    readonly approvalId: typeof APPROVAL_ID;
    readonly correlationId: typeof CORRELATION_ID;
    readonly value: 'approved';
    readonly reasonHash: string;
    readonly revisionBefore: 0;
    readonly revisionAfter: 2;
    readonly auditProjection: 'recorded';
    readonly auditEventId: string;
  };
  readonly cleanup: {
    readonly temporaryWorkspace: 'removed';
    readonly subjectMapping: 'removed';
    readonly approvalStore: 'removed';
  };
  readonly completedAt: string;
}

function blocked(code: string, message: string): never {
  throw new QualificationError(code, message);
}

function workspaceYaml(): string {
  return [
    'schema: openslack.workspace.v1',
    `workspace_id: ${HUMAN_ATTESTED_QUALIFICATION_WORKSPACE}`,
    'name: Qoder Human Attested Qualification',
    'mode: normal',
    'canonical_remote:',
    '  provider: github',
    '  owner: openslack-local',
    '  repo: qoder-human-attested-qualification',
    '  default_branch: main',
    'workspace:',
    '  root: "."',
    '  state_root: ".openslack"',
    'product:',
    '  repo_role: managed',
    '  source_roots: []',
    '  protected_roots: []',
    '',
  ].join('\n');
}

export function humanQualificationRegistryYaml(): string {
  return [
    'schema: openslack.agent_registry.v2',
    `agent_id: ${HUMAN_ATTESTED_QUALIFICATION_AGENT}`,
    'display_name: Qoder Qualification Agent',
    'identity:',
    `  uid: ${HUMAN_ATTESTED_QUALIFICATION_AGENT}-uid`,
    `  principal_id: principal:${HUMAN_ATTESTED_QUALIFICATION_AGENT}`,
    '  public_key_jwk: null',
    '  key_id: null',
    '  key_rotation:',
    '    last_rotated_at: null',
    '    rotation_interval_days: 90',
    '  status: active',
    'vendor:',
    '  provider: openslack',
    '  runtime: cli',
    'employment:',
    '  status: active',
    '  hired_at: "2026-01-01T00:00:00.000Z"',
    'capabilities:',
    '  primary:',
    '    - scenario_governance',
    '  secondary: []',
    'repositories:',
    '  workspace_repo:',
    '    owner: openslack-local',
    '    repo: qoder-human-attested-qualification',
    '    default_branch: main',
    'permissions:',
    '  paths:',
    '    allow:',
    '      - "scenarios/**"',
    '      - ".openslack.local/**"',
    '    deny:',
    '      - "**/.git/**"',
    '  actions:',
    '    scenario.instantiate: allow',
    '    openslack.collaboration.recordEvent: allow',
    '  github:',
    '    can_create_pr: false',
    '    can_comment: false',
    '    can_approve: false',
    '    can_merge: false',
    '  max_risk_zone: yellow',
    'execution: {}',
    'output_contract:',
    '  must_create: []',
    '  may_create: []',
    '  must_not_create: []',
    'approval_rules:',
    '  require_human_approval_for: []',
    '',
  ].join('\n');
}

function runtimeIdentityYaml(): string {
  return [
    'schema: openslack.agent_runtime_identity.v1',
    `agent_id: ${HUMAN_ATTESTED_QUALIFICATION_AGENT}`,
    `agent_uid: ${HUMAN_ATTESTED_QUALIFICATION_AGENT}-uid`,
    'run_id: RUN-qoder-human-attested-qualification',
    'public_key_jwk: null',
    'key_id: null',
    'key_generated_at: null',
    'provider: cli',
    `started_at: "${new Date().toISOString()}"`,
    '',
  ].join('\n');
}

export function createHumanQualificationWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), WORKSPACE_PREFIX)));
  writeFileSync(join(root, 'openslack.yaml'), workspaceYaml(), { encoding: 'utf8', mode: 0o600 });
  for (const directory of [
    'agents/registry',
    'agents/prompts',
    'policies',
    'tasks',
    'leases',
    'audit',
    'collaboration',
  ]) {
    mkdirSync(join(root, '.openslack', directory), { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    join(root, '.openslack', 'agents', 'registry', `${HUMAN_ATTESTED_QUALIFICATION_AGENT}.yaml`),
    humanQualificationRegistryYaml(),
    { encoding: 'utf8', mode: 0o600 },
  );
  const identityDirectory = join(
    root,
    '.openslack.local',
    'agents',
    HUMAN_ATTESTED_QUALIFICATION_AGENT,
  );
  mkdirSync(identityDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(identityDirectory, 'identity.yaml'), runtimeIdentityYaml(), {
    encoding: 'utf8',
    mode: 0o600,
  });
  mkdirSync(join(root, 'scenarios'), { mode: 0o700 });
  for (const scenarioId of ['contract-to-delivery-lite', 'software-delivery']) {
    cpSync(join(REPOSITORY_ROOT, 'scenarios', scenarioId), join(root, 'scenarios', scenarioId), {
      recursive: true,
    });
  }
  return root;
}

export function cleanupHumanQualificationWorkspace(rootValue: string): void {
  const root = resolve(rootValue);
  const temporaryRoot = realpathSync(tmpdir());
  const parent = realpathSync(dirname(root));
  const pathFromTemporaryRoot = relative(temporaryRoot, root);
  if (
    parent !== temporaryRoot ||
    basename(root).length <= WORKSPACE_PREFIX.length ||
    !basename(root).startsWith(WORKSPACE_PREFIX) ||
    pathFromTemporaryRoot === '..' ||
    pathFromTemporaryRoot.startsWith(`..${sep}`) ||
    !existsSync(root) ||
    lstatSync(root).isSymbolicLink()
  ) {
    blocked(
      'HUMAN_QUALIFICATION_CLEANUP_UNSAFE',
      'The temporary qualification workspace could not be safely identified.',
    );
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (existsSync(root)) {
    blocked(
      'HUMAN_QUALIFICATION_CLEANUP_FAILED',
      'The temporary qualification workspace was not removed.',
    );
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function humanAttestedQualificationServerStderr(
  platform: NodeJS.Platform,
): 'inherit' | 'pipe' {
  // Bun needs one inherited Windows standard handle to preserve the real
  // controlling console while MCP stdin/stdout remain dedicated JSON-RPC pipes.
  return platform === 'win32' ? 'inherit' : 'pipe';
}

async function seedApproval(
  workspaceRoot: string,
  humanPrincipal: string,
): Promise<{
  readonly store: LocalWorkflowEffectApprovalStore;
  readonly reasonHash: string;
}> {
  const binding = bindLocalHumanSubject({
    workspaceRoot,
    humanPrincipalId: humanPrincipal,
    confirmed: true,
  });
  if (
    binding.state !== 'ready' ||
    binding.humanPrincipalId !== HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL ||
    !binding.ttyAvailable
  ) {
    return blocked(
      'HUMAN_QUALIFICATION_ATTESTATION_NOT_READY',
      'The current OS subject and controlling TTY are not ready.',
    );
  }
  const provider = createLocalHumanAttestationProvider({
    workspaceRoot,
    workspaceId: HUMAN_ATTESTED_QUALIFICATION_WORKSPACE,
    humanPrincipalAssertion: humanPrincipal,
  });
  const store = new LocalWorkflowEffectApprovalStore(
    provider.approvalStoreRoot,
    provider.authority,
  );
  const createdAt = new Date().toISOString();
  await store.createPending({
    runId: RUN_ID,
    approvalId: APPROVAL_ID,
    correlationId: CORRELATION_ID,
    workflowId: WORKFLOW_ID,
    workflowVersion: '1.0.0',
    workflowHash: hash(`${WORKFLOW_ID}\0v1`),
    inputHash: hash('isolated-synthetic-low-risk-input'),
    effectId: `workflow-effect:sha256:${hash('isolated-synthetic-low-risk-effect')}`,
    effectHash: hash('isolated-synthetic-low-risk-effect'),
    requiredCapability: 'workflow.effect.decide',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 5 * 60 * 1_000).toISOString(),
  });
  return Object.freeze({ store, reasonHash: hash(DECISION_REASON) });
}

async function runOverProductionStdio(workspaceRoot: string): Promise<{
  readonly toolNames: readonly string[];
  readonly result: Readonly<Record<string, unknown>>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(REPOSITORY_ROOT, 'scripts', 'qualification', 'human-attested-server.ts'),
      '--workspace-root',
      workspaceRoot,
      '--principal-ref',
      HUMAN_ATTESTED_QUALIFICATION_AGENT,
      '--human-principal',
      HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL,
      '--workspace-id',
      HUMAN_ATTESTED_QUALIFICATION_WORKSPACE,
    ],
    cwd: workspaceRoot,
    stderr: humanAttestedQualificationServerStderr(process.platform),
  });
  let stderrBytes = 0;
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
  });
  const client = new Client({ name: 'openslack-human-attested-qualification', version: '1.0.0' });
  try {
    await client.connect(transport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
      return blocked(
        'HUMAN_QUALIFICATION_TOOL_CATALOG_MISMATCH',
        'The human-attested profile is not the exact reviewed 17-tool catalog.',
      );
    }
    const decision = await client.callTool(
      {
        name: 'openslack_decide_workflow_approval',
        arguments: {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          decision: 'approved',
          reason: DECISION_REASON,
        },
      },
      undefined,
      { timeout: 40_000 },
    );
    if (
      !decision.structuredContent ||
      typeof decision.structuredContent !== 'object' ||
      Array.isArray(decision.structuredContent)
    ) {
      return blocked(
        'HUMAN_QUALIFICATION_RESULT_INVALID',
        'The human-attested MCP result is unavailable.',
      );
    }
    if (stderrBytes > 64 * 1024) {
      return blocked(
        'HUMAN_QUALIFICATION_STDERR_BOUND_EXCEEDED',
        'The qualification server exceeded its bounded diagnostic channel.',
      );
    }
    return Object.freeze({
      toolNames: Object.freeze([...toolNames]),
      result: Object.freeze({ ...decision.structuredContent }),
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function assertAuditEvent(workspaceRoot: string, eventId: string): void {
  const eventPath = join(workspaceRoot, '.openslack.local', 'collaboration', 'events.jsonl');
  const stat = lstatSync(eventPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    blocked(
      'HUMAN_QUALIFICATION_AUDIT_UNRECORDED',
      'The durable Collaboration audit event is unavailable.',
    );
  }
  const events = readFileSync(eventPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id?: unknown; correlationId?: unknown });
  if (!events.some((event) => event.id === eventId && event.correlationId === CORRELATION_ID)) {
    blocked(
      'HUMAN_QUALIFICATION_AUDIT_UNRECORDED',
      'The durable Collaboration audit event did not match the decision.',
    );
  }
}

export function validateHumanAttestedReceipt(value: unknown): HumanAttestedQualificationReceipt {
  assertExactRecord(
    value,
    [
      'schema',
      'status',
      'claim',
      'candidate',
      'profile',
      'principal',
      'transport',
      'decision',
      'cleanup',
      'completedAt',
    ],
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'human-attested qualification receipt',
  );
  const receipt = value as unknown as HumanAttestedQualificationReceipt;
  assertExactRecord(
    receipt.candidate,
    ['commit', 'tree'],
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'candidate binding',
  );
  assertExactRecord(
    receipt.profile,
    ['toolCount', 'toolNames'],
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'profile evidence',
  );
  assertExactRecord(
    receipt.principal,
    ['agentRef', 'humanPrincipalId', 'osSubjectProvider'],
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'principal evidence',
  );
  assertExactRecord(
    receipt.transport,
    ['mcp', 'humanAttestation', 'separated'],
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'transport evidence',
  );
  assertExactRecord(
    receipt.decision,
    [
      'runId',
      'approvalId',
      'correlationId',
      'value',
      'reasonHash',
      'revisionBefore',
      'revisionAfter',
      'auditProjection',
      'auditEventId',
    ],
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'decision evidence',
  );
  assertExactRecord(
    receipt.cleanup,
    ['temporaryWorkspace', 'subjectMapping', 'approvalStore'],
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'cleanup evidence',
  );
  if (
    receipt.schema !== HUMAN_ATTESTED_QUALIFICATION_SCHEMA ||
    receipt.status !== 'completed' ||
    receipt.claim !== HUMAN_ATTESTED_QUALIFICATION_CLAIM ||
    !GIT_OBJECT_ID.test(receipt.candidate.commit) ||
    !GIT_OBJECT_ID.test(receipt.candidate.tree) ||
    receipt.profile.toolCount !== 17 ||
    JSON.stringify(receipt.profile.toolNames) !== JSON.stringify(EXPECTED_TOOLS) ||
    receipt.principal.agentRef !== HUMAN_ATTESTED_QUALIFICATION_AGENT ||
    receipt.principal.humanPrincipalId !== HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL ||
    !['windows_os_subject', 'posix_os_subject'].includes(receipt.principal.osSubjectProvider) ||
    receipt.transport.mcp !== 'stdio' ||
    !['CON', '/dev/tty'].includes(receipt.transport.humanAttestation) ||
    receipt.transport.separated !== true ||
    receipt.decision.runId !== RUN_ID ||
    receipt.decision.approvalId !== APPROVAL_ID ||
    receipt.decision.correlationId !== CORRELATION_ID ||
    receipt.decision.value !== 'approved' ||
    !/^[0-9a-f]{64}$/.test(receipt.decision.reasonHash) ||
    receipt.decision.revisionBefore !== 0 ||
    receipt.decision.revisionAfter !== 2 ||
    receipt.decision.auditProjection !== 'recorded' ||
    !AUDIT_EVENT.test(receipt.decision.auditEventId) ||
    receipt.cleanup.temporaryWorkspace !== 'removed' ||
    receipt.cleanup.subjectMapping !== 'removed' ||
    receipt.cleanup.approvalStore !== 'removed'
  ) {
    return blocked(
      'HUMAN_QUALIFICATION_RECEIPT_INVALID',
      'Human-attested qualification evidence did not satisfy the closed contract.',
    );
  }
  assertCanonicalTimestamp(
    receipt.completedAt,
    'HUMAN_QUALIFICATION_RECEIPT_INVALID',
    'completedAt',
  );
  assertSensitiveDataAbsent(receipt, 'HUMAN_QUALIFICATION_RECEIPT_SENSITIVE');
  if (!SHA256.test(sha256Bytes(DECISION_REASON))) {
    return blocked(
      'HUMAN_QUALIFICATION_RECEIPT_INVALID',
      'The fixed decision reason hash is invalid.',
    );
  }
  return Object.freeze(receipt);
}

export async function runProductionHumanAttestedQualification(
  options: HumanAttestedQualificationOptions,
): Promise<HumanAttestedQualificationReceipt> {
  if (
    !options ||
    typeof options !== 'object' ||
    options.confirmed !== true ||
    options.humanPrincipal !== HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL
  ) {
    return blocked(
      'HUMAN_QUALIFICATION_PRINCIPAL_INVALID',
      'Qualification requires --human-principal human:founder and --confirm.',
    );
  }
  const candidate = candidateRevision(REPOSITORY_ROOT);
  const workspaceRoot = createHumanQualificationWorkspace();
  let receipt: HumanAttestedQualificationReceipt | undefined;
  let cleanupError: unknown;
  try {
    const { store, reasonHash } = await seedApproval(workspaceRoot, options.humanPrincipal);
    const before = await store.read(RUN_ID, APPROVAL_ID);
    if (before?.revision !== 0 || before.status !== 'pending') {
      return blocked(
        'HUMAN_QUALIFICATION_PENDING_RECORD_INVALID',
        'The synthetic approval did not start at revision zero.',
      );
    }
    const { toolNames, result } = await runOverProductionStdio(workspaceRoot);
    const after = await store.read(RUN_ID, APPROVAL_ID);
    if (
      result.schema !== 'openslack.mcp_result.v2' ||
      result.status !== 'completed' ||
      (result.data as { status?: unknown; auditProjection?: unknown } | undefined)?.status !==
        'approved' ||
      (result.data as { status?: unknown; auditProjection?: unknown } | undefined)
        ?.auditProjection !== 'recorded' ||
      after?.revision !== 2 ||
      after.status !== 'approved' ||
      after.decision?.principalId !== HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL ||
      after.auditProjection?.status !== 'recorded'
    ) {
      return blocked(
        'HUMAN_QUALIFICATION_DECISION_INVALID',
        'The synthetic decision or durable CAS readback was incomplete.',
      );
    }
    if (after.decision.reasonHash !== reasonHash) {
      return blocked(
        'HUMAN_QUALIFICATION_REASON_MISMATCH',
        'The exact decision reason binding changed.',
      );
    }
    assertAuditEvent(workspaceRoot, after.auditProjection.eventId);
    receipt = {
      schema: HUMAN_ATTESTED_QUALIFICATION_SCHEMA,
      status: 'completed',
      claim: HUMAN_ATTESTED_QUALIFICATION_CLAIM,
      candidate: { commit: candidate.commit, tree: candidate.tree },
      profile: { toolCount: 17, toolNames },
      principal: {
        agentRef: HUMAN_ATTESTED_QUALIFICATION_AGENT,
        humanPrincipalId: HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL,
        osSubjectProvider: process.platform === 'win32' ? 'windows_os_subject' : 'posix_os_subject',
      },
      transport: {
        mcp: 'stdio',
        humanAttestation: process.platform === 'win32' ? 'CON' : '/dev/tty',
        separated: true,
      },
      decision: {
        runId: RUN_ID,
        approvalId: APPROVAL_ID,
        correlationId: CORRELATION_ID,
        value: 'approved',
        reasonHash,
        revisionBefore: 0,
        revisionAfter: 2,
        auditProjection: 'recorded',
        auditEventId: after.auditProjection.eventId,
      },
      cleanup: {
        temporaryWorkspace: 'removed',
        subjectMapping: 'removed',
        approvalStore: 'removed',
      },
      completedAt: new Date().toISOString(),
    };
  } finally {
    try {
      cleanupHumanQualificationWorkspace(workspaceRoot);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    return blocked(
      'HUMAN_QUALIFICATION_CLEANUP_FAILED',
      'Qualification completed without proving temporary-state cleanup.',
    );
  }
  if (!receipt) {
    return blocked(
      'HUMAN_QUALIFICATION_INCOMPLETE',
      'Qualification ended without a completion receipt.',
    );
  }
  return validateHumanAttestedReceipt(receipt);
}
