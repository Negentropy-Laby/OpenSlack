import type {
  BlockingFinding,
  BundledActionContribution,
  BundledPluginCapability,
  BundledPluginContext,
  BundledWorkflowContribution,
  HostPlanStep,
  JsonValue,
  MaybePromise,
} from '@openslack/plugin-api';

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const RANGE =
  /^(?:\^|~|>=|<=|>|<|=)?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?: (?:\^|~|>=|<=|>|<|=)?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))*$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u;
const RESERVED = new Set([
  'openslack',
  'built-in',
  'plugin',
  'workspace',
  'external',
  'negentropy',
]);
const BUNDLED_CAPABILITIES = new Set<BundledPluginCapability>([
  'host.actions.read',
  'host.workflows.read',
  'workspace.read',
  'github.issues.read',
  'github.pull_requests.read',
  'github.checks.read',
  'collaboration.read',
  'host.actions.plan',
  'host.workflows.contribute',
  'prms.blockers.append',
  'github.issues.write',
  'github.pull_requests.comment',
  'github.pull_requests.merge.request',
  'collaboration.write',
  'workflow.execute',
]);

export class BundledPluginValidationError extends Error {
  readonly code:
    | 'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID'
    | 'PLUGIN_HOST_PRMS_RESULT_INVALID'
    | 'PLUGIN_HOST_PRMS_BLOCKER_INVALID';
  readonly path: string;

  constructor(code: BundledPluginValidationError['code'], path: string, message: string) {
    super(message);
    this.name = 'BundledPluginValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: BundledPluginValidationError['code'], path: string, message: string): never {
  throw new BundledPluginValidationError(code, path, message);
}

function exactDataObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
  code: BundledPluginValidationError['code'] = 'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(code, path, 'Expected a plain data object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(code, path, 'Custom prototypes are forbidden.');
  }
  const allowed = new Set([...required, ...optional]);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return fail(code, path, 'Unknown, symbol, or authority-bearing fields are forbidden.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(code, `${path}/${String(key)}`, 'Fields must be enumerable own data properties.');
    }
    output[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(output, key))
      return fail(code, `${path}/${key}`, 'Required field is missing.');
  }
  return output;
}

function safeString(
  value: unknown,
  path: string,
  options: { max: number; pattern?: RegExp; code?: BundledPluginValidationError['code'] },
): string {
  const code = options.code ?? 'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID';
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Array.from(value).length > options.max ||
    !SAFE_TEXT.test(value) ||
    (options.pattern && !options.pattern.test(value))
  ) {
    return fail(code, path, 'Expected bounded control-free text in the closed host grammar.');
  }
  return value;
}

function safeJsonClone(value: unknown, state = { nodes: 0 }, depth = 0): JsonValue {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 32)
    fail(
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      '/contributions/catalogItem',
      'Catalog data exceeds host limits.',
    );
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && Array.from(value).length > 4_096)
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        '/contributions/catalogItem',
        'Catalog text exceeds host limits.',
      );
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        '/contributions/catalogItem',
        'Catalog numbers must be finite.',
      );
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1_000)
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        '/contributions/catalogItem',
        'Catalog arrays are invalid.',
      );
    const output: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        fail(
          'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
          '/contributions/catalogItem',
          'Catalog arrays must be dense data arrays.',
        );
      output.push(safeJsonClone(descriptor.value, state, depth + 1));
    }
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== 'string' || (key !== 'length' && !/^\d+$/.test(key)),
      )
    )
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        '/contributions/catalogItem',
        'Catalog arrays cannot have named or symbol fields.',
      );
    return Object.freeze(output);
  }
  const record = exactDataObject(value, '/contributions/catalogItem', Object.keys(value as object));
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(record).sort()) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor')
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        '/contributions/catalogItem',
        'Prototype-sensitive catalog keys are forbidden.',
      );
    output[key] = safeJsonClone(record[key], state, depth + 1);
  }
  return Object.freeze(output);
}

export interface NormalizedBundledAction extends BundledActionContribution<HostPlanStep> {
  readonly target: {
    readonly kind: 'host_action';
    readonly id: string;
  };
}
export type NormalizedBundledWorkflow = BundledWorkflowContribution<JsonValue>;
export interface NormalizedBundledPrmsBlocker {
  readonly kind: 'prms_blocker';
  readonly id: string;
  evaluate(report: Readonly<unknown>, context: BundledPluginContext): MaybePromise<unknown>;
}

export type NormalizedBundledContribution =
  | NormalizedBundledAction
  | NormalizedBundledWorkflow
  | NormalizedBundledPrmsBlocker;

export interface NormalizedBundledPlugin {
  readonly providerKind: 'bundled';
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly requires: { readonly openslack: string };
  readonly gate: { readonly mode: 'SHADOW' | 'ENFORCE'; readonly gateId: string };
  readonly requestedCapabilities: readonly BundledPluginCapability[];
  readonly contributions: readonly NormalizedBundledContribution[];
  readonly activate?: (context: BundledPluginContext) => MaybePromise<void>;
  readonly deactivate?: (context: BundledPluginContext) => MaybePromise<void>;
}

