import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getClient, parseGitHubRepoSpec } from '@openslack/github';
import { cleanupPRBranch, sendCleanupBrokerRequest, CleanupBrokerClientError } from '@openslack/pr';
import type { PRBranchCleanupAuditEvent } from '@openslack/pr';
import { createBoundEventAppender, createEvent, recordEvent } from '@openslack/collaboration';
import type { CollaborationEvent, CollaborationEventType } from '@openslack/collaboration';

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
  remoteExplicit?: boolean;
}

class CleanupInputError extends Error {}

function positiveInteger(value: string, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new CleanupInputError(
      `${name} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return parsed;
}

function workspaceRoot(): string {
  let root = process.cwd();
  while (!existsSync(join(root, 'openslack.yaml'))) {
    const parent = dirname(root);
    if (parent === root)
      throw new CleanupInputError('Workspace root with openslack.yaml was not found.');
    root = parent;
  }
  return root;
}

function cleanupEvent(
  event: PRBranchCleanupAuditEvent,
): Omit<CollaborationEvent, 'id' | 'timestamp' | 'schema'> {
  let type: CollaborationEventType = 'pr.cleanup_branch.blocked';
  if (event.mode === 'preview' && event.state === 'CLEANUP_READY')
    type = 'pr.cleanup_branch.previewed';
  else if (event.phase === 'requested') type = 'pr.cleanup_branch.requested';
  else if (event.state === 'DELETED') type = 'pr.cleanup_branch.executed';
  else if (event.state === 'ALREADY_ABSENT') type = 'pr.cleanup_branch.already_absent';
  else if (['RECONCILIATION_REQUIRED', 'ABSENT_AFTER_ATTEMPT'].includes(event.state)) {
    type = 'pr.cleanup_branch.reconciliation_required';
  }
  return {
    type,
    // human-cli denotes an explicit calling mode, not proof of a human login.
    actor: {
      id: event.executor,
      kind: event.executor === 'human-cli' ? 'system' : 'agent',
      provider: 'cli',
    },
    object: { kind: 'pr', id: String(event.prNumber) },
    source: { kind: 'prms', ref: 'pr.cleanup-branch' },
    summary: `PR #${event.prNumber} branch cleanup: ${event.phase} / ${event.state}`,
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    correlationId: event.operationId,
    metadata: {
      operation_id: event.operationId,
      repository: event.repository,
      pr_number: event.prNumber,
      branch: event.branch,
      expected_sha: event.expectedSha,
      observed_sha: event.observedSha,
      observed_ref_state: event.observedRefState,
      outcome: event.state,
      attempted: event.attempted,
      executor: event.executor,
      authorization_source: event.authorizationSource,
      evidence_timestamp: event.evidenceTimestamp,
      transport_identity: 'github_app_installation',
    },
  };
}

