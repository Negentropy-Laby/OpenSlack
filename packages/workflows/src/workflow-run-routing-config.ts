import { createHash } from 'node:crypto';

import {
  WorkflowControlAuthorityHttpClient,
  type WorkflowControlAuthorityPort,
} from './workflow-control-authority-client.js';
import type { WorkflowRunnerControlConfig } from './workflow-runner-control-client.js';
import { WorkflowRunRouter } from './workflow-run-routing.js';
import {
  WorkflowRunnerV2ControlClient,
  type WorkflowRunnerV2ControlPort,
} from './workflow-runner-v2-control-client.js';
import type { WorkflowRunnerV2BudgetPolicyBinding } from './workflow-runner-v2-descriptor.js';

export const WORKFLOW_RUN_ROUTING_MODE_ENV = 'OPENSLACK_WORKFLOW_RUN_ROUTING_MODE' as const;
export const WORKFLOW_RUN_ROUTING_MODE_GO = 'go-new-record-canary-v1' as const;
export const WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK = 'ts-new-record-rollback-v1' as const;

const PREFIX = 'OPENSLACK_WORKFLOW_RUN_ROUTING_';
const HASH = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,17}[1-9])?$/u;
const KNOWN = new Set([
  WORKFLOW_RUN_ROUTING_MODE_ENV,
  `${PREFIX}EPOCH`,
  `${PREFIX}AUTHORITY_BUILD_SHA`,
  `${PREFIX}QUALIFICATION_ENVIRONMENT_ID`,
  `${PREFIX}WORKFLOW_ALLOWLIST`,
  `${PREFIX}RUN_ALLOWLIST`,
  `${PREFIX}EXPIRES_AT`,
  `${PREFIX}AUTHORITY_ORIGIN`,
  `${PREFIX}AUTHORITY_BEARER_TOKEN`,
  `${PREFIX}AUTHORITY_BEARER_SHA256`,
  `${PREFIX}AUTHORITY_CALLER_ID`,
  `${PREFIX}BUDGET_ACCOUNT_ID`,
  `${PREFIX}BUDGET_POLICY_SHA`,
  `${PREFIX}BUDGET_RATE_NANO_USD_PER_TOKEN`,
  `${PREFIX}BUDGET_TOKEN_LIMIT`,
  `${PREFIX}BUDGET_COST_LIMIT_NANO_USD`,
  `${PREFIX}BUDGET_CALL_LIMIT`,
]);
const COMMON = [
  `${PREFIX}EPOCH`,
  `${PREFIX}AUTHORITY_BUILD_SHA`,
  `${PREFIX}QUALIFICATION_ENVIRONMENT_ID`,
  `${PREFIX}WORKFLOW_ALLOWLIST`,
  `${PREFIX}RUN_ALLOWLIST`,
  `${PREFIX}EXPIRES_AT`,
] as const;
const GO_ONLY = [
  `${PREFIX}AUTHORITY_ORIGIN`,
  `${PREFIX}AUTHORITY_BEARER_TOKEN`,
  `${PREFIX}AUTHORITY_BEARER_SHA256`,
  `${PREFIX}AUTHORITY_CALLER_ID`,
  `${PREFIX}BUDGET_ACCOUNT_ID`,
  `${PREFIX}BUDGET_POLICY_SHA`,
  `${PREFIX}BUDGET_RATE_NANO_USD_PER_TOKEN`,
  `${PREFIX}BUDGET_TOKEN_LIMIT`,
  `${PREFIX}BUDGET_COST_LIMIT_NANO_USD`,
  `${PREFIX}BUDGET_CALL_LIMIT`,
] as const;

export interface WorkflowRunRoutingExecutionConfig {
  readonly router: WorkflowRunRouter;
  readonly authority?: WorkflowControlAuthorityPort;
  readonly v2Client?: WorkflowRunnerV2ControlPort;
  readonly v2BudgetPolicy?: WorkflowRunnerV2BudgetPolicyBinding;
}

export class WorkflowRunRoutingConfigError extends Error {
  readonly code = 'WORKFLOW_RUN_ROUTING_CONFIG_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunRoutingConfigError';
  }
}

const processConfigs = new Map<
  string,
  { readonly fingerprint: string; readonly config: WorkflowRunRoutingExecutionConfig }
>();

function fail(message: string): never {
  throw new WorkflowRunRoutingConfigError(message);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value === '') return fail(`${name} is required.`);
  return value;
}

function allowlist(value: string, name: string): readonly string[] {
  if (value === '') return Object.freeze([]);
  const entries = value.split(',');
  if (entries.some((entry) => entry === '' || entry.trim() !== entry)) {
    return fail(`${name} must be a canonical comma-separated list.`);
  }
  return Object.freeze(entries);
}

function exactEnvironment(
  environment: NodeJS.ProcessEnv,
  mode: string,
): Readonly<Record<string, string>> {
  const present = Object.keys(environment).filter((name) => name.startsWith(PREFIX));
  const unknown = present.find((name) => !KNOWN.has(name));
  if (unknown) return fail(`Unknown workflow routing setting ${unknown}.`);
  const expected = new Set<string>([
    WORKFLOW_RUN_ROUTING_MODE_ENV,
    ...COMMON,
    ...(mode === WORKFLOW_RUN_ROUTING_MODE_GO ? GO_ONLY : []),
  ]);
  const extra = present.find((name) => !expected.has(name));
  if (extra) return fail(`${extra} is not valid for routing mode ${mode}.`);
  const result: Record<string, string> = {};
  for (const name of expected) {
    if (name === `${PREFIX}WORKFLOW_ALLOWLIST` || name === `${PREFIX}RUN_ALLOWLIST`) {
      const value = environment[name];
      if (value === undefined) return fail(`${name} is required.`);
      result[name] = value;
    } else {
      result[name] = required(environment, name);
    }
  }
  return Object.freeze(result);
}

