import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createOpenSlackAgentBoundMutationComposition,
  createOpenSlackMcpServer,
  type OpenSlackAgentBoundMutationComposition,
  type OpenSlackMcpContext,
  type OpenSlackMcpServer,
  type OperatorApplicationContextPort,
} from '@openslack/mcp';
import {
  OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
} from '../../packages/qoder-adapter/src/index.js';
import {
  canonicalGovernedJson,
  createGovernanceAuthorityHttpClient,
  governedPlanAuthorityRoot,
  LocalGovernedPlanStore,
  validateGovernedPlanRecord,
  type GovernedPlanAuthorityRoute,
  type GovernedPlanRecord,
} from '../../packages/operator/src/index.js';
import { mcpCommands, type McpCommandDependencies } from '../../apps/cli/src/commands/mcp.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const sourcePack = join(repositoryRoot, 'scenarios', 'software-delivery');
const PRINCIPAL_REF = 'gs6-cross-language-agent';
const BUILD_SHA = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CANONICAL_EPOCH = /^[1-9]\d*$/u;
const HASH = /^[0-9a-f]{64}$/u;
const EXPECTED_TOOLS = Object.freeze([
  ...OPENSLACK_READ_TOOL_NAMES,
  ...OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
]);

type QualificationEnvironment = Readonly<{
  origin: string;
  buildSha: string;
  callerId: string;
  routingEpoch: number;
  workspaceId: string;
}>;

class GS6McpQualificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GS6McpQualificationError';
  }
}

function fail(code: string, message: string): never {
  throw new GS6McpQualificationError(code, message);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fail('ENVIRONMENT_INVALID', `${name} is required.`);
  return value;
}

function qualificationEnvironment(): QualificationEnvironment {
  const origin = requiredEnvironment('OPENSLACK_GS6_AUTHORITY_ORIGIN');
  const buildSha = requiredEnvironment('OPENSLACK_GS6_AUTHORITY_BUILD_SHA');
  const callerId = requiredEnvironment('OPENSLACK_GS6_AUTHORITY_CALLER_ID');
  const routingEpochText = requiredEnvironment('OPENSLACK_GS6_AUTHORITY_ROUTING_EPOCH');
  const workspaceId = requiredEnvironment('OPENSLACK_GS6_AUTHORITY_WORKSPACE_ID');
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return fail('ENVIRONMENT_INVALID', 'OPENSLACK_GS6_AUTHORITY_ORIGIN must be an HTTP URL.');
  }
  const hostname = parsedOrigin.hostname.replace(/^\[|\]$/gu, '');
  if (
    parsedOrigin.protocol !== 'http:' ||
    !['127.0.0.1', '::1'].includes(hostname) ||
    parsedOrigin.username !== '' ||
    parsedOrigin.password !== '' ||
    parsedOrigin.pathname !== '/' ||
    parsedOrigin.search !== '' ||
    parsedOrigin.hash !== ''
  ) {
    return fail(
      'ENVIRONMENT_INVALID',
      'OPENSLACK_GS6_AUTHORITY_ORIGIN must be an uncredentialed loopback origin.',
    );
  }
  if (!BUILD_SHA.test(buildSha)) {
    return fail(
      'ENVIRONMENT_INVALID',
      'OPENSLACK_GS6_AUTHORITY_BUILD_SHA must be 64 lowercase hexadecimal characters.',
    );
  }
  if (!IDENTIFIER.test(callerId) || !IDENTIFIER.test(workspaceId)) {
    return fail('ENVIRONMENT_INVALID', 'GS6 caller and workspace bindings must be identifiers.');
  }
  if (!CANONICAL_EPOCH.test(routingEpochText)) {
    return fail('ENVIRONMENT_INVALID', 'GS6 routing epoch must be canonical and positive.');
  }
  const routingEpoch = Number(routingEpochText);
  if (!Number.isSafeInteger(routingEpoch)) {
    return fail('ENVIRONMENT_INVALID', 'GS6 routing epoch must be a safe integer.');
  }
  return Object.freeze({
    origin: parsedOrigin.origin,
    buildSha,
    callerId,
    routingEpoch,
    workspaceId,
  });
}

