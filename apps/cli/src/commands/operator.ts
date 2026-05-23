import { Command } from 'commander';
import { createInterface } from 'node:readline';
import {
  parseIntent,
  planActions,
  executePlan,
  formatPlan,
  summarizeResults,
  buildClarificationQuestion,
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

export function operatorCommands(): Command {
  const cmd = new Command('operator').description('OpenSlack Operator Agent');

  cmd
    .command('ask')
    .description('Ask the Operator Agent to perform a task (natural language)')
    .argument('<query...>', 'What do you want to do?')
    .option('--plan', 'Show the execution plan without running it')
    .action(async (queryParts: string[], options: { plan?: boolean }) => {
      const query = queryParts.join(' ');

      console.log(`\nOperator: "${query}"`);
      console.log('─'.repeat(50));

      // Step 1: Parse intent
      const intent = parseIntent(query);

      if (intent.kind === 'unknown') {
        console.log(`I don't understand "${query}".`);
        console.log('Try: check status, PR #12 doctor, merge PR #12, create task, eval');
        console.log('');
        return;
      }

      // Step 2: Plan actions
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

      // Step 3: Handle missing params
      if (plan.missingParams.length > 0) {
        const question = buildClarificationQuestion(plan.missingParams);
        console.log(`${question}`);
        console.log('');
        return;
      }

      // Step 4: Show plan (always)
      console.log(formatPlan(plan));
      console.log('');

      // Step 5: Dry-run / plan-only mode
      if (options.plan) {
        return;
      }

      // Step 6: Confirm high-risk plans
      if (plan.requiresConfirmation) {
        const message = plan.riskExplanation
          ? `${plan.riskExplanation} Proceed?`
          : `This action requires confirmation. Proceed?`;
        const confirmed = await confirmPrompt(message);
        if (!confirmed) {
          console.log('Cancelled by user.\n');
          return;
        }
        console.log('');
      }

      // Step 7: Execute
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

      // Step 8: Summary
      console.log('');
      console.log(summarizeResults(result));
      console.log('');
    });

  return cmd;
}
