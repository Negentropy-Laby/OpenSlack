import { Command, Option } from 'commander';
import {
  normalizeGraphServiceOrigin,
  type GraphReadAuthorityPort,
  type GraphReadCanaryPort,
} from '@openslack/organization-graph';
import {
  createOpenSlackAgentBoundMutationComposition,
  createOpenSlackGraphReadCanary,
  createOpenSlackGraphReadAuthority,
  createOpenSlackGraphReadMirror,
  createOpenSlackMcpContext,
  createOpenSlackMcpServer,
  type OpenSlackMcpContext,
  type OpenSlackMcpServer,
  type OperatorApplicationContextPort,
  type GovernedPlanAuthorityCompositionOptions,
} from '@openslack/mcp';
import {
  bindLocalHumanSubject,
  getLocalHumanAttestationStatus,
  LocalHumanAttestationError,
  type BindLocalHumanSubjectOptions,
  type LocalHumanAttestationStatus,
} from '@openslack/workflows';
import {
  createOpenSlackHumanAttestedMcpComposition,
  type OpenSlackHumanAttestedMcpComposition,
} from '../mcp-human-attested-composition.js';

export const OPENSLACK_MCP_CLI_PROFILES = Object.freeze([
  'read-only',
  'agent-bound',
  'human-attested',
] as const);
export type OpenSlackMcpCliProfile = (typeof OPENSLACK_MCP_CLI_PROFILES)[number];

export interface McpCommandDependencies {
  readonly workspaceRoot: string;
  readonly operator: OperatorApplicationContextPort;
  readonly createContext?: typeof createOpenSlackMcpContext;
  readonly createAgentBoundComposition?: typeof createOpenSlackAgentBoundMutationComposition;
  readonly createHumanAttestedComposition?: (
    options: Parameters<typeof createOpenSlackHumanAttestedMcpComposition>[0],
  ) => Promise<OpenSlackHumanAttestedMcpComposition>;
  readonly createGraphReadMirror?: typeof createOpenSlackGraphReadMirror;
  readonly createGraphReadCanary?: typeof createOpenSlackGraphReadCanary;
  readonly createGraphReadAuthority?: typeof createOpenSlackGraphReadAuthority;
  readonly getAttestationStatus?: (workspaceRoot: string) => LocalHumanAttestationStatus;
  readonly bindLocalSubject?: (
    options: BindLocalHumanSubjectOptions,
  ) => LocalHumanAttestationStatus;
  readonly createServer?: typeof createOpenSlackMcpServer;
}

interface McpServeOptions {
  readonly stdio: true;
  readonly profile: OpenSlackMcpCliProfile;
  readonly principalRef?: string;
  readonly humanPrincipal?: string;
  readonly workspaceId?: string;
  readonly graphReadMirrorOrigin?: string;
  readonly graphReadMirrorNetwork?: 'loopback' | 'internal';
  readonly graphReadCanaryBackend?: 'go' | 'ts-local';
  readonly graphReadCanaryRoutingEpoch?: string;
  readonly graphReadCanaryTenant?: string;
  readonly graphReadCanaryScenarios?: string;
  readonly graphReadCanaryExpiresAt?: string;
  readonly graphReadCanaryOrigin?: string;
  readonly graphReadCanaryNetwork?: 'loopback' | 'internal';
  readonly graphReadCanaryBuildSha?: string;
  readonly graphReadAuthorityBackend?: 'go' | 'ts-local';
  readonly graphReadAuthorityRoutingEpoch?: string;
  readonly graphReadAuthorityTenant?: string;
  readonly graphReadAuthorityExpiresAt?: string;
  readonly graphReadAuthorityOrigin?: string;
  readonly graphReadAuthorityNetwork?: 'loopback' | 'internal';
  readonly graphReadAuthorityBuildSha?: string;
  readonly governanceAuthorityBackend?: 'go' | 'ts-local';
  readonly governanceAuthorityRoutingEpoch?: string;
  readonly governanceAuthorityTenant?: string;
  readonly governanceAuthorityOrigin?: string;
  readonly governanceAuthorityNetwork?: 'loopback' | 'internal';
  readonly governanceAuthorityBuildSha?: string;
  readonly governanceAuthorityCaller?: string;
  readonly governanceAuthorityExpiresAt?: string;
}