export async function runPRBranchCleanupCommand(
  number: string,
  options: CleanupCommandOptions,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const prNumber = positiveInteger(number, 'PR number');
    const timeoutMs = positiveInteger(options.timeout, '--timeout', 600) * 1000;
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
    if (options.repo !== undefined && !parseGitHubRepoSpec(options.repo)) {
      throw new CleanupInputError('--repo must be owner/name.');
    }
    if (
      options.agentId === undefined &&
      (options.permitId !== undefined ||
        options.operationId !== undefined ||
        options.operationStatus)
    ) {
      throw new CleanupInputError('BLOCKED_AUTHORIZATION: broker options require --agent-id.');
    }
    const rootDir = workspaceRoot();
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
      const { resolveAgentPrincipal, loadRuntimeIdentity } = await import('@openslack/runtime');
      const { parseAgentRegistry } = await import('@openslack/workspace');
      const registry = parseAgentRegistry(rootDir, options.agentId);
      let principal: { registry_id: string; runtime_uid: string; run_id: string };
      if (mode === 'status') {
        // A historical receipt remains readable after admission is revoked.
        // Preserve the original local identity claims; never fabricate them
        // from current authority, environment variables or a human fallback.
        const identity = loadRuntimeIdentity(rootDir, options.agentId);
        if (
          !registry ||
          !identity ||
          identity.agent_id !== options.agentId ||
          identity.provider !== 'cli'
        ) {
          throw new CleanupInputError(
            'BLOCKED_AUTHORIZATION: STATUS_IDENTITY_UNAVAILABLE; original local identity and registry claims are required for status.',
          );
        }
        principal = {
          registry_id: identity.agent_id,
          runtime_uid: identity.agent_uid,
          run_id: identity.run_id,
        };
      } else {
        const resolved = resolveAgentPrincipal({
          root: rootDir,
          agentId: options.agentId,
          provider: 'cli',
        });
        if ('error' in resolved)
          throw new CleanupInputError('BLOCKED_AUTHORIZATION: agent identity resolution failed.');
        principal = resolved.principal;
      }
      if (
        !registry ||
        registry.agent_id !== principal.registry_id ||
        registry.identity.uid !== principal.runtime_uid
      ) {
        throw new CleanupInputError('BLOCKED_AUTHORIZATION: local identity binding changed.');
      }
      // These fields are claims, not authenticated identity. The broker binds
      // its kernel peer to administrator-controlled authority independently.
      const result = await sendCleanupBrokerRequest(
        {
          schema: 'openslack.cleanup_request.v1',
          mode,
          agentId: principal.registry_id,
          principalId: registry.identity.principal_id,
          runtimeUid: principal.runtime_uid,
          runId: principal.run_id,
          repo: options.repo,
          remote: options.remote,
          prNumber,
          permitId: options.permitId,
          ...(mode !== 'preview' ? { operationId: options.operationId! } : {}),
        },
        { timeoutMs: remainingMs() },
      );
      console.log(
        `PR: #${prNumber}\nRepository: ${options.repo}\nDecision: ${result.state}\nReason: ${result.reason}\nAudit: ${result.auditStatus}\nPermit: ${result.permitId}\nPermit state: ${result.permitState}\nOperation: ${result.operationId ?? 'not reserved'}\nClaim requirement: ${result.claimRequirement}\nClaim status: ${result.claimStatus}`,
      );
      if (mode === 'preview') console.log('Preview only. No remote branch was deleted.');
      if (
        ['reserved', 'reconciliation_required'].includes(result.permitState) ||
        ['OPERATION_IN_PROGRESS', 'RECONCILIATION_REQUIRED', 'ABSENT_AFTER_ATTEMPT'].includes(
          result.state,
        )
      ) {
        console.error(
          'Operation unresolved. Query --operation-status with the same operation ID; do not repeat execute.',
        );
      }
      const success =
        mode === 'preview'
          ? ['CLEANUP_READY', 'ALREADY_ABSENT'].includes(result.state)
          : ['DELETED', 'ALREADY_ABSENT'].includes(result.state) &&
            result.auditStatus === 'RECORDED' &&
            result.permitState === 'consumed';
      if (!success || result.auditStatus === 'FAILED') process.exitCode = 1;
      return;
    }
    const auth = options.auth as 'auto' | 'app' | 'token';
    const client = await getClient({
      repoFullName: options.repo,
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
          recordEvent(cleanupEvent(event), rootDir);
          return;
        }
        // Creation and append errors propagate to the steward. Intent must be
        // fsynced before deletion; terminal failure must not trigger a retry.
        appender ??= createBoundEventAppender(rootDir);
        appender.append(createEvent(cleanupEvent(event)));
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
    const success = options.execute
      ? ['DELETED', 'ALREADY_ABSENT'].includes(result.state) && result.auditStatus !== 'FAILED'
      : ['CLEANUP_READY', 'ALREADY_ABSENT'].includes(result.state);
    if (!success) process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof CleanupInputError || error instanceof CleanupBrokerClientError
        ? error.message
        : 'BLOCKED_EVIDENCE: branch cleanup could not complete; inspect sanitized operational diagnostics.',
    );
    process.exitCode = 1;
  }
}
