import { Command } from 'commander';
import { createInterface } from 'node:readline';
import {
  resolveIntent,
  planActions,
  executePlan,
  formatPlan,
  summarizeResults,
  buildClarificationQuestion,
  savePendingPlan,
  listPendingPlans,
  loadPendingPlan,
  updatePendingPlanState,
  resumePendingPlan,
} from '@openslack/operator';
import type { PlanStep } from '@openslack/operator';
import { recordEvent } from '@openslack/collaboration';

function confirmPrompt(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function parseSetOptions(items: string[] | undefined): Record<string, string | number> {
  const updates: Record<string, string | number> = {};
  for (const item of items ?? []) {
    const [key, ...rest] = item.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=');
    updates[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return updates;
}

async function runAsk(query: string, options: { plan?: boolean }): Promise<void> {
  console.log(`\nOperator: "${query}"`);
  console.log('─'.repeat(50));

  const intent = await resolveIntent(query);

  if (intent.kind === 'unknown') {
    console.log(`I don't understand "${query}".`);
    console.log('Try: check status, PR #12 doctor, merge PR #12, create task, eval');
    console.log('');
    return;
  }

  const plan = planActions(intent);

  try {
    recordEvent({
      type: 'operator.plan.created',
      actor: { id: 'cli', kind: 'system', provider: 'cli' },
      object: { kind: 'plan', id: plan.goal },
      source: { kind: 'operator', ref: 'planActions' },
      summary: `Plan created for intent "${intent.kind}" with ${plan.steps.length} steps, risk: ${plan.riskLevel}`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      risk: plan.riskLevel,
      nextAction: plan.missingParams.length > 0
        ? { owner: 'human', action: `Provide missing params: ${plan.missingParams.map((p) => p.name).join(', ')}` }
        : { owner: 'human', action: `Confirm execution of plan: ${plan.goal}` },
    });
  } catch {
    // Best-effort event recording
  }

  if (plan.missingParams.length > 0) {
    const pending = savePendingPlan({ query, plan, actorId: 'cli' });
    const question = buildClarificationQuestion(plan.missingParams);
    console.log(`${question}`);
    console.log(`Plan ID: ${pending.planId}`);
    console.log(`Resume with: openslack ask plan resume ${pending.planId} --set name=value`);
    console.log('');
    return;
  }

  console.log(formatPlan(plan));
  console.log('');

  if (options.plan) {
    const pending = savePendingPlan({ query, plan, actorId: 'cli' });
    console.log(`Saved pending plan: ${pending.planId}`);
    console.log(`Approve later with: openslack ask plan approve ${pending.planId}`);
    return;
  }

  let pendingPlanId: string | undefined;
  if (plan.requiresConfirmation) {
    const pending = savePendingPlan({ query, plan, actorId: 'cli' });
    pendingPlanId = pending.planId;
    console.log(`Saved pending plan: ${pending.planId}`);
    console.log(`Approve later with: openslack ask plan approve ${pending.planId}`);

    const message = plan.riskExplanation
      ? `${plan.riskExplanation} Proceed now?`
      : `This action requires confirmation. Proceed now?`;
    const confirmed = await confirmPrompt(message);
    if (!confirmed) {
      console.log('Cancelled by user. Pending plan remains available until expiry.\n');
      return;
    }
    updatePendingPlanState(pending.planId, 'approved');
    console.log('');
  }

  const result = await executePlan(plan, {
    dryRun: options.plan,
    onStepStart: (step: PlanStep) => {
      console.log(`→ ${step.description}`);
    },
    onStepComplete: (step, stepResult) => {
      if (stepResult.status === 'success') {
        console.log(`  ✓ ${step.id} complete`);
      } else if (stepResult.status === 'skipped') {
        console.log(`  ⊘ ${step.id} skipped`);
      } else {
        console.log(`  ✗ ${step.id} failed`);
      }
    },
  });

  if (pendingPlanId && result.status === 'success') {
    updatePendingPlanState(pendingPlanId, 'executed');
  }

  console.log('');
  console.log(summarizeResults(result));
  console.log('');
}

export function operatorCommands(): Command {
  const cmd = new Command('operator').description('OpenSlack Operator Agent');

  const ask = new Command('ask')
    .description('Ask the Operator Agent to perform a task (natural language)')
    .argument('<query...>', 'What do you want to do?')
    .option('--plan', 'Show the execution plan without running it')
    .action(async (queryParts: string[], options: { plan?: boolean }) => {
      await runAsk(queryParts.join(' '), options);
    });

  const planCmd = new Command('plan').description('Manage pending Operator plans');

  planCmd
    .command('list')
    .description('List pending Operator plans')
    .action(() => {
      const plans = listPendingPlans();
      if (plans.length === 0) {
        console.log('No pending plans found.');
        return;
      }
      for (const plan of plans) {
        console.log(`${plan.planId}  ${plan.state}  ${plan.plan.goal}`);
        console.log(`  Expires: ${plan.expiresAt}`);
      }
    });

  planCmd
    .command('show <planId>')
    .description('Show a pending Operator plan')
    .action((planId: string) => {
      const pending = loadPendingPlan(planId);
      if (!pending) {
        console.error(`Plan not found: ${planId}`);
        process.exit(1);
      }
      console.log(`Plan ID: ${pending.planId}`);
      console.log(`State: ${pending.state}`);
      console.log(`Query: ${pending.query}`);
      console.log(`Expires: ${pending.expiresAt}`);
      console.log('');
      console.log(formatPlan(pending.plan));
    });

  planCmd
    .command('cancel <planId>')
    .description('Cancel a pending Operator plan')
    .action((planId: string) => {
      const pending = updatePendingPlanState(planId, 'cancelled');
      if (!pending) {
        console.error(`Plan not found: ${planId}`);
        process.exit(1);
      }
      console.log(`Cancelled plan: ${pending.planId}`);
    });

  planCmd
    .command('resume <planId>')
    .description('Update a pending plan with clarification values')
    .option('--set <key=value>', 'Slot update, can be repeated', (value, previous: string[]) => [...previous, value], [])
    .action((planId: string, options: { set: string[] }) => {
      const pending = resumePendingPlan(planId, parseSetOptions(options.set));
      if (!pending) {
        console.error(`Plan not found, expired, or not pending: ${planId}`);
        process.exit(1);
      }
      console.log(`Updated plan: ${pending.planId}`);
      console.log(formatPlan(pending.plan));
      if (pending.plan.missingParams.length > 0) {
        console.log('');
        console.log(buildClarificationQuestion(pending.plan.missingParams));
      }
    });

  planCmd
    .command('approve <planId>')
    .description('Approve and execute a pending Operator plan')
    .action(async (planId: string) => {
      const pending = loadPendingPlan(planId);
      if (!pending) {
        console.error(`Plan not found: ${planId}`);
        process.exit(1);
      }
      if (pending.state !== 'pending' && pending.state !== 'approved') {
        console.error(`Plan cannot be approved from state: ${pending.state}`);
        process.exit(1);
      }
      if (pending.plan.missingParams.length > 0) {
        console.error(buildClarificationQuestion(pending.plan.missingParams));
        process.exit(1);
      }
      updatePendingPlanState(planId, 'approved');
      const result = await executePlan(pending.plan, { confirmStep: async () => true });
      if (result.status === 'success') updatePendingPlanState(planId, 'executed');
      console.log(summarizeResults(result));
      if (result.status !== 'success') process.exit(1);
    });

  ask.addCommand(planCmd);
  cmd.addCommand(ask);

  return cmd;
}
