import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ProductModule {
  id: string;
  name: string;
  status: string;
  phase: string;
  cli?: string[];
  packages?: string[];
  tests?: number;
  test_files?: number;
  golden_evals?: number;
  notes?: string;
}

export interface ModulesRegistry {
  schema: string;
  vitest_tests?: number;
  vitest_files?: number;
  modules: ProductModule[];
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
  registry?: ModulesRegistry;
}

const REQUIRED_FIELDS = ['id', 'name', 'status', 'phase'];

export function readModules(rootPath: string): ModulesRegistry {
  const yamlPath = join(rootPath, '.openslack', 'modules.yaml');
  if (!existsSync(yamlPath)) {
    throw new Error(`modules.yaml not found at ${yamlPath}`);
  }
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw) as ModulesRegistry;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('modules.yaml is empty or invalid');
  }
  if (parsed.schema !== 'openslack.modules.v1') {
    throw new Error(`Expected schema "openslack.modules.v1", got "${String(parsed.schema)}"`);
  }
  if (!Array.isArray(parsed.modules)) {
    throw new Error('modules.yaml must contain a "modules" array');
  }
  return parsed;
}

export function validateModules(registry: ModulesRegistry): RegistryValidationResult {
  const errors: string[] = [];

  for (const mod of registry.modules) {
    if (!mod || typeof mod !== 'object') {
      errors.push('Module entry is not an object');
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (!mod[field as keyof ProductModule]) {
        errors.push(`Module "${mod.id || 'unknown'}" missing required field: ${field}`);
      }
    }
    if (mod.tests !== undefined && typeof mod.tests !== 'number') {
      errors.push(`Module "${mod.id}" tests must be a number`);
    }
    if (mod.test_files !== undefined && typeof mod.test_files !== 'number') {
      errors.push(`Module "${mod.id}" test_files must be a number`);
    }
  }

  // Check for duplicate IDs
  const ids = registry.modules.map((m) => m.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push(`Duplicate module id: ${id}`);
    }
    seen.add(id);
  }

  return {
    valid: errors.length === 0,
    errors,
    registry: errors.length === 0 ? registry : undefined,
  };
}

export function getModuleById(registry: ModulesRegistry, id: string): ProductModule | undefined {
  return registry.modules.find((m) => m.id === id);
}

export function getTotalTests(registry: ModulesRegistry): number {
  return registry.modules.reduce((sum, m) => sum + (m.tests || 0), 0);
}

export function getTotalTestFiles(registry: ModulesRegistry): number {
  return registry.modules.reduce((sum, m) => sum + (m.test_files || 0), 0);
}
