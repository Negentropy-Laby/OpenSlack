export const meta = {
  name: 'r-ext-go-qualification',
  version: '1.0.0',
  description:
    'Bounded Go-owned Workflow qualification; external execution requires separate qualification readiness.',
  whenToUse:
    'Issue #411 only, after the candidate, private send admission and real readiness evidence are reviewed.',
  phases: [
    {
      title: 'FirstCall',
      detail: 'Make one authenticated call and durably commit its checkpoint.',
    },
    { title: 'Approval', detail: 'Wait for one exact, independently human-attested audit effect.' },
    {
      title: 'SecondCall',
      detail: 'After canonical resume, make one additional authenticated call.',
    },
    { title: 'Complete', detail: 'Durably commit the completed result.' },
  ],
  inputs: {
    campaignId: {
      type: 'string',
      description: 'Correlation ID matching the host registered private send campaign.',
    },
    campaignBindingHash: {
      type: 'string',
      description: 'SHA-256 of the exact host registration, sealed with the workflow input hash.',
    },
  },
  permissions: { github: [], git: [], filesystem: [], openslack: ['governance.audit'] },
  sideEffects: ['openslack.governance.audit'],
  forbidden: [
    'github.review.approve',
    'github.pull_request.merge',
    'git.main.push',
    'shell.arbitrary',
  ],
  risk: 'medium',
  budgetPolicy: { maxAgents: 2, maxConcurrency: 1, tokenBudget: 16384, onExceeded: 'fail' },
  isolationPolicy: { codex_qualification_rext: 'none' },
};

const AGENT_ID = 'codex_qualification_rext';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const sha256 = async (value) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));

export async function preview(ctx) {
  ctx.phase('FirstCall');
  return {
    preview: true,
    agentId: AGENT_ID,
    providerCalls: 0,
    preparationBlocker: 'readiness_evidence_required',
  };
}

async function call(ctx, stage, phase) {
  const result = await ctx.agent(
    `Return only JSON {"ok":true,"stage":"${stage}"}. This is a bounded read-only Workflow qualification; do not use tools.`,
    {
      agentType: AGENT_ID,
      label: `r-ext:${stage}`,
      phase,
      isolation: 'none',
      budget: { tokens: 8192 },
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          stage: { type: 'string', enum: [stage] },
        },
        required: ['ok', 'stage'],
        additionalProperties: false,
      },
    },
  );
  if (result?.ok !== true || result.stage !== stage)
    throw new Error('R-EXT provider result did not satisfy its bounded schema.');
  return result;
}

export async function run(ctx) {
  // Fail before any provider call when the host did not expose the supported
  // checkpoint capability. No TS state writer or guessed recovery path exists.
  if (!ctx.checkpoint) throw new Error('R-EXT requires the Go-owned checkpoint capability.');
  if (typeof crypto !== 'object' || typeof crypto.subtle?.digest !== 'function')
    throw new Error('R-EXT requires the installed host Web Crypto capability before any call.');
  const campaignId = ctx.args.campaignId;
  if (typeof campaignId !== 'string' || !SAFE_ID.test(campaignId))
    throw new Error('R-EXT requires a well-formed campaignId for evidence correlation.');
  const campaignBindingHash = ctx.args.campaignBindingHash;
  if (typeof campaignBindingHash !== 'string' || !/^[a-f0-9]{64}$/u.test(campaignBindingHash))
    throw new Error('R-EXT requires the host registered campaignBindingHash before any call.');

  const commit = (stage, extra = {}, resultHash) =>
    ctx.checkpoint.commit({
      artifact: bytes({
        schema: 'openslack.r_ext_checkpoint.v1',
        campaignId,
        campaignBindingHash,
        runId: ctx.runId,
        stage,
        ...extra,
      }),
      ...(resultHash === undefined ? {} : { resultHash }),
    });

  ctx.phase('FirstCall');
  const first = await call(ctx, 'first', 'FirstCall');
  const firstHash = await sha256(bytes(first));
  // Stable across function re-entry: never add timestamps, random values or
  // resume generation. Recovery must verify the original committed evidence.
  await commit('first', { resultHash: firstHash }, firstHash);

  ctx.phase('Approval');
  await ctx.openslack.governance.audit('r-ext-go-qualification-approved', {
    schema: 'openslack.r_ext_audit_marker.v1',
    campaignId,
    campaignBindingHash,
    runId: ctx.runId,
    marker: 'r-ext-go-qualification-approved',
  });
  await commit('approved');

  ctx.phase('SecondCall');
  const second = await call(ctx, 'second', 'SecondCall');
  const secondHash = await sha256(bytes(second));
  await commit('second', { resultHash: secondHash }, secondHash);
  ctx.phase('Complete');
  await commit('completed', { firstHash, secondHash });
  return { status: 'completed', campaignId, firstHash, secondHash };
}
