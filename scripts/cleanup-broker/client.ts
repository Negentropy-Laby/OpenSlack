import {
  CleanupBrokerClientError,
  sendCleanupBrokerRequest,
  type CleanupBrokerRequest,
} from '../../packages/pr/src/cleanup-broker-client.js';
import {
  buildCleanupOperationRecord,
  readCleanupOperationRecord,
  saveCleanupOperationRecord,
} from '../../packages/pr/src/cleanup-operation-record.js';
import { evaluateCleanupBrokerResult } from '../../packages/pr/src/cleanup-result.js';
// Narrow import: only the identity resolver is needed, not the whole runtime
// surface, so the bundle stays small and gains no unrelated capability.
import { resolveAgentPrincipal } from '../../packages/runtime/src/identity.js';
import { parseAgentRegistry } from '../../packages/workspace/src/index.js';

/**
 * Broker-only cleanup client for the installed target.
 *
 * It reuses the production broker command path — the same
 * `sendCleanupBrokerRequest` the repository CLI uses — and it deliberately
 * exposes **no direct branch-deletion fallback**. Deletion happens only through
 * the governed broker, which authenticates its operating-system peer and the
 * durable binding; this client can neither delete a remote branch itself nor
 * authorize one.
 *
 * Identity is read from an explicitly named workspace and never bootstrapped:
 * the fixed registry and runtime identity an administrator provisioned are the
 * only source, and the explicit claims on the command line are checked against
 * them rather than trusted.
 *
 * This entry is bundled with its implementation and has no checkout,
 * node_modules, Git or network dependency beyond the broker socket.
 */
const MODES = ['preview', 'execute', 'status'] as const;
const OPTIONS = [
  '--mode',
  '--workspace',
  '--agent-id',
  '--principal-id',
  '--runtime-uid',
  '--run-id',
  '--repo',
  '--remote',
  '--pr',
  '--permit-id',
  '--operation-id',
  '--operation-record',
  '--timeout-ms',
] as const;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const claim = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

function usage(message: string): never {
  process.stderr.write(`CLIENT_INPUT_INVALID: ${message}\n`);
  process.stderr.write(
    `Usage: client.mjs --mode <${MODES.join('|')}> --workspace <dir> --agent-id <id> --repo <owner/name> --remote <name> --pr <number> --permit-id <id> [--operation-id <id>] [--principal-id <id>] [--runtime-uid <uid>] [--run-id <id>] [--timeout-ms <n>]\n` +
      '       client.mjs --mode status --operation-record <path>\n' +
      'Explicit --principal-id, --runtime-uid and --run-id are checked against the fixed workspace identity; they never replace it.\n',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!name || !(OPTIONS as readonly string[]).includes(name) || !value || options.has(name)) {
    usage(`unexpected or repeated argument ${name ?? ''}`.trim());
  }
  options.set(name, value);
}

const rawMode = options.get('--mode');
if (!rawMode || !(MODES as readonly string[]).includes(rawMode)) usage('--mode is required');
const mode = rawMode as (typeof MODES)[number];
// Resolved once, before main(), because the record branch uses it too.
const timeoutMs = options.has('--timeout-ms') ? Number(options.get('--timeout-ms')) : 60_000;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
  usage('--timeout-ms must be an integer between 1 and 600000');
}

