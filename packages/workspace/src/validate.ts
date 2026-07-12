import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { WorkspaceConfig, ValidationResult, ValidationError } from './types.js';

function checkOpenslackYaml(rootPath: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const yamlPath = join(rootPath, 'openslack.yaml');

  if (!existsSync(yamlPath)) {
    return [
      { severity: 'error', message: 'openslack.yaml not found at workspace root', path: yamlPath },
    ];
  }

  let config: unknown;
  try {
    const raw = readFileSync(yamlPath, 'utf-8');
    config = parseYaml(raw);
  } catch (e) {
    return [
      {
        severity: 'error',
        message: `Failed to parse openslack.yaml: ${(e as Error).message}`,
        path: yamlPath,
      },
    ];
  }

  if (!config || typeof config !== 'object') {
    return [{ severity: 'error', message: 'openslack.yaml is empty or invalid', path: yamlPath }];
  }

  const c = config as Record<string, unknown>;
  if (c.schema !== 'openslack.workspace.v1') {
    errors.push({
      severity: 'error',
      message: `Expected schema "openslack.workspace.v1", got "${String(c.schema)}"`,
      path: yamlPath,
    });
  }
  if (!c.workspace_id || typeof c.workspace_id !== 'string') {
    errors.push({
      severity: 'error',
      message: 'workspace_id is required and must be a string',
      path: yamlPath,
    });
  }
  if (!c.name || typeof c.name !== 'string') {
    errors.push({
      severity: 'error',
      message: 'name is required and must be a string',
      path: yamlPath,
    });
  }
  if (c.mode !== 'self_project' && c.mode !== 'normal') {
    errors.push({
      severity: 'error',
      message: `mode must be "self_project" or "normal", got "${String(c.mode)}"`,
      path: yamlPath,
    });
  }
  if (!c.canonical_remote || typeof c.canonical_remote !== 'object') {
    errors.push({ severity: 'error', message: 'canonical_remote is required', path: yamlPath });
  }
  if (!c.workspace || typeof c.workspace !== 'object') {
    errors.push({ severity: 'error', message: 'workspace config is required', path: yamlPath });
  } else {
    const workspace = c.workspace as Record<string, unknown>;
    if (workspace.root !== '.' || typeof workspace.state_root !== 'string') {
      errors.push({
        severity: 'error',
        message: 'workspace.root must be "." and workspace.state_root must be a string',
        path: yamlPath,
      });
    }
  }
  if (!c.product || typeof c.product !== 'object') {
    errors.push({ severity: 'error', message: 'product config is required', path: yamlPath });
  } else {
    const product = c.product as Record<string, unknown>;
    if (
      (product.repo_role !== 'self' && product.repo_role !== 'managed') ||
      !Array.isArray(product.source_roots) ||
      !Array.isArray(product.protected_roots)
    ) {
      errors.push({ severity: 'error', message: 'product config is invalid', path: yamlPath });
    }
  }

  return errors;
}

function checkStateDirectory(rootPath: string, config: WorkspaceConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const stateRoot = resolve(rootPath, config.workspace.state_root);
  const stateRelative = relative(rootPath, stateRoot);
  if (isAbsolute(stateRelative) || stateRelative === '..' || stateRelative.startsWith(`..${sep}`)) {
    return [
      {
        severity: 'error',
        message: 'workspace.state_root must remain inside the workspace root',
        path: stateRoot,
      },
    ];
  }

  if (!existsSync(stateRoot)) {
    return [
      {
        severity: 'error',
        message: `State directory "${config.workspace.state_root}" does not exist`,
        path: stateRoot,
      },
    ];
  }

  const requiredDirs = [
    'agents/registry',
    'agents/prompts',
    'policies',
    'tasks',
    'leases',
    'audit',
    'collaboration',
  ];
  if (config.mode === 'self_project') requiredDirs.push('self');

  for (const dir of requiredDirs) {
    const fullPath = join(stateRoot, dir);
    if (!existsSync(fullPath)) {
      errors.push({
        severity: 'error',
        message: `Required state directory missing: ${dir}`,
        path: fullPath,
      });
    }
  }

  return errors;
}

function checkProtectedRoots(rootPath: string, config: WorkspaceConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const protectedRoot of config.product.protected_roots) {
    const fullPath = join(rootPath, protectedRoot);
    if (existsSync(fullPath)) {
      // Protected roots that exist are validated as present — this is informational
      // The actual write protection is enforced by git branch protection + policy engine
    }
  }

  return errors;
}

function checkSourceRoots(rootPath: string, config: WorkspaceConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const sourceRoot of config.product.source_roots) {
    const fullPath = join(rootPath, sourceRoot);
    if (!existsSync(fullPath)) {
      errors.push({
        severity: 'warning',
        message: `Source root "${sourceRoot}" does not exist yet`,
        path: fullPath,
      });
    }
  }

  return errors;
}

export function validateWorkspace(rootPath: string): ValidationResult {
  const errors: ValidationError[] = [];

  // Phase 1: Parse openslack.yaml
  const yamlErrors = checkOpenslackYaml(rootPath);
  errors.push(...yamlErrors);

  if (yamlErrors.some((e) => e.severity === 'error')) {
    return { valid: false, errors };
  }

  // Parse config for remaining checks
  const raw = readFileSync(join(rootPath, 'openslack.yaml'), 'utf-8');
  const config = parseYaml(raw) as WorkspaceConfig;

  // Phase 2: Check state directory
  const stateErrors = checkStateDirectory(rootPath, config);
  errors.push(...stateErrors);

  // Phase 3: Check source roots
  const sourceErrors = checkSourceRoots(rootPath, config);
  errors.push(...sourceErrors);

  // Phase 4: Check protected roots
  const protectedErrors = checkProtectedRoots(rootPath, config);
  errors.push(...protectedErrors);

  return {
    valid: !errors.some((e) => e.severity === 'error'),
    errors,
    config,
  };
}
