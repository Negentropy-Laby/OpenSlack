import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { parse, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildAndPublishSoftwareDeliverySnapshot,
  LocalGraphStore,
} from '../../packages/organization-graph/src/index.js';
import {
  OPENSLACK_READ_TOOL_CATALOG,
  OPENSLACK_READ_TOOL_NAMES,
  validateOpenSlackMcpResultV2,
  type OpenSlackMcpResultV2,
} from '../../packages/qoder-adapter/src/index.js';
import {
  assertCanonicalTimestamp,
  assertExactRecord,
  assertSensitiveDataAbsent,
  atomicWriteJson,
  candidateRevision,
  ensureQualificationDirectory,
  GIT_OBJECT_ID,
  hashDirectoryTree,
  hashJson,
  QualificationError,
  readStrictJson,
  SAFE_QUALIFICATION_ID,
  SHA256,
  type CandidateRevision,
} from './common.js';

export const QODER_DESKTOP_MANIFEST_SCHEMA =
  'openslack.qoder_desktop_qualification_manifest.v2' as const;
export const QODER_DESKTOP_RECEIPT_SCHEMA =
  'openslack.qoder_desktop_qualification_receipt.v2' as const;
export const QODER_DESKTOP_CALL_PLAN_SCHEMA =
  'openslack.qoder_desktop_qualification_call_plan.v1' as const;
export const QODER_DESKTOP_VERIFICATION_SCHEMA =
  'openslack.qoder_desktop_qualification_verification.v2' as const;

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
const RECEIPT_FILE = 'qoder-desktop-receipt.json';
const MANIFEST_FILE = 'qualification-manifest.json';
const CONFIG_FILE = 'mcp-config.windows.json';
const CALL_PLAN_FILE = 'call-plan.json';
const EVIDENCE_REF = /^sha256:[0-9a-f]{64}$/;
const PENDING = 'PENDING';
const PERMISSION_OUTCOMES = Object.freeze([
  'prompt_observed',
  'no_prompt_read_only_observed',
] as const);
const SKILL_MODES = Object.freeze(['automatic', 'slash_chooser', 'explicit_name'] as const);
const REQUIRED_SECTIONS = Object.freeze([
  'Status',
  'Owner',
  'Blocker',
  'Next',
  'Evidence',
] as const);

export interface QoderToolCallPlan {
  readonly name: (typeof OPENSLACK_READ_TOOL_NAMES)[number];
  readonly input: Readonly<Record<string, unknown>>;
}

export interface QoderToolBaseline {
  readonly name: string;
  readonly inputHash: string;
  readonly resultSchema: 'openslack.mcp_result.v2';
  readonly status: string;
  readonly blocker: string | null;
  readonly assertions: readonly string[];
}

