import { findWorkspaceRoot } from '@openslack/workspace';
import { getClient, parseGitHubRepoSpec } from '@openslack/github';
import {
  cleanupPRBranch,
  sendCleanupBrokerRequest,
  CleanupBrokerClientError,
  projectPRBranchCleanupEvent,
  evaluateCleanupBrokerResult,
  evaluatePRBranchCleanupResult,
  buildCleanupOperationRecord,
  readCleanupOperationRecord,
  CleanupOperationRecordError,
  saveCleanupOperationRecord,
  buildCleanupStatusRequest,
  parseCleanupPositiveInteger,
  CleanupRequestInputError,
  validateCleanupBrokerRequest,
} from '@openslack/pr';
import type { CleanupBrokerRequest } from '@openslack/pr';
import type { AgentPermissionSnapshot } from '@openslack/kernel';
import { createBoundEventAppender, createEvent, recordEvent } from '@openslack/collaboration';

interface CleanupCommandOptions {
  execute?: boolean;
  agentId?: string;
  repo?: string;
  auth: string;
  remote: string;
  timeout: string;
  permitId?: string;
  operationId?: string;
  operationStatus?: boolean;
  operationRecord?: string;
  remoteExplicit?: boolean;
}

class CleanupInputError extends Error {}

export async function runPRBranchCleanupCommand(
  number: string | undefined,
  options: CleanupCommandOptions,
): Promise<void> {
  process.exitCode = 0;
  const startedAt = Date.now();
  try {
    // The PR positional is optional so record status mode can run without one;
    // every other mode requires it, checked once the record branch has passed.
    const parsedNumber =
      number === undefined ? undefined : parseCleanupPositiveInteger(number, 'PR number');
    const timeoutMs = parseCleanupPositiveInteger(options.timeout, '--timeout', 600) * 1000;
    const deadline = startedAt + timeoutMs;
    const remainingMs = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new CleanupInputError('BLOCKED_EVIDENCE: cleanup deadline elapsed.');
      return remaining;
    };
    if (!['auto', 'app', 'token'].includes(options.auth)) {
      throw new CleanupInputError(
        '--auth must be auto, app, or token; cleanup always requires live evidence.',
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.remote)) {
      throw new CleanupInputError('--remote must be a named Git remote, not a URL or option.');
    }
    const parsedRepo = options.repo === undefined ? undefined : parseGitHubRepoSpec(options.repo);
    if (options.repo !== undefined && !parsedRepo) {
      throw new CleanupInputError('--repo must be owner/name.');
    }
    const repository = parsedRepo ? `${parsedRepo.owner}/${parsedRepo.repo}` : undefined;
    // A published operation record is read here — before the broker-option
    // guard and before findWorkspaceRoot() — so a historical record stays
    // readable without a workspace, agent registry, or local identity. The
    // record is evidence of what was originally requested; it is never an
    // authorization, and it cannot admit a preview or execute.
    if (options.operationRecord !== undefined) {
      if (options.operationStatus !== true) {
        throw new CleanupInputError('--operation-record is only valid with --operation-status.');
      }
      if (options.execute === true) {
        throw new CleanupInputError('--operation-record cannot authorize an execute.');
      }
      const record = readCleanupOperationRecord(options.operationRecord);
      const { request } = record;

      // The record carries the original validated binding. An explicit argument
      // that matches it is allowed; a conflict is refused before the query so a
      // mistyped argument cannot silently query a different operation.
      const statusRequest = buildCleanupStatusRequest(record, {
        agentId: options.agentId,
        permitId: options.permitId,
        operationId: options.operationId,
        repo: repository,
        remote: options.remoteExplicit ? options.remote : undefined,
        prNumber: parsedNumber,
      });
      const result = await sendCleanupBrokerRequest(statusRequest, { timeoutMs: remainingMs() });
      console.log(
        `Record: ${record.schema}\nCreated: ${record.createdAt}\nDigest: ${record.requestDigest}\nOperation: ${request.operationId}\nRepository: ${request.repo}\nRemote: ${request.remote}\nPR: #${request.prNumber}\nPermit: ${request.permitId}\nAgent: ${request.agentId}\nPrincipal: ${request.principalId}\nRuntime UID: ${request.runtimeUid}\nRun: ${request.runId}`,
      );
      console.log(
        `Decision: ${result.state}\nReason: ${result.reason}\nAudit: ${result.auditStatus}\nPermit state: ${result.permitState}\nAttempted: ${result.attempted}`,
      );
      console.log(
        'The record is historical evidence, not an authorization: it cannot admit a preview or execute.',
      );
      const evaluation = evaluateCleanupBrokerResult(result);
      if (evaluation.notice) console.error(evaluation.notice);
      process.exitCode = evaluation.exitCode;
      return;
    }
    if (parsedNumber === undefined) {
      throw new CleanupInputError(
        'PR number is required unless --operation-record supplies the binding.',
      );
    }
    const prNumber = parsedNumber;
    if (
      options.agentId === undefined &&
      (options.permitId !== undefined ||
        options.operationId !== undefined ||
        options.operationStatus)
    ) {
      throw new CleanupInputError('BLOCKED_AUTHORIZATION: broker options require --agent-id.');
    }
    const rootDir = findWorkspaceRoot();
    if (!rootDir) throw new CleanupInputError('Workspace root with openslack.yaml was not found.');
    if (options.agentId !== undefined) {
      if (!options.agentId.trim())
        throw new CleanupInputError('BLOCKED_AUTHORIZATION: empty agent ID.');
      if (
        !options.permitId ||
        !options.repo ||
        options.remoteExplicit !== true ||
        options.auth !== 'app'
      ) {
        throw new CleanupInputError(
          'BLOCKED_AUTHORIZATION: agent cleanup requires --permit-id, explicit --repo, explicit --remote and --auth app.',
        );
      }
      if (options.execute && options.operationStatus) {
        throw new CleanupInputError('--execute and --operation-status are mutually exclusive.');
      }
      const mode = options.operationStatus ? 'status' : options.execute ? 'execute' : 'preview';
      if (
        (mode === 'preview' && options.operationId !== undefined) ||
        (mode !== 'preview' && !options.operationId)
      ) {
        throw new CleanupInputError(
          'Execute/status requires --operation-id; preview prohibits --operation-id.',
        );
      }
      const { resolveAgentPrincipal, resolveAgentStatusBinding } =
        await import('@openslack/runtime');
      const resolved =
        mode === 'status'
          ? resolveAgentStatusBinding({ root: rootDir, agentId: options.agentId, provider: 'cli' })
          : resolveAgentPrincipal({ root: rootDir, agentId: options.agentId, provider: 'cli' });
      if ('error' in resolved)
        throw new CleanupInputError(
          mode === 'status'
            ? 'BLOCKED_AUTHORIZATION: STATUS_IDENTITY_UNAVAILABLE; original local identity and registry claims are required for status.'
            : 'BLOCKED_AUTHORIZATION: agent identity resolution failed.',
        );
      const principal = resolved.principal;
      const snapshot: AgentPermissionSnapshot | null =
        'snapshot' in resolved ? (resolved.snapshot ?? null) : null;
      // These fields are claims, not authenticated identity. The broker binds
      // its kernel peer to administrator-controlled authority independently.
      const brokerRequest: CleanupBrokerRequest = {
        schema: 'openslack.cleanup_request.v1',
        mode,
        agentId: principal.registry_id,
        principalId: resolved.principalId,
        runtimeUid: principal.runtime_uid,
        runId: principal.run_id,
        repo: repository!,
        remote: options.remote,
        prNumber,
        permitId: options.permitId!,
        ...(mode !== 'preview' ? { operationId: options.operationId! } : {}),
      };
      validateCleanupBrokerRequest(brokerRequest);
      if (mode === 'execute') {
        // Publish the historical query record before the request is sent. The
        // resolved permission snapshot authorizes the real record path first, so
        // a denial creates no directory, writes no record and sends nothing. A
        // persistence failure likewise refuses the send rather than proceeding
        // without evidence; an identical binding is reused, a different one is
        // refused.
        saveCleanupOperationRecord(
          buildCleanupOperationRecord({
            ...brokerRequest,
            operationId: options.operationId!,
          }),
          { rootDir, snapshot },
        );
      }
      const result = await sendCleanupBrokerRequest(brokerRequest, { timeoutMs: remainingMs() });
      console.log(
        `PR: #${prNumber}\nRepository: ${repository}\nDecision: ${result.state}\nReason: ${result.reason}\nAudit: ${result.auditStatus}\nPermit: ${result.permitId}\nPermit state: ${result.permitState}\nOperation: ${result.operationId ?? 'not reserved'}\nClaim requirement: ${result.claimRequirement}\nClaim status: ${result.claimStatus}`,
      );
      if (mode === 'preview') console.log('Preview only. No remote branch was deleted.');
      const evaluation = evaluateCleanupBrokerResult(result);
      if (evaluation.notice) console.error(evaluation.notice);
      process.exitCode = evaluation.exitCode;
      return;
    }
    const auth = options.auth as 'auto' | 'app' | 'token';
    const client = await getClient({
      repoFullName: repository,
      auth,
      requireLive: true,
      strictEvidence: true,
      signal: AbortSignal.timeout(remainingMs()),
    });
    if (client.isDryRun)
      throw new CleanupInputError('BLOCKED_EVIDENCE: live GitHub authentication is required.');
    let appender: ReturnType<typeof createBoundEventAppender> | undefined;
    const result = await cleanupPRBranch({
      prNumber,
      rootDir,
      owner: client.owner,
      repo: client.repo,
      remote: options.remote,
      auth,
      timeoutMs: remainingMs(),
      execute: options.execute === true,
      context: { kind: 'human-cli' },
      audit: async (event) => {
        if (event.mode === 'preview') {
          recordEvent(projectPRBranchCleanupEvent(event), rootDir);
          return;
        }
        // Creation and append errors propagate to the steward. Intent must be
        // fsynced before deletion; terminal failure must not trigger a retry.
        appender ??= createBoundEventAppender(rootDir);
        appender.append(createEvent(projectPRBranchCleanupEvent(event)));
      },
    });
    console.log(
      `PR: #${result.prNumber}\nRepository: ${result.repository}\nBranch: ${result.branch ?? 'unknown'}\nExpected SHA: ${result.expectedSha ?? 'unknown'}`,
    );
    for (const check of result.checks)
      console.log(`${check.status}\t${check.name}\t${check.detail ?? ''}`);
    console.log(
      `Decision: ${result.state}\nReason: ${result.reason}\nAudit: ${result.auditStatus}\nOperation: ${result.operationId}`,
    );
    if (!options.execute) console.log('Preview only. No remote branch was deleted.');
    if (result.auditStatus === 'FAILED')
      console.error(
        'Audit incomplete. Preserve this operation result; do not automatically retry deletion.',
      );
    process.exitCode = evaluatePRBranchCleanupResult(result, options.execute === true);
  } catch (error) {
    console.error(
      error instanceof CleanupInputError ||
        error instanceof CleanupRequestInputError ||
        error instanceof CleanupBrokerClientError ||
        error instanceof CleanupOperationRecordError
        ? error.message
        : 'BLOCKED_EVIDENCE: branch cleanup could not complete; inspect sanitized operational diagnostics.',
    );
    process.exitCode = 1;
  }
}
