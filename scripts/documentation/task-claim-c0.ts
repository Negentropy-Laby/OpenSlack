import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { parseDocument } from 'yaml';

import { decodeStrictJSON } from '../../packages/core/src/strict-json.js';

const SCHEMA = 'docs/reference/schemas/task-claim/task-claim-v2-c0.schema.json';
const VECTORS = 'docs/reference/vectors/task-claim/task-claim-v2-c0-vectors.json';
const V1_SCHEMA = 'packages/github/src/task-manifest.schema.json';
const C0_ID = 'https://openslack.dev/schemas/task-claim-v2-c0.candidate.json';
const V1_ID = 'https://openslack.dev/schemas/github-issue-task.schema.json';
const MAX_BYTES = 4 * 1024 * 1024;
type Row = Record<string, unknown>;

export interface TaskClaimC0Report {
  canonicalDigests: number;
  schemaAccepted: number;
  codecOnly: number;
  rejected: number;
  projectionCases: number;
  transitionReferences: number;
  schemaObservationNegatives: number;
  semanticObservationCases: number;
  semanticExecution: 'NOT_RUN';
}

function insist(condition: unknown, rule: string): asserts condition {
  if (!condition) throw new Error(`Task Claim C0: ${rule}.`);
}

function row(value: unknown): Row {
  insist(value !== null && typeof value === 'object' && !Array.isArray(value), 'object required');
  return value as Row;
}

function fields(value: unknown, required: string[], optional: string[] = []): Row {
  const object = row(value);
  insist(
    required.every((key) => Object.hasOwn(object, key)),
    'missing vector metadata',
  );
  insist(
    Object.keys(object).every((key) => [...required, ...optional].includes(key)),
    'unknown vector metadata',
  );
  return object;
}

function text(value: unknown): string {
  insist(typeof value === 'string', 'string required');
  return value;
}

function list(value: unknown): unknown[] {
  insist(Array.isArray(value), 'array required');
  return value;
}

function strings(value: unknown): string[] {
  return list(value).map(text);
}

function read(root: string, path: string): Buffer {
  try {
    const file = join(root, path);
    const stat = lstatSync(file);
    insist(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES,
      'bounded ordinary file required',
    );
    const bytes = readFileSync(file);
    insist(bytes.length <= MAX_BYTES, 'file size limit');
    return bytes;
  } catch {
    throw new Error(`Task Claim C0: required material unavailable (${path}).`);
  }
}

function json(bytes: Uint8Array): unknown {
  try {
    return decodeStrictJSON(bytes, MAX_BYTES);
  } catch {
    throw new Error('Task Claim C0: strict JSON, UTF-8 or Unicode invalid.');
  }
}

function base64(value: unknown): Buffer {
  const encoded = text(value);
  insist(
    encoded.length <= MAX_BYTES * 2 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
    'Base64 invalid',
  );
  const bytes = Buffer.from(encoded, 'base64');
  insist(
    bytes.toString('base64') === encoded && bytes.length <= MAX_BYTES,
    'Base64 roundtrip or size invalid',
  );
  return bytes;
}

// This private codec implements only the candidate's number-free JCS subset.
// Inputs already passed strict JSON/Unicode decoding; property order is UTF-16.
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  insist(typeof value !== 'number', 'JSON numbers forbidden');
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = row(value);
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

