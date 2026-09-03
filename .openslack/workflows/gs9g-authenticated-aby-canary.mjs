const ABY_PROVIDER = 'aby';
const ABY_AGENT_ID = 'anthropic_architect_aby';
const ABY_BRIDGE_ID = 'aby-runAgent';

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
    tokenBudget: 8192,
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
      budget: { tokens: 8192, costUsd: 1 },
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          response: { type: 'string' },
          runId: { type: 'string' },
          agentId: { type: 'string', enum: [ABY_AGENT_ID] },
          bridge: { type: 'string', enum: [ABY_BRIDGE_ID] },
        },
        required: ['ok', 'response', 'runId', 'agentId', 'bridge'],
        additionalProperties: false,
      },
    },
  );
  const response = result.response.trim();
  const runId = result.runId.trim();
  if (response.length === 0 || runId.length === 0) {
    throw new Error('Authenticated Aby canary did not return a valid provider response.');
  }

  return {
    status: 'complete',
    result,
  };
}
