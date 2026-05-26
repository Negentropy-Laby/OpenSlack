import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  generateSessionId,
  appendTurn,
  loadConversation,
  listConversations,
  getRecentTurns,
  resolveContext,
  extractSlotsFromMessage,
  mergeDefinedSlots,
  MAX_CLARIFICATION_ROUNDS,
} from '@openslack/operator';
import type { PlanStep } from '@openslack/operator';
import { recordEvent } from '@openslack/collaboration';
import { resolveAgentPrincipal } from '@openslack/runtime';

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

type AgentAuthOptions = {
  principal?: import('@openslack/kernel').AgentPrincipal;
  snapshot?: import('@openslack/kernel').AgentPermissionSnapshot;
};

function resolveAgentAuthOptions(agentId: string | undefined): AgentAuthOptions {
  if (!agentId) return {};
  const root = findRepoRoot();
  const resolved = resolveAgentPrincipal({ root, agentId, provider: 'cli' });
  if ('error' in resolved) {
    console.error(`Authorization failed: ${resolved.error}`);
    process.exit(1);
  }
  return { principal: resolved.principal, snapshot: resolved.snapshot };
}

async function runAsk(
  query: string,
  options: { plan?: boolean; agentId?: string; session?: string },
): Promise<void> {
  const sessionId = options.session || generateSessionId();
  const root = findRepoRoot();

  console.log(`\nOperator: "${query}"`);
  console.log('─'.repeat(50));

  // Load conversation history and append user turn
  const history = getRecentTurns(sessionId, 10, root);
  const messageSlots = extractSlotsFromMessage(query);

  // Check context: affirmation/negation or slot inheritance
  const pendingPlans = listPendingPlans(root);
  const lastPending = pendingPlans.find((p) => p.state === 'pending');

  let intent = await resolveIntent(query);

  if (intent.kind === 'unknown' && history.length > 0) {
    // Maybe the query is a short response to a previous plan
    const context = resolveContext(intent, history, lastPending?.planId, query);
    if (context.type === 'confirm_last_plan' && lastPending) {
      appendTurn(sessionId, { role: 'user', content: query, timestamp: new Date().toISOString() }, root);
      console.log(`Confirming plan: ${lastPending.planId}`);
      updatePendingPlanState(lastPending.planId, 'approved', root);

      const authOptions = resolveAgentAuthOptions(options.agentId);
      const result = await executePlan(lastPending.plan, {
        ...authOptions,
        confirmStep: async () => true,
        onStepStart: (step: PlanStep) => { console.log(`→ ${step.description}`); },
        onStepComplete: (step, sr) => {
          if (sr.status === 'success') console.log(`  ✓ ${step.id} complete`);
          else if (sr.status === 'skipped') console.log(`  ⊘ ${step.id} skipped`);
          else console.log(`  ✗ ${step.id} failed`);
        },
      });

      if (result.status === 'success') updatePendingPlanState(lastPending.planId, 'executed', root);
      appendTurn(sessionId, { role: 'assistant', content: summarizeResults(result), intent, timestamp: new Date().toISOString() }, root);
      console.log(`\n${summarizeResults(result)}\n`);
      return;
    }

    if (context.type === 'cancel_last_plan' && lastPending) {
      appendTurn(sessionId, { role: 'user', content: query, timestamp: new Date().toISOString() }, root);
      updatePendingPlanState(lastPending.planId, 'cancelled', root);
      appendTurn(sessionId, { role: 'assistant', content: `Cancelled plan: ${lastPending.planId}`, intent, timestamp: new Date().toISOString() }, root);
      console.log(`Cancelled plan: ${lastPending.planId}\n`);
      return;
    }
  }

  if (intent.kind === 'unknown') {
    console.log(`I don't understand "${query}".`);
    console.log('Try: check status, PR #12 doctor, merge PR #12, create task, eval');
    console.log('');
    return;
  }

  // Merge slots from message parsing and context resolution
  const context = resolveContext(intent, history, lastPending?.planId, query);
  if (context.type === 'resolve_slots') {
    intent = {
      ...intent,
      slots: mergeDefinedSlots(context.resolved, messageSlots, intent.slots),
    };
  } else {
    intent = {
      ...intent,
      slots: mergeDefinedSlots(messageSlots, intent.slots),
    };
  }

  // Append user turn with resolved intent
  appendTurn(sessionId, { role: 'user', content: query, intent, timestamp: new Date().toISOString() }, root);

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
    const existingPending = lastPending?.plan;
    const round = existingPending ? (lastPending?.clarificationRounds ?? 0) : 0;

    if (round >= MAX_CLARIFICATION_ROUNDS) {
      const question = buildClarificationQuestion(plan.missingParams, round, intent.kind);
      console.log(question);
      return;
    }

    const pending = savePendingPlan({
      query, plan, actorId: 'cli', root,
      state: 'pending',
    });
    // Update clarification rounds
    const currentRounds = lastPending?.clarificationRounds ?? 0;
    const updatedPlan = loadPendingPlan(pending.planId, root);
    if (updatedPlan) {
      const planData = JSON.parse(JSON.stringify(updatedPlan)) as Record<string, unknown>;
      planData.clarificationRounds = currentRounds + 1;
      const { writeFileSync } = await import('node:fs');
      const planPath = join(root, '.openslack.local', 'operator', 'plans', `${pending.planId}.json`);
      writeFileSync(planPath, JSON.stringify(planData, null, 2), 'utf-8');
    }

    const question = buildClarificationQuestion(plan.missingParams, currentRounds, intent.kind);
    console.log(`${question}`);
    console.log(`Plan ID: ${pending.planId}  (Session: ${sessionId})`);
    console.log(`Resume with: openslack ask plan resume ${pending.planId} --set name=value`);
    appendTurn(sessionId, { role: 'assistant', content: question, intent, timestamp: new Date().toISOString() }, root);
    console.log('');
    return;
  }

  console.log(formatPlan(plan));
  console.log('');

  if (options.plan) {
    const pending = savePendingPlan({ query, plan, actorId: 'cli', root });
    console.log(`Saved pending plan: ${pending.planId}`);
    console.log(`Approve later with: openslack ask plan approve ${pending.planId}`);
    appendTurn(sessionId, { role: 'assistant', content: `Plan saved: ${pending.planId}`, intent, timestamp: new Date().toISOString() }, root);
    return;
  }

  let pendingPlanId: string | undefined;
  if (plan.requiresConfirmation) {
    const pending = savePendingPlan({ query, plan, actorId: 'cli', root });
    pendingPlanId = pending.planId;
    console.log(`Saved pending plan: ${pending.planId}`);
    console.log(`Approve later with: openslack ask plan approve ${pending.planId}`);

    const message = plan.riskExplanation
      ? `${plan.riskExplanation} Proceed now?`
      : `This action requires confirmation. Proceed now?`;
    const confirmed = await confirmPrompt(message);
    if (!confirmed) {
      console.log('Cancelled by user. Pending plan remains available until expiry.\n');
      appendTurn(sessionId, { role: 'assistant', content: 'Plan cancelled by user.', intent, timestamp: new Date().toISOString() }, root);
      return;
    }
    updatePendingPlanState(pending.planId, 'approved', root);
    console.log('');
  }

  const authOptions = resolveAgentAuthOptions(options.agentId);

  const result = await executePlan(plan, {
    dryRun: options.plan,
    ...authOptions,
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
    updatePendingPlanState(pendingPlanId, 'executed', root);
  }

  const summary = summarizeResults(result);
  appendTurn(sessionId, { role: 'assistant', content: summary, intent, timestamp: new Date().toISOString() }, root);
  console.log('');
  console.log(summary);
  console.log('');
}