export interface QoderToolAnnotationBinding {
  readonly name: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface QoderDesktopQualificationManifest {
  readonly schema: typeof QODER_DESKTOP_MANIFEST_SCHEMA;
  readonly qualificationId: string;
  readonly preparedAt: string;
  readonly candidate: {
    readonly commit: string;
    readonly tree: string;
    readonly os: NodeJS.Platform;
    readonly architecture: string;
  };
  readonly qoderBuild: string;
  readonly skillSha: string;
  readonly configSha: string;
  readonly callPlanSha: string;
  readonly staleInstanceId: string;
  readonly missingInstanceId: string;
  readonly toolNames: readonly string[];
  readonly toolAnnotations: readonly QoderToolAnnotationBinding[];
  readonly calls: readonly QoderToolBaseline[];
}

interface QoderReceiptToolCall extends QoderToolBaseline {
  readonly permissionOutcome: (typeof PERMISSION_OUTCOMES)[number];
  readonly evidenceRef: string;
}

interface QoderSkillTrigger {
  readonly mode: (typeof SKILL_MODES)[number];
  readonly status: 'completed';
  readonly sections: readonly string[];
  readonly preservedBlockedAndUnknown: true;
  readonly fixtureNotLiveAuthority: true;
  readonly evidenceRef: string;
}

export interface QoderDesktopQualificationReceipt {
  readonly schema: typeof QODER_DESKTOP_RECEIPT_SCHEMA;
  readonly qualificationId: string;
  readonly status: 'completed';
  readonly claim: 'QODER_VERIFIED';
  readonly manifestSha: string;
  readonly candidate: {
    readonly commit: string;
    readonly tree: string;
    readonly os: NodeJS.Platform;
    readonly architecture: string;
  };
  readonly qoderBuild: string;
  readonly skillSha: string;
  readonly configSha: string;
  readonly callPlanSha: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly connectorInitialize: {
    readonly status: 'completed';
    readonly evidenceRef: string;
  };
  readonly toolsListed: {
    readonly names: readonly string[];
    readonly evidenceRef: string;
  };
  readonly calls: readonly QoderReceiptToolCall[];
  readonly permissions: {
    readonly oldConnectorRemoved: true;
    readonly oldGrantsRemoved: true;
    readonly connectorExplicitlyEnabled: true;
    readonly autoRunDisabled: true;
    readonly wildcard: false;
  };
  readonly scenarioCatalog: {
    readonly count: 2;
    readonly ids: readonly ['contract-to-delivery-lite', 'software-delivery'];
    readonly locked: true;
  };
  readonly skillTriggers: readonly QoderSkillTrigger[];
  readonly sensitiveDataAbsent: true;
}

export function candidateRevisionsEqual(
  left: CandidateRevision,
  right: CandidateRevision,
): boolean {
  return (
    left.commit === right.commit &&
    left.tree === right.tree &&
    left.os === right.os &&
    left.architecture === right.architecture
  );
}

export interface QoderDesktopPreparationResult {
  readonly schema: typeof QODER_DESKTOP_MANIFEST_SCHEMA;
  readonly qualificationId: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly qoderBuild: string;
  readonly skillSha: string;
  readonly configSha: string;
  readonly callPlanSha: string;
  readonly connectorConfigPath: string;
  readonly callPlanPath: string;
  readonly receiptPath: string;
  readonly staleInstanceId: string;
  readonly missingInstanceId: string;
}

function blocked(code: string, message: string): never {
  throw new QualificationError(code, message);
}

function nonce(): string {
  return randomBytes(6).toString('hex');
}

function reviewedToolAnnotations(): readonly QoderToolAnnotationBinding[] {
  return Object.freeze(
    OPENSLACK_READ_TOOL_CATALOG.map((tool) =>
      Object.freeze({
        name: tool.name,
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      }),
    ),
  );
}

function isReviewedReadOnlyBinding(binding: QoderToolAnnotationBinding | undefined): boolean {
  return (
    binding !== undefined &&
    binding.readOnlyHint === true &&
    binding.destructiveHint === false &&
    binding.idempotentHint === true
  );
}

function isPermissionOutcome(value: unknown): value is (typeof PERMISSION_OUTCOMES)[number] {
  return value === 'prompt_observed' || value === 'no_prompt_read_only_observed';
}

function validateToolAnnotationBindings(value: unknown): readonly QoderToolAnnotationBinding[] {
  if (!Array.isArray(value) || value.length !== OPENSLACK_READ_TOOL_NAMES.length) {
    return blocked(
      'QODER_QUALIFICATION_TOOL_POLICY_MISMATCH',
      'The qualification tool annotations are not the exact reviewed read-only bindings.',
    );
  }
  const bindings = value.map((entry, index) => {
    assertExactRecord(
      entry,
      ['name', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'],
      'QODER_QUALIFICATION_TOOL_POLICY_MISMATCH',
      `tool annotation binding ${index}`,
    );
    const binding = entry as Record<string, unknown>;
    if (
      binding.name !== OPENSLACK_READ_TOOL_NAMES[index] ||
      typeof binding.readOnlyHint !== 'boolean' ||
      typeof binding.destructiveHint !== 'boolean' ||
      typeof binding.idempotentHint !== 'boolean' ||
      typeof binding.openWorldHint !== 'boolean'
    ) {
      return blocked(
        'QODER_QUALIFICATION_TOOL_POLICY_MISMATCH',
        'The qualification tool annotations are not the exact reviewed read-only bindings.',
      );
    }
    return Object.freeze({
      name: OPENSLACK_READ_TOOL_NAMES[index]!,
      readOnlyHint: binding.readOnlyHint,
      destructiveHint: binding.destructiveHint,
      idempotentHint: binding.idempotentHint,
      openWorldHint: binding.openWorldHint,
    });
  });
  if (JSON.stringify(bindings) !== JSON.stringify(reviewedToolAnnotations())) {
    return blocked(
      'QODER_QUALIFICATION_TOOL_POLICY_MISMATCH',
      'The qualification tool annotations are not the exact reviewed read-only bindings.',
    );
  }
  return Object.freeze(bindings);
}

function fixedCallPlan(
  staleInstanceId: string,
  missingInstanceId: string,
): readonly QoderToolCallPlan[] {
  return Object.freeze([
    {
      name: 'openslack_get_executive_overview',
      input: Object.freeze({ sinceHours: 24, limit: 10 }),
    },
    {
      name: 'openslack_list_work_items',
      input: Object.freeze({ sinceHours: 168, limit: 10 }),
    },
    {
      name: 'openslack_get_work_room',
      input: Object.freeze({ roomId: 'pr:335', limit: 10 }),
    },
    {
      name: 'openslack_get_activity',
      input: Object.freeze({ sinceHours: 24, limit: 10 }),
    },
    {
      name: 'openslack_get_workflow_progress',
      input: Object.freeze({ runId: 'QODER-QUALIFICATION-MISSING' }),
    },
    {
      name: 'openslack_get_pr_readiness',
      input: Object.freeze({ prNumber: 335, repo: 'Negentropy-Laby/OpenSlack' }),
    },
    {
      name: 'openslack_list_pending_approvals',
      input: Object.freeze({ limit: 10 }),
    },
    {
      name: 'openslack_get_business_outcomes',
      input: Object.freeze({ scenarioId: 'contract-to-delivery-lite' }),
    },
    {
      name: 'openslack_get_notification_status',
      input: Object.freeze({}),
    },
    {
      name: 'openslack_list_scenarios',
      input: Object.freeze({}),
    },
    {
      name: 'openslack_query_graph',
      input: Object.freeze({
        scenarioInstanceId: staleInstanceId,
        depth: 1,
        maxNodes: 10,
        maxEdges: 10,
      }),
    },
    {
      name: 'openslack_explain_graph',
      input: Object.freeze({
        scenarioInstanceId: missingInstanceId,
        targetId: 'node-missing',
        depth: 1,
      }),
    },
  ]);
}

function connectorConfig(candidateRoot: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    mcpServers: Object.freeze({
      openslack: Object.freeze({
        type: 'stdio',
        command: realpathSyncWindows(process.execPath),
        args: Object.freeze([
          `--cwd=${candidateRoot}`,
          'run',
          'openslack',
          'mcp',
          'serve',
          '--stdio',
        ]),
      }),
    }),
  });
}

