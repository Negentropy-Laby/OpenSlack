import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  WorkflowControlAuthorityHttpClient,
  type WorkflowControlAuthorityPort,
} from './workflow-control-authority-client.js';
import type { WorkflowRunnerControlConfig } from './workflow-runner-control-client.js';
import { WorkflowRunRouteJournal, WorkflowRunRouter } from './workflow-run-routing.js';
import {
  WorkflowRunnerV2ControlClient,
  type WorkflowRunnerV2ControlPort,
} from './workflow-runner-v2-control-client.js';
import type { WorkflowRunnerV2BudgetPolicyBinding } from './workflow-runner-v2-descriptor.js';
import {
  isWorkflowControlBearerToken,
  parseWorkflowControlRoutingEpoch,
} from './workflow-control-routing-identity.js';

export const WORKFLOW_RUN_ROUTING_MODE_ENV = 'OPENSLACK_WORKFLOW_RUN_ROUTING_MODE' as const;
export const WORKFLOW_RUN_ROUTING_MODE_GO = 'go-new-record-canary-v1' as const;
export const WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK = 'ts-new-record-rollback-v1' as const;

const PREFIX = 'OPENSLACK_WORKFLOW_RUN_ROUTING_';
const HASH = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,17}[1-9])?$/u;
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
const KNOWN = new Set<string>([WORKFLOW_RUN_ROUTING_MODE_ENV, ...COMMON, ...GO_ONLY]);

export interface WorkflowRunRoutingConfig {
  readonly mode: typeof WORKFLOW_RUN_ROUTING_MODE_GO | typeof WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK;
  readonly router: WorkflowRunRouter;
  readonly authorityOptions?: ConstructorParameters<typeof WorkflowControlAuthorityHttpClient>[0];
  readonly v2BudgetPolicy?: WorkflowRunnerV2BudgetPolicyBinding;
  readonly fingerprint: string;
}

export interface WorkflowRunRoutingDisabledConfig {
  readonly mode: 'disabled';
  readonly ignoredSettings: readonly string[];
}

export interface WorkflowRunRoutingExecutionContext {
  readonly mode: 'disabled' | 'explicit';
  readonly router?: WorkflowRunRouter;
  readonly journal: Pick<
    WorkflowRunRouteJournal,
    'load' | 'locate' | 'commit' | 'close' | 'inspect' | 'repair'
  >;
  readonly authority?: WorkflowControlAuthorityPort;
  readonly v2Client?: WorkflowRunnerV2ControlPort;
  readonly v2BudgetPolicy?: WorkflowRunnerV2BudgetPolicyBinding;
  readonly fingerprint: string;
  readonly diagnostics: readonly string[];
  readonly binding?: WorkflowRunRoutingBindingExpectation;
}

export interface WorkflowRunRoutingBindingExpectation {
  readonly runnerOrigin: string;
  readonly runnerWorkspaceId: string;
  readonly runnerTokenSha256: string;
  readonly runnerBuildSha: string;
  readonly authorityOrigin: string;
  readonly authorityCallerId: string;
  readonly authorityBuildSha: string;
  readonly authorityTokenSha256: string;
}

