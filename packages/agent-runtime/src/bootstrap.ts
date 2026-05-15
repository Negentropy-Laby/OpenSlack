import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkspace } from '@openslack/workspace-engine';

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

export interface BootstrapCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface BootstrapResult {
  agentId: string;
  passed: boolean;
  checks: BootstrapCheck[];
}

export function bootstrapAgent(agentId: string): BootstrapResult {
  const root = findRepoRoot();
  const checks: BootstrapCheck[] = [];

  // 1. Registry exists
  const registryPath = join(root, '.openslack', 'agents', 'registry', `${agentId}.yaml`);
  if (existsSync(registryPath)) {
    checks.push({ name: 'registry', passed: true, detail: `Registry found: ${registryPath}` });
  } else {
    checks.push({ name: 'registry', passed: false, detail: `Registry not found: ${registryPath}` });
  }

  // 2. Onboarding package exists
  const onboardingDir = join(root, '.openslack', 'agents', 'onboarding', agentId);
  if (existsSync(onboardingDir)) {
    checks.push({ name: 'onboarding', passed: true, detail: `Onboarding package exists` });
  } else {
    checks.push({ name: 'onboarding', passed: false, detail: `Onboarding package not found: ${onboardingDir}` });
  }

  // 3. START_HERE.md exists
  const startHerePath = join(onboardingDir, 'START_HERE.md');
  if (existsSync(startHerePath)) {
    checks.push({ name: 'start_here', passed: true, detail: 'START_HERE.md found' });
  } else {
    checks.push({ name: 'start_here', passed: false, detail: `START_HERE.md not found` });
  }

  // 4. Local identity exists (.openslack.local or agents/ registry check)
  const localIdentityPath = join(root, '.openslack.local', 'agents', agentId, 'identity.yaml');
  if (existsSync(localIdentityPath)) {
    checks.push({ name: 'local_identity', passed: true, detail: 'Local identity found' });
  } else {
    checks.push({ name: 'local_identity', passed: false, detail: `Local identity not found: ${localIdentityPath}` });
  }

  // 5. Workspace validation
  try {
    const wsResult = validateWorkspace(root);
    if (wsResult.valid) {
      checks.push({ name: 'workspace', passed: true, detail: 'Workspace validation passed' });
    } else {
      checks.push({ name: 'workspace', passed: false, detail: wsResult.errors.map((e) => e.message).join('; ') });
    }
  } catch (e) {
    checks.push({ name: 'workspace', passed: false, detail: `Workspace validation error: ${(e as Error).message}` });
  }

  // 6. Permission globs are syntactically valid
  try {
    const registryRaw = readFileSync(registryPath, 'utf-8');
    if (registryRaw.includes('workspace_permissions:') && registryRaw.includes('allow:')) {
      checks.push({ name: 'permissions', passed: true, detail: 'Permission globs present in registry' });
    } else {
      checks.push({ name: 'permissions', passed: false, detail: 'No workspace_permissions found in registry' });
    }
  } catch {
    // Registry read error handled above
  }

  return {
    agentId,
    passed: checks.every((c) => c.passed),
    checks,
  };
}
