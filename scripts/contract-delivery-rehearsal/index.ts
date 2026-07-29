import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalGraphStore } from '../../packages/organization-graph/src/index.js';
import {
  OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
} from '../../packages/qoder-adapter/src/index.js';
import {
  CONTRACT_DELIVERY_LITE_FIXTURE_ID,
  CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
} from '../../packages/workflows/src/index.js';
import {
  assembleContractDeliveryLiteRehearsalSource,
  createOpenSlackAgentBoundMutationComposition,
  createOpenSlackMcpContext,
  createOpenSlackMcpServer,
  publishContractDeliveryLiteRehearsalSnapshot,
  type OperatorApplicationContextPort,
} from '../../apps/mcp/src/index.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
const PRINCIPAL_REF = 'contract-delivery-rehearsal-agent';
const WORKSPACE_ID = 'contract-delivery-local-rehearsal';
const EXPECTED_TOOLS = Object.freeze([
  ...OPENSLACK_READ_TOOL_NAMES,
  ...OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
]);

interface PreviewMetadata {
  readonly planId: string;
  readonly confirmationToken: string;
  readonly correlationId: string;
}

class LocalRehearsalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LocalRehearsalError';
    this.code = code;
  }
}

function operator(): OperatorApplicationContextPort {
  return Object.freeze({}) as unknown as OperatorApplicationContextPort;
}

function registryYaml(): string {
  return [
    'schema: openslack.agent_registry.v2',
    `agent_id: ${PRINCIPAL_REF}`,
    'display_name: Contract Delivery Local Rehearsal Agent',
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
    '    repo: contract-delivery-rehearsal',
    '    default_branch: main',
    'permissions:',
    '  paths:',
    '    allow:',
    '      - "**"',
    '    deny: []',
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
    `agent_id: ${PRINCIPAL_REF}`,
    `agent_uid: ${PRINCIPAL_REF}-uid`,
    'run_id: RUN-contract-delivery-local-rehearsal',
    'public_key_jwk: null',
    'key_id: null',
    'key_generated_at: null',
    'provider: cli',
    `started_at: "${new Date().toISOString()}"`,
    '',
  ].join('\n');
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-contract-delivery-rehearsal-'));
  writeFileSync(
    join(root, 'openslack.yaml'),
    [
      'schema: openslack.workspace.v1',
      `workspace_id: ${WORKSPACE_ID}`,
      'name: Contract Delivery Local Rehearsal',
      'mode: normal',
      'canonical_remote:',
      '  provider: github',
      '  owner: openslack-local',
      '  repo: contract-delivery-rehearsal',
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
  for (const scenarioId of ['contract-to-delivery-lite', 'software-delivery']) {
    cpSync(join(REPOSITORY_ROOT, 'scenarios', scenarioId), join(root, 'scenarios', scenarioId), {
      recursive: true,
    });
  }
  return root;
}

function previewMetadata(value: unknown): PreviewMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRehearsalError('PREVIEW_INVALID', 'Governed preview metadata is unavailable.');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.planId !== 'string' ||
    typeof record.confirmationToken !== 'string' ||
    typeof record.correlationId !== 'string'
  ) {
    throw new LocalRehearsalError('PREVIEW_INVALID', 'Governed preview metadata is incomplete.');
  }
  return Object.freeze({
    planId: record.planId,
    confirmationToken: record.confirmationToken,
    correlationId: record.correlationId,
  });
}