export class WorkflowRunRoutingConfigError extends Error {
  readonly code = 'WORKFLOW_RUN_ROUTING_CONFIG_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunRoutingConfigError';
  }
}

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
export function loadWorkflowRunRoutingConfig(
  runner: WorkflowRunnerControlConfig,
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunRoutingConfig | WorkflowRunRoutingDisabledConfig {
  const mode = environment[WORKFLOW_RUN_ROUTING_MODE_ENV];
  if (mode === undefined || mode === '') {
    const ignoredSettings = Object.keys(environment)
      .filter((name) => name.startsWith(PREFIX) && name !== WORKFLOW_RUN_ROUTING_MODE_ENV)
      .sort();
    return Object.freeze({ mode: 'disabled', ignoredSettings: Object.freeze(ignoredSettings) });
  }
  if (mode !== WORKFLOW_RUN_ROUTING_MODE_GO && mode !== WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK) {
    return fail('Workflow run routing mode is unsupported.');
  }
  const exact = exactEnvironment(environment, mode);
  const configFingerprint = fingerprint(exact);
  const epochText = exact[`${PREFIX}EPOCH`]!;
  let routingEpoch: number;
  try {
    routingEpoch = parseWorkflowControlRoutingEpoch(epochText);
  } catch {
    return fail('Workflow run routing epoch is invalid.');
  }
  const build = exact[`${PREFIX}AUTHORITY_BUILD_SHA`]!;
  if (!HASH.test(build)) return fail('Workflow run routing authority build is invalid.');
  const go = mode === WORKFLOW_RUN_ROUTING_MODE_GO;
  const router = new WorkflowRunRouter({
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: runner.workspaceId,
    backend: go ? 'go' : 'ts-local',
    routingEpoch,
    authorityBuildHash: build,
    qualificationEnvironmentId: exact[`${PREFIX}QUALIFICATION_ENVIRONMENT_ID`]!,
    workflowAllowlist: allowlist(
      exact[`${PREFIX}WORKFLOW_ALLOWLIST`]!,
      `${PREFIX}WORKFLOW_ALLOWLIST`,
    ),
    runAllowlist: allowlist(exact[`${PREFIX}RUN_ALLOWLIST`]!, `${PREFIX}RUN_ALLOWLIST`),
    expiresAt: exact[`${PREFIX}EXPIRES_AT`]!,
  });
  let config: WorkflowRunRoutingConfig = Object.freeze({
    mode,
    router,
    fingerprint: configFingerprint,
  });
  if (go) {
    const bearerToken = exact[`${PREFIX}AUTHORITY_BEARER_TOKEN`]!;
    const bearerHash = exact[`${PREFIX}AUTHORITY_BEARER_SHA256`]!;
    if (
      !isWorkflowControlBearerToken(bearerToken) ||
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
      mode,
      router,
      authorityOptions: Object.freeze({
        origin: exact[`${PREFIX}AUTHORITY_ORIGIN`]!,
        workspaceId: runner.workspaceId,
        callerId: exact[`${PREFIX}AUTHORITY_CALLER_ID`]!,
        bearerToken,
        expectedBuildHash: build,
      }),
      v2BudgetPolicy: budgetPolicy,
      fingerprint: configFingerprint,
    });
  }
  return config;
}

export function createWorkflowRunRoutingExecutionContext(input: {
  readonly runner: WorkflowRunnerControlConfig;
  readonly workspaceRoot: string;
  readonly config: WorkflowRunRoutingConfig | WorkflowRunRoutingDisabledConfig;
  readonly authority?: WorkflowControlAuthorityPort;
  readonly v2Client?: WorkflowRunnerV2ControlPort;
  readonly journal?: WorkflowRunRouteJournal;
}): WorkflowRunRoutingExecutionContext {
  const journal =
    input.journal ??
    new WorkflowRunRouteJournal(
      join(input.workspaceRoot, '.openslack.local', 'workflows', 'routes'),
    );
  if (input.config.mode === 'disabled') {
    return Object.freeze({
      mode: 'disabled',
      journal,
      fingerprint: fingerprint({ mode: 'disabled' }),
      diagnostics: Object.freeze(
        input.config.ignoredSettings.length === 0
          ? []
          : ['WORKFLOW_RUN_ROUTING_SETTINGS_IGNORED_WITHOUT_MODE'],
      ),
    });
  }
  const go = input.config.mode === WORKFLOW_RUN_ROUTING_MODE_GO;
  if (go && !input.runner.expectedBuildHash) {
    fail('Go workflow routing requires an expected runner build hash.');
  }
  const authority =
    input.authority ??
    (input.config.authorityOptions
      ? new WorkflowControlAuthorityHttpClient(input.config.authorityOptions)
      : undefined);
  const v2Client =
    input.v2Client ?? (go ? new WorkflowRunnerV2ControlClient(input.runner) : undefined);
  return Object.freeze({
    mode: 'explicit',
    router: input.config.router,
    journal,
    authority,
    v2Client,
    v2BudgetPolicy: input.config.v2BudgetPolicy,
    fingerprint: input.config.fingerprint,
    diagnostics: Object.freeze([]),
    ...(go && input.config.authorityOptions
      ? {
          binding: Object.freeze({
            runnerOrigin: input.runner.origin,
            runnerWorkspaceId: input.runner.workspaceId,
            runnerTokenSha256: createHash('sha256')
              .update(input.runner.bearerToken, 'utf8')
              .digest('hex'),
            runnerBuildSha: input.runner.expectedBuildHash!,
            authorityOrigin: input.config.authorityOptions.origin,
            authorityCallerId: input.config.authorityOptions.callerId,
            authorityBuildSha: input.config.authorityOptions.expectedBuildHash,
            authorityTokenSha256: createHash('sha256')
              .update(input.config.authorityOptions.bearerToken, 'utf8')
              .digest('hex'),
          }),
        }
      : {}),
  });
}

/** @deprecated Use the pure loader plus the explicit execution-context factory. */
export function loadWorkflowRunRoutingExecutionConfig(
  runner: WorkflowRunnerControlConfig,
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunRoutingConfig | WorkflowRunRoutingDisabledConfig {
  return loadWorkflowRunRoutingConfig(runner, environment);
}
