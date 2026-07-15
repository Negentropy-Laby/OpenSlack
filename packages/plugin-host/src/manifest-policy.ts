import type {
  DeclarativeContributionV1,
  DeclarativePluginCapability,
  ManifestValidationCode,
  ManifestValidationFinding,
  PluginManifestV1,
  PluginManifestValidationResult,
} from '@openslack/plugin-api';

const ROOT_FIELDS = new Set([
  'schema',
  'id',
  'version',
  'name',
  'description',
  'requires',
  'gate',
  'capabilities',
  'contributes',
]);
const ROOT_REQUIRED = [
  'schema',
  'id',
  'version',
  'name',
  'requires',
  'gate',
  'capabilities',
  'contributes',
];
const CONTRIBUTION_FIELDS = new Set([
  'kind',
  'id',
  'title',
  'description',
  'inputs',
  'inputMapping',
  'target',
]);
const CAPABILITIES = new Set<DeclarativePluginCapability>([
  'host.actions.read',
  'host.workflows.read',
  'workspace.read',
  'github.issues.read',
  'github.pull_requests.read',
  'github.checks.read',
  'collaboration.read',
]);
const RESERVED_IDS = new Set([
  'openslack',
  'built-in',
  'plugin',
  'workspace',
  'external',
  'negentropy',
]);
const EXECUTABLE_FIELDS = new Set([
  'entry',
  'main',
  'exports',
  'activate',
  'deactivate',
  'evaluate',
  'implementation',
  'command',
  'argv',
  'args',
  'shell',
  'exec',
  'spawn',
  'template',
]);
const SECURITY_FIELDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'tostring',
  'path',
  'file',
  'url',
  'provider',
  'providerkind',
  'approval',
  'approved',
  'humanapproval',
  'permissions',
  'risk',
  'risklevel',
  'riskzone',
  'confirmationrequired',
  'lifecycle',
  'state',
  'authoritystate',
  'proposemutation',
  'authoritywriterhandle',
]);
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HOST_REFERENCE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RANGE_VERSION = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
const OPENSLACK_RANGE = new RegExp(
  `^(?:\\^|~|>=|<=|>|<|=)?${RANGE_VERSION}(?: (?:\\^|~|>=|<=|>|<|=)?${RANGE_VERSION})*$`,
);
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

type MutableFinding = {
  severity: 'error';
  code: ManifestValidationCode;
  path: string;
  message: string;
};

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pointer(base: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${base}/${escaped}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function add(
  findings: MutableFinding[],
  code: ManifestValidationCode,
  path: string,
  message: string,
): void {
  findings.push({ severity: 'error', code, path, message });
}

function unknownFieldCode(key: string): ManifestValidationCode {
  const folded = key.toLowerCase();
  if (EXECUTABLE_FIELDS.has(folded)) return 'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN';
  if (SECURITY_FIELDS.has(folded)) return 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN';
  return 'PLUGIN_MANIFEST_FIELD_UNKNOWN';
}

function exactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  path: string,
  findings: MutableFinding[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      add(
        findings,
        unknownFieldCode(key),
        pointer(path, key),
        `Field "${key}" is not allowed by the Red host.`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      add(
        findings,
        'PLUGIN_MANIFEST_FIELD_REQUIRED',
        pointer(path, key),
        `Field "${key}" is required.`,
      );
    }
  }
}

function stringField(
  value: unknown,
  path: string,
  findings: MutableFinding[],
  options: { max: number; pattern?: RegExp; display?: boolean; code?: ManifestValidationCode },
): value is string {
  if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > options.max) {
    add(
      findings,
      options.code ?? 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      `Expected a non-empty string of at most ${options.max} characters.`,
    );
    return false;
  }
  if (options.pattern && !options.pattern.test(value)) {
    add(
      findings,
      options.code ?? 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'String does not match the closed host format.',
    );
    return false;
  }
  if (options.display && UNSAFE_DISPLAY.test(value)) {
    add(
      findings,
      'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
      path,
      'Display text contains terminal-control or bidirectional-control characters.',
    );
    return false;
  }
  return true;
}

