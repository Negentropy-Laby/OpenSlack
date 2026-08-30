const ABY_PROVIDER = 'aby';
const ABY_AGENT_ID = 'anthropic_architect_aby';

export const meta = {
  name: 'gs9g-authenticated-aby-canary',
  version: '1.0.0',
  description: 'One-call read-only workflow used to qualify the GS9-G authenticated Aby host.',
  whenToUse: 'Use only for the bounded GS9-G external canary qualification.',
  phases: [
    {
      title: 'Authenticate',
      detail: 'Execute one read-only request through the registered Aby runtime.',
    },
  ],
  inputs: {},
  permissions: {
    github: [],
    git: [],
    filesystem: [],
    openslack: [],
  },
  sideEffects: [],
  forbidden: [
    'github.review.approve',
    'github.pull_request.merge',
    'git.main.push',
    'shell.arbitrary',
  ],
  risk: 'low',
  budgetPolicy: {
    maxAgents: 1,
    maxConcurrency: 1,
    tokenBudget: 4096,
    onExceeded: 'fail',
  },
  isolationPolicy: {
    anthropic_architect_aby: 'none',
  },
};

export async function preview(ctx) {
  ctx.phase('Authenticate');
  return {
    preview: true,
    provider: ABY_PROVIDER,
    agentId: ABY_AGENT_ID,
  };
}

export async function run(ctx) {
  ctx.phase('Authenticate');
  const result = await ctx.agent(
    'Return JSON with ok=true and one concise response confirming this authenticated read-only Workflow canary completed.',
    {
      agentType: ABY_AGENT_ID,
      label: 'authenticate:aby-provider',
      phase: 'Authenticate',
      isolation: 'none',
      budget: { tokens: 2048, costUsd: 1 },
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          response: { type: 'string' },
          runId: { type: 'string' },
          agentId: { type: 'string' },
          bridge: { type: 'string' },
        },
        required: ['ok', 'response', 'runId', 'agentId', 'bridge'],
        additionalProperties: false,
      },
    },
  );
  const response = typeof result?.response === 'string' ? result.response.trim() : '';
  const runId = typeof result?.runId === 'string' ? result.runId.trim() : '';
  if (
    result?.ok !== true ||
    response.length === 0 ||
    runId.length === 0 ||
    result?.agentId !== ABY_AGENT_ID ||
    result?.bridge !== 'aby-runAgent'
  ) {
    throw new Error('Authenticated Aby canary did not return a valid provider response.');
  }

  return {
    status: 'complete',
    provider: ABY_PROVIDER,
    agentId: ABY_AGENT_ID,
    result,
  };
}