function equal(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compile(root: string, sourcePin: unknown) {
  const pin = fields(sourcePin, ['path', 'id', 'sha256']);
  const sourceBytes = read(root, V1_SCHEMA);
  insist(
    pin.path === V1_SCHEMA && pin.id === V1_ID && pin.sha256 === sha256(sourceBytes),
    'v1 source schema pin mismatch; explicit review required',
  );
  const source = row(json(sourceBytes));
  const schema = row(json(read(root, SCHEMA)));
  insist(source.$id === V1_ID && schema.$id === C0_ID, 'schema ID mismatch');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  try {
    ajv.addSchema(source);
    ajv.addSchema(schema);
    // Compile every definition, including references outside the root's union.
    for (const key of Object.keys(row(schema.$defs))) ajv.getSchema(`${C0_ID}#/$defs/${key}`);
    const get = (id: string): ValidateFunction => {
      const validate = ajv.getSchema(id);
      insist(validate, 'local schema reference unresolved');
      return validate;
    };
    return {
      schema,
      validate: get(C0_ID),
      definition: get(`${C0_ID}#/$defs/definition`),
      decimal: get(`${C0_ID}#/$defs/positiveDecimal`),
      manifest: get(V1_ID),
    };
  } catch {
    throw new Error('Task Claim C0: strict local schema compilation failed.');
  }
}

function verifyRejection(item: Row, checks: ReturnType<typeof compile>): void {
  const bytes = base64(item.inputUTF8Base64);
  insist(item.apiError === 'REQUEST_INVALID', 'rejection API error invalid');
  if (item.stage === 'codec') {
    if (item.reason === 'JSON_NUMBER_FORBIDDEN') {
      const value = json(bytes);
      let rejected = false;
      try {
        canonical(value);
      } catch {
        rejected = true;
      }
      insist(rejected, 'numeric negative must reach the number guard');
    } else {
      let strictRejected = false;
      try {
        decodeStrictJSON(bytes, MAX_BYTES);
      } catch {
        strictRejected = true;
      }
      insist(strictRejected, 'codec negative accepted');
      // Preserve a BOM: stripping it could hide a framing failure as duplicate keys.
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const value: unknown = JSON.parse(raw);
      let normalizedRejected = false;
      try {
        decodeStrictJSON(JSON.stringify(value), MAX_BYTES);
      } catch {
        normalizedRejected = true;
      }
      if (item.reason === 'DUPLICATE_KEY') {
        insist(!normalizedRejected, 'duplicate-key negative must otherwise be valid');
        canonical(value);
      } else {
        insist(
          item.reason === 'UNICODE_INVALID' && normalizedRejected,
          'Unicode negative must reach the Unicode guard',
        );
      }
    }
    return;
  }
  const input = json(bytes);
  canonical(input);
  if (item.stage === 'counter-field') {
    const counter = fields(input, ['revision']);
    insist(
      item.reason === 'DECIMAL_INVALID' &&
        typeof counter.revision === 'string' &&
        !checks.decimal(counter.revision),
      'counter-field negative must reach the decimal guard',
    );
    return;
  }
  insist(
    item.stage === 'definition-projection' && !checks.definition(input),
    'definition negative accepted',
  );
  const errors = checks.definition.errors ?? [];
  if (item.reason === 'UNKNOWN_FIELD') {
    insist(
      errors.length > 0 && errors.every((error) => error.keyword === 'additionalProperties'),
      'unknown-field negative must otherwise be valid',
    );
  } else {
    insist(
      item.reason === 'MISSING_FIELD' &&
        errors.length > 0 &&
        errors.every((error) => error.keyword === 'required'),
      'missing-field negative must reach required fields',
    );
  }
}

const LIFECYCLE_LABELS = new Set([
  'openslack:ready',
  'openslack:claimed',
  'openslack:running',
  'openslack:review',
  'openslack:done',
  'openslack:blocked',
]);
const SET_FIELDS = [
  'required_capabilities',
  'allowed_paths',
  'forbidden_paths',
  'output_contract',
  'human_approval_required_for',
];

// Static consistency of the retained raw Issue examples; this is not a C1
// producer, authentication path, state transition engine, or TS/Go parity run.
function verifyProjection(
  item: Row,
  accepted: Map<string, Row>,
  checks: ReturnType<typeof compile>,
): void {
  const input = fields(item.input, ['task', 'issueTitle', 'body', 'labels']);
  const body = text(input.body);
  const labels = strings(input.labels);
  const fences = [...body.matchAll(/^```(?:openslack-task|ya?ml)[^\r\n]*\r?\n([\s\S]*?)^```/gm)];
  if (item.reason === 'MANIFEST_AMBIGUOUS') {
    insist(
      item.apiError === 'REQUEST_INVALID' && fences.length > 1,
      'ambiguous-fence negative invalid',
    );
    return;
  }
  insist(fences.length === 1, 'projection requires one complete task fence');
  const match = fences[0]!;
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  insist(document.errors.length === 0, 'raw manifest YAML invalid');
  const manifest = row(document.toJSON());
  const allowed = Object.keys(row(row(row(checks.schema.$defs).manifest).properties));
  const unknown = Object.keys(manifest).filter(
    (key) => ![...allowed, 'status', 'linked_pr'].includes(key),
  );
  if (item.reason === 'UNKNOWN_FIELD') {
    insist(
      item.apiError === 'REQUEST_INVALID' && unknown.length > 0,
      'unknown-manifest negative invalid',
    );
    const known = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => !unknown.includes(key)),
    );
    insist(checks.manifest(known), 'unknown-manifest negative must otherwise match v1');
    return;
  }
  insist(unknown.length === 0 && checks.manifest(manifest), 'raw manifest violates pinned v1');
  const expected = accepted.get(text(item.expectedProjection));
  insist(
    expected?.schema === 'openslack.task_definition.v1',
    'projection reference must identify a definition',
  );
  const projected: Row = { ...manifest };
  delete projected.status;
  delete projected.linked_pr;
  for (const key of SET_FIELDS) {
    if (!Object.hasOwn(projected, key)) continue;
    const values = strings(projected[key]);
    insist(new Set(values).size === values.length, 'duplicate set member');
    projected[key] = values.sort();
  }
  if (projected.lease !== undefined) {
    const lease = row(projected.lease);
    projected.lease = Object.fromEntries(
      Object.entries(lease).map(([key, value]) => [key, String(value)]),
    );
  }
  const prose = body.slice(0, match.index) + body.slice(match.index! + match[0].length);
  const substantive = labels.filter((label) => !LIFECYCLE_LABELS.has(label));
  insist(new Set(substantive).size === substantive.length, 'duplicate substantive label');
  insist(
    equal(expected.task, input.task) &&
      expected.issueTitle === input.issueTitle &&
      expected.prose === prose &&
      equal(expected.manifest, projected) &&
      equal(expected.labels, substantive.sort()),
    'projection static reference mismatch',
  );
}

