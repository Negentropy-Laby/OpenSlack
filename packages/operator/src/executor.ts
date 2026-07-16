import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ActionPlan, PlanStep, StepResult, ExecutionResult, ExecutionOptions } from './types.js';
import { BUILTIN_ACTION_REGISTRY, type ActionRegistryPort } from './tool-registry.js';
import type { AgentPrincipal } from '@openslack/kernel';
import { authorizeAgentAction, classifyPaths } from '@openslack/kernel';
import type { AgentPermissionSnapshot, RiskZone } from '@openslack/kernel';

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

let planCounter = 0;
function generatePlanId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  planCounter++;
  return `PLAN-${ts}-${String(planCounter).padStart(4, '0')}`;
}

function runCLIStep(step: PlanStep, root: string): Promise<StepResult> {
  return new Promise((resolve) => {
    const args = [
      '--import', 'tsx',
      join(root, 'apps', 'cli', 'src', 'index.ts'),
      step.command,
      ...step.args,
    ];

    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const output = stdout + (stderr ? `\n${stderr}` : '');
      if (code === 0) {
        resolve({ stepId: step.id, status: 'success', output, exitCode: code ?? 0 });
      } else {
        resolve({ stepId: step.id, status: 'failed', output, exitCode: code ?? 1 });
      }
    });

    child.on('error', (err) => {
      resolve({ stepId: step.id, status: 'failed', output: err.message, exitCode: 1 });
    });
  });
}

function splitPathList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(',').map((path) => path.trim()).filter(Boolean);
}

function getStepChangedPaths(step: PlanStep): string[] {
  const inputPaths = splitPathList(step.input?.paths);
  if (inputPaths.length > 0) return inputPaths;

  const pathsArgIndex = step.args.indexOf('--paths');
  if (pathsArgIndex >= 0) {
    return splitPathList(step.args[pathsArgIndex + 1]);
  }

  return [];
}

function getStepRiskZone(changedPaths: string[]): RiskZone | undefined {
  if (changedPaths.length > 0) return classifyPaths(changedPaths);
  return undefined;
}

function rejectedStep(
  planId: string,
  results: StepResult[],
  invalid: { readonly stepId: string; readonly actionId?: string; readonly reason: string },
): ExecutionResult {
  const action = invalid.actionId ?? 'unknown';
  results.push({
    stepId: invalid.stepId,
    status: 'failed',
    output: `Unregistered or non-canonical OpenSlack action: ${action}. ${invalid.reason}`,
    exitCode: 1,
  });
  return {
    planId,
    status: 'failed',
    steps: results,
    summary: `Rejected unregistered action "${action}"`,
    nextActions: ['Use a canonical step from the current registered action'],
  };
}

