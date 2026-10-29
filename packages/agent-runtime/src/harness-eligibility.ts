import { isAbsolute } from 'node:path';
import { HARNESS_CALLBACK_TOOLS } from './bridge-wire.js';
import { RUN_ID_RE } from './run-id.js';

export type HarnessEligibilityPhase = 'dispatch' | 'execute' | 'report' | 'accept';
export type HarnessEligibilityRestriction = Readonly<{ mode: 'required'; expiresAt: number } | { mode: 'not_applicable' }>;
export interface HarnessTaskEligibilityBinding {
  taskId: string; taskHash: string; principalId: string; principalHash: string; phase: HarnessEligibilityPhase;
}
export interface HarnessToolEligibilityBinding {
  runId: string; requestHash: string; principalHash: string; generation: string; toolName: string; targetPath: string;
}
export interface HarnessRunStartEligibilityBinding {
  runId: string; requestHash: string; principalHash: string; generation: string;
}
declare const taskEligibilityBrand: unique symbol;
declare const toolEligibilityBrand: unique symbol;
declare const runStartEligibilityBrand: unique symbol;
/** A phase-local expiry restriction, never a replacement for live permission or source checks. */
export interface HarnessTaskEligibility { readonly [taskEligibilityBrand]: never }
export interface HarnessToolEligibility { readonly [toolEligibilityBrand]: never }
/** A narrower known lease cutoff for this already-confirmed start, never a grant to start or replay a run. */
export interface HarnessRunStartEligibility { readonly [runStartEligibilityBrand]: never }
interface TaskObservation { kind: 'task'; binding: Readonly<HarnessTaskEligibilityBinding>; restriction: HarnessEligibilityRestriction }
interface ToolObservation { kind: 'tool'; task: TaskObservation; binding: Readonly<HarnessToolEligibilityBinding>; domain: 'native' | 'callback' }
interface RunStartObservation { kind: 'run_start'; task: TaskObservation; binding: Readonly<HarnessRunStartEligibilityBinding> }
type EligibilityObservation = TaskObservation | ToolObservation | RunStartObservation;
const observations = new WeakMap<object, EligibilityObservation>();
const callbackTools = new Set<string>(Object.values(HARNESS_CALLBACK_TOOLS).map(tool => tool.bridge));
const taskKeys = ['taskId', 'taskHash', 'principalId', 'principalHash', 'phase'] as const;
const toolKeys = ['runId', 'requestHash', 'principalHash', 'generation', 'toolName', 'targetPath'] as const;
const runStartKeys = ['runId', 'requestHash', 'principalHash', 'generation'] as const;

function reject(): never { throw new Error('Harness eligibility observation is missing, mismatched or its lease expired'); }
function expiry(restriction: HarnessEligibilityRestriction): void {
  if (restriction.mode === 'required') {
    if (!Number.isSafeInteger(restriction.expiresAt) || !Number.isFinite(Date.now()) || Date.now() >= restriction.expiresAt) reject();
  } else if (restriction.mode !== 'not_applicable') reject();
}
function observation(value: unknown): EligibilityObservation {
  const row = value && typeof value === 'object' ? observations.get(value) : undefined;
  if (!row) return reject();
  expiry(row.kind === 'task' ? row.restriction : row.task.restriction);
  return row;
}

/** Internal authority mint: omitted from package barrels and never accepts MCP/model data. */
export function createHarnessTaskEligibility(binding: HarnessTaskEligibilityBinding, restriction: HarnessEligibilityRestriction): HarnessTaskEligibility {
  if (!binding.taskId || !binding.principalId || !/^[a-f0-9]{64}$/.test(binding.taskHash) || !/^[a-f0-9]{64}$/.test(binding.principalHash) ||
    !['dispatch', 'execute', 'report', 'accept'].includes(binding.phase)) reject();
  expiry(restriction);
  const value = Object.freeze({}) as HarnessTaskEligibility;
  observations.set(value, { kind: 'task', binding: Object.freeze({ ...binding }), restriction: Object.freeze({ ...restriction }) });
  return value;
}

export function assertHarnessTaskEligibility(value: unknown, expected: HarnessTaskEligibilityBinding): asserts value is HarnessTaskEligibility {
  const row = observation(value);
  if (row.kind !== 'task' || taskKeys.some(key => row.binding[key] !== expected[key])) reject();
}

/** Carry only the independently checked execute phase's cutoff through later preflight and SDK awaits. */
export function bindHarnessRunStartEligibility(value: HarnessTaskEligibility, binding: Pick<HarnessRunStartEligibilityBinding, 'runId' | 'generation'>): HarnessRunStartEligibility {
  const task = observation(value);
  if (task.kind !== 'task' || task.binding.phase !== 'execute' || !RUN_ID_RE.test(binding.runId) || !binding.generation) reject();
  const result = Object.freeze({}) as HarnessRunStartEligibility;
  observations.set(result, { kind: 'run_start', task, binding: Object.freeze({ ...binding,
    requestHash: task.binding.taskHash, principalHash: task.binding.principalHash }) });
  return result;
}

export function assertHarnessRunStartEligibility(value: unknown, expected: HarnessRunStartEligibilityBinding): asserts value is HarnessRunStartEligibility {
  const row = observation(value);
  if (row.kind !== 'run_start' || runStartKeys.some(key => row.binding[key] !== expected[key])) reject();
}

/** Private transport denial constraint: it cannot replace the current owner, confirmation or live authorization. */
export function harnessRunStartEligibilityRestriction(value: unknown): HarnessEligibilityRestriction {
  const row = observation(value);
  if (row.kind !== 'run_start') return reject();
  return Object.freeze({ ...row.task.restriction });
}

/** Derive only a narrower run/generation/tool observation after the real per-effect authority checks. */
export function bindHarnessToolEligibility(value: HarnessTaskEligibility, binding: Omit<HarnessToolEligibilityBinding, 'requestHash' | 'principalHash'>): HarnessToolEligibility {
  const task = observation(value);
  const domain = callbackTools.has(binding.toolName) ? 'callback' : 'native';
  if (task.kind !== 'task' || !RUN_ID_RE.test(binding.runId) || !binding.generation ||
    (domain === 'callback' ? task.binding.phase !== 'report' || binding.targetPath !== `mcp:${binding.toolName}` :
      task.binding.phase !== 'execute' || !['Read', 'Write', 'Edit'].includes(binding.toolName) || !isAbsolute(binding.targetPath))) reject();
  const result = Object.freeze({}) as HarnessToolEligibility;
  observations.set(result, { kind: 'tool', task, domain, binding: Object.freeze({ ...binding,
    requestHash: task.binding.taskHash, principalHash: task.binding.principalHash }) });
  return result;
}

export function assertHarnessToolEligibility(value: unknown, expected: HarnessToolEligibilityBinding): asserts value is HarnessToolEligibility {
  const row = observation(value);
  if (row.kind !== 'tool' || toolKeys.some(key => row.binding[key] !== expected[key]) ||
    row.domain !== (callbackTools.has(expected.toolName) ? 'callback' : 'native')) reject();
}

/** Safe transport constraint only; the existing authenticated allow/result binding remains mandatory. */
export function harnessToolEligibilityRestriction(value: unknown): HarnessEligibilityRestriction {
  const row = observation(value);
  if (row.kind !== 'tool') return reject();
  return Object.freeze({ ...row.task.restriction });
}