export function normalizeBundledPluginDefinition(value: unknown): NormalizedBundledPlugin {
  const root = exactDataObject(
    value,
    '',
    [
      'providerKind',
      'id',
      'version',
      'name',
      'requires',
      'gate',
      'requestedCapabilities',
      'contributions',
    ],
    ['description', 'activate', 'deactivate'],
  );
  if (root.providerKind !== 'bundled')
    fail(
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      '/providerKind',
      'Explicit bundled registration requires providerKind bundled.',
    );
  const id = safeString(root.id, '/id', { max: 64, pattern: PLUGIN_ID });
  if (RESERVED.has(id) || id.startsWith('openslack-'))
    fail('PLUGIN_HOST_BUNDLED_DEFINITION_INVALID', '/id', 'Bundled plugin ID is reserved.');
  const version = safeString(root.version, '/version', { max: 32, pattern: VERSION });
  const name = safeString(root.name, '/name', { max: 120 });
  const description =
    root.description === undefined
      ? undefined
      : safeString(root.description, '/description', { max: 512 });
  const requires = exactDataObject(root.requires, '/requires', ['openslack']);
  const openslack = safeString(requires.openslack, '/requires/openslack', {
    max: 128,
    pattern: RANGE,
  });
  const gate = exactDataObject(root.gate, '/gate', ['mode', 'gateId']);
  if (gate.mode !== 'SHADOW' && gate.mode !== 'ENFORCE')
    fail('PLUGIN_HOST_BUNDLED_DEFINITION_INVALID', '/gate/mode', 'Gate mode is invalid.');
  const gateId = safeString(gate.gateId, '/gate/gateId', { max: 128, pattern: ID });

  if (!Array.isArray(root.requestedCapabilities) || root.requestedCapabilities.length > 32)
    fail(
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      '/requestedCapabilities',
      'Capabilities must be a bounded array.',
    );
  const capabilitySeen = new Set<string>();
  const requestedCapabilities = root.requestedCapabilities.map((item, index) => {
    if (
      typeof item !== 'string' ||
      !BUNDLED_CAPABILITIES.has(item as BundledPluginCapability) ||
      capabilitySeen.has(item)
    )
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        `/requestedCapabilities/${index}`,
        'Capability is unknown or duplicated.',
      );
    capabilitySeen.add(item);
    return item as BundledPluginCapability;
  });

  if (
    !Array.isArray(root.contributions) ||
    root.contributions.length < 1 ||
    root.contributions.length > 64
  )
    fail(
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      '/contributions',
      'Contributions must contain 1 to 64 entries.',
    );
  const seen = new Set<string>();
  const contributions: NormalizedBundledContribution[] = root.contributions.map((item, index) => {
    const basePath = `/contributions/${index}`;
    const probe = exactDataObject(
      item,
      basePath,
      ['kind', 'id'],
      ['target', 'buildPlanStep', 'catalogItem', 'evaluate'],
    );
    const contributionId = safeString(probe.id, `${basePath}/id`, { max: 64, pattern: PLUGIN_ID });
    if (
      probe.kind !== 'bundled_action' &&
      probe.kind !== 'bundled_workflow' &&
      probe.kind !== 'prms_blocker'
    )
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        `${basePath}/kind`,
        'Bundled contribution kind is invalid.',
      );
    const collisionKey = `${String(probe.kind)}:${contributionId}`;
    if (seen.has(collisionKey))
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        `${basePath}/id`,
        'Contribution ID is duplicated for its kind.',
      );
    seen.add(collisionKey);
    if (probe.kind === 'bundled_action') {
      const exact = exactDataObject(item, basePath, ['kind', 'id', 'target', 'buildPlanStep']);
      const target = exactDataObject(exact.target, `${basePath}/target`, ['kind', 'id']);
      if (target.kind !== 'host_action')
        fail(
          'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
          `${basePath}/target/kind`,
          'Bundled actions require a fixed host_action target.',
        );
      const targetId = safeString(target.id, `${basePath}/target/id`, {
        max: 128,
        pattern: ID,
      });
      if (typeof exact.buildPlanStep !== 'function')
        fail(
          'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
          `${basePath}/buildPlanStep`,
          'Bundled action requires a function.',
        );
      return Object.freeze({
        kind: 'bundled_action' as const,
        id: contributionId,
        target: Object.freeze({ kind: 'host_action' as const, id: targetId }),
        buildPlanStep: exact.buildPlanStep as NormalizedBundledAction['buildPlanStep'],
      });
    }
    if (probe.kind === 'bundled_workflow') {
      const exact = exactDataObject(item, basePath, ['kind', 'id', 'catalogItem']);
      return Object.freeze({
        kind: 'bundled_workflow' as const,
        id: contributionId,
        catalogItem: safeJsonClone(exact.catalogItem),
      });
    }
    const exact = exactDataObject(item, basePath, ['kind', 'id', 'evaluate']);
    if (typeof exact.evaluate !== 'function')
      fail(
        'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
        `${basePath}/evaluate`,
        'PRMS blocker requires an evaluator function.',
      );
    return Object.freeze({
      kind: 'prms_blocker' as const,
      id: contributionId,
      evaluate: exact.evaluate as NormalizedBundledPrmsBlocker['evaluate'],
    });
  });

  if (
    contributions.some((item) => item.kind === 'bundled_action') &&
    !capabilitySeen.has('host.actions.plan')
  )
    fail(
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      '/requestedCapabilities',
      'Bundled actions require host.actions.plan.',
    );
  if (
    contributions.some((item) => item.kind === 'bundled_workflow') &&
    !capabilitySeen.has('host.workflows.contribute')
  )
    fail(
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      '/requestedCapabilities',
      'Bundled workflows require host.workflows.contribute.',
    );
  if (
    contributions.some((item) => item.kind === 'prms_blocker') &&
    !capabilitySeen.has('prms.blockers.append')
  )
    fail(
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      '/requestedCapabilities',
      'PRMS blockers require prms.blockers.append.',
    );
  for (const hook of ['activate', 'deactivate'] as const) {
    if (root[hook] !== undefined && typeof root[hook] !== 'function')
      fail('PLUGIN_HOST_BUNDLED_DEFINITION_INVALID', `/${hook}`, `${hook} must be a function.`);
  }

  return Object.freeze({
    providerKind: 'bundled' as const,
    id,
    version,
    name,
    ...(description === undefined ? {} : { description }),
    requires: Object.freeze({ openslack }),
    gate: Object.freeze({ mode: gate.mode as 'SHADOW' | 'ENFORCE', gateId }),
    requestedCapabilities: Object.freeze(requestedCapabilities),
    contributions: Object.freeze(contributions),
    ...(root.activate === undefined
      ? {}
      : { activate: root.activate as NormalizedBundledPlugin['activate'] }),
    ...(root.deactivate === undefined
      ? {}
      : { deactivate: root.deactivate as NormalizedBundledPlugin['deactivate'] }),
  });
}