export function validateCredentialFreeConnectorConfig(
  value: unknown,
  expectedCandidateRoot?: string,
): void {
  assertExactRecord(
    value,
    ['mcpServers'],
    'QODER_QUALIFICATION_CONFIG_INVALID',
    'connector config',
  );
  const root = value as { mcpServers: unknown };
  assertExactRecord(
    root.mcpServers,
    ['openslack'],
    'QODER_QUALIFICATION_CONFIG_INVALID',
    'connector server map',
  );
  const servers = root.mcpServers as { openslack: unknown };
  assertExactRecord(
    servers.openslack,
    ['type', 'command', 'args'],
    'QODER_QUALIFICATION_CONFIG_INVALID',
    'OpenSlack connector',
  );
  const server = servers.openslack as {
    type: unknown;
    command: unknown;
    args: unknown;
  };
  const candidateArgument =
    Array.isArray(server.args) && typeof server.args[0] === 'string'
      ? server.args[0].slice('--cwd='.length)
      : '';
  if (
    server.type !== 'stdio' ||
    typeof server.command !== 'string' ||
    !/bun\.exe$/i.test(server.command) ||
    !Array.isArray(server.args) ||
    server.args.length !== 6 ||
    typeof server.args[0] !== 'string' ||
    !server.args[0].startsWith('--cwd=') ||
    candidateArgument.length === 0 ||
    server.args[1] !== 'run' ||
    server.args[2] !== 'openslack' ||
    server.args[3] !== 'mcp' ||
    server.args[4] !== 'serve' ||
    server.args[5] !== '--stdio'
  ) {
    blocked(
      'QODER_QUALIFICATION_CONFIG_INVALID',
      'The stock Windows connector config is not the reviewed STDIO shape.',
    );
  }
  if (
    expectedCandidateRoot !== undefined &&
    (realpathSyncWindows(server.command).toLowerCase() !==
      realpathSyncWindows(process.execPath).toLowerCase() ||
      realpathSyncWindows(candidateArgument).toLowerCase() !==
        realpathSyncWindows(expectedCandidateRoot).toLowerCase())
  ) {
    blocked(
      'QODER_QUALIFICATION_CONFIG_INVALID',
      'The stock Windows connector config is not bound to the candidate checkout.',
    );
  }
  const serialized = JSON.stringify(value);
  if (
    /token|secret|password|credential|authorization|cookie|oauth|https?:|\"env\"|\"url\"/i.test(
      serialized,
    )
  ) {
    blocked(
      'QODER_QUALIFICATION_CONFIG_SENSITIVE',
      'The connector config contains credential-like or remote material.',
    );
  }
  assertSensitiveDataAbsent(value, 'QODER_QUALIFICATION_CONFIG_SENSITIVE');
}

function qoderExecutable(candidateRoot: string): string {
  if (process.platform !== 'win32') {
    return blocked(
      'QODER_QUALIFICATION_PLATFORM_UNSUPPORTED',
      'Qoder Desktop qualification preparation requires Windows.',
    );
  }
  const candidates = new Set<string>();
  try {
    const found = execFileSync('where.exe', ['QoderWork.exe'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    found
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => candidates.add(value));
  } catch {
    // Fixed-path candidates below are still checked.
  }
  const drive = parse(candidateRoot).root;
  for (const path of [
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'QoderWork', 'QoderWork.exe')
      : '',
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'QoderWork', 'QoderWork.exe') : '',
    drive ? join(drive, 'Games', 'QoderWork', 'QoderWork.exe') : '',
  ]) {
    if (path) candidates.add(path);
  }
  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return realpathSyncWindows(candidate);
    } catch {
      // Continue through the bounded candidate list.
    }
  }
  return blocked(
    'QODER_QUALIFICATION_BUILD_UNAVAILABLE',
    'The installed Qoder Work executable could not be resolved.',
  );
}

function realpathSyncWindows(path: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.IO.Path]::GetFullPath($env:OPENSLACK_QODER_EXE)',
    ],
    {
      env: { ...process.env, OPENSLACK_QODER_EXE: path },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    },
  ).trim();
}

function qoderBuild(candidateRoot: string): string {
  const executable = qoderExecutable(candidateRoot);
  const value = execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Item -LiteralPath $env:OPENSLACK_QODER_EXE).VersionInfo.ProductVersion',
    ],
    {
      env: { ...process.env, OPENSLACK_QODER_EXE: executable },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    },
  ).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)) {
    return blocked(
      'QODER_QUALIFICATION_BUILD_INVALID',
      'The installed Qoder Work build is invalid.',
    );
  }
  return value;
}

