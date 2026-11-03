import { createHash } from 'node:crypto';
import type { WorkflowMeta, WorkflowPhase } from './types.js';

export interface WorkflowManifestDiagnostic {
  readonly field: keyof WorkflowMeta | 'title' | 'detail';
  readonly message: string;
}
const manifestFields = new WeakMap<object, readonly string[]>();

/** Parser-owned field identities; diagnostic consumers never inspect message values. */
export function manifestDiagnosticFields(error: unknown): readonly string[] {
  return error !== null && typeof error === 'object' ? (manifestFields.get(error) ?? []) : [];
}

export function invalidManifest(diagnostics: readonly WorkflowManifestDiagnostic[]): Error {
  const error = new Error(diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
  manifestFields.set(
    error,
    Object.freeze([...new Set(diagnostics.map((diagnostic) => diagnostic.field))]),
  );
  return error;
}

function invalidField(field: WorkflowManifestDiagnostic['field'], message: string): Error {
  return invalidManifest([{ field, message }]);
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const SIDE_EFFECT_PATTERN = /^[a-zA-Z_*]+\.[a-zA-Z_*]+\.[a-zA-Z_*]+$/;

/**
 * Parse an unknown value into a WorkflowMeta, applying structural defaults.
 * Returns a normalized WorkflowMeta or throws on structural issues.
 */
export function parseManifest(raw: unknown): WorkflowMeta {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    throw new Error('Manifest must be a non-null object');
  }

  const obj = raw as Record<string, unknown>;

  // Required string fields
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw invalidField('name', 'Manifest "name" must be a non-empty string');
  }
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    throw invalidField('description', 'Manifest "description" must be a non-empty string');
  }

  // Phases
  if (!Array.isArray(obj.phases) || obj.phases.length === 0) {
    throw invalidField('phases', 'Manifest "phases" must be a non-empty array');
  }

  const phases: WorkflowPhase[] = obj.phases.map((p: unknown, i: number) => {
    if (p === null || typeof p !== 'object') {
      throw invalidField('phases', `Phase at index ${i} must be an object`);
    }
    const phase = p as Record<string, unknown>;
    if (typeof phase.title !== 'string' || phase.title.length === 0) {
      throw invalidField('phases', `Phase at index ${i} must have a non-empty "title"`);
    }
    if (typeof phase.detail !== 'string') {
      throw invalidField('phases', `Phase at index ${i} must have a string "detail"`);
    }
    return { title: phase.title, detail: phase.detail };
  });

  const meta: WorkflowMeta = {
    name: obj.name,
    description: obj.description,
    phases,
  };

  // Optional string fields
  if (obj.version !== undefined) {
    if (typeof obj.version !== 'string') {
      throw invalidField('version', 'Manifest "version" must be a string');
    }
    meta.version = obj.version;
  }

  if (obj.whenToUse !== undefined) {
    if (typeof obj.whenToUse !== 'string') {
      throw invalidField('whenToUse', 'Manifest "whenToUse" must be a string');
    }
    meta.whenToUse = obj.whenToUse;
  }

  if (obj.draftCreatedAt !== undefined) {
    if (typeof obj.draftCreatedAt !== 'string') {
      throw invalidField('draftCreatedAt', 'Manifest "draftCreatedAt" must be a string');
    }
    meta.draftCreatedAt = obj.draftCreatedAt;
  }

  if (obj.dynamicPattern !== undefined) {
    if (typeof obj.dynamicPattern !== 'string') {
      throw invalidField('dynamicPattern', 'Manifest "dynamicPattern" must be a string');
    }
    meta.dynamicPattern = obj.dynamicPattern;
  }

  // Optional risk
  if (obj.risk !== undefined) {
    if (obj.risk !== 'low' && obj.risk !== 'medium' && obj.risk !== 'high') {
      throw invalidField('risk', 'Manifest "risk" must be "low", "medium", or "high"');
    }
    meta.risk = obj.risk;
  }

  // Optional inputs
  if (obj.inputs !== undefined) {
    if (typeof obj.inputs !== 'object' || obj.inputs === null) {
      throw invalidField('inputs', 'Manifest "inputs" must be an object');
    }
    meta.inputs = obj.inputs as Record<
      string,
      { type: 'string' | 'number' | 'boolean'; default?: unknown; description: string }
    >;
  }

  // Optional permissions
  if (obj.permissions !== undefined) {
    if (typeof obj.permissions !== 'object' || obj.permissions === null) {
      throw invalidField('permissions', 'Manifest "permissions" must be an object');
    }
    meta.permissions = obj.permissions as {
      github?: string[];
      git?: string[];
      filesystem?: string[];
      openslack?: string[];
    };
  }

  // Optional sideEffects
  if (obj.sideEffects !== undefined) {
    if (!Array.isArray(obj.sideEffects)) {
      throw invalidField('sideEffects', 'Manifest "sideEffects" must be an array');
    }
    meta.sideEffects = obj.sideEffects as string[];
  }

  // Optional forbidden
  if (obj.forbidden !== undefined) {
    if (!Array.isArray(obj.forbidden)) {
      throw invalidField('forbidden', 'Manifest "forbidden" must be an array');
    }
    meta.forbidden = obj.forbidden as string[];
  }

  if (obj.modelRouting !== undefined) {
    if (typeof obj.modelRouting !== 'object' || obj.modelRouting === null) {
      throw invalidField('modelRouting', 'Manifest "modelRouting" must be an object');
    }
    meta.modelRouting = obj.modelRouting as Record<string, string>;
  }

  if (obj.isolationPolicy !== undefined) {
    if (typeof obj.isolationPolicy !== 'object' || obj.isolationPolicy === null) {
      throw invalidField('isolationPolicy', 'Manifest "isolationPolicy" must be an object');
    }
    meta.isolationPolicy = obj.isolationPolicy as Record<string, 'none' | 'worktree'>;
  }

  if (obj.budgetPolicy !== undefined) {
    if (typeof obj.budgetPolicy !== 'object' || obj.budgetPolicy === null) {
      throw invalidField('budgetPolicy', 'Manifest "budgetPolicy" must be an object');
    }
    meta.budgetPolicy = obj.budgetPolicy as WorkflowMeta['budgetPolicy'];
  }

  return meta;
}