function fingerprint(value: Readonly<Record<string, string>>): string {
  return createHash('sha256')
    .update('openslack.workflow-run-routing.process-config.v1\0', 'utf8')
    .update(
      JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
    )
    .digest('hex');
}

/**
 * Loads one process-immutable, default-off new-record routing profile. A
 * higher-epoch TS rollback is explicit and carries no Go credentials.
 */
export function loadWorkflowRunRoutingExecutionConfig(
  runner: WorkflowRunnerControlConfig,
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunRoutingExecutionConfig | undefined {
  const mode = environment[WORKFLOW_RUN_ROUTING_MODE_ENV];
  if (mode === undefined || mode === '') {
    const unexpected = Object.keys(environment).find((name) => name.startsWith(PREFIX));
    if (unexpected || processConfigs.has(runner.workspaceId)) {
      return fail('Workflow run routing cannot be disabled or partially configured in-process.');
    }
    return undefined;
  }
  if (mode !== WORKFLOW_RUN_ROUTING_MODE_GO && mode !== WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK) {
    return fail('Workflow run routing mode is unsupported.');
  }
  const exact = exactEnvironment(environment, mode);
  const configFingerprint = fingerprint(exact);
  const cached = processConfigs.get(runner.workspaceId);
  if (cached) {
    if (cached.fingerprint !== configFingerprint) {
      return fail('Workflow run routing configuration changed after process initialization.');
    }
    return cached.config;
  }
  const epochText = exact[`${PREFIX}EPOCH`]!;
  if (!POSITIVE_INTEGER.test(epochText) || Number(epochText) > Number.MAX_SAFE_INTEGER) {
    return fail('Workflow run routing epoch is invalid.');
  }
  const build = exact[`${PREFIX}AUTHORITY_BUILD_SHA`]!;
  if (!HASH.test(build)) return fail('Workflow run routing authority build is invalid.');
  const go = mode === WORKFLOW_RUN_ROUTING_MODE_GO;
  const router = new WorkflowRunRouter({
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: runner.workspaceId,
    backend: go ? 'go' : 'ts-local',
    authority: go ? 'workflow-control' : 'typescript',
    routingEpoch: Number(epochText),
    authorityBuildHash: build,
    qualificationEnvironmentId: exact[`${PREFIX}QUALIFICATION_ENVIRONMENT_ID`]!,
    workflowAllowlist: allowlist(
      exact[`${PREFIX}WORKFLOW_ALLOWLIST`]!,
      `${PREFIX}WORKFLOW_ALLOWLIST`,
    ),
    runAllowlist: allowlist(exact[`${PREFIX}RUN_ALLOWLIST`]!, `${PREFIX}RUN_ALLOWLIST`),
    expiresAt: exact[`${PREFIX}EXPIRES_AT`]!,
  });
  let config: WorkflowRunRoutingExecutionConfig = Object.freeze({ router });
  if (go) {
    const bearerToken = exact[`${PREFIX}AUTHORITY_BEARER_TOKEN`]!;
    const bearerHash = exact[`${PREFIX}AUTHORITY_BEARER_SHA256`]!;
    if (
      !HASH.test(bearerHash) ||
      createHash('sha256').update(bearerToken, 'utf8').digest('hex') !== bearerHash
    ) {
      return fail('Workflow run routing authority bearer binding is invalid.');
    }
    const budgetPolicy = Object.freeze({
      accountId: exact[`${PREFIX}BUDGET_ACCOUNT_ID`]!,
      policyHash: exact[`${PREFIX}BUDGET_POLICY_SHA`]!,
      rateNanoUsdPerToken: exact[`${PREFIX}BUDGET_RATE_NANO_USD_PER_TOKEN`]!,
      tokenLimit: exact[`${PREFIX}BUDGET_TOKEN_LIMIT`]!,
      costLimitNanoUsd: exact[`${PREFIX}BUDGET_COST_LIMIT_NANO_USD`]!,
      callLimit: exact[`${PREFIX}BUDGET_CALL_LIMIT`]!,
    });
    if (
      !HASH.test(budgetPolicy.policyHash) ||
      !DECIMAL.test(budgetPolicy.rateNanoUsdPerToken) ||
      !POSITIVE_INTEGER.test(budgetPolicy.tokenLimit) ||
      !POSITIVE_INTEGER.test(budgetPolicy.costLimitNanoUsd) ||
      !POSITIVE_INTEGER.test(budgetPolicy.callLimit)
    ) {
      return fail('Workflow run routing v2 budget policy is invalid.');
    }
    config = Object.freeze({
      router,
      authority: new WorkflowControlAuthorityHttpClient({
        origin: exact[`${PREFIX}AUTHORITY_ORIGIN`]!,
        workspaceId: runner.workspaceId,
        callerId: exact[`${PREFIX}AUTHORITY_CALLER_ID`]!,
        bearerToken,
        expectedBuildHash: build,
      }),
      v2Client: new WorkflowRunnerV2ControlClient(runner),
      v2BudgetPolicy: budgetPolicy,
    });
  }
  processConfigs.set(runner.workspaceId, { fingerprint: configFingerprint, config });
  return config;
}