function hasGovernanceAuthority(options: McpServeOptions): boolean {
  return [
    options.governanceAuthorityBackend,
    options.governanceAuthorityRoutingEpoch,
    options.governanceAuthorityTenant,
    options.governanceAuthorityOrigin,
    options.governanceAuthorityNetwork,
    options.governanceAuthorityBuildSha,
    options.governanceAuthorityCaller,
    options.governanceAuthorityExpiresAt,
  ].some((value) => value !== undefined);
}

function bindGovernanceAuthority(
  options: McpServeOptions,
): GovernedPlanAuthorityCompositionOptions | undefined {
  if (!hasGovernanceAuthority(options)) return undefined;
  if (
    options.governanceAuthorityBackend === undefined ||
    options.governanceAuthorityRoutingEpoch === undefined ||
    options.governanceAuthorityTenant === undefined
  ) {
    throw new McpProfileArgumentError(
      'Governance authority requires backend, routing epoch, and tenant.',
    );
  }
  if (!/^[1-9]\d*$/u.test(options.governanceAuthorityRoutingEpoch)) {
    throw new McpProfileArgumentError('--governance-authority-routing-epoch must be canonical.');
  }
  const routingEpoch = Number(options.governanceAuthorityRoutingEpoch);
  if (!Number.isSafeInteger(routingEpoch)) {
    throw new McpProfileArgumentError(
      '--governance-authority-routing-epoch must be a safe integer.',
    );
  }
  const transportValues = [
    options.governanceAuthorityOrigin,
    options.governanceAuthorityBuildSha,
    options.governanceAuthorityCaller,
    options.governanceAuthorityExpiresAt,
  ];
  const transportCount = transportValues.filter((value) => value !== undefined).length;
  if (
    options.governanceAuthorityBackend === 'go'
      ? transportCount !== transportValues.length
      : transportCount !== 0 && transportCount !== transportValues.length
  ) {
    throw new McpProfileArgumentError(
      'Governance-control transport requires origin, build SHA, caller, and expiry together.',
    );
  }
  if (options.governanceAuthorityNetwork !== undefined && transportCount === 0) {
    throw new McpProfileArgumentError(
      '--governance-authority-network requires a complete governance-control transport.',
    );
  }
  return Object.freeze({
    backend: options.governanceAuthorityBackend,
    routingEpoch,
    tenantId: options.governanceAuthorityTenant,
    ...(options.governanceAuthorityOrigin === undefined
      ? {}
      : { origin: options.governanceAuthorityOrigin }),
    ...(options.governanceAuthorityNetwork === undefined
      ? {}
      : { networkMode: options.governanceAuthorityNetwork }),
    ...(options.governanceAuthorityBuildSha === undefined
      ? {}
      : { expectedBuildSha: options.governanceAuthorityBuildSha }),
    ...(options.governanceAuthorityCaller === undefined
      ? {}
      : { callerId: options.governanceAuthorityCaller }),
    ...(options.governanceAuthorityExpiresAt === undefined
      ? {}
      : { expiresAt: options.governanceAuthorityExpiresAt }),
  });
}

function hasGraphReadAuthority(options: McpServeOptions): boolean {
  return [
    options.graphReadAuthorityBackend,
    options.graphReadAuthorityRoutingEpoch,
    options.graphReadAuthorityTenant,
    options.graphReadAuthorityExpiresAt,
    options.graphReadAuthorityOrigin,
    options.graphReadAuthorityNetwork,
    options.graphReadAuthorityBuildSha,
  ].some((value) => value !== undefined);
}

