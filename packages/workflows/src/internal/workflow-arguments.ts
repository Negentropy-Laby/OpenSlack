import { types as nodeTypes } from 'node:util';
import { canonicalJson } from './canonical-json.js';
import { WORKFLOW_CONTROL_CONTRACT_LIMITS } from '../workflow-control-contract.js';

export const WORKFLOW_ARGUMENTS_SCHEMA = 'openslack.workflow_arguments.v1' as const;

export type WorkflowArgumentNode =
  | { readonly t: 'null' }
  | { readonly t: 'boolean'; readonly v: boolean }
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'number'; readonly v: number }
  | { readonly t: 'negative_zero' }
  | { readonly t: 'bigint'; readonly v: string }
  | { readonly t: 'undefined' }
  | { readonly t: 'date'; readonly v: string }
  | { readonly t: 'hole' }
  | { readonly t: 'array'; readonly v: readonly WorkflowArgumentNode[] }
  | {
      readonly t: 'object';
      readonly p: 'object' | 'null';
      readonly v: readonly (readonly [string, WorkflowArgumentNode])[];
    };

export interface WorkflowArgumentsEnvelope {
  readonly schema: typeof WORKFLOW_ARGUMENTS_SCHEMA;
  readonly root: Extract<WorkflowArgumentNode, { readonly t: 'object' }>;
}

export interface EncodedWorkflowArguments {
  readonly envelope: WorkflowArgumentsEnvelope;
  readonly canonical: string;
}

export class WorkflowArgumentsError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowArgumentsError';
  }
}

interface TraversalState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

const MAX_BYTES = WORKFLOW_CONTROL_CONTRACT_LIMITS.maxObservationBytes;
const MAX_DEPTH = WORKFLOW_CONTROL_CONTRACT_LIMITS.maxJsonDepth;
const MAX_NODES = WORKFLOW_CONTROL_CONTRACT_LIMITS.maxJsonNodes;
const MAX_KEY_BYTES = WORKFLOW_CONTROL_CONTRACT_LIMITS.maxIdentifierBytes;
const BIGINT = /^-?(?:0|[1-9][0-9]*)$/u;
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;
const nativeObjectSource = Function.prototype.toString.call(Object);

/** Encode workflow arguments without losing supported JavaScript data semantics. */
export function encodeWorkflowArguments(value: Record<string, unknown>): EncodedWorkflowArguments {
  const state: TraversalState = { ancestors: new WeakSet<object>(), nodes: 0 };
  const root = encodeNode(value, state, 1);
  if (root.t !== 'object')
    throw new WorkflowArgumentsError('Workflow arguments must be an object.');
  const envelope: WorkflowArgumentsEnvelope = { schema: WORKFLOW_ARGUMENTS_SCHEMA, root };
  const canonical = canonicalJson(envelope);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES) {
    throw new WorkflowArgumentsError('Workflow arguments exceed the 256 KiB canonical byte limit.');
  }
  return { envelope, canonical };
}

/** Strictly validate an already encoded workflow argument envelope. */
export function validateWorkflowArgumentsEnvelope(value: unknown): WorkflowArgumentsEnvelope {
  return inspectWorkflowArgumentsEnvelope(value).envelope;
}

/** Validate and canonicalize an encoded envelope in one traversal. */
export function inspectWorkflowArgumentsEnvelope(value: unknown): EncodedWorkflowArguments {
  const envelope = exactRecord(value, ['schema', 'root'], 'workflow arguments envelope');
  if (envelope.schema !== WORKFLOW_ARGUMENTS_SCHEMA) {
    throw new WorkflowArgumentsError('Workflow arguments encoding is unsupported.');
  }
  const state = { nodes: 0 };
  const root = validateNode(envelope.root, state, 1, false);
  if (root.t !== 'object')
    throw new WorkflowArgumentsError('Workflow arguments root must be an object.');
  const result: WorkflowArgumentsEnvelope = { schema: WORKFLOW_ARGUMENTS_SCHEMA, root };
  const canonical = canonicalJson(result);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES) {
    throw new WorkflowArgumentsError('Workflow arguments exceed the 256 KiB canonical byte limit.');
  }
  return { envelope: result, canonical };
}

/** Decode an envelope into a fresh local-realm value. */
export function decodeWorkflowArguments(value: unknown): Record<string, unknown> {
  const envelope = validateWorkflowArgumentsEnvelope(value);
  return decodeValidatedWorkflowArguments(envelope);
}

/** Decode an envelope that was produced or validated in the current operation. */
export function decodeValidatedWorkflowArguments(
  envelope: WorkflowArgumentsEnvelope,
): Record<string, unknown> {
  return decodeNode(envelope.root, false) as Record<string, unknown>;
}