export async function executePlan(
  plan: ActionPlan,
  options: ExecutionOptions & { principal?: AgentPrincipal; snapshot?: AgentPermissionSnapshot } = {},
  registry: ActionRegistryPort = BUILTIN_ACTION_REGISTRY,
): Promise<ExecutionResult> {
  const planId = generatePlanId();
  const root = findRepoRoot();
  const results: StepResult[] = [];

  // If there are missing params, block immediately
  if (plan.missingParams.length > 0) {
    return {
      planId,
      status: 'blocked',
      steps: [],
      summary: `Missing required parameters: ${plan.missingParams.map((m) => m.name).join(', ')}`,
      nextActions: ['Provide missing parameters and retry'],
    };
  }

  const plannedSteps = [...plan.steps];
  const preflightSteps: PlanStep[] = [];
  // Validate the complete plan before any authorization callback or command can
  // run. Revalidation may rebuild steps; registered builders are pure by contract.
  for (const plannedStep of plannedSteps) {
    const validation = registry.revalidateStep(plannedStep);
    if (!validation.valid) return rejectedStep(planId, results, validation);
    preflightSteps.push(validation.step);
  }

  if (options.dryRun) {
    return {
      planId,
      status: 'success',
      steps: preflightSteps.map((s) => ({
        stepId: s.id,
        status: 'skipped' as const,
        output: `[dry-run] ${s.description}`,
      })),
      summary: `Plan "${plan.goal}" — ${plan.steps.length} step(s) would execute.`,
      nextActions: ['Run without --plan to execute'],
    };
  }

  for (const plannedStep of plannedSteps) {
    // Re-check at the per-step authority boundary instead of relying only on the
    // earlier whole-plan snapshot.
    const validation = registry.revalidateStep(plannedStep);
    if (!validation.valid) return rejectedStep(planId, results, validation);
    let step = validation.step;

    // Per-step authorization gate
    let authorizationConfirmed = false;
    if (options.snapshot) {
      const action = step.actionId || step.command;
      const changedPaths = getStepChangedPaths(step);
      const auth = authorizeAgentAction({
        snapshot: options.snapshot,
        action,
        changedPaths,
        riskZone: getStepRiskZone(changedPaths),
      });
      if (auth.decision === 'deny') {
        const result = {
          stepId: step.id,
          status: 'failed' as const,
          output: `Authorization denied: ${auth.evidence.reason}`,
          exitCode: 1,
        };
        results.push(result);
        return {
          planId,
          status: 'failed',
          steps: results,
          summary: `Authorization denied at step "${step.description}": ${auth.evidence.reason}`,
          nextActions: ['Check agent permissions and retry'],
        };
      }
      if (auth.decision === 'ask') {
        if (!options.confirmStep) {
          const result = {
            stepId: step.id,
            status: 'skipped' as const,
            output: `Authorization requires confirmation: ${auth.evidence.reason}`,
          };
          results.push(result);
          return {
            planId,
            status: 'blocked',
            steps: results,
            summary: `Authorization requires confirmation at step "${step.description}": ${auth.evidence.reason}`,
            nextActions: ['Re-run with an explicit confirmation path'],
          };
        }

        const confirmed = await options.confirmStep(step);
        if (!confirmed) {
          results.push({ stepId: step.id, status: 'skipped', output: 'Authorization cancelled by user' });
          return {
            planId,
            status: 'cancelled',
            steps: results,
            summary: `Cancelled authorization for step "${step.description}"`,
            nextActions: ['Re-run and confirm the step'],
          };
        }
        authorizationConfirmed = true;
      }
    }

    // Per-step confirmation hook
    if (step.confirmationRequired && options.confirmStep && !authorizationConfirmed) {
      const confirmed = await options.confirmStep(step);
      if (!confirmed) {
        results.push({ stepId: step.id, status: 'skipped', output: 'Cancelled by user' });
        return {
          planId,
          status: 'cancelled',
          steps: results,
          summary: `Cancelled at step "${step.description}"`,
          nextActions: ['Re-run and confirm the step'],
        };
      }
    }

    options.onStepStart?.(step);

    // Re-check through the supplied registry after the callback; a compliant
    // ActionRegistryPort must reject any lifecycle-callback drift.
    const finalValidation = registry.revalidateStep(step);
    if (!finalValidation.valid) return rejectedStep(planId, results, finalValidation);
    step = finalValidation.step;

    let result: StepResult;
    if (step.tool === 'openslack-cli') {
      result = await runCLIStep(step, root);
    } else {
      result = {
        stepId: step.id,
        status: 'failed',
        output: `Unsupported tool: ${step.tool}`,
        exitCode: 1,
      };
    }

    results.push(result);
    options.onStepComplete?.(step, result);

    // Stop on first failure
    if (result.status === 'failed') {
      return {
        planId,
        status: 'failed',
        steps: results,
        summary: `Failed at step "${step.description}"`,
        nextActions: ['Check error output and retry'],
      };
    }
  }

  return {
    planId,
    status: 'success',
    steps: results,
    summary: `Completed: ${plan.goal}`,
    nextActions: [],
  };
}