function validateInputs(value: unknown, path: string, findings: MutableFinding[]): Set<string> {
  const names = new Set<string>();
  if (!isRecord(value)) {
    add(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', path, 'Inputs must be an object.');
    return names;
  }
  const keys = Object.keys(value);
  if (keys.length > 32) {
    add(findings, 'PLUGIN_MANIFEST_CONTRIBUTION_INVALID', path, 'At most 32 inputs are allowed.');
  }
  for (const name of keys) {
    const inputPath = pointer(path, name);
    if (
      !FIELD_NAME.test(name) ||
      SECURITY_FIELDS.has(name.toLowerCase()) ||
      EXECUTABLE_FIELDS.has(name.toLowerCase())
    ) {
      add(
        findings,
        'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
        inputPath,
        'Input name is forbidden by the Red host.',
      );
      continue;
    }
    names.add(name);
    const definition = value[name];
    if (!isRecord(definition)) {
      add(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        inputPath,
        'Input definition must be an object.',
      );
      continue;
    }
    exactFields(
      definition,
      new Set(['type', 'required', 'description']),
      ['type'],
      inputPath,
      findings,
    );
    if (
      definition.type !== 'string' &&
      definition.type !== 'number' &&
      definition.type !== 'boolean'
    ) {
      add(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        pointer(inputPath, 'type'),
        'Input type must be string, number, or boolean.',
      );
    }
    if (Object.hasOwn(definition, 'required') && typeof definition.required !== 'boolean') {
      add(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        pointer(inputPath, 'required'),
        'Required must be boolean.',
      );
    }
    if (Object.hasOwn(definition, 'description')) {
      stringField(definition.description, pointer(inputPath, 'description'), findings, {
        max: 256,
        display: true,
      });
    }
  }
  return names;
}

function validateMapping(
  value: unknown,
  path: string,
  inputNames: ReadonlySet<string>,
  findings: MutableFinding[],
): void {
  if (!isRecord(value)) {
    add(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', path, 'Input mapping must be an object.');
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > 32)
    add(findings, 'PLUGIN_MANIFEST_CONTRIBUTION_INVALID', path, 'At most 32 mappings are allowed.');
  for (const targetField of keys) {
    const bindingPath = pointer(path, targetField);
    const folded = targetField.toLowerCase();
    if (
      !FIELD_NAME.test(targetField) ||
      SECURITY_FIELDS.has(folded) ||
      EXECUTABLE_FIELDS.has(folded)
    ) {
      add(
        findings,
        'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
        bindingPath,
        'Mapping target field is forbidden by the Red host.',
      );
      continue;
    }
    const binding = value[targetField];
    if (!isRecord(binding)) {
      add(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        bindingPath,
        'Mapping binding must be an object.',
      );
      continue;
    }
    if (binding.kind === 'constant') {
      exactFields(binding, new Set(['kind', 'value']), ['kind', 'value'], bindingPath, findings);
      if (
        binding.value === null ||
        (typeof binding.value !== 'string' &&
          typeof binding.value !== 'number' &&
          typeof binding.value !== 'boolean') ||
        (typeof binding.value === 'number' && !Number.isFinite(binding.value))
      ) {
        add(
          findings,
          'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
          pointer(bindingPath, 'value'),
          'Constant must be a finite string, number, or boolean.',
        );
      }
    } else if (binding.kind === 'input') {
      exactFields(binding, new Set(['kind', 'name']), ['kind', 'name'], bindingPath, findings);
      if (
        !stringField(binding.name, pointer(bindingPath, 'name'), findings, {
          max: 64,
          pattern: FIELD_NAME,
        })
      )
        continue;
      if (!inputNames.has(binding.name)) {
        add(
          findings,
          'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
          pointer(bindingPath, 'name'),
          'Mapping references an undeclared input.',
        );
      }
    } else {
      add(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        pointer(bindingPath, 'kind'),
        'Mapping kind must be constant or input.',
      );
    }
  }
}

function validateContribution(
  value: unknown,
  index: number,
  findings: MutableFinding[],
): DeclarativeContributionV1 | undefined {
  const path = `/contributes/${index}`;
  if (!isRecord(value)) {
    add(findings, 'PLUGIN_MANIFEST_CONTRIBUTION_INVALID', path, 'Contribution must be an object.');
    return undefined;
  }
  exactFields(value, CONTRIBUTION_FIELDS, ['kind', 'id', 'target'], path, findings);
  if (value.kind !== 'action_alias' && value.kind !== 'workflow_alias') {
    add(
      findings,
      'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
      pointer(path, 'kind'),
      'Only action_alias and workflow_alias are allowed.',
    );
  }
  stringField(value.id, pointer(path, 'id'), findings, {
    max: 64,
    pattern: PLUGIN_ID,
    code: 'PLUGIN_MANIFEST_REFERENCE_INVALID',
  });
  for (const key of ['title', 'description'] as const) {
    if (Object.hasOwn(value, key))
      stringField(value[key], pointer(path, key), findings, {
        max: key === 'title' ? 120 : 512,
        display: true,
      });
  }
  let inputNames = new Set<string>();
  if (Object.hasOwn(value, 'inputs'))
    inputNames = validateInputs(value.inputs, pointer(path, 'inputs'), findings);
  if (Object.hasOwn(value, 'inputMapping'))
    validateMapping(value.inputMapping, pointer(path, 'inputMapping'), inputNames, findings);
  if (!isRecord(value.target)) {
    add(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      pointer(path, 'target'),
      'Target must be an object.',
    );
  } else {
    exactFields(
      value.target,
      new Set(['kind', 'id']),
      ['kind', 'id'],
      pointer(path, 'target'),
      findings,
    );
    const expected = value.kind === 'workflow_alias' ? 'host_workflow' : 'host_action';
    if (value.target.kind !== expected) {
      add(
        findings,
        'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
        pointer(pointer(path, 'target'), 'kind'),
        `Target kind must be ${expected}.`,
      );
    }
    if (
      stringField(value.target.id, pointer(pointer(path, 'target'), 'id'), findings, {
        max: 128,
        pattern: HOST_REFERENCE,
        code: 'PLUGIN_MANIFEST_REFERENCE_INVALID',
      })
    ) {
      if (value.kind === 'action_alias' && value.target.id === 'pr.merge') {
        add(
          findings,
          'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
          pointer(pointer(path, 'target'), 'id'),
          'Declarative plugins cannot alias merge actions.',
        );
      }
    }
  }
  return value as unknown as DeclarativeContributionV1;
}

/**
 * Red-host validation. This intentionally duplicates the security boundary
 * instead of trusting the authoring validator exported by plugin-api.
 */
export function validateManifestForHost(value: unknown): PluginManifestValidationResult {
  const findings: MutableFinding[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      findings: [
        {
          severity: 'error',
          code: 'PLUGIN_MANIFEST_NOT_OBJECT',
          path: '',
          message: 'Manifest must be a plain JSON object.',
        },
      ],
    };
  }
  exactFields(value, ROOT_FIELDS, ROOT_REQUIRED, '', findings);
  if (value.schema !== 'openslack.plugin.v1')
    add(findings, 'PLUGIN_MANIFEST_SCHEMA_UNSUPPORTED', '/schema', 'Unsupported manifest schema.');
  if (
    stringField(value.id, '/id', findings, {
      max: 64,
      pattern: PLUGIN_ID,
      code: 'PLUGIN_MANIFEST_ID_INVALID',
    })
  ) {
    if (RESERVED_IDS.has(value.id) || value.id.startsWith('openslack-'))
      add(findings, 'PLUGIN_MANIFEST_ID_RESERVED', '/id', 'Plugin ID is reserved by the host.');
  }
  stringField(value.version, '/version', findings, {
    max: 128,
    pattern: SEMVER,
    code: 'PLUGIN_MANIFEST_VERSION_INVALID',
  });
  stringField(value.name, '/name', findings, { max: 120, display: true });
  if (Object.hasOwn(value, 'description'))
    stringField(value.description, '/description', findings, { max: 512, display: true });

  if (!isRecord(value.requires)) {
    add(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', '/requires', 'Requires must be an object.');
  } else {
    exactFields(value.requires, new Set(['openslack']), ['openslack'], '/requires', findings);
    stringField(value.requires.openslack, '/requires/openslack', findings, {
      max: 128,
      pattern: OPENSLACK_RANGE,
      code: 'PLUGIN_MANIFEST_VERSION_RANGE_INVALID',
    });
  }
  if (!isRecord(value.gate)) {
    add(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', '/gate', 'Gate must be an object.');
  } else {
    exactFields(value.gate, new Set(['mode', 'gateId']), ['mode', 'gateId'], '/gate', findings);
    if (value.gate.mode !== 'SHADOW' && value.gate.mode !== 'ENFORCE')
      add(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        '/gate/mode',
        'Gate mode must be SHADOW or ENFORCE.',
      );
    stringField(value.gate.gateId, '/gate/gateId', findings, {
      max: 128,
      pattern: HOST_REFERENCE,
      code: 'PLUGIN_MANIFEST_REFERENCE_INVALID',
    });
  }

  const capabilities: DeclarativePluginCapability[] = [];
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length < 1 ||
    value.capabilities.length > 16
  ) {
    add(
      findings,
      'PLUGIN_MANIFEST_CAPABILITY_INVALID',
      '/capabilities',
      'Capabilities must contain 1 to 16 entries.',
    );
  } else {
    const seen = new Set<string>();
    value.capabilities.forEach((capability, index) => {
      if (
        typeof capability !== 'string' ||
        !CAPABILITIES.has(capability as DeclarativePluginCapability) ||
        seen.has(capability)
      ) {
        add(
          findings,
          'PLUGIN_MANIFEST_CAPABILITY_INVALID',
          `/capabilities/${index}`,
          'Capability is unknown or duplicated.',
        );
      } else {
        seen.add(capability);
        capabilities.push(capability as DeclarativePluginCapability);
      }
    });
  }

  const contributions: DeclarativeContributionV1[] = [];
  if (
    !Array.isArray(value.contributes) ||
    value.contributes.length < 1 ||
    value.contributes.length > 64
  ) {
    add(
      findings,
      'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
      '/contributes',
      'Contributes must contain 1 to 64 entries.',
    );
  } else {
    const ids = new Set<string>();
    value.contributes.forEach((contribution, index) => {
      const normalized = validateContribution(contribution, index, findings);
      if (normalized) {
        const key = `${normalized.kind}:${normalized.id}`;
        if (ids.has(key))
          add(
            findings,
            'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
            `/contributes/${index}/id`,
            'Contribution ID is duplicated for its kind.',
          );
        ids.add(key);
        contributions.push(normalized);
      }
    });
  }
  if (
    contributions.some((item) => item.kind === 'action_alias') &&
    !capabilities.includes('host.actions.read')
  ) {
    add(
      findings,
      'PLUGIN_MANIFEST_CAPABILITY_INVALID',
      '/capabilities',
      'Action aliases require host.actions.read.',
    );
  }
  if (
    contributions.some((item) => item.kind === 'workflow_alias') &&
    !capabilities.includes('host.workflows.read')
  ) {
    add(
      findings,
      'PLUGIN_MANIFEST_CAPABILITY_INVALID',
      '/capabilities',
      'Workflow aliases require host.workflows.read.',
    );
  }

  if (findings.length > 0) {
    findings.sort(
      (left, right) =>
        asciiCompare(left.path, right.path) ||
        asciiCompare(left.code, right.code) ||
        asciiCompare(left.message, right.message),
    );
    return { valid: false, findings: findings as readonly ManifestValidationFinding[] };
  }
  return { valid: true, manifest: value as unknown as PluginManifestV1, findings: [] };
}