/** Clone supported workflow arguments without retaining caller-owned objects. */
export function cloneWorkflowArguments(value: Record<string, unknown>): Record<string, unknown> {
  return decodeWorkflowArguments(encodeWorkflowArguments(value).envelope);
}

function visit(state: { nodes: number }, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new WorkflowArgumentsError(
      `Workflow arguments exceed the maximum depth of ${MAX_DEPTH}.`,
    );
  }
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw new WorkflowArgumentsError(
      `Workflow arguments exceed the maximum node count of ${MAX_NODES}.`,
    );
  }
}

function encodeNode(value: unknown, state: TraversalState, depth: number): WorkflowArgumentNode {
  visit(state, depth);
  if (value === null) return { t: 'null' };
  if (value === undefined) return { t: 'undefined' };
  if (typeof value === 'boolean') return { t: 'boolean', v: value };
  if (typeof value === 'string') return { t: 'string', v: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new WorkflowArgumentsError('Workflow numbers must be finite.');
    if (Object.is(value, -0)) return { t: 'negative_zero' };
    return { t: 'number', v: value };
  }
  if (typeof value === 'bigint') return { t: 'bigint', v: value.toString(10) };
  if (typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw new WorkflowArgumentsError('Workflow arguments contain an unsupported value.');
  }
  if (state.ancestors.has(value)) {
    throw new WorkflowArgumentsError('Workflow arguments contain a circular reference.');
  }

  if (isDate(value)) {
    if (Reflect.ownKeys(value).length !== 0) {
      throw new WorkflowArgumentsError('Workflow Date values cannot contain custom fields.');
    }
    const time = Date.prototype.getTime.call(value);
    if (!Number.isFinite(time))
      throw new WorkflowArgumentsError('Workflow Date values must be valid.');
    return { t: 'date', v: new Date(time).toISOString() };
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_NODES) {
        throw new WorkflowArgumentsError(`Workflow arrays cannot exceed ${MAX_NODES} slots.`);
      }
      assertArrayOwnKeys(value);
      const items: WorkflowArgumentNode[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          visit(state, depth + 1);
          items.push({ t: 'hole' });
          continue;
        }
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new WorkflowArgumentsError('Workflow arrays cannot contain accessors.');
        }
        items.push(encodeNode(descriptor.value, state, depth + 1));
      }
      return { t: 'array', v: items };
    }

    const prototypeKind = plainObjectPrototype(value);
    if (prototypeKind === null) {
      throw new WorkflowArgumentsError('Workflow arguments contain a non-plain object.');
    }
    const entries: Array<readonly [string, WorkflowArgumentNode]> = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new WorkflowArgumentsError('Workflow objects cannot contain symbol keys.');
    }
    for (const key of (keys as string[]).sort()) {
      if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
        throw new WorkflowArgumentsError(
          `Workflow argument keys cannot exceed ${MAX_KEY_BYTES} bytes.`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new WorkflowArgumentsError(
          'Workflow objects cannot contain accessors or hidden fields.',
        );
      }
      entries.push([key, encodeNode(descriptor.value, state, depth + 1)]);
    }
    return { t: 'object', p: prototypeKind, v: entries };
  } finally {
    state.ancestors.delete(value);
  }
}