function bindGraphReadAuthority(
  dependencies: McpCommandDependencies,
  options: McpServeOptions,
): GraphReadAuthorityPort | undefined {
  if (!hasGraphReadAuthority(options)) return undefined;
  if (
    options.graphReadAuthorityBackend === undefined ||
    options.graphReadAuthorityRoutingEpoch === undefined ||
    options.graphReadAuthorityTenant === undefined ||
    options.graphReadAuthorityExpiresAt === undefined
  ) {
    throw new McpProfileArgumentError(
      'Graph read authority requires backend, routing epoch, tenant, and expiry.',
    );
  }
  if (!/^[1-9]\d*$/u.test(options.graphReadAuthorityRoutingEpoch)) {
    throw new McpProfileArgumentError('--graph-read-authority-routing-epoch must be canonical.');
  }
  const routingEpoch = Number(options.graphReadAuthorityRoutingEpoch);
  if (!Number.isSafeInteger(routingEpoch)) {
    throw new McpProfileArgumentError(
      '--graph-read-authority-routing-epoch must be a safe integer.',
    );
  }
  if (options.graphReadAuthorityBackend === 'go') {
    if (
      options.graphReadAuthorityOrigin === undefined ||
      options.graphReadAuthorityBuildSha === undefined
    ) {
      throw new McpProfileArgumentError('Go graph read authority requires origin and build SHA.');
    }
  } else if (
    options.graphReadAuthorityOrigin !== undefined ||
    options.graphReadAuthorityNetwork !== undefined ||
    options.graphReadAuthorityBuildSha !== undefined
  ) {
    throw new McpProfileArgumentError(
      'ts-local graph read authority rollback does not accept Go transport settings.',
    );
  }
  const create = dependencies.createGraphReadAuthority ?? createOpenSlackGraphReadAuthority;
  return create({
    workspaceRoot: dependencies.workspaceRoot,
    backend: options.graphReadAuthorityBackend,
    tenantId: options.graphReadAuthorityTenant,
    routingEpoch,
    expiresAt: options.graphReadAuthorityExpiresAt,
    ...(options.graphReadAuthorityOrigin === undefined
      ? {}
      : { origin: options.graphReadAuthorityOrigin }),
    ...(options.graphReadAuthorityNetwork === undefined
      ? {}
      : { networkMode: options.graphReadAuthorityNetwork }),
    ...(options.graphReadAuthorityBuildSha === undefined
      ? {}
      : { expectedBuildSha: options.graphReadAuthorityBuildSha }),
  });
}

function bindGraphReadCanary(
  dependencies: McpCommandDependencies,
  options: McpServeOptions,
): GraphReadCanaryPort | undefined {
  const supplied = [
    options.graphReadCanaryBackend,
    options.graphReadCanaryRoutingEpoch,
    options.graphReadCanaryTenant,
    options.graphReadCanaryScenarios,
    options.graphReadCanaryExpiresAt,
    options.graphReadCanaryOrigin,
    options.graphReadCanaryNetwork,
    options.graphReadCanaryBuildSha,
  ].some((value) => value !== undefined);
  if (!supplied) return undefined;
  if (
    options.graphReadCanaryBackend === undefined ||
    options.graphReadCanaryRoutingEpoch === undefined ||
    options.graphReadCanaryTenant === undefined ||
    options.graphReadCanaryScenarios === undefined ||
    options.graphReadCanaryExpiresAt === undefined
  ) {
    throw new McpProfileArgumentError(
      'Graph read canary requires backend, routing epoch, tenant, scenarios, and expiry.',
    );
  }
  if (!/^[1-9]\d*$/u.test(options.graphReadCanaryRoutingEpoch)) {
    throw new McpProfileArgumentError('--graph-read-canary-routing-epoch must be canonical.');
  }
  const routingEpoch = Number(options.graphReadCanaryRoutingEpoch);
  if (!Number.isSafeInteger(routingEpoch)) {
    throw new McpProfileArgumentError('--graph-read-canary-routing-epoch must be a safe integer.');
  }
  const scenarios = options.graphReadCanaryScenarios.split(',');
  if (scenarios.some((value) => value.length === 0 || value.trim() !== value)) {
    throw new McpProfileArgumentError(
      '--graph-read-canary-scenarios must be a canonical CSV allowlist.',
    );
  }
  if (options.graphReadCanaryBackend === 'go') {
    if (
      options.graphReadCanaryOrigin === undefined ||
      options.graphReadCanaryBuildSha === undefined
    ) {
      throw new McpProfileArgumentError('Go graph read canary requires origin and build SHA.');
    }
  } else if (
    options.graphReadCanaryOrigin !== undefined ||
    options.graphReadCanaryNetwork !== undefined ||
    options.graphReadCanaryBuildSha !== undefined
  ) {
    throw new McpProfileArgumentError(
      'ts-local graph read rollback does not accept Go transport settings.',
    );
  }
  const create = dependencies.createGraphReadCanary ?? createOpenSlackGraphReadCanary;
  return create({
    workspaceRoot: dependencies.workspaceRoot,
    backend: options.graphReadCanaryBackend,
    tenantId: options.graphReadCanaryTenant,
    scenarioInstanceIds: scenarios,
    routingEpoch,
    expiresAt: options.graphReadCanaryExpiresAt,
    ...(options.graphReadCanaryOrigin === undefined
      ? {}
      : { origin: options.graphReadCanaryOrigin }),
    ...(options.graphReadCanaryNetwork === undefined
      ? {}
      : { networkMode: options.graphReadCanaryNetwork }),
    ...(options.graphReadCanaryBuildSha === undefined
      ? {}
      : { expectedBuildSha: options.graphReadCanaryBuildSha }),
  });
}

class McpProfileArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpProfileArgumentError';
  }
}

function bindGraphReadMirror(dependencies: McpCommandDependencies, options: McpServeOptions) {
  return options.graphReadMirrorOrigin === undefined
    ? undefined
    : (dependencies.createGraphReadMirror ?? createOpenSlackGraphReadMirror)({
        workspaceRoot: dependencies.workspaceRoot,
        origin: options.graphReadMirrorOrigin,
        networkMode: options.graphReadMirrorNetwork ?? 'loopback',
      });
}

async function createProfileContext(
  dependencies: McpCommandDependencies,
  options: McpServeOptions,
): Promise<OpenSlackMcpContext> {
  const createContext = dependencies.createContext ?? createOpenSlackMcpContext;
  if (options.graphReadMirrorNetwork !== undefined && options.graphReadMirrorOrigin === undefined) {
    throw new McpProfileArgumentError(
      '--graph-read-mirror-network requires --graph-read-mirror-origin.',
    );
  }
  if (options.graphReadMirrorOrigin !== undefined) {
    normalizeGraphServiceOrigin(
      options.graphReadMirrorOrigin,
      options.graphReadMirrorNetwork ?? 'loopback',
      'Graph read mirror origin',
    );
  }
  if (
    hasGraphReadAuthority(options) &&
    (options.graphReadMirrorOrigin !== undefined ||
      options.graphReadMirrorNetwork !== undefined ||
      options.graphReadCanaryBackend !== undefined ||
      options.graphReadCanaryRoutingEpoch !== undefined ||
      options.graphReadCanaryTenant !== undefined ||
      options.graphReadCanaryScenarios !== undefined ||
      options.graphReadCanaryExpiresAt !== undefined ||
      options.graphReadCanaryOrigin !== undefined ||
      options.graphReadCanaryNetwork !== undefined ||
      options.graphReadCanaryBuildSha !== undefined)
  ) {
    throw new McpProfileArgumentError(
      'Graph read authority is mutually exclusive with mirror and canary routing.',
    );
  }
  const graphReadCanary = bindGraphReadCanary(dependencies, options);
  const graphReadAuthority = bindGraphReadAuthority(dependencies, options);
  if (options.profile === 'read-only') {
    if (
      options.principalRef !== undefined ||
      options.humanPrincipal !== undefined ||
      options.workspaceId !== undefined ||
      hasGovernanceAuthority(options)
    ) {
      throw new McpProfileArgumentError('read-only does not accept authority-binding arguments.');
    }
    const graphReadMirror = bindGraphReadMirror(dependencies, options);
    return createContext({
      workspaceRoot: dependencies.workspaceRoot,
      operator: dependencies.operator,
      ...(graphReadMirror === undefined ? {} : { graphReadMirror }),
      ...(graphReadCanary === undefined ? {} : { graphReadCanary }),
      ...(graphReadAuthority === undefined ? {} : { graphReadAuthority }),
    });
  }
  if (options.profile !== 'agent-bound' && options.profile !== 'human-attested') {
    throw new McpProfileArgumentError('The requested MCP profile is not registered.');
  }
  if (options.principalRef === undefined) {
    throw new McpProfileArgumentError(`${options.profile} requires --principal-ref.`);
  }
  const governanceAuthority = bindGovernanceAuthority(options);
  if (options.profile === 'agent-bound') {
    if (options.humanPrincipal !== undefined) {
      throw new McpProfileArgumentError('agent-bound does not accept --human-principal.');
    }
    const composition = await (
      dependencies.createAgentBoundComposition ?? createOpenSlackAgentBoundMutationComposition
    )({
      workspaceRoot: dependencies.workspaceRoot,
      principalRef: options.principalRef,
      provider: 'cli',
      ...(options.workspaceId === undefined ? {} : { workspaceIdAssertion: options.workspaceId }),
      ...(governanceAuthority === undefined ? {} : { governanceAuthority }),
    });
    const graphReadMirror = bindGraphReadMirror(dependencies, options);
    return createContext({
      workspaceRoot: dependencies.workspaceRoot,
      operator: dependencies.operator,
      ...(graphReadMirror === undefined ? {} : { graphReadMirror }),
      ...(graphReadCanary === undefined ? {} : { graphReadCanary }),
      ...(graphReadAuthority === undefined ? {} : { graphReadAuthority }),
      governedMutations: composition.governedMutations,
    });
  }
  if (options.humanPrincipal === undefined) {
    throw new McpProfileArgumentError('human-attested requires --human-principal.');
  }
  const composition = await (
    dependencies.createHumanAttestedComposition ?? createOpenSlackHumanAttestedMcpComposition
  )({
    workspaceRoot: dependencies.workspaceRoot,
    principalRef: options.principalRef,
    humanPrincipalAssertion: options.humanPrincipal,
    ...(options.workspaceId === undefined ? {} : { workspaceIdAssertion: options.workspaceId }),
    ...(governanceAuthority === undefined ? {} : { governanceAuthority }),
  });
  const graphReadMirror = bindGraphReadMirror(dependencies, options);
  return createContext({
    workspaceRoot: dependencies.workspaceRoot,
    operator: dependencies.operator,
    ...(graphReadMirror === undefined ? {} : { graphReadMirror }),
    ...(graphReadCanary === undefined ? {} : { graphReadCanary }),
    ...(graphReadAuthority === undefined ? {} : { graphReadAuthority }),
    governedMutations: composition.governedMutations,
    workflowApprovalAuthority: composition.workflowApprovalAuthority,
  });
}

