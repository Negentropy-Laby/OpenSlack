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
}

export async function preview(ctx) {
  ctx.phase('Authenticate')
  return {
    preview: true,
    provider: 'aby',
    agentId: 'anthropic_architect_aby',
  }
}

export async function run(ctx) {
  ctx.phase('Authenticate')
  const result = await ctx.agent(
    'Return one concise sentence confirming this authenticated read-only Workflow canary completed.',
    {
      agentType: 'anthropic_architect_aby',
      label: 'authenticate:aby-provider',
      phase: 'Authenticate',
      isolation: 'none',
      budget: { tokens: 2048, costUsd: 1 },
      schema: {
        type: 'object',
        properties: {
          response: { type: 'string' },
        },
        required: ['response'],
      },
    },
  )
  const response = typeof result?.response === 'string' ? result.response.trim() : ''
  if (
    response.length === 0 ||
    /(?:API Error:|Failed to authenticate|Missing API key|Authentication (?:failed|error)|\bUnauthorized\b|\bForbidden\b)/iu.test(
      response,
    )
  ) {
    throw new Error('Authenticated Aby canary did not return a valid provider response.')
  }

  return {
    status: 'complete',
    provider: 'aby',
    agentId: 'anthropic_architect_aby',
    result,
  }
}