function registryYaml(): string {
  return [
    'schema: openslack.agent_registry.v2',
    `agent_id: ${PRINCIPAL_REF}`,
    'display_name: GS6 Cross-language Principal',
    'identity:',
    `  uid: ${PRINCIPAL_REF}-uid`,
    `  principal_id: principal:${PRINCIPAL_REF}`,
    '  public_key_jwk: null',
    '  key_id: null',
    '  key_rotation:',
    '    last_rotated_at: null',
    '    rotation_interval_days: 90',
    '  status: active',
    'vendor:',
    '  provider: qualification',
    '  runtime: cli',
    'employment:',
    '  status: active',
    '  hired_at: "2026-08-03T00:00:00.000Z"',
    'capabilities:',
    '  primary:',
    '    - scenario_governance',
    '  secondary: []',
    'repositories:',
    '  workspace_repo:',
    '    owner: qualification',
    '    repo: OpenSlack',
    '    default_branch: main',
    'permissions:',
    '  paths:',
    '    allow:',
    '      - "**"',
    '    deny: []',
    '  actions:',
    '    scenario.instantiate: allow',
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
    `agent_id: ${PRINCIPAL_REF}`,
    `agent_uid: ${PRINCIPAL_REF}-uid`,
    'run_id: RUN-gs6-cross-language-001',
    'public_key_jwk: null',
    'key_id: null',
    'key_generated_at: null',
    'provider: cli',
    'started_at: "2026-08-03T00:00:00.000Z"',
    '',
  ].join('\n');
}

function createWorkspace(workspaceId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-gs6-mcp-'));
  writeFileSync(
    join(root, 'openslack.yaml'),
    [
      'schema: openslack.workspace.v1',
      `workspace_id: ${workspaceId}`,
      'name: GS6 Cross-language Qualification',
      'mode: normal',
      'canonical_remote:',
      '  provider: github',
      '  owner: qualification',
      '  repo: OpenSlack',
      '  default_branch: main',
      'workspace:',
      '  root: "."',
      '  state_root: ".openslack"',
      'product:',
      '  repo_role: managed',
      '  source_roots: []',
      '  protected_roots: []',
      '',
    ].join('\n'),
    'utf8',
  );
  for (const directory of [
    'agents/registry',
    'agents/prompts',
    'policies',
    'tasks',
    'leases',
    'audit',
    'collaboration',
  ]) {
    mkdirSync(join(root, '.openslack', directory), { recursive: true });
  }
  writeFileSync(
    join(root, '.openslack', 'agents', 'registry', `${PRINCIPAL_REF}.yaml`),
    registryYaml(),
    'utf8',
  );
  const identityDirectory = join(root, '.openslack.local', 'agents', PRINCIPAL_REF);
  mkdirSync(identityDirectory, { recursive: true });
  writeFileSync(join(identityDirectory, 'identity.yaml'), runtimeIdentityYaml(), 'utf8');
  mkdirSync(join(root, 'scenarios'));
  cpSync(sourcePack, join(root, 'scenarios', 'software-delivery'), { recursive: true });
  return root;
}

function operator(): OperatorApplicationContextPort {
  return Object.freeze({}) as unknown as OperatorApplicationContextPort;
}

function previewMetadata(value: unknown): Readonly<{
  planId: string;
  confirmationToken: string;
  correlationId: string;
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('PREVIEW_INVALID', 'Scenario preview did not return an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.status !== 'needs_confirmation' ||
    typeof record.planId !== 'string' ||
    typeof record.confirmationToken !== 'string' ||
    typeof record.correlationId !== 'string'
  ) {
    return fail('PREVIEW_INVALID', 'Scenario preview metadata is incomplete.');
  }
  return Object.freeze({
    planId: record.planId,
    confirmationToken: record.confirmationToken,
    correlationId: record.correlationId,
  });
}

