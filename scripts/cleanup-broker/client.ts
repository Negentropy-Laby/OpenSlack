import {
  CleanupBrokerClientError,
  sendCleanupBrokerRequest,
  validateCleanupBrokerRequest,
  type CleanupBrokerRequest,
} from '../../packages/pr/src/cleanup-broker-client.js';
import {
  buildCleanupOperationRecord,
  readCleanupOperationRecord,
  CleanupOperationRecordError,
  saveCleanupOperationRecord,
} from '../../packages/pr/src/cleanup-operation-record.js';
import {
  buildCleanupStatusRequest,
  parseCleanupPositiveInteger,
  parseCleanupRepository,
  CleanupRequestInputError,
} from '../../packages/pr/src/cleanup-request.js';
import { evaluateCleanupBrokerResult } from '../../packages/pr/src/cleanup-result.js';
// Application entry only. PR never imports Runtime; there is no deletion fallback.
import {
  resolveAgentPrincipal,
  resolveAgentStatusBinding,
} from '../../packages/runtime/src/identity.js';

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

function usage(message: string): never {
  throw new CleanupRequestInputError(message);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (!name || !(OPTIONS as readonly string[]).includes(name) || !value || options.has(name))
      usage('unexpected or repeated argument');
    options.set(name, value);
  }
  const rawMode = options.get('--mode');
  if (!rawMode || !(MODES as readonly string[]).includes(rawMode)) usage('--mode is required');
  const mode = rawMode as (typeof MODES)[number];
  const timeoutMs = options.has('--timeout-ms')
    ? parseCleanupPositiveInteger(options.get('--timeout-ms')!, '--timeout-ms', 600_000)
    : 60_000;
  const explicit = {
    agentId: options.get('--agent-id'),
    principalId: options.get('--principal-id'),
    runtimeUid: options.get('--runtime-uid'),
    runId: options.get('--run-id'),
    repo: options.has('--repo') ? parseCleanupRepository(options.get('--repo')!) : undefined,
    remote: options.get('--remote'),
    prNumber: options.has('--pr')
      ? parseCleanupPositiveInteger(options.get('--pr')!, 'PR number')
      : undefined,
    permitId: options.get('--permit-id'),
    operationId: options.get('--operation-id'),
  };
  let request: CleanupBrokerRequest;
  const recordPath = options.get('--operation-record');
  if (recordPath !== undefined) {
    if (mode !== 'status') usage('--operation-record is only valid with --mode status');
    const record = readCleanupOperationRecord(recordPath);
    request = buildCleanupStatusRequest(record, explicit);
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    for (const name of ['--workspace', '--agent-id', '--repo', '--remote', '--pr', '--permit-id'])
      if (!options.has(name)) usage(`${name} is required`);
    const workspace = options.get('--workspace')!,
      agentId = explicit.agentId!;
    // Validate user-controlled wire fields before identity IO, publication or transport.
    const provisional: CleanupBrokerRequest = {
      schema: 'openslack.cleanup_request.v1',
      mode,
      agentId,
      principalId: 'pending',
      runtimeUid: 'pending',
      runId: 'pending',
      repo: explicit.repo!,
      remote: explicit.remote!,
      prNumber: explicit.prNumber!,
      permitId: explicit.permitId!,
      ...(explicit.operationId === undefined ? {} : { operationId: explicit.operationId }),
    };
    try {
      validateCleanupBrokerRequest(provisional);
    } catch {
      usage('request does not satisfy the cleanup wire contract');
    }
    const resolved =
      mode === 'status'
        ? resolveAgentStatusBinding({ root: workspace, agentId, provider: 'cli' })
        : resolveAgentPrincipal({ root: workspace, agentId, provider: 'cli' });
    if ('error' in resolved)
      usage('the fixed workspace identity could not be resolved; do not bootstrap a new one');
    const principal = resolved.principal;
    const claims = {
      principalId: resolved.principalId,
      runtimeUid: principal.runtime_uid,
      runId: principal.run_id,
    };
    for (const field of ['principalId', 'runtimeUid', 'runId'] as const)
      if (explicit[field] !== undefined && explicit[field] !== claims[field])
        usage(`${field} does not match the fixed workspace identity`);
    request = { ...provisional, agentId: principal.registry_id, ...claims };
    validateCleanupBrokerRequest(request);
    if (mode === 'execute') {
      if (!('snapshot' in resolved) || !resolved.snapshot)
        usage('execution admission is unavailable');
      saveCleanupOperationRecord(
        buildCleanupOperationRecord({ ...request, operationId: explicit.operationId! }),
        { rootDir: workspace, snapshot: resolved.snapshot },
      );
    }
  }
  const response = await sendCleanupBrokerRequest(request, { timeoutMs });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (mode === 'preview') process.stdout.write('Preview only. No remote branch was deleted.\n');
  const evaluation = evaluateCleanupBrokerResult(response);
  if (evaluation.notice) process.stderr.write(`${evaluation.notice}\n`);
  process.exitCode = evaluation.exitCode;
}

try {
  await main();
} catch (error) {
  if (error instanceof CleanupRequestInputError) {
    process.stderr.write(`CLIENT_INPUT_INVALID: ${error.message}\n`);
    process.stderr.write(
      'Usage: client.mjs --mode <preview|execute|status> --workspace <dir> --agent-id <id> --repo <owner/name> --remote <name> --pr <number> --permit-id <id> [--operation-id <id>]\n       client.mjs --mode status --operation-record <path> [matching explicit bindings]\n',
    );
    process.exitCode = 2;
  } else {
    process.stderr.write(
      error instanceof CleanupBrokerClientError || error instanceof CleanupOperationRecordError
        ? `${error.message}\n`
        : 'CLIENT_EVIDENCE_FAILED: preserve evidence and inspect the original operation.\n',
    );
    process.exitCode = 1;
  }
}