function validateNode(
  value: unknown,
  state: { nodes: number },
  depth: number,
  allowHole: boolean,
): WorkflowArgumentNode {
  visit(state, depth);
  const record = exactRecord(value, undefined, 'workflow argument node');
  if (typeof record.t !== 'string')
    throw new WorkflowArgumentsError('Workflow argument tag is invalid.');
  switch (record.t) {
    case 'null':
    case 'undefined':
    case 'negative_zero':
      exactKeys(record, ['t'], 'workflow argument node');
      return { t: record.t };
    case 'hole':
      exactKeys(record, ['t'], 'workflow argument node');
      if (!allowHole)
        throw new WorkflowArgumentsError('Workflow argument holes are valid only in arrays.');
      return { t: 'hole' };
    case 'boolean':
      exactKeys(record, ['t', 'v'], 'workflow argument node');
      if (typeof record.v !== 'boolean')
        throw new WorkflowArgumentsError('Boolean argument is invalid.');
      return { t: 'boolean', v: record.v };
    case 'string':
      exactKeys(record, ['t', 'v'], 'workflow argument node');
      if (typeof record.v !== 'string')
        throw new WorkflowArgumentsError('String argument is invalid.');
      return { t: 'string', v: record.v };
    case 'number':
      exactKeys(record, ['t', 'v'], 'workflow argument node');
      if (typeof record.v !== 'number' || !Number.isFinite(record.v)) {
        throw new WorkflowArgumentsError('Number argument is invalid.');
      }
      return { t: 'number', v: record.v };
    case 'bigint':
      exactKeys(record, ['t', 'v'], 'workflow argument node');
      if (
        typeof record.v !== 'string' ||
        !BIGINT.test(record.v) ||
        BigInt(record.v).toString() !== record.v
      ) {
        throw new WorkflowArgumentsError('BigInt argument is invalid.');
      }
      return { t: 'bigint', v: record.v };
    case 'date': {
      exactKeys(record, ['t', 'v'], 'workflow argument node');
      if (typeof record.v !== 'string')
        throw new WorkflowArgumentsError('Date argument is invalid.');
      const date = new Date(record.v);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== record.v) {
        throw new WorkflowArgumentsError('Date argument is invalid.');
      }
      return { t: 'date', v: record.v };
    }
    case 'array': {
      exactKeys(record, ['t', 'v'], 'workflow argument node');
      if (!Array.isArray(record.v) || record.v.length > MAX_NODES) {
        throw new WorkflowArgumentsError('Array argument is invalid.');
      }
      return { t: 'array', v: record.v.map((item) => validateNode(item, state, depth + 1, true)) };
    }
    case 'object': {
      exactKeys(record, ['t', 'p', 'v'], 'workflow argument node');
      if (record.p !== 'object' && record.p !== 'null') {
        throw new WorkflowArgumentsError('Object prototype tag is invalid.');
      }
      if (!Array.isArray(record.v)) throw new WorkflowArgumentsError('Object entries are invalid.');
      let previous: string | undefined;
      const entries = record.v.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
          throw new WorkflowArgumentsError('Object entry is invalid.');
        }
        if (
          Buffer.byteLength(entry[0], 'utf8') > MAX_KEY_BYTES ||
          (previous !== undefined && entry[0] <= previous)
        ) {
          throw new WorkflowArgumentsError('Object argument keys are invalid or not canonical.');
        }
        previous = entry[0];
        return [entry[0], validateNode(entry[1], state, depth + 1, false)] as const;
      });
      return { t: 'object', p: record.p, v: entries };
    }
    default:
      throw new WorkflowArgumentsError('Workflow argument tag is unsupported.');
  }
}

function decodeNode(node: WorkflowArgumentNode, allowHole: boolean): unknown {
  switch (node.t) {
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'boolean':
    case 'string':
    case 'number':
      return node.v;
    case 'negative_zero':
      return -0;
    case 'bigint':
      return BigInt(node.v);
    case 'date':
      return new Date(node.v);
    case 'hole':
      if (!allowHole) throw new WorkflowArgumentsError('Workflow argument hole is misplaced.');
      return HOLE;
    case 'array': {
      const result = new Array(node.v.length);
      node.v.forEach((item, index) => {
        const decoded = decodeNode(item, true);
        if (decoded !== HOLE) result[index] = decoded;
      });
      return result;
    }
    case 'object': {
      const result: Record<string, unknown> =
        node.p === 'null'
          ? Object.create(null)
          : (Object.create(Object.prototype) as Record<string, unknown>);
      for (const [key, value] of node.v) {
        Object.defineProperty(result, key, {
          value: decodeNode(value, false),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return result;
    }
  }
}

const HOLE = Symbol('workflow argument hole');

function isDate(value: object): value is Date {
  try {
    Date.prototype.getTime.call(value);
    return Object.prototype.toString.call(value) === '[object Date]';
  } catch {
    return false;
  }
}

function plainObjectPrototype(value: object): 'object' | 'null' | null {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return 'null';
  if (Object.getPrototypeOf(prototype) !== null) return null;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  if (typeof constructor !== 'function') return null;
  return Function.prototype.toString.call(constructor) === nativeObjectSource &&
    constructor.prototype === prototype
    ? 'object'
    : null;
}

function assertArrayOwnKeys(value: readonly unknown[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !ARRAY_INDEX.test(key)) {
      throw new WorkflowArgumentsError('Workflow arrays cannot contain custom fields.');
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= value.length || String(index) !== key) {
      throw new WorkflowArgumentsError('Workflow array index is invalid.');
    }
  }
}

function exactRecord(
  value: unknown,
  fields: readonly string[] | undefined,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new WorkflowArgumentsError(`${label} must be an inert object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowArgumentsError(`${label} must be a data object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string')
      throw new WorkflowArgumentsError(`${label} cannot contain symbol keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new WorkflowArgumentsError(`${label} cannot contain accessors or hidden fields.`);
    }
  }
  if (fields !== undefined) exactKeys(record, fields, label);
  return record;
}

function exactKeys(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new WorkflowArgumentsError(`${label} has unexpected or missing fields.`);
  }
}