async function main(): Promise<void> {
  const workspaceRoot = createWorkspace();
  let client: Client | undefined;
  let server: ReturnType<typeof createOpenSlackMcpServer> | undefined;
  try {
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
      provider: 'cli',
      workspaceIdAssertion: WORKSPACE_ID,
    });
    const context = createOpenSlackMcpContext({
      workspaceRoot,
      operator: operator(),
      governedMutations: composition.governedMutations,
    });
    server = createOpenSlackMcpServer(context);
    client = new Client({ name: 'contract-delivery-local-rehearsal', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.sdkServer.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new LocalRehearsalError(
        'TOOL_CATALOG_MISMATCH',
        'The agent-bound MCP catalog is not the reviewed 16-tool profile.',
      );
    }

    const scenarioPreview = await client.callTool({
      name: 'openslack_preview_scenario',
      arguments: {
        scenarioId: 'contract-to-delivery-lite',
        input: {
          mode: 'local_rehearsal',
          fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
        },
      },
    });
    const scenario = previewMetadata(scenarioPreview.structuredContent);
    const scenarioConfirmation = await client.callTool({
      name: 'openslack_confirm_plan',
      arguments: {
        planId: scenario.planId,
        confirmationToken: scenario.confirmationToken,
      },
    });
    const scenarioOutcome = (
      scenarioConfirmation.structuredContent as {
        data?: { outcomes?: Array<{ data?: { scenarioInstanceId?: string; state?: string } }> };
      }
    ).data?.outcomes?.[0]?.data;
    if (scenarioOutcome?.state !== 'active' || !scenarioOutcome.scenarioInstanceId) {
      throw new LocalRehearsalError(
        'SCENARIO_CONFIRMATION_FAILED',
        'The locked Scenario instance did not become active.',
      );
    }

    const workflowPreview = await client.callTool({
      name: 'openslack_preview_workflow',
      arguments: {
        workflowId: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
        input: {
          mode: 'local_rehearsal',
          fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
          scenarioInstanceId: scenarioOutcome.scenarioInstanceId,
          scenarioCorrelationId: scenario.correlationId,
        },
      },
    });
    const workflow = previewMetadata(workflowPreview.structuredContent);
    const workflowConfirmation = await client.callTool({
      name: 'openslack_confirm_plan',
      arguments: {
        planId: workflow.planId,
        confirmationToken: workflow.confirmationToken,
      },
    });
    const receipt = (
      workflowConfirmation.structuredContent as {
        data?: {
          outcomes?: Array<{
            data?: {
              evidenceLevel?: string;
              workflowRunId?: string;
              origins?: {
                notificationIntent?: string;
                notificationDelivery?: string;
                liveGitHub?: string;
                liveCapstone?: string;
                qoderDesktop?: string;
              };
            };
          }>;
        };
      }
    ).data?.outcomes?.[0]?.data;
    if (
      receipt?.evidenceLevel !== 'LOCAL_REHEARSAL_PASS' ||
      receipt.origins?.notificationIntent !== 'not_created' ||
      receipt.origins.notificationDelivery !== 'blocked_not_configured' ||
      receipt.origins.liveGitHub !== 'not_run' ||
      receipt.origins.liveCapstone !== 'LIVE_CAPSTONE_PENDING' ||
      receipt.origins.qoderDesktop !== 'not_run'
    ) {
      throw new LocalRehearsalError(
        'WORKFLOW_CONFIRMATION_FAILED',
        'The reviewed local Workflow did not produce its bounded receipt.',
      );
    }

    const source = await assembleContractDeliveryLiteRehearsalSource({
      governedPlanRoot: composition.governedPlanRoot,
      scenarioInstanceRoot: composition.scenarioInstanceRoot,
      workflowPlanId: workflow.planId,
      scenarioInstanceId: scenarioOutcome.scenarioInstanceId,
      scenarioCorrelationId: scenario.correlationId,
    });
    const published = await publishContractDeliveryLiteRehearsalSnapshot({
      workspaceRoot,
      source,
      expectedCursor: null,
    });
    const snapshot = await new LocalGraphStore(
      join(workspaceRoot, '.openslack.local', 'graph'),
    ).readCurrentSnapshot(scenarioOutcome.scenarioInstanceId);
    const customer = snapshot.nodes.find((node) => node.type === 'business.customer');
    const edge = snapshot.edges.find(
      (candidate) => candidate.projectorVersion === 'openslack.contract_to_delivery.v1',
    );
    if (!customer || !edge) {
      throw new LocalRehearsalError(
        'GRAPH_EVIDENCE_INCOMPLETE',
        'The composite graph omitted the reviewed business chain.',
      );
    }
    const query = await client.callTool({
      name: 'openslack_query_graph',
      arguments: {
        scenarioInstanceId: scenarioOutcome.scenarioInstanceId,
        rootNodeIds: [customer.id],
        direction: 'both',
        depth: 3,
        maxNodes: 200,
        maxEdges: 500,
        includeEvidence: true,
      },
    });
    const explain = await client.callTool({
      name: 'openslack_explain_graph',
      arguments: {
        scenarioInstanceId: scenarioOutcome.scenarioInstanceId,
        targetId: edge.id,
        depth: 3,
      },
    });
    if (
      (query.structuredContent as { status?: string } | undefined)?.status !== 'completed' ||
      (explain.structuredContent as { status?: string } | undefined)?.status !== 'completed'
    ) {
      throw new LocalRehearsalError(
        'GRAPH_READBACK_FAILED',
        'The official MCP SDK could not query and explain the published graph.',
      );
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          schema: 'openslack.contract_delivery_lite_local_rehearsal.v1',
          status: 'completed',
          evidenceLevel: 'CONTRACT_TO_DELIVERY_LOCAL_REHEARSED',
          toolCount: tools.length,
          scenarioDefinitionId: 'contract-to-delivery-lite',
          scenarioInstanceState: 'completed',
          workflowId: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
          workflowRunId: receipt.workflowRunId,
          graph: {
            cursor: published.cursor,
            integrityHash: published.snapshotIntegrityHash,
            nodeCount: published.nodeCount,
            edgeCount: published.edgeCount,
            query: 'completed',
            explain: 'completed',
          },
          origins: {
            workflow: 'governed_local_store',
            businessChain: 'demo_fixture',
            notificationIntent: 'not_created',
            notificationDelivery: 'blocked_not_configured',
            liveGitHub: 'not_run',
            liveCapstone: 'LIVE_CAPSTONE_PENDING',
            qoderDesktop: 'not_run',
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const blocked =
    error instanceof LocalRehearsalError
      ? error
      : new LocalRehearsalError(
          'LOCAL_REHEARSAL_FAILED',
          'The local rehearsal failed without producing completion evidence.',
        );
  process.stderr.write(
    `${JSON.stringify({
      schema: 'openslack.contract_delivery_lite_local_rehearsal.v1',
      status: 'blocked',
      code: blocked.code,
      summary: blocked.message,
    })}\n`,
  );
  process.exitCode = 1;
}