function verifyMaterial(root: string): TaskClaimC0Report {
  // Fresh bytes and a fresh Ajv instance on every call: path-only caches would
  // hide changes to frozen evidence or referenced v1 properties in this process.
  const vectors = fields(json(read(root, VECTORS)), [
    'schema',
    'status',
    'profile',
    'digestEncoding',
    'scope',
    'sourceSchema',
    'accept',
    'reject',
    'projectionCases',
    'projectionRule',
    'transitionCases',
    'observationReject',
  ]);
  insist(
    vectors.schema === 'openslack.task_claim_c0_vectors.v1' &&
      vectors.status === 'proposed-data-only' &&
      vectors.profile === 'restricted-jcs-utf8-no-json-numbers' &&
      vectors.digestEncoding === 'UTF8(domain) || NUL || canonicalUTF8',
    'vector profile invalid',
  );
  text(vectors.scope);
  text(vectors.projectionRule);
  const checks = compile(root, vectors.sourceSchema);
  const accepted = new Map<string, Row>();
  const identifiers = new Set<string>();
  const identify = (item: Row) => {
    const id = text(item.id);
    insist(
      /^[a-z0-9][a-z0-9_-]*$/.test(id) && !identifiers.has(id),
      'duplicate or invalid vector ID',
    );
    identifiers.add(id);
  };
  const report: TaskClaimC0Report = {
    canonicalDigests: 0,
    schemaAccepted: 0,
    codecOnly: 0,
    rejected: 0,
    projectionCases: 0,
    transitionReferences: 0,
    schemaObservationNegatives: 0,
    semanticObservationCases: 0,
    semanticExecution: 'NOT_RUN',
  };
  const stages: Record<string, string> = {
    'definition-projection': 'openslack.task_definition.v1',
    'mutation-schema': 'openslack.task_claim_request.v2',
    'receipt-schema': 'openslack.task_claim_operation.v1',
    'claim-schema': 'openslack.task_claim.v2',
    'observation-schema': 'openslack.task_claim_observation.v1',
  };
  for (const value of list(vectors.accept)) {
    const item = fields(value, [
      'id',
      'stage',
      'domain',
      'inputUTF8Base64',
      'canonicalUTF8Base64',
      'byteLength',
      'digest',
    ]);
    identify(item);
    const input = json(base64(item.inputUTF8Base64));
    const bytes = Buffer.from(canonical(input), 'utf8');
    insist(
      bytes.equals(base64(item.canonicalUTF8Base64)) && item.byteLength === bytes.length,
      'canonical bytes or byteLength mismatch',
    );
    const domain = text(item.domain);
    insist(Object.values(stages).includes(domain), 'digest domain invalid');
    const digest = `sha256:${sha256(Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0]), bytes]))}`;
    insist(item.digest === digest, 'domain-separated digest mismatch');
    if (item.stage === 'codec-only') report.codecOnly++;
    else {
      const object = row(input);
      insist(
        stages[text(item.stage)] === domain && object.schema === domain && checks.validate(object),
        'schema-bearing accepted object invalid',
      );
      accepted.set(text(item.id), object);
      report.schemaAccepted++;
    }
    report.canonicalDigests++;
  }
  identifiers.clear();
  for (const value of list(vectors.reject)) {
    const item = fields(value, ['id', 'stage', 'reason', 'inputUTF8Base64', 'apiError']);
    identify(item);
    verifyRejection(item, checks);
    report.rejected++;
  }
  identifiers.clear();
  for (const value of list(vectors.projectionCases)) {
    const item = fields(value, ['id', 'input'], ['expectedProjection', 'reason', 'apiError']);
    identify(item);
    insist(
      (item.expectedProjection !== undefined) !== (item.reason !== undefined),
      'projection outcome ambiguous',
    );
    verifyProjection(item, accepted, checks);
    report.projectionCases++;
  }
  const errors = strings(row(row(checks.schema.$defs).error).enum);
  const timestamp = new Ajv2020({ strict: true });
  addFormats(timestamp);
  const validTime = timestamp.compile({
    type: 'string',
    format: 'date-time',
    pattern: '^[0-9]{4}-.*\\.[0-9]{6}Z$',
  });
  identifiers.clear();
  for (const value of list(vectors.transitionCases)) {
    const item = fields(
      value,
      ['id', 'operationVector', 'beforeVector', 'authorityTime'],
      [
        'effectiveLeaseDurationMs',
        'expectedAfterVector',
        'expectedError',
        'expectedRevision',
        'authorityActorRole',
        'outstandingBefore',
        'outstandingAfter',
        'authorityInspection',
      ],
    );
    identify(item);
    const operation = accepted.get(text(item.operationVector));
    const before = accepted.get(text(item.beforeVector));
    insist(
      operation?.schema === 'openslack.task_claim_request.v2' &&
        before?.schema === 'openslack.task_claim.v2' &&
        validTime(item.authorityTime),
      'transition reference or time invalid',
    );
    insist(equal(operation.task, before.task), 'transition task references disagree');
    insist(
      (item.expectedAfterVector !== undefined) !== (item.expectedError !== undefined),
      'transition outcome ambiguous',
    );
    if (item.expectedAfterVector !== undefined) {
      const after = accepted.get(text(item.expectedAfterVector));
      insist(
        after?.schema === 'openslack.task_claim.v2' && equal(after.task, before.task),
        'transition result reference invalid',
      );
    } else insist(errors.includes(text(item.expectedError)), 'transition error invalid');
    for (const key of ['effectiveLeaseDurationMs', 'expectedRevision'])
      if (item[key] !== undefined) insist(checks.decimal(item[key]), 'transition decimal invalid');
    for (const key of ['outstandingBefore', 'outstandingAfter'])
      if (item[key] !== undefined) {
        const values = strings(item[key]);
        insist(new Set(values).size === values.length, 'transition effect set invalid');
      }
    if (item.authorityActorRole !== undefined) text(item.authorityActorRole);
    if (item.authorityInspection !== undefined && item.authorityInspection !== null) {
      const inspection = fields(item.authorityInspection, ['inspectionId', 'digest', 'result']);
      text(inspection.inspectionId);
      insist(
        /^sha256:[a-f0-9]{64}$/.test(text(inspection.digest)) &&
          inspection.result === 'settled_no_send',
        'inspection reference invalid',
      );
    }
    report.transitionReferences++;
  }
  identifiers.clear();
  for (const value of list(vectors.observationReject)) {
    const item = fields(value, ['id', 'layer', 'input', 'expectedError']);
    identify(item);
    canonical(item.input);
    insist(
      row(item.input).schema === 'openslack.task_claim_observation.v1' &&
        item.expectedError === 'EVIDENCE_UNAVAILABLE',
      'observation negative metadata invalid',
    );
    if (item.layer === 'schema') {
      insist(!checks.validate(item.input), 'schema observation negative accepted');
      report.schemaObservationNegatives++;
    } else {
      insist(
        item.layer === 'semantic' && checks.validate(item.input),
        'semantic case must pass structural validation',
      );
      report.semanticObservationCases++;
    }
  }
  insist(
    report.schemaAccepted > 0 &&
      report.codecOnly > 0 &&
      report.rejected > 0 &&
      report.projectionCases > 0 &&
      report.transitionReferences > 0 &&
      report.schemaObservationNegatives > 0 &&
      report.semanticObservationCases > 0,
    'required evidence category empty',
  );
  return report;
}

export function verifyTaskClaimC0(root: string): TaskClaimC0Report {
  try {
    return verifyMaterial(root);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Task Claim C0:')) throw cause;
    throw new Error('Task Claim C0: evidence verification failed.', { cause });
  }
}
