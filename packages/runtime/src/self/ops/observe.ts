import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { validateWorkspace } from '@openslack/workspace';

export interface Observation {
  id: string;
  type:
    | 'ci_failure'
    | 'test_failure'
    | 'validation_failure'
    | 'missing_file'
    | 'typecheck_failure'
    | 'security_finding';
  source: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  evidence: string[];
  module: string;
  timestamp: string;
}

export interface InjectedChecks {
  typecheck?: { passed: boolean; output: string };
  tests?: { passed: boolean; output: string };
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function runTypecheck(root: string): { passed: boolean; output: string } {
  try {
    const output = execSync('bun run typecheck', {
      cwd: root,
      stdio: 'pipe',
      timeout: 60000,
    }).toString();
    return { passed: true, output };
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
    return { passed: false, output: stderr };
  }
}

function runTests(root: string): { passed: boolean; output: string } {
  try {
    const output = execSync('npx vitest run --reporter=verbose', {
      cwd: root,
      stdio: 'pipe',
      timeout: 60000,
    }).toString();
    return { passed: true, output };
  } catch (e) {
    const execErr = e as { stdout?: Buffer; stderr?: Buffer };
    const output = execErr.stdout?.toString() || execErr.stderr?.toString() || (e as Error).message;
    return { passed: false, output };
  }
}

export function observeHealth(checks?: InjectedChecks): Observation[] {
  const root = findRepoRoot();
  const observations: Observation[] = [];
  const now = new Date().toISOString();

  // 1. Check workspace validation
  const wsResult = validateWorkspace(root);
  if (!wsResult.valid) {
    observations.push({
      id: `OBS-${observations.length + 1}`,
      type: 'validation_failure',
      source: 'workspace-engine',
      severity: 'high',
      summary: 'Workspace validation failed',
      evidence: wsResult.errors.map((e) => `[${e.severity}] ${e.message}`),
      module: 'workspace-engine',
      timestamp: now,
    });
  }

  // 2. Check TypeScript compilation (injected or real)
  const tc = checks?.typecheck ?? runTypecheck(root);
  if (!tc.passed) {
    observations.push({
      id: `OBS-${observations.length + 1}`,
      type: 'typecheck_failure',
      source: 'typescript',
      severity: 'high',
      summary: 'TypeScript compilation failed',
      evidence: tc.output
        .split('\n')
        .filter((l) => l.includes('error TS'))
        .slice(0, 5),
      module: 'all',
      timestamp: now,
    });
  }

  // 3. Check tests (injected or real)
  const testResult = checks?.tests ?? runTests(root);
  if (!testResult.passed) {
    observations.push({
      id: `OBS-${observations.length + 1}`,
      type: 'test_failure',
      source: 'vitest',
      severity: 'high',
      summary: 'Test suite failed',
      evidence: testResult.output
        .split('\n')
        .filter((l) => l.includes('FAIL') || l.includes('failed'))
        .slice(0, 5),
      module: 'all',
      timestamp: now,
    });
  }

  // 4. Check required files exist
  const requiredFiles = [
    'openslack.yaml',
    '.openslack/self/constitution.md',
    '.openslack/self/invariants.yaml',
    '.openslack/policies/self_evolution.yaml',
  ];
  for (const file of requiredFiles) {
    if (!existsSync(join(root, file))) {
      observations.push({
        id: `OBS-${observations.length + 1}`,
        type: 'missing_file',
        source: 'file-system',
        severity: 'critical',
        summary: `Required file missing: ${file}`,
        evidence: [`${file} does not exist`],
        module: 'self',
        timestamp: now,
      });
    }
  }

  return observations;
}
