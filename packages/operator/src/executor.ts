import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ActionPlan, PlanStep, StepResult, ExecutionResult, ExecutionOptions } from './types.js';
import { isRegisteredStep } from './tool-registry.js';

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

export async function executePlan(
  plan: ActionPlan,
  options: ExecutionOptions = {},
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

  if (options.dryRun) {
    const invalid = plan.steps.find((step) => !isRegisteredStep(step));
    if (invalid) {
      return {
        planId,
        status: 'failed',
        steps: [{ stepId: invalid.id, status: 'failed', output: `Unregistered OpenSlack action: ${invalid.actionId || invalid.command}` }],
        summary: `Rejected unregistered action "${invalid.actionId || invalid.command}"`,
        nextActions: ['Use a registered OpenSlack action'],
      };
    }
    return {
      planId,
      status: 'success',
      steps: plan.steps.map((s) => ({
        stepId: s.id,
        status: 'skipped' as const,
        output: `[dry-run] ${s.description}`,
      })),
      summary: `Plan "${plan.goal}" — ${plan.steps.length} step(s) would execute.`,
      nextActions: ['Run without --plan to execute'],
    };
  }

  for (const step of plan.steps) {
    if (!isRegisteredStep(step)) {
      const result = {
        stepId: step.id,
        status: 'failed' as const,
        output: `Unregistered OpenSlack action: ${step.actionId || step.command}`,
        exitCode: 1,
      };
      results.push(result);
      return {
        planId,
        status: 'failed',
        steps: results,
        summary: `Rejected unregistered action "${step.actionId || step.command}"`,
        nextActions: ['Use a registered OpenSlack action'],
      };
    }

    // Per-step confirmation hook
    if (step.confirmationRequired && options.confirmStep) {
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