function terminalConfirmation(value: unknown, correlationId: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('CONFIRMATION_INVALID', 'Scenario confirmation did not return an object.');
  }
  const result = value as Record<string, unknown>;
  const data = result.data as Record<string, unknown> | undefined;
  if (
    result.status !== 'completed' ||
    result.correlationId !== correlationId ||
    data?.state !== 'succeeded'
  ) {
    return fail('CONFIRMATION_INVALID', 'Scenario confirmation did not reach succeeded.');
  }
}

async function localRecordCount(
  composition: OpenSlackAgentBoundMutationComposition,
): Promise<number> {
  return (await new LocalGovernedPlanStore(composition.governedPlanRoot).list()).length;
}

function readFrozenRoute(
  workspaceRoot: string,
  planId: string,
  expected: GovernedPlanAuthorityRoute,
): void {
  const routeDirectory = join(governedPlanAuthorityRoot(workspaceRoot), 'routes');
  const names = readdirSync(routeDirectory).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name));
  if (names.length !== 1) {
    return fail('ROUTE_INVALID', 'Exactly one immutable governance authority route is required.');
  }
  const value = JSON.parse(readFileSync(join(routeDirectory, names[0]!), 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    value.schema !== 'openslack.governed_plan_authority_route.v1' ||
    value.planId !== planId ||
    value.backend !== expected.backend ||
    value.authority !== expected.authority ||
    value.routingEpoch !== expected.routingEpoch
  ) {
    return fail('ROUTE_INVALID', 'The persisted governance authority route is not the Go route.');
  }
}

function recordHash(record: GovernedPlanRecord): string {
  return createHash('sha256')
    .update(`${canonicalGovernedJson(validateGovernedPlanRecord(record))}\n`, 'utf8')
    .digest('hex');
}