export function buildAskCommand(): Command {
  const ask = new Command('ask')
    .description('Ask the Operator Agent to perform a task (natural language)')
    .argument('<query...>', 'What do you want to do?')
    .option('--plan', 'Show the execution plan without running it')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .option('--session <id>', 'Session ID for conversation continuity')
    .action(async (queryParts: string[], options: { plan?: boolean; agentId?: string; session?: string }) => {
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
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (planId: string, options: { agentId?: string }) => {
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
      const authOptions = resolveAgentAuthOptions(options.agentId);
      const result = await executePlan(pending.plan, { ...authOptions, confirmStep: async () => true });
      if (result.status === 'success') updatePendingPlanState(planId, 'executed');
      console.log(summarizeResults(result));
      if (result.status !== 'success') process.exit(1);
    });

  ask.addCommand(planCmd);

  ask
    .command('history')
    .description('Show recent conversation turns for a session')
    .option('--session <id>', 'Session ID')
    .option('--limit <n>', 'Number of recent turns to show', '10')
    .action((options: { session?: string; limit: string }) => {
      const sessionId = options.session || process.env.OPENSLACK_SESSION_ID || generateSessionId();
      const limit = parseInt(options.limit, 10) || 10;
      const turns = getRecentTurns(sessionId, limit, findRepoRoot());
      if (turns.length === 0) {
        console.log(`No conversation history for session: ${sessionId}`);
        return;
      }
      console.log(`Session: ${sessionId}`);
      console.log('─'.repeat(50));
      for (const turn of turns) {
        const time = new Date(turn.timestamp).toLocaleTimeString();
        const role = turn.role === 'user' ? 'You' : 'Operator';
        console.log(`[${time}] ${role}: ${turn.content}`);
        if (turn.intent && turn.intent.kind !== 'unknown') {
          console.log(`  Intent: ${turn.intent.kind} (${(turn.intent.confidence * 100).toFixed(0)}%)`);
        }
      }
      console.log('');
    });

  ask
    .command('sessions')
    .description('List active conversation sessions')
    .action(() => {
      const conversations = listConversations(findRepoRoot());
      if (conversations.length === 0) {
        console.log('No active sessions.');
        return;
      }
      for (const conv of conversations) {
        const age = new Date(conv.updatedAt).toLocaleString();
        console.log(`${conv.sessionId}  ${conv.turns.length} turns  updated: ${age}`);
      }
    });

  return ask;
}

export function operatorCommands(): Command {
  const cmd = new Command('operator').description('OpenSlack Operator Agent');
  cmd.addCommand(buildAskCommand());
  return cmd;
}