async function publishStaleSnapshot(
  candidateRoot: string,
  staleInstanceId: string,
  preparedAt: string,
): Promise<void> {
  const source = JSON.parse(
    readFileSync(
      join(
        REPOSITORY_ROOT,
        'packages',
        'organization-graph',
        'src',
        '__tests__',
        'fixtures',
        'software-delivery-source.json',
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  source.scenarioInstanceId = staleInstanceId;
  source.cursor = `cursor-${staleInstanceId}`;
  source.generatedAt = new Date(Date.parse(preparedAt) - 25 * 60 * 60 * 1_000).toISOString();
  await buildAndPublishSoftwareDeliverySnapshot({
    sourceBytes: Buffer.from(JSON.stringify(source), 'utf8'),
    store: new LocalGraphStore(join(candidateRoot, '.openslack.local', 'graph')),
    expectedCursor: null,
    expectedScenarioInstanceId: staleInstanceId,
  });
}

function resultAssertions(name: string, result: OpenSlackMcpResultV2<unknown>): readonly string[] {
  if (name === 'openslack_list_scenarios') {
    const data = result.data as { scenarios?: unknown; blockedCounts?: unknown } | undefined;
    const scenarios = data?.scenarios;
    if (
      !Array.isArray(scenarios) ||
      !Array.isArray(data?.blockedCounts) ||
      data.blockedCounts.length !== 0
    ) {
      return blocked(
        'QODER_QUALIFICATION_SCENARIO_CATALOG_INVALID',
        'The locked Scenario catalog is unavailable.',
      );
    }
    const bindings = scenarios
      .map((scenario) => {
        if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) return undefined;
        const value = scenario as {
          id?: unknown;
          definitionHash?: unknown;
          evidenceRef?: unknown;
        };
        if (
          typeof value.id !== 'string' ||
          typeof value.definitionHash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(value.definitionHash) ||
          value.evidenceRef !== `artifact:sha256:${value.definitionHash}`
        ) {
          return undefined;
        }
        return `${value.id}:${value.definitionHash}`;
      })
      .filter((binding): binding is string => typeof binding === 'string')
      .sort();
    if (
      scenarios.length !== 2 ||
      bindings.length !== 2 ||
      bindings[0]?.split(':', 1)[0] !== 'contract-to-delivery-lite' ||
      bindings[1]?.split(':', 1)[0] !== 'software-delivery'
    ) {
      return blocked(
        'QODER_QUALIFICATION_SCENARIO_CATALOG_INVALID',
        'The qualification catalog is not the exact two locked Packs.',
      );
    }
    return Object.freeze([
      'locked-scenario-count:2',
      'scenario:contract-to-delivery-lite',
      'scenario:software-delivery',
    ]);
  }
  const blocker = (result.governance as { blocker?: unknown } | undefined)?.blocker;
  if (name === 'openslack_query_graph') {
    if (blocker !== 'SOURCE_EVIDENCE_STALE') {
      return blocked(
        'QODER_QUALIFICATION_STALE_BLOCKER_INVALID',
        'The stale graph fixture did not preserve SOURCE_EVIDENCE_STALE.',
      );
    }
    return Object.freeze(['blocker:SOURCE_EVIDENCE_STALE']);
  }
  if (name === 'openslack_explain_graph') {
    if (blocker !== 'SOURCE_EVIDENCE_UNAVAILABLE') {
      return blocked(
        'QODER_QUALIFICATION_UNAVAILABLE_BLOCKER_INVALID',
        'The missing graph fixture did not preserve SOURCE_EVIDENCE_UNAVAILABLE.',
      );
    }
    return Object.freeze(['blocker:SOURCE_EVIDENCE_UNAVAILABLE']);
  }
  return Object.freeze([]);
}

async function preflightStockConnector(
  config: Readonly<Record<string, unknown>>,
  candidateRoot: string,
  plan: readonly QoderToolCallPlan[],
): Promise<{
  readonly toolNames: readonly string[];
  readonly toolAnnotations: readonly QoderToolAnnotationBinding[];
  readonly calls: readonly QoderToolBaseline[];
}> {
  const server = (config.mcpServers as { openslack: { command: string; args: string[] } })
    .openslack;
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    cwd: candidateRoot,
    stderr: 'pipe',
  });
  let stderrBytes = 0;
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
  });
  const client = new Client({ name: 'openslack-qoder-desktop-preflight', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listedTools = (await client.listTools()).tools;
    const toolNames = listedTools.map((tool) => tool.name);
    if (JSON.stringify(toolNames) !== JSON.stringify(OPENSLACK_READ_TOOL_NAMES)) {
      return blocked(
        'QODER_QUALIFICATION_TOOL_CATALOG_MISMATCH',
        'The stock MCP server is not the exact reviewed 12-tool catalog.',
      );
    }
    const toolAnnotations = validateToolAnnotationBindings(
      listedTools.map((tool) => ({ name: tool.name, ...tool.annotations })),
    );
    const calls: QoderToolBaseline[] = [];
    for (const entry of plan) {
      const response = await client.callTool(
        { name: entry.name, arguments: { ...entry.input } },
        undefined,
        { timeout: 30_000 },
      );
      if (
        !response.structuredContent ||
        typeof response.structuredContent !== 'object' ||
        Array.isArray(response.structuredContent) ||
        !validateOpenSlackMcpResultV2(response.structuredContent)
      ) {
        return blocked(
          'QODER_QUALIFICATION_RESULT_INVALID',
          'The stock MCP preflight returned a non-v2 result.',
        );
      }
      const result = response.structuredContent;
      const status = result.status;
      const blocker = (result.governance as { blocker?: unknown } | undefined)?.blocker;
      if (typeof status !== 'string' || (blocker !== undefined && typeof blocker !== 'string')) {
        return blocked(
          'QODER_QUALIFICATION_RESULT_INVALID',
          'The stock MCP preflight result status is invalid.',
        );
      }
      calls.push(
        Object.freeze({
          name: entry.name,
          inputHash: hashJson(entry.input),
          resultSchema: 'openslack.mcp_result.v2' as const,
          status,
          blocker: typeof blocker === 'string' ? blocker : null,
          assertions: resultAssertions(entry.name, result),
        }),
      );
    }
    if (stderrBytes > 64 * 1024) {
      return blocked(
        'QODER_QUALIFICATION_STDERR_BOUND_EXCEEDED',
        'The stock connector exceeded its bounded diagnostic channel.',
      );
    }
    return Object.freeze({
      toolNames: Object.freeze([...toolNames]),
      toolAnnotations: Object.freeze([...toolAnnotations]),
      calls: Object.freeze(calls),
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function receiptTemplate(
  manifest: QoderDesktopQualificationManifest,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: QODER_DESKTOP_RECEIPT_SCHEMA,
    qualificationId: manifest.qualificationId,
    status: 'pending',
    claim: 'NOT_CLAIMED',
    manifestSha: hashJson(manifest),
    candidate: manifest.candidate,
    qoderBuild: manifest.qoderBuild,
    skillSha: manifest.skillSha,
    configSha: manifest.configSha,
    callPlanSha: manifest.callPlanSha,
    startedAt: PENDING,
    completedAt: PENDING,
    connectorInitialize: Object.freeze({ status: 'pending', evidenceRef: PENDING }),
    toolsListed: Object.freeze({ names: manifest.toolNames, evidenceRef: PENDING }),
    calls: Object.freeze(
      manifest.calls.map((call) =>
        Object.freeze({ ...call, permissionOutcome: 'pending', evidenceRef: PENDING }),
      ),
    ),
    permissions: Object.freeze({
      oldConnectorRemoved: false,
      oldGrantsRemoved: false,
      connectorExplicitlyEnabled: false,
      autoRunDisabled: false,
      wildcard: true,
    }),
    scenarioCatalog: Object.freeze({
      count: 2,
      ids: Object.freeze(['contract-to-delivery-lite', 'software-delivery']),
      locked: true,
    }),
    skillTriggers: Object.freeze(
      SKILL_MODES.map((mode) =>
        Object.freeze({
          mode,
          status: 'pending',
          sections: REQUIRED_SECTIONS,
          preservedBlockedAndUnknown: false,
          fixtureNotLiveAuthority: false,
          evidenceRef: PENDING,
        }),
      ),
    ),
    sensitiveDataAbsent: false,
  });
}

export async function prepareQoderDesktopQualification(): Promise<QoderDesktopPreparationResult> {
  const candidateRoot = realpathSyncWindows(REPOSITORY_ROOT);
  const candidate = candidateRevision(candidateRoot);
  if (candidate.os !== 'win32') {
    return blocked(
      'QODER_QUALIFICATION_PLATFORM_UNSUPPORTED',
      'Qoder Desktop qualification preparation requires Windows.',
    );
  }
  const preparedAt = new Date().toISOString();
  const idNonce = nonce();
  const qualificationId = `qoder-desktop-${candidate.commit.slice(0, 12)}-${idNonce}`;
  const staleInstanceId = `qoder-qualification-stale-${idNonce}`;
  const missingInstanceId = `qoder-qualification-missing-${idNonce}`;
  const outputRoot = ensureQualificationDirectory(candidateRoot, [
    '.openslack.local',
    'qualification',
    'qoder-desktop',
    qualificationId,
  ]);
  const config = connectorConfig(candidateRoot);
  validateCredentialFreeConnectorConfig(config, candidateRoot);
  const configSha = hashJson(config);
  const skillSha = hashDirectoryTree(
    join(candidateRoot, 'integrations', 'qoder-work', 'skills', 'openslack-organization-control'),
  );
  const build = qoderBuild(candidateRoot);
  await publishStaleSnapshot(candidateRoot, staleInstanceId, preparedAt);
  const plan = fixedCallPlan(staleInstanceId, missingInstanceId);
  const callPlan = Object.freeze({
    schema: QODER_DESKTOP_CALL_PLAN_SCHEMA,
    qualificationId,
    calls: plan,
  });
  assertSensitiveDataAbsent(callPlan, 'QODER_QUALIFICATION_CALL_PLAN_SENSITIVE');
  const callPlanSha = hashJson(callPlan);
  const preflight = await preflightStockConnector(config, candidateRoot, plan);
  const manifest: QoderDesktopQualificationManifest = Object.freeze({
    schema: QODER_DESKTOP_MANIFEST_SCHEMA,
    qualificationId,
    preparedAt,
    candidate,
    qoderBuild: build,
    skillSha,
    configSha,
    callPlanSha,
    staleInstanceId,
    missingInstanceId,
    toolNames: preflight.toolNames,
    toolAnnotations: preflight.toolAnnotations,
    calls: preflight.calls,
  });
  const configPath = join(outputRoot, CONFIG_FILE);
  const callPlanPath = join(outputRoot, CALL_PLAN_FILE);
  const manifestPath = join(outputRoot, MANIFEST_FILE);
  const receiptPath = join(outputRoot, RECEIPT_FILE);
  atomicWriteJson(configPath, config);
  atomicWriteJson(callPlanPath, callPlan);
  atomicWriteJson(manifestPath, manifest);
  atomicWriteJson(receiptPath, receiptTemplate(manifest));
  return Object.freeze({
    schema: QODER_DESKTOP_MANIFEST_SCHEMA,
    qualificationId,
    candidateCommit: candidate.commit,
    candidateTree: candidate.tree,
    qoderBuild: build,
    skillSha,
    configSha,
    callPlanSha,
    connectorConfigPath: configPath,
    callPlanPath,
    receiptPath,
    staleInstanceId,
    missingInstanceId,
  });
}

function manifestFromReceiptPath(receiptPathValue: string): QoderDesktopQualificationManifest {
  const receiptPath = resolve(receiptPathValue);
  const manifestPath = join(dirname(receiptPath), MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return blocked(
      'QODER_QUALIFICATION_MANIFEST_UNAVAILABLE',
      'The receipt does not have its sealed preparation manifest.',
    );
  }
  return validateManifest(readStrictJson(manifestPath));
}

function validateManifest(value: unknown): QoderDesktopQualificationManifest {
  assertExactRecord(
    value,
    [
      'schema',
      'qualificationId',
      'preparedAt',
      'candidate',
      'qoderBuild',
      'skillSha',
      'configSha',
      'callPlanSha',
      'staleInstanceId',
      'missingInstanceId',
      'toolNames',
      'toolAnnotations',
      'calls',
    ],
    'QODER_QUALIFICATION_MANIFEST_INVALID',
    'qualification manifest',
  );
  const manifest = value as unknown as QoderDesktopQualificationManifest;
  assertExactRecord(
    manifest.candidate,
    ['commit', 'tree', 'os', 'architecture'],
    'QODER_QUALIFICATION_MANIFEST_INVALID',
    'candidate revision',
  );
  if (
    manifest.schema !== QODER_DESKTOP_MANIFEST_SCHEMA ||
    !SAFE_QUALIFICATION_ID.test(manifest.qualificationId) ||
    !GIT_OBJECT_ID.test(manifest.candidate.commit) ||
    !GIT_OBJECT_ID.test(manifest.candidate.tree) ||
    manifest.candidate.os !== 'win32' ||
    !SHA256.test(manifest.skillSha) ||
    !SHA256.test(manifest.configSha) ||
    !SHA256.test(manifest.callPlanSha) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(manifest.qoderBuild) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.candidate.architecture) ||
    !SAFE_QUALIFICATION_ID.test(manifest.staleInstanceId) ||
    !SAFE_QUALIFICATION_ID.test(manifest.missingInstanceId) ||
    manifest.staleInstanceId === manifest.missingInstanceId ||
    JSON.stringify(manifest.toolNames) !== JSON.stringify(OPENSLACK_READ_TOOL_NAMES) ||
    !Array.isArray(manifest.toolAnnotations) ||
    !Array.isArray(manifest.calls) ||
    manifest.calls.length !== OPENSLACK_READ_TOOL_NAMES.length
  ) {
    return blocked(
      'QODER_QUALIFICATION_MANIFEST_INVALID',
      'Qualification manifest bindings are invalid.',
    );
  }
  assertCanonicalTimestamp(
    manifest.preparedAt,
    'QODER_QUALIFICATION_MANIFEST_INVALID',
    'preparedAt',
  );
  validateToolAnnotationBindings(manifest.toolAnnotations);
  manifest.calls.forEach((call, index) => {
    assertExactRecord(
      call,
      ['name', 'inputHash', 'resultSchema', 'status', 'blocker', 'assertions'],
      'QODER_QUALIFICATION_MANIFEST_INVALID',
      `call baseline ${index}`,
    );
    if (
      call.name !== OPENSLACK_READ_TOOL_NAMES[index] ||
      typeof call.inputHash !== 'string' ||
      !SHA256.test(call.inputHash) ||
      call.resultSchema !== 'openslack.mcp_result.v2' ||
      typeof call.status !== 'string' ||
      (call.blocker !== null && typeof call.blocker !== 'string') ||
      !Array.isArray(call.assertions) ||
      call.assertions.some((entry) => typeof entry !== 'string')
    ) {
      blocked('QODER_QUALIFICATION_MANIFEST_INVALID', 'Qualification call baseline is invalid.');
    }
  });
  assertSensitiveDataAbsent(manifest, 'QODER_QUALIFICATION_MANIFEST_SENSITIVE');
  return Object.freeze(manifest);
}

export function validateQoderDesktopReceipt(
  value: unknown,
  manifest: QoderDesktopQualificationManifest,
  nowValue = new Date().toISOString(),
): QoderDesktopQualificationReceipt {
  validateManifest(manifest);
  assertExactRecord(
    value,
    [
      'schema',
      'qualificationId',
      'status',
      'claim',
      'manifestSha',
      'candidate',
      'qoderBuild',
      'skillSha',
      'configSha',
      'callPlanSha',
      'startedAt',
      'completedAt',
      'connectorInitialize',
      'toolsListed',
      'calls',
      'permissions',
      'scenarioCatalog',
      'skillTriggers',
      'sensitiveDataAbsent',
    ],
    'QODER_QUALIFICATION_RECEIPT_INVALID',
    'Qoder Desktop receipt',
  );
  const receipt = value as unknown as QoderDesktopQualificationReceipt;
  for (const [candidate, fields, label] of [
    [receipt.candidate, ['commit', 'tree', 'os', 'architecture'], 'candidate revision'],
    [receipt.connectorInitialize, ['status', 'evidenceRef'], 'initialize evidence'],
    [receipt.toolsListed, ['names', 'evidenceRef'], 'tool-list evidence'],
    [
      receipt.permissions,
      [
        'oldConnectorRemoved',
        'oldGrantsRemoved',
        'connectorExplicitlyEnabled',
        'autoRunDisabled',
        'wildcard',
      ],
      'permission evidence',
    ],
    [receipt.scenarioCatalog, ['count', 'ids', 'locked'], 'Scenario catalog evidence'],
  ] as const) {
    assertExactRecord(candidate, fields, 'QODER_QUALIFICATION_RECEIPT_INVALID', label);
  }
  const startedAt = assertCanonicalTimestamp(
    receipt.startedAt,
    'QODER_QUALIFICATION_RECEIPT_INVALID',
    'startedAt',
  );
  const completedAt = assertCanonicalTimestamp(
    receipt.completedAt,
    'QODER_QUALIFICATION_RECEIPT_INVALID',
    'completedAt',
  );
  const now = assertCanonicalTimestamp(
    nowValue,
    'QODER_QUALIFICATION_RECEIPT_INVALID',
    'verification clock',
  );
  if (
    receipt.schema !== QODER_DESKTOP_RECEIPT_SCHEMA ||
    receipt.qualificationId !== manifest.qualificationId ||
    receipt.status !== 'completed' ||
    receipt.claim !== 'QODER_VERIFIED' ||
    receipt.manifestSha !== hashJson(manifest) ||
    JSON.stringify(receipt.candidate) !== JSON.stringify(manifest.candidate) ||
    receipt.qoderBuild !== manifest.qoderBuild ||
    receipt.skillSha !== manifest.skillSha ||
    receipt.configSha !== manifest.configSha ||
    receipt.callPlanSha !== manifest.callPlanSha ||
    Date.parse(startedAt) < Date.parse(manifest.preparedAt) ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(completedAt) > Date.parse(now) + 5 * 60 * 1_000 ||
    Date.parse(completedAt) - Date.parse(startedAt) > 24 * 60 * 60 * 1_000 ||
    receipt.connectorInitialize.status !== 'completed' ||
    typeof receipt.connectorInitialize.evidenceRef !== 'string' ||
    !EVIDENCE_REF.test(receipt.connectorInitialize.evidenceRef) ||
    JSON.stringify(receipt.toolsListed.names) !== JSON.stringify(manifest.toolNames) ||
    typeof receipt.toolsListed.evidenceRef !== 'string' ||
    !EVIDENCE_REF.test(receipt.toolsListed.evidenceRef) ||
    receipt.permissions.oldConnectorRemoved !== true ||
    receipt.permissions.oldGrantsRemoved !== true ||
    receipt.permissions.connectorExplicitlyEnabled !== true ||
    receipt.permissions.autoRunDisabled !== true ||
    receipt.permissions.wildcard !== false ||
    receipt.scenarioCatalog.count !== 2 ||
    JSON.stringify(receipt.scenarioCatalog.ids) !==
      JSON.stringify(['contract-to-delivery-lite', 'software-delivery']) ||
    receipt.scenarioCatalog.locked !== true ||
    receipt.sensitiveDataAbsent !== true
  ) {
    return blocked(
      'QODER_QUALIFICATION_RECEIPT_INVALID',
      'Qoder Desktop qualification root evidence is invalid.',
    );
  }
  if (!Array.isArray(receipt.calls) || receipt.calls.length !== manifest.calls.length) {
    return blocked(
      'QODER_QUALIFICATION_CALL_MISSING',
      'Qoder Desktop qualification did not record every required tool call.',
    );
  }
  receipt.calls.forEach((call, index) => {
    assertExactRecord(
      call,
      [
        'name',
        'inputHash',
        'resultSchema',
        'status',
        'blocker',
        'assertions',
        'permissionOutcome',
        'evidenceRef',
      ],
      'QODER_QUALIFICATION_RECEIPT_INVALID',
      `tool call ${index}`,
    );
    const baseline = manifest.calls[index]!;
    if (call.name === 'openslack_query_graph' && call.blocker !== 'SOURCE_EVIDENCE_STALE') {
      blocked(
        'QODER_QUALIFICATION_STALE_BLOCKER_INVALID',
        'Qoder Desktop did not preserve SOURCE_EVIDENCE_STALE.',
      );
    }
    if (call.name === 'openslack_explain_graph' && call.blocker !== 'SOURCE_EVIDENCE_UNAVAILABLE') {
      blocked(
        'QODER_QUALIFICATION_UNAVAILABLE_BLOCKER_INVALID',
        'Qoder Desktop did not preserve SOURCE_EVIDENCE_UNAVAILABLE.',
      );
    }
    if (
      call.permissionOutcome === 'no_prompt_read_only_observed' &&
      !isReviewedReadOnlyBinding(manifest.toolAnnotations[index])
    ) {
      blocked(
        'QODER_QUALIFICATION_TOOL_POLICY_MISMATCH',
        'A no-prompt observation is not bound to the exact reviewed read-only annotation.',
      );
    }
    if (
      call.name !== OPENSLACK_READ_TOOL_NAMES[index] ||
      call.name !== baseline.name ||
      call.inputHash !== baseline.inputHash ||
      call.resultSchema !== baseline.resultSchema ||
      call.status !== baseline.status ||
      call.blocker !== baseline.blocker ||
      JSON.stringify(call.assertions) !== JSON.stringify(baseline.assertions) ||
      !isPermissionOutcome(call.permissionOutcome) ||
      typeof call.evidenceRef !== 'string' ||
      !EVIDENCE_REF.test(call.evidenceRef)
    ) {
      blocked(
        index >= receipt.calls.length
          ? 'QODER_QUALIFICATION_CALL_MISSING'
          : 'QODER_QUALIFICATION_TOOL_ORDER_OR_RESULT_INVALID',
        'Qoder Desktop tool order, result, blocker, or permission outcome evidence is invalid.',
      );
    }
  });
  const stale = receipt.calls.find((call) => call.name === 'openslack_query_graph');
  const missing = receipt.calls.find((call) => call.name === 'openslack_explain_graph');
  if (stale?.blocker !== 'SOURCE_EVIDENCE_STALE') {
    return blocked(
      'QODER_QUALIFICATION_STALE_BLOCKER_INVALID',
      'Qoder Desktop did not preserve SOURCE_EVIDENCE_STALE.',
    );
  }
  if (missing?.blocker !== 'SOURCE_EVIDENCE_UNAVAILABLE') {
    return blocked(
      'QODER_QUALIFICATION_UNAVAILABLE_BLOCKER_INVALID',
      'Qoder Desktop did not preserve SOURCE_EVIDENCE_UNAVAILABLE.',
    );
  }
  if (
    !Array.isArray(receipt.skillTriggers) ||
    receipt.skillTriggers.length !== SKILL_MODES.length
  ) {
    return blocked(
      'QODER_QUALIFICATION_SKILL_TRIGGER_MISSING',
      'Qoder Desktop did not record every Skill trigger.',
    );
  }
  receipt.skillTriggers.forEach((trigger, index) => {
    assertExactRecord(
      trigger,
      [
        'mode',
        'status',
        'sections',
        'preservedBlockedAndUnknown',
        'fixtureNotLiveAuthority',
        'evidenceRef',
      ],
      'QODER_QUALIFICATION_RECEIPT_INVALID',
      `Skill trigger ${index}`,
    );
    if (
      trigger.mode !== SKILL_MODES[index] ||
      trigger.status !== 'completed' ||
      JSON.stringify(trigger.sections) !== JSON.stringify(REQUIRED_SECTIONS) ||
      trigger.preservedBlockedAndUnknown !== true ||
      trigger.fixtureNotLiveAuthority !== true ||
      typeof trigger.evidenceRef !== 'string' ||
      !EVIDENCE_REF.test(trigger.evidenceRef)
    ) {
      blocked(
        'QODER_QUALIFICATION_SKILL_TRIGGER_INVALID',
        'A Qoder Skill trigger did not preserve the reviewed output contract.',
      );
    }
  });
  assertSensitiveDataAbsent(receipt, 'QODER_QUALIFICATION_RECEIPT_SENSITIVE');
  return Object.freeze(receipt);
}

export function verifyQoderDesktopQualification(receiptPathValue: string): Readonly<{
  schema: typeof QODER_DESKTOP_VERIFICATION_SCHEMA;
  status: 'completed';
  claim: 'QODER_VERIFIED';
  qualificationId: string;
  candidateCommit: string;
  candidateTree: string;
  receiptSha: string;
  manifestSha: string;
}> {
  const receiptPath = resolve(receiptPathValue);
  const manifest = manifestFromReceiptPath(receiptPath);
  const currentCandidate = candidateRevision(REPOSITORY_ROOT);
  if (
    !candidateRevisionsEqual(currentCandidate, manifest.candidate) ||
    qoderBuild(REPOSITORY_ROOT) !== manifest.qoderBuild
  ) {
    return blocked(
      'QODER_QUALIFICATION_CANDIDATE_CHANGED',
      'The candidate revision or installed Qoder build changed after preparation.',
    );
  }
  const artifactRoot = dirname(receiptPath);
  const config = readStrictJson(join(artifactRoot, CONFIG_FILE));
  validateCredentialFreeConnectorConfig(config, REPOSITORY_ROOT);
  const callPlan = readStrictJson(join(artifactRoot, CALL_PLAN_FILE));
  const expectedCallPlan = Object.freeze({
    schema: QODER_DESKTOP_CALL_PLAN_SCHEMA,
    qualificationId: manifest.qualificationId,
    calls: fixedCallPlan(manifest.staleInstanceId, manifest.missingInstanceId),
  });
  if (
    hashJson(config) !== manifest.configSha ||
    hashJson(callPlan) !== manifest.callPlanSha ||
    hashJson(callPlan) !== hashJson(expectedCallPlan) ||
    hashDirectoryTree(
      join(
        REPOSITORY_ROOT,
        'integrations',
        'qoder-work',
        'skills',
        'openslack-organization-control',
      ),
    ) !== manifest.skillSha
  ) {
    return blocked(
      'QODER_QUALIFICATION_ARTIFACT_CHANGED',
      'A sealed qualification artifact or Skill changed after preparation.',
    );
  }
  assertSensitiveDataAbsent(callPlan, 'QODER_QUALIFICATION_CALL_PLAN_SENSITIVE');
  const receipt = validateQoderDesktopReceipt(readStrictJson(receiptPath), manifest);
  return Object.freeze({
    schema: QODER_DESKTOP_VERIFICATION_SCHEMA,
    status: 'completed',
    claim: 'QODER_VERIFIED',
    qualificationId: receipt.qualificationId,
    candidateCommit: receipt.candidate.commit,
    candidateTree: receipt.candidate.tree,
    receiptSha: hashJson(receipt),
    manifestSha: hashJson(manifest),
  });
}

export function qoderReceiptFixture(
  manifest: QoderDesktopQualificationManifest,
  timestamp = new Date().toISOString(),
  permissionOutcome: (typeof PERMISSION_OUTCOMES)[number] = 'no_prompt_read_only_observed',
): QoderDesktopQualificationReceipt {
  const evidenceRef = `sha256:${'e'.repeat(64)}`;
  return {
    schema: QODER_DESKTOP_RECEIPT_SCHEMA,
    qualificationId: manifest.qualificationId,
    status: 'completed',
    claim: 'QODER_VERIFIED',
    manifestSha: hashJson(manifest),
    candidate: manifest.candidate,
    qoderBuild: manifest.qoderBuild,
    skillSha: manifest.skillSha,
    configSha: manifest.configSha,
    callPlanSha: manifest.callPlanSha,
    startedAt: timestamp,
    completedAt: timestamp,
    connectorInitialize: { status: 'completed', evidenceRef },
    toolsListed: { names: manifest.toolNames, evidenceRef },
    calls: manifest.calls.map((call) => ({
      ...call,
      permissionOutcome,
      evidenceRef,
    })),
    permissions: {
      oldConnectorRemoved: true,
      oldGrantsRemoved: true,
      connectorExplicitlyEnabled: true,
      autoRunDisabled: true,
      wildcard: false,
    },
    scenarioCatalog: {
      count: 2,
      ids: ['contract-to-delivery-lite', 'software-delivery'],
      locked: true,
    },
    skillTriggers: SKILL_MODES.map((mode) => ({
      mode,
      status: 'completed',
      sections: REQUIRED_SECTIONS,
      preservedBlockedAndUnknown: true,
      fixtureNotLiveAuthority: true,
      evidenceRef,
    })),
    sensitiveDataAbsent: true,
  };
}

export function qoderManifestFixture(
  overrides: Partial<QoderDesktopQualificationManifest> = {},
): QoderDesktopQualificationManifest {
  const staleInstanceId = 'qoder-qualification-stale-fixture';
  const missingInstanceId = 'qoder-qualification-missing-fixture';
  const calls = fixedCallPlan(staleInstanceId, missingInstanceId).map((entry) => {
    const isStale = entry.name === 'openslack_query_graph';
    const isMissing = entry.name === 'openslack_explain_graph';
    const isScenarios = entry.name === 'openslack_list_scenarios';
    return {
      name: entry.name,
      inputHash: hashJson(entry.input),
      resultSchema: 'openslack.mcp_result.v2' as const,
      status: isStale || isMissing ? 'blocked' : 'completed',
      blocker: isStale ? 'SOURCE_EVIDENCE_STALE' : isMissing ? 'SOURCE_EVIDENCE_UNAVAILABLE' : null,
      assertions: isScenarios
        ? [
            'locked-scenario-count:2',
            'scenario:contract-to-delivery-lite',
            'scenario:software-delivery',
          ]
        : isStale
          ? ['blocker:SOURCE_EVIDENCE_STALE']
          : isMissing
            ? ['blocker:SOURCE_EVIDENCE_UNAVAILABLE']
            : [],
    };
  });
  return {
    schema: QODER_DESKTOP_MANIFEST_SCHEMA,
    qualificationId: 'qoder-desktop-fixture',
    preparedAt: '2026-07-29T00:00:00.000Z',
    candidate: {
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      os: 'win32',
      architecture: 'x64',
    },
    qoderBuild: '0.9.12',
    skillSha: `sha256:${'c'.repeat(64)}`,
    configSha: `sha256:${'d'.repeat(64)}`,
    callPlanSha: `sha256:${'f'.repeat(64)}`,
    staleInstanceId,
    missingInstanceId,
    toolNames: [...OPENSLACK_READ_TOOL_NAMES],
    toolAnnotations: reviewedToolAnnotations().map((binding) => ({ ...binding })),
    calls,
    ...overrides,
  };
}