async function main(): Promise<void> {
  const environment = qualificationEnvironment();
  const workspaceRoot = createWorkspace(environment.workspaceId);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  let composition: OpenSlackAgentBoundMutationComposition | undefined;
  let client: Client | undefined;
  let server: OpenSlackMcpServer | undefined;
  let probeError: unknown;
  try {
    const counts = { afterComposition: -1, afterPreview: -1, afterConfirm: -1, afterRead: -1 };
    const route = Object.freeze({
      backend: 'go',
      routingEpoch: environment.routingEpoch,
      authority: 'governance-control',
    } as const satisfies GovernedPlanAuthorityRoute);
    let toolNames: readonly string[] = [];
    let planId = '';
    let correlationId = '';
    let terminal: GovernedPlanRecord | undefined;

    const createAgentBoundComposition: typeof createOpenSlackAgentBoundMutationComposition = async (
      options,
    ) => {
      composition = await createOpenSlackAgentBoundMutationComposition(options);
      counts.afterComposition = await localRecordCount(composition);
      return composition;
    };
    const createServer = ((context: OpenSlackMcpContext): OpenSlackMcpServer => {
      const productionServer = createOpenSlackMcpServer(context);
      server = productionServer;
      return Object.freeze({
        core: productionServer.core,
        sdkServer: productionServer.sdkServer,
        async serveStdio(): Promise<void> {
          client = new Client({ name: 'openslack-gs6-authority-qualification', version: '1.0.0' });
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await productionServer.sdkServer.connect(serverTransport);
          await client.connect(clientTransport);
          try {
            toolNames = Object.freeze((await client.listTools()).tools.map((tool) => tool.name));
            if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
              return fail('TOOL_CATALOG_MISMATCH', 'Agent-bound MCP must expose exactly 16 tools.');
            }
            const preview = await client.callTool({
              name: 'openslack_preview_scenario',
              arguments: { scenarioId: 'software-delivery', input: {} },
            });
            const metadata = previewMetadata(preview.structuredContent);
            planId = metadata.planId;
            correlationId = metadata.correlationId;
            counts.afterPreview = await localRecordCount(composition!);
            readFrozenRoute(workspaceRoot, planId, route);
            const confirmed = await client.callTool({
              name: 'openslack_confirm_plan',
              arguments: {
                planId,
                confirmationToken: metadata.confirmationToken,
              },
            });
            terminalConfirmation(confirmed.structuredContent, correlationId);
            counts.afterConfirm = await localRecordCount(composition!);
            const authority = createGovernanceAuthorityHttpClient({
              origin: environment.origin,
              networkMode: 'loopback',
              workspaceId: environment.workspaceId,
              callerId: environment.callerId,
              expectedBuildSha: environment.buildSha,
              expiresAt,
            });
            terminal = (await authority.load(planId, route)) ?? undefined;
            if (!terminal || terminal.state !== 'succeeded' || terminal.revision < 3) {
              return fail(
                'TERMINAL_READ_INVALID',
                'Go authority did not return terminal succeeded.',
              );
            }
            counts.afterRead = await localRecordCount(composition!);
          } catch (error) {
            probeError = error;
            throw error;
          } finally {
            try {
              await client?.close();
              client = undefined;
              await productionServer.close();
              server = undefined;
            } catch (error) {
              probeError ??= error;
              throw error;
            }
          }
        },
        close: () => productionServer.close(),
      });
    }) as typeof createOpenSlackMcpServer;

    const dependencies: McpCommandDependencies = {
      workspaceRoot,
      operator: operator(),
      createAgentBoundComposition,
      createServer,
    };
    await mcpCommands(dependencies).parseAsync([
      'node',
      'gs6-mcp-client',
      'serve',
      '--stdio',
      '--profile',
      'agent-bound',
      '--principal-ref',
      PRINCIPAL_REF,
      '--workspace-id',
      environment.workspaceId,
      '--governance-authority-backend',
      'go',
      '--governance-authority-routing-epoch',
      String(environment.routingEpoch),
      '--governance-authority-tenant',
      environment.workspaceId,
      '--governance-authority-origin',
      environment.origin,
      '--governance-authority-network',
      'loopback',
      '--governance-authority-build-sha',
      environment.buildSha,
      '--governance-authority-caller',
      environment.callerId,
      '--governance-authority-expires-at',
      expiresAt,
    ]);
    if (probeError !== undefined) throw probeError;
    if (!composition || !terminal || toolNames.length !== 16 || !planId || !correlationId) {
      return fail('QUALIFICATION_INCOMPLETE', 'The official SDK qualification did not complete.');
    }
    if (Object.values(counts).some((count) => count !== 0)) {
      return fail('LOCAL_WRITER_DETECTED', 'A Go-routed governed plan reached the local writer.');
    }
    const hash = recordHash(terminal);
    if (!HASH.test(hash)) {
      return fail('TERMINAL_READ_INVALID', 'Terminal record hash is invalid.');
    }
    const receipt = Object.freeze({
      schema: 'openslack.gs6_mcp_authority_qualification.v1',
      status: 'passed',
      workspaceId: environment.workspaceId,
      principalRef: PRINCIPAL_REF,
      toolCatalog: Object.freeze({ count: toolNames.length, names: toolNames }),
      plan: Object.freeze({
        planId,
        correlationId,
        state: terminal.state,
        revision: terminal.revision,
        recordHash: hash,
      }),
      route,
      localAuthority: Object.freeze({
        recordCountAfterComposition: counts.afterComposition,
        recordCountAfterPreview: counts.afterPreview,
        recordCountAfterConfirm: counts.afterConfirm,
        recordCountAfterTerminalRead: counts.afterRead,
      }),
      transport: Object.freeze({
        officialMcpSdk: true,
        productionMcpCommands: true,
        productionComposition: true,
        inMemoryMcpTransport: true,
        realGoAuthorityHttp: true,
        callerId: environment.callerId,
        serviceBuildSha: environment.buildSha,
      }),
      evidenceCeiling: Object.freeze({
        authenticatedQoderDesktop: false,
        qoderVerified: false,
        remoteConnector: false,
        productionDeployment: false,
      }),
    });
    process.stdout.write(`${canonicalGovernedJson(receipt)}\n`);
  } finally {
    try {
      await client?.close();
      await server?.close();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  const code = error instanceof GS6McpQualificationError ? error.code : 'QUALIFICATION_FAILED';
  process.stderr.write(`${code}: GS6 official-SDK authority qualification failed.\n`);
  process.exitCode = 1;
});
