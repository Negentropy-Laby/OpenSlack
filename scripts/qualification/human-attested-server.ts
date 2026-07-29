import { parseArgs } from 'node:util';
import {
  createOpenSlackMcpContext,
  createOpenSlackMcpServer,
  type OpenSlackMcpServer,
} from '../../apps/mcp/src/index.js';
import { createOpenSlackCliContext } from '../../apps/cli/src/boot/context.js';
import { createOpenSlackHumanAttestedMcpComposition } from '../../apps/cli/src/mcp-human-attested-composition.js';

interface ServerArguments {
  readonly workspaceRoot: string;
  readonly principalRef: string;
  readonly humanPrincipal: string;
  readonly workspaceId: string;
}

function argumentsFromProcess(): ServerArguments {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    strict: true,
    options: {
      'workspace-root': { type: 'string' },
      'principal-ref': { type: 'string' },
      'human-principal': { type: 'string' },
      'workspace-id': { type: 'string' },
    },
  });
  const workspaceRoot = parsed.values['workspace-root'];
  const principalRef = parsed.values['principal-ref'];
  const humanPrincipal = parsed.values['human-principal'];
  const workspaceId = parsed.values['workspace-id'];
  if (
    typeof workspaceRoot !== 'string' ||
    typeof principalRef !== 'string' ||
    typeof humanPrincipal !== 'string' ||
    typeof workspaceId !== 'string'
  ) {
    throw new Error('HUMAN_QUALIFICATION_SERVER_ARGUMENT_INVALID');
  }
  return Object.freeze({ workspaceRoot, principalRef, humanPrincipal, workspaceId });
}

async function main(): Promise<void> {
  const input = argumentsFromProcess();
  const application = createOpenSlackCliContext({
    workspaceRoot: input.workspaceRoot,
    openslackVersion: '0.2.0',
  });
  const composition = await createOpenSlackHumanAttestedMcpComposition({
    workspaceRoot: input.workspaceRoot,
    principalRef: input.principalRef,
    humanPrincipalAssertion: input.humanPrincipal,
    workspaceIdAssertion: input.workspaceId,
  });
  const context = createOpenSlackMcpContext({
    workspaceRoot: input.workspaceRoot,
    operator: application.operator,
    governedMutations: composition.governedMutations,
    workflowApprovalAuthority: composition.workflowApprovalAuthority,
  });
  let server: OpenSlackMcpServer | undefined = createOpenSlackMcpServer(context, {
    timeoutMs: 30_000,
  });
  const close = async (): Promise<void> => {
    try {
      await server?.close();
    } finally {
      server = undefined;
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
}

try {
  await main();
} catch {
  process.stderr.write('HUMAN_QUALIFICATION_SERVER_FAILED\n');
  process.exitCode = 1;
}