async function main(): Promise<void> {
  const recordPath = options.get('--operation-record');
  if (recordPath !== undefined) {
    // A published record is historical evidence. It is readable only in status
    // mode and it can never stand in for identity authorization, so it is
    // refused for preview and execute.
    if (mode !== 'status') usage('--operation-record is only valid with --mode status');
    const record = readCleanupOperationRecord(recordPath);
    const { request } = record;

    // Explicit bindings must match the record; a conflict is refused before the
    // query so a mistyped argument cannot query a different operation.
    const conflicts: string[] = [];
    if (options.has('--agent-id') && options.get('--agent-id') !== request.agentId)
      conflicts.push('--agent-id');
    if (options.has('--principal-id') && options.get('--principal-id') !== request.principalId)
      conflicts.push('--principal-id');
    if (options.has('--runtime-uid') && options.get('--runtime-uid') !== request.runtimeUid)
      conflicts.push('--runtime-uid');
    if (options.has('--run-id') && options.get('--run-id') !== request.runId)
      conflicts.push('--run-id');
    if (options.has('--repo') && options.get('--repo') !== request.repo) conflicts.push('--repo');
    if (options.has('--remote') && options.get('--remote') !== request.remote)
      conflicts.push('--remote');
    if (options.has('--pr') && Number(options.get('--pr')) !== request.prNumber)
      conflicts.push('--pr');
    if (options.has('--permit-id') && options.get('--permit-id') !== request.permitId)
      conflicts.push('--permit-id');
    if (options.has('--operation-id') && options.get('--operation-id') !== request.operationId)
      conflicts.push('--operation-id');
    if (conflicts.length > 0) usage(`--operation-record conflicts with ${conflicts.join(', ')}`);

    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    // The record supplies the validated original binding, so status needs no
    // workspace, registry or local identity. It must actually query the Broker.
    try {
      const response = await sendCleanupBrokerRequest(
        { ...request, mode: 'status' },
        { timeoutMs },
      );
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      const evaluation = evaluateCleanupBrokerResult(response);
      if (evaluation.notice) process.stderr.write(`${evaluation.notice}\n`);
      process.exitCode = evaluation.exitCode;
    } catch (error) {
      process.stderr.write(
        error instanceof CleanupBrokerClientError
          ? `${error.message}\n`
          : 'BROKER_UNAVAILABLE: the cleanup broker could not be reached.\n',
      );
      process.exitCode = 1;
    }
    return;
  }

  const required = ['--workspace', '--agent-id', '--repo', '--remote', '--pr', '--permit-id'] as const;
  for (const name of required) if (!options.has(name)) usage(`${name} is required`);

  const workspace = options.get('--workspace')!;
  const agentId = options.get('--agent-id')!;
  const repo = options.get('--repo')!;
  const remote = options.get('--remote')!;
  const permitId = options.get('--permit-id')!;
  const prNumber = Number(options.get('--pr'));

  if (!identifier.test(agentId)) usage('--agent-id must be a bounded identifier');
  if (!claim.test(permitId)) usage('--permit-id must be a bounded claim');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) usage('--repo must be owner/name');
  if (!identifier.test(remote)) usage('--remote must be a named remote');
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) usage('--pr must be a positive integer');

  const operationId = options.get('--operation-id');
  if (mode === 'preview' && operationId !== undefined) {
    usage('--operation-id is prohibited for preview');
  }
  if (mode !== 'preview' && !operationId) usage('--operation-id is required for execute and status');
  if (operationId !== undefined && !identifier.test(operationId)) {
    usage('--operation-id must be a bounded identifier');
  }

  // The fixed identity comes from the named workspace. Nothing is bootstrapped:
  // if the administrator has not provisioned a registry and runtime identity,
  // this refuses rather than creating one.
  const resolved = resolveAgentPrincipal({ root: workspace, agentId, provider: 'cli' });
  if ('error' in resolved) {
    usage('the fixed workspace identity could not be resolved; do not bootstrap a new one');
  }
  const principal = resolved.principal;
  const snapshot = resolved.snapshot;

  // The principal ID is a distinct registry field. `AgentPrincipal` carries only
  // the registry id, so reading the principal from it would send the agent id
  // instead — producing a different record digest than the CLI for the same
  // operation and failing the Broker's own registry binding check.
  const registry = parseAgentRegistry(workspace, agentId);
  if (
    !registry ||
    registry.agent_id !== principal.registry_id ||
    registry.identity.uid !== principal.runtime_uid
  ) {
    usage('the local identity binding changed; do not bootstrap a new identity');
  }
  const principalId = registry.identity.principal_id;

  // Explicit claims are checked against the resolved identity, never trusted.
  const mismatched: string[] = [];
  if (options.has('--principal-id') && options.get('--principal-id') !== principalId)
    mismatched.push('--principal-id');
  if (options.has('--runtime-uid') && options.get('--runtime-uid') !== principal.runtime_uid)
    mismatched.push('--runtime-uid');
  if (options.has('--run-id') && options.get('--run-id') !== principal.run_id)
    mismatched.push('--run-id');
  if (mismatched.length > 0) {
    usage(`${mismatched.join(', ')} does not match the fixed workspace identity`);
  }

  const request: CleanupBrokerRequest = {
    schema: 'openslack.cleanup_request.v1',
    mode,
    agentId: principal.registry_id,
    principalId,
    runtimeUid: principal.runtime_uid,
    runId: principal.run_id,
    repo,
    remote,
    prNumber,
    permitId,
    ...(mode === 'preview' ? {} : { operationId: operationId! }),
  };

  if (mode === 'execute') {
    // Publish the historical query record before the request is sent, through
    // the same authorized, durable publish path the repository CLI uses. The
    // resolved snapshot authorizes the real record path first, so a denial
    // creates nothing and sends nothing; a persistence failure likewise
    // refuses the send rather than proceeding without evidence.
    try {
      saveCleanupOperationRecord(
        buildCleanupOperationRecord({ ...request, operationId: operationId! }),
        { rootDir: workspace, snapshot },
      );
    } catch (error) {
      process.stderr.write(
        `${
          error instanceof Error ? error.message : 'CLEANUP_OPERATION_RECORD_FAILED'
        }\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  try {
    const response = await sendCleanupBrokerRequest(request, { timeoutMs });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    if (mode === 'preview') {
      process.stdout.write('Preview only. No remote branch was deleted.\n');
    }
    // The shared evaluator owns the exit-code table so both entries agree:
    // accepted-but-running is 0 with a notice; refused, failed, unknown and
    // reconciliation are 1.
    const evaluation = evaluateCleanupBrokerResult(response);
    if (evaluation.notice) process.stderr.write(`${evaluation.notice}\n`);
    process.exitCode = evaluation.exitCode;
  } catch (error) {
    if (error instanceof CleanupBrokerClientError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write('BROKER_UNAVAILABLE: the cleanup broker could not be reached.\n');
    process.exitCode = 1;
  }
}

await main();