/**
 * Validate a parsed WorkflowMeta with parser-owned field/message diagnostics.
 * Returns an empty array if valid.
 */
export function validateManifestDiagnostics(meta: WorkflowMeta): WorkflowManifestDiagnostic[] {
  const errors: WorkflowManifestDiagnostic[] = [];
  const fail = (field: WorkflowManifestDiagnostic['field'], message: string) =>
    errors.push({ field, message });

  // Name pattern
  if (!NAME_PATTERN.test(meta.name)) {
    fail('name', `Manifest "name" must match ${NAME_PATTERN.source}`);
  }

  // Version semver
  if (meta.version !== undefined && !SEMVER_PATTERN.test(meta.version)) {
    fail('version', 'Manifest "version" must be a valid semver string (e.g. "1.0.0")');
  }

  // Phases
  if (!Array.isArray(meta.phases) || meta.phases.length === 0) {
    fail('phases', 'Manifest must have at least one phase');
  } else {
    for (const [i, phase] of meta.phases.entries()) {
      if (typeof phase.title !== 'string' || phase.title.length === 0) {
        fail('title', `Phase ${i} must have a non-empty "title"`);
      }
      if (typeof phase.detail !== 'string') {
        fail('detail', `Phase ${i} must have a string "detail"`);
      }
    }
  }

  // Side effects pattern
  if (meta.sideEffects) {
    for (const se of meta.sideEffects) {
      if (typeof se !== 'string' || !SIDE_EFFECT_PATTERN.test(se)) {
        fail('sideEffects', `Side effect "${se}" must match pattern *.scope.action`);
      }
    }
  }

  // Forbidden entries
  if (meta.forbidden) {
    for (const f of meta.forbidden) {
      if (typeof f !== 'string' || f.length === 0) {
        fail('forbidden', `Forbidden entry must be a non-empty string`);
      }
    }
  }

  // Permissions must have string array values
  if (meta.permissions) {
    for (const [cat, actions] of Object.entries(meta.permissions)) {
      if (!Array.isArray(actions)) {
        fail('permissions', `Permissions category "${cat}" must be an array`);
      } else {
        for (const action of actions) {
          if (typeof action !== 'string') {
            fail('permissions', `Permission action in "${cat}" must be a string`);
          }
        }
      }
    }
  }

  // Inputs validation
  if (meta.inputs) {
    for (const [key, input] of Object.entries(meta.inputs)) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        fail('inputs', `Input "${key}" must be an object`);
        continue;
      }
      if (input.type !== 'string' && input.type !== 'number' && input.type !== 'boolean') {
        fail('inputs', `Input "${key}" type must be "string", "number", or "boolean"`);
      }
      if (typeof input.description !== 'string') {
        fail('inputs', `Input "${key}" must have a string "description"`);
      }
    }
  }

  return errors;
}

/** Compatibility projection: the structured validator is the single rule source. */
export function validateManifest(meta: WorkflowMeta): string[] {
  return validateManifestDiagnostics(meta).map((diagnostic) => diagnostic.message);
}

/**
 * Compute a deterministic SHA-256 hash of the manifest for cache/integrity checks.
 * Returns the first 16 hex characters.
 */
export function computeManifestHash(meta: WorkflowMeta): string {
  const sortedKeys = Object.keys(meta).sort();
  const canonical = JSON.stringify(meta, sortedKeys);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