function renderAttestationError(error: unknown): string {
  return error instanceof LocalHumanAttestationError
    ? `${error.code}: local human attestation failed closed.`
    : 'LOCAL_HUMAN_ATTESTATION_FAILED: local human attestation failed closed.';
}

export function mcpCommands(dependencies: McpCommandDependencies): Command {
  const command = new Command('mcp').description(
    'Qoder/OpenSlack Model Context Protocol integration',
  );

  const attestation = command
    .command('attestation')
    .description('Manage the credential-free local human subject binding');

  attestation
    .command('status')
    .description('Inspect the current local human attestation readiness')
    .action(() => {
      try {
        const status = (dependencies.getAttestationStatus ?? getLocalHumanAttestationStatus)(
          dependencies.workspaceRoot,
        );
        console.log(JSON.stringify(status, null, 2));
      } catch (error) {
        console.error(renderAttestationError(error));
        process.exitCode = 1;
      }
    });

  attestation
    .command('bind-local-subject')
    .description('Bind the current OS subject hash to one asserted human principal')
    .requiredOption('--human-principal <human-id>', 'Assert the human principal to bind')
    .requiredOption('--confirm', 'Confirm this local subject binding')
    .action((options: { readonly humanPrincipal: string; readonly confirm: true }) => {
      try {
        const status = (dependencies.bindLocalSubject ?? bindLocalHumanSubject)({
          workspaceRoot: dependencies.workspaceRoot,
          humanPrincipalId: options.humanPrincipal,
          confirmed: options.confirm,
        });
        console.log(JSON.stringify(status, null, 2));
      } catch (error) {
        console.error(renderAttestationError(error));
        process.exitCode = 1;
      }
    });

  command
    .command('serve')
    .description('Serve one exact OpenSlack MCP profile over stdio')
    .requiredOption('--stdio', 'Use the local stdio transport')
    .addOption(
      new Option('--profile <profile>', 'Select one exact production MCP profile')
        .choices([...OPENSLACK_MCP_CLI_PROFILES])
        .default('read-only'),
    )
    .option(
      '--principal-ref <agent-id>',
      'Resolve an active registry/runtime principal for agent-bound',
    )
    .option(
      '--human-principal <human-id>',
      'Assert the separately mapped human principal for human-attested',
    )
    .option('--workspace-id <workspace-id>', 'Assert the canonical workspace ID')
    .option(
      '--graph-read-mirror-origin <origin>',
      'Mirror Graph query/explain reads to one exact credential-free Go service origin',
    )
    .addOption(
      new Option(
        '--graph-read-mirror-network <mode>',
        'Restrict the mirror origin to loopback or explicitly selected internal IPs',
      ).choices(['loopback', 'internal']),
    )
    .addOption(
      new Option(
        '--graph-read-canary-backend <backend>',
        'Explicitly route the bounded canary to Go or roll it back to ts-local',
      ).choices(['go', 'ts-local']),
    )
    .option(
      '--graph-read-canary-routing-epoch <epoch>',
      'Bind canary reads and cursors to one routing epoch',
    )
    .option(
      '--graph-read-canary-tenant <workspace-id>',
      'Bind canary routing to the canonical workspace ID',
    )
    .option(
      '--graph-read-canary-scenarios <ids>',
      'Select a bounded comma-separated scenario instance allowlist',
    )
    .option(
      '--graph-read-canary-expires-at <timestamp>',
      'Expire the canary policy at one bounded timestamp',
    )
    .option('--graph-read-canary-origin <origin>', 'Use one exact credential-free Go canary origin')
    .addOption(
      new Option(
        '--graph-read-canary-network <mode>',
        'Restrict the canary origin to loopback or explicitly selected internal IPs',
      ).choices(['loopback', 'internal']),
    )
    .option(
      '--graph-read-canary-build-sha <sha>',
      'Bind every Go canary read to one exact service build SHA',
    )
    .addOption(
      new Option(
        '--graph-read-authority-backend <backend>',
        'Select the global Go Graph read authority or an explicit ts-local rollback epoch',
      ).choices(['go', 'ts-local']),
    )
    .option(
      '--graph-read-authority-routing-epoch <epoch>',
      'Bind every authority read and cursor to one global routing epoch',
    )
    .option(
      '--graph-read-authority-tenant <workspace-id>',
      'Bind the global authority to the canonical workspace ID',
    )
    .option(
      '--graph-read-authority-expires-at <timestamp>',
      'Expire the process-immutable authority policy at one bounded timestamp',
    )
    .option(
      '--graph-read-authority-origin <origin>',
      'Use one exact credential-free Go Graph authority origin',
    )
    .addOption(
      new Option(
        '--graph-read-authority-network <mode>',
        'Restrict the authority origin to loopback or explicitly selected internal IPs',
      ).choices(['loopback', 'internal']),
    )
    .option(
      '--graph-read-authority-build-sha <sha>',
      'Bind every Go authority read to one exact service build SHA',
    )
    .addOption(
      new Option(
        '--governance-authority-backend <backend>',
        'Select the backend for newly created governed plans in this routing epoch',
      ).choices(['go', 'ts-local']),
    )
    .option(
      '--governance-authority-routing-epoch <epoch>',
      'Bind newly created governed plans to one immutable authority epoch',
    )
    .option(
      '--governance-authority-tenant <workspace-id>',
      'Bind governance authority to the canonical workspace tenant',
    )
    .option(
      '--governance-authority-origin <origin>',
      'Use one exact private governance-control origin',
    )
    .addOption(
      new Option(
        '--governance-authority-network <mode>',
        'Restrict governance-control to loopback or explicitly selected internal IPs',
      ).choices(['loopback', 'internal']),
    )
    .option(
      '--governance-authority-build-sha <sha>',
      'Bind governance authority receipts to one exact service build SHA',
    )
    .option(
      '--governance-authority-caller <caller-id>',
      'Bind governance-control requests to one host-owned caller ID',
    )
    .option(
      '--governance-authority-expires-at <timestamp>',
      'Expire the process governance-control transport binding',
    )
    .action(async (options: McpServeOptions) => {
      let server: OpenSlackMcpServer | undefined;
      try {
        const context = await createProfileContext(dependencies, options);
        server = (dependencies.createServer ?? createOpenSlackMcpServer)(context);

        const close = async (): Promise<void> => {
          try {
            await server?.close();
          } finally {
            process.exitCode = 0;
          }
        };
        process.once('SIGINT', close);
        process.once('SIGTERM', close);
        try {
          await server.serveStdio();
        } finally {
          process.off('SIGINT', close);
          process.off('SIGTERM', close);
        }
      } catch (error) {
        // stdout is reserved for protocol frames for the full lifetime of this command.
        if (error instanceof McpProfileArgumentError) {
          console.error(`OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: ${error.message}`);
        } else {
          console.error('OPENSLACK_MCP_START_FAILED: the requested stdio profile did not start.');
        }
        process.exitCode = 1;
      }
    });

  return command;
}