export interface NormalizedPrmsBlockerResult {
  readonly blockers: readonly BlockingFinding[];
}

export function normalizePrmsBlockerResult(value: unknown): NormalizedPrmsBlockerResult {
  const root = exactDataObject(value, '', ['blockers'], [], 'PLUGIN_HOST_PRMS_RESULT_INVALID');
  if (!Array.isArray(root.blockers) || root.blockers.length > 100)
    fail('PLUGIN_HOST_PRMS_RESULT_INVALID', '/blockers', 'Blockers must be a bounded array.');
  const blockers = root.blockers.map((item, index) => {
    const path = `/blockers/${index}`;
    const blocker = exactDataObject(
      item,
      path,
      ['kind', 'code', 'summary'],
      ['detail'],
      'PLUGIN_HOST_PRMS_BLOCKER_INVALID',
    );
    if (blocker.kind !== 'blocker')
      fail(
        'PLUGIN_HOST_PRMS_BLOCKER_INVALID',
        `${path}/kind`,
        'PRMS output can only append blockers.',
      );
    const code = safeString(blocker.code, `${path}/code`, {
      max: 128,
      pattern: /^[A-Z][A-Z0-9_]*$/,
      code: 'PLUGIN_HOST_PRMS_BLOCKER_INVALID',
    });
    if (
      /(?:^|_)(?:PASS|PASSED|APPROVE|APPROVED|APPROVAL|READY_TO_MERGE|MERGEABLE|CAN_MERGE|AUTHORIZED|ALLOWED)(?:$|_)/.test(
        code,
      )
    ) {
      fail(
        'PLUGIN_HOST_PRMS_BLOCKER_INVALID',
        `${path}/code`,
        'PRMS blocker codes cannot represent approval, authorization, PASS, or mergeability.',
      );
    }
    const summary = safeString(blocker.summary, `${path}/summary`, {
      max: 512,
      code: 'PLUGIN_HOST_PRMS_BLOCKER_INVALID',
    });
    const detail =
      blocker.detail === undefined
        ? undefined
        : safeString(blocker.detail, `${path}/detail`, {
            max: 2_048,
            code: 'PLUGIN_HOST_PRMS_BLOCKER_INVALID',
          });
    return Object.freeze({
      kind: 'blocker' as const,
      code,
      summary,
      ...(detail === undefined ? {} : { detail }),
    });
  });
  return Object.freeze({ blockers: Object.freeze(blockers) });
}

export function prmsEvaluatorFailureBlocker(
  pluginId: string,
  contributionId: string,
  invalidResult: boolean,
): BlockingFinding {
  return Object.freeze({
    kind: 'blocker' as const,
    code: invalidResult ? 'PLUGIN_HOST_PRMS_RESULT_INVALID' : 'PLUGIN_HOST_PRMS_EVALUATOR_FAILED',
    summary: `Plugin PRMS blocker ${pluginId}/${contributionId} failed closed.`,
  });
}
