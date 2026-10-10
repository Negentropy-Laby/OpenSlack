import {
  CleanupBrokerClientError,
  sendCleanupBrokerRequest,
  type CleanupBrokerRequest,
} from '../../packages/pr/src/cleanup-broker-client.js';
import { readCleanupOperationRecord } from '../../packages/pr/src/cleanup-operation-record.js';
import { evaluateCleanupBrokerResult } from '../../packages/pr/src/cleanup-result.js';

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
 * This entry is bundled with its implementation and has no checkout,
 * node_modules, Git or network dependency beyond the broker socket.
 */
const MODES = ['preview', 'execute', 'status'] as const;
const OPTIONS = [
  '--mode',
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
    `Usage: client.mjs --mode <${MODES.join('|')}> --agent-id <id> --principal-id <id> --runtime-uid <uid> --run-id <id> --repo <owner/name> --remote <name> --pr <number> --permit-id <id> [--operation-id <id>] [--timeout-ms <n>]\n` +
      '       client.mjs --mode status --operation-record <path>\n',
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

  const required = [
    '--agent-id',
    '--principal-id',
    '--runtime-uid',
    '--run-id',
    '--repo',
    '--remote',
    '--pr',
    '--permit-id',
  ] as const;
  for (const name of required) if (!options.has(name)) usage(`${name} is required`);

  const agentId = options.get('--agent-id')!;
  const principalId = options.get('--principal-id')!;
  const runtimeUid = options.get('--runtime-uid')!;
  const runId = options.get('--run-id')!;
  const repo = options.get('--repo')!;
  const remote = options.get('--remote')!;
  const permitId = options.get('--permit-id')!;
  const prNumber = Number(options.get('--pr'));

  if (!identifier.test(agentId)) usage('--agent-id must be a bounded identifier');
  if (!claim.test(principalId)) usage('--principal-id must be a bounded claim');
  if (!claim.test(runtimeUid)) usage('--runtime-uid must be a bounded claim');
  if (!claim.test(runId)) usage('--run-id must be a bounded claim');
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

  const request: CleanupBrokerRequest = {
    schema: 'openslack.cleanup_request.v1',
    mode,
    agentId,
    principalId,
    runtimeUid,
    runId,
    repo,
    remote,
    prNumber,
    permitId,
    ...(mode === 'preview' ? {} : { operationId: operationId! }),
  };

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
