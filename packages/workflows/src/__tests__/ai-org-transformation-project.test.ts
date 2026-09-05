import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRuntime } from '../runtime.js';
import {
  executeDryRun,
  executePreview,
  loadWorkflow,
  type AgentLauncher,
  type JSONSchemaDefinition,
  type WorkflowModule,
} from '@openslack/workflows';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

const DEMO_ROLE_IDS = [
  'business-discovery-agent',
  'data-inventory-agent',
  'solution-architect-agent',
  'roi-analyst-agent',
  'risk-reviewer-agent',
  'delivery-planner-agent',
] as const;

const DEMO_ARTIFACT_FILES = [
  'executive-summary.md',
  'opportunity-matrix.md',
  'data-system-map.md',
  'roi-model.md',
  'target-architecture.md',
  'risk-register.md',
  '90-day-plan.md',
] as const;

function loadProjectWorkflow(): Promise<WorkflowModule> {
  return loadWorkflow(resolve(REPO_ROOT, '.openslack/workflows/ai-org-transformation.ts'));
}

function loadAgentFixture(agentType: string): unknown {
  return JSON.parse(
    readFileSync(
      resolve(
        REPO_ROOT,
        'examples/ai-organization-demo/fixtures/agent-results',
        `${agentType}.json`,
      ),
      'utf8',
    ),
  );
}

function expectClosedAndBoundedSchema(schema: JSONSchemaDefinition): void {
  if (schema.type === 'object') expect(schema.additionalProperties).toBe(false);
  if (schema.type === 'string' && !schema.enum) {
    expect(schema.minLength).toBeTypeOf('number');
    expect(schema.maxLength).toBeTypeOf('number');
  }
  if (schema.type === 'number') {
    expect(schema.minimum).toBeTypeOf('number');
    expect(schema.maximum).toBeTypeOf('number');
  }
  if (schema.type === 'array') {
    expect(schema.minItems).toBeTypeOf('number');
    expect(schema.maxItems).toBeTypeOf('number');
  }
  for (const property of Object.values(schema.properties ?? {})) {
    expectClosedAndBoundedSchema(property);
  }
  if (schema.items && !Array.isArray(schema.items)) expectClosedAndBoundedSchema(schema.items);
}

describe('ai-org-transformation workflow', () => {
  it('is discoverable and statically validates its six ordered phases', async () => {
    const source = readFileSync(
      resolve(REPO_ROOT, '.openslack/workflows/ai-org-transformation.ts'),
      'utf8',
    );
    const workflow = await loadProjectWorkflow();
    expect(source).toContain("from '@openslack/collaboration'");
    expect(source).not.toContain('../../packages/collaboration/src/');
    expect(workflow.meta.name).toBe('ai-org-transformation');
    expect(workflow.meta.phases.map((phase) => phase.title)).toEqual([
      'Intake',
      'Discover',
      'Select',
      'Design',
      'Validate',
      'Deliver',
    ]);
    expect(workflow.meta.sideEffects).toEqual([]);
  });

  it('routes all six roles, caps fan-out at two, and returns seven stable artifacts', async () => {
    const workflow = await loadProjectWorkflow();
    const roles: string[] = [];
    const schemas: JSONSchemaDefinition[] = [];
    let active = 0;
    let maxActive = 0;
    const launcher: AgentLauncher = vi.fn(
      async (_prompt: string, options: Parameters<AgentLauncher>[1]) => {
        roles.push(String(options.agentType));
        if (options.schema) schemas.push(options.schema);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return {
          data: structuredClone(loadAgentFixture(String(options.agentType))),
          tokenUsage: 100,
        };
      },
    );
    const runtime = createRuntime({
      runId: 'demo-contract-test',
      mode: 'execute',
      manifest: workflow.meta,
      budget: { tokens: 64000, costUsd: 1 },
      agentLauncher: launcher,
      onConfirm: async () => false,
    });

    const result = await workflow.run!(runtime, {});
    const workflowResultSchema = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, 'examples/ai-organization-demo/schemas/workflow-result.schema.json'),
        'utf8',
      ),
    );
    const validateResult = new Ajv2020({ strict: false }).compile(workflowResultSchema);

    expect(new Set(roles)).toEqual(new Set(DEMO_ROLE_IDS));
    expect(roles).toHaveLength(8);
    expect(schemas).toHaveLength(8);
    schemas.forEach(expectClosedAndBoundedSchema);
    expect(maxActive).toBe(2);
    expect(
      (result.artifacts as Array<{ filename: string }>).map((artifact) => artifact.filename),
    ).toEqual(DEMO_ARTIFACT_FILES);
    expect(
      validateResult(result),
      validateResult.errors?.map((error: { message?: string }) => error.message).join('; '),
    ).toBe(true);
    expect(result.governance).toEqual({
      workflowCanApproveGitHubReview: false,
      workflowCanMergePullRequest: false,
      githubHumanApprovalRequired: true,
      writesGitHubObjects: false,
      writesMain: false,
    });
  });

  it('returns a static six-phase preview without invoking an agent', async () => {
    const workflow = await loadProjectWorkflow();
    const launcher: AgentLauncher = vi.fn(async () => {
      throw new Error('preview must not invoke agents');
    });

    const result = await executePreview(workflow, {
      manifest: workflow.meta,
      args: {},
      agentLauncher: launcher,
      budget: { tokens: 10000, costUsd: 0 },
    });

    expect(launcher).not.toHaveBeenCalled();
    expect((result.phases as Array<{ title: string }>).map((phase) => phase.title)).toEqual([
      'Intake',
      'Discover',
      'Select',
      'Design',
      'Validate',
      'Deliver',
    ]);
    expect(result.roles).toEqual(DEMO_ROLE_IDS);
    expect(result.artifactFiles).toEqual(DEMO_ARTIFACT_FILES);
    expect(result.budgetContract).toEqual({
      maxAgents: 8,
      maxConcurrency: 2,
      tokenBudget: 64000,
      onExceeded: 'fail',
      plannedAgentCalls: 8,
    });
    expect(result.budget).toMatchObject({ agentCalls: 0, tokensUsed: 0 });
  });

  it('completes dry-run with a schema-compatible result and no agent or external effect', async () => {
    const workflow = await loadProjectWorkflow();
    const launcher: AgentLauncher = vi.fn(async () => {
      throw new Error('dry-run must not invoke agents');
    });
    const result = await executeDryRun(workflow, {
      manifest: workflow.meta,
      args: {},
      agentLauncher: launcher,
    });
    const workflowResultSchema = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, 'examples/ai-organization-demo/schemas/workflow-result.schema.json'),
        'utf8',
      ),
    );
    const validateResult = new Ajv2020({ strict: false }).compile(workflowResultSchema);

    expect(launcher).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
    expect(result.simulatedEffects).toEqual([]);
    expect(validateResult(result.result), JSON.stringify(validateResult.errors)).toBe(true);
    expect(
      (result.result?.artifacts as Array<{ filename: string }>).map(({ filename }) => filename),
    ).toEqual(DEMO_ARTIFACT_FILES);
  });

  it.each([
    ['bearer token', 'Bearer abcdefghijklmnop'],
    ['basic token', 'Basic YWxhZGRpbjpvcGVuc2VzYW1l'],
    ['API key', 'api_key=super-secret-value'],
    ['cookie', 'cookie: session=super-secret-value'],
    ['GitHub classic token', 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'],
    ['GitHub fine-grained token', 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890'],
    ['Slack token', 'xoxb-123456789012-abcdefghijklmnop'],
    ['private key', '-----BEGIN PRIVATE KEY-----\nnot-a-real-key'],
    ['encrypted private key', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nnot-a-real-key'],
    ['password', 'password=not-a-real-password'],
    ['quoted password', '"password": "not-a-real-password"'],
    ['passwd', 'passwd: not-a-real-password'],
    ['client secret', 'client_secret=not-a-real-secret'],
  ])(
    'blocks %s before a result can be synthesized',
    async (_label: string, sensitiveValue: string) => {
      const workflow = await loadProjectWorkflow();
      const launcher: AgentLauncher = vi.fn(
        async (_prompt: string, options: Parameters<AgentLauncher>[1]) => {
          const fixture = structuredClone(loadAgentFixture(String(options.agentType))) as Record<
            string,
            unknown
          >;
          if (options.label === 'intake:business-context') {
            fixture.executiveContext = sensitiveValue;
          }
          return { data: fixture, tokenUsage: 100 };
        },
      );
      const runtime = createRuntime({
        runId: 'demo-sensitive-result',
        mode: 'execute',
        manifest: workflow.meta,
        budget: { tokens: 64000, costUsd: 1 },
        agentLauncher: launcher,
        onConfirm: async () => false,
      });

      await expect(workflow.run!(runtime, {})).rejects.toThrow(/blocked|credential/i);
    },
  );

  it('rejects extra fields and oversized strings before synthesis', async () => {
    const workflow = await loadProjectWorkflow();
    const invalidValues = [{ unexpected: true }, { executiveContext: 'x'.repeat(8_001) }];

    for (const invalidValue of invalidValues) {
      const launcher: AgentLauncher = vi.fn(
        async (_prompt: string, options: Parameters<AgentLauncher>[1]) => {
          const fixture = structuredClone(loadAgentFixture(String(options.agentType))) as Record<
            string,
            unknown
          >;
          if (options.label === 'intake:business-context') Object.assign(fixture, invalidValue);
          return { data: fixture, tokenUsage: 100 };
        },
      );
      const runtime = createRuntime({
        runId: 'demo-closed-result',
        mode: 'execute',
        manifest: workflow.meta,
        budget: { tokens: 64000, costUsd: 1 },
        agentLauncher: launcher,
        onConfirm: async () => false,
      });

      await expect(workflow.run!(runtime, {})).rejects.toThrow(
        /additional property is not allowed|exceeds 8000/,
      );
    }
  });

  it.each([
    ['AWS secret', { objective: 'AWS_SECRET_ACCESS_KEY=not-a-real-secret' }],
    ['OpenSlack secret', { organization: 'OPENSLACK_VENDOR_SECRET=not-a-real-secret' }],
  ])(
    'rejects %s in workflow input before preview or execute can construct an agent prompt',
    async (secretName: string, args: Record<string, unknown>) => {
      const workflow = await loadProjectWorkflow();
      const launcher: AgentLauncher = vi.fn(async () => {
        throw new Error('secret-bearing input must not reach an agent prompt');
      });

      await expect(
        executePreview(workflow, {
          manifest: workflow.meta,
          args,
          agentLauncher: launcher,
          budget: { tokens: 10000, costUsd: 0 },
        }),
      ).rejects.toThrow(secretName);

      const runtime = createRuntime({
        runId: 'demo-sensitive-input',
        mode: 'execute',
        manifest: workflow.meta,
        budget: { tokens: 64000, costUsd: 1 },
        agentLauncher: launcher,
        onConfirm: async () => false,
      });
      await expect(workflow.run!(runtime, args)).rejects.toThrow(secretName);
      expect(launcher).not.toHaveBeenCalled();
    },
  );

  it('fails closed in Validate when risk review decides stop and never invokes delivery', async () => {
    const workflow = await loadProjectWorkflow();
    const roles: string[] = [];
    const launcher: AgentLauncher = vi.fn(
      async (_prompt: string, options: Parameters<AgentLauncher>[1]) => {
        const fixture = structuredClone(loadAgentFixture(String(options.agentType))) as Record<
          string,
          unknown
        >;
        roles.push(String(options.agentType));
        if (options.label === 'validate:risk-review') {
          fixture.decision = 'stop';
        }
        return { data: fixture, tokenUsage: 100 };
      },
    );
    const runtime = createRuntime({
      runId: 'demo-risk-stop',
      mode: 'execute',
      manifest: workflow.meta,
      budget: { tokens: 64000, costUsd: 1 },
      agentLauncher: launcher,
      onConfirm: async () => false,
    });
    const phase = vi.spyOn(runtime, 'phase');
    const log = vi.spyOn(runtime, 'log');
    const terminalReason =
      'Workflow blocked: status=failed; phase=Validate; decision=stop; ' +
      'reason=risk_review_stop; delivery=not_started; ' +
      'agent=delivery-planner-agent:not_invoked; ' +
      'evidenceRefs=fixture:risk-workshop-01, repo:docs/security/human-approval.md';

    await expect(workflow.run!(runtime, {})).rejects.toThrow(terminalReason);
    expect(roles).toContain('risk-reviewer-agent');
    expect(roles).not.toContain('delivery-planner-agent');
    expect(phase).toHaveBeenLastCalledWith('Validate');
    expect(phase).not.toHaveBeenCalledWith('Deliver');
    expect(log).toHaveBeenCalledWith(terminalReason);
  });

  it('rejects scenarios longer than the fixed 90-day boundary before any agent call', async () => {
    const workflow = await loadProjectWorkflow();
    const launcher: AgentLauncher = vi.fn();
    const runtime = createRuntime({
      runId: 'demo-invalid-duration',
      mode: 'execute',
      manifest: workflow.meta,
      agentLauncher: launcher,
      onConfirm: async () => false,
    });

    await expect(workflow.run!(runtime, { durationDays: 91 })).rejects.toThrow(
      'durationDays must be an integer from 1 through 90',
    );
    expect(launcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ duratonDays: 30 }, /Unknown workflow input keys: duratonDays/],
    [{ durationDays: '30' }, /durationDays must be a number/],
    [{ budgetCny: '500000' }, /budgetCny must be a number/],
    [{ budgetCny: 500000.5 }, /budgetCny must be a positive integer/],
    [{ organization: 42 }, /organization must be a string/],
    [{ objective: false }, /objective must be a string/],
  ])(
    'rejects unknown or coercible input %# before any agent call',
    async (args: Record<string, unknown>, message: RegExp) => {
      const workflow = await loadProjectWorkflow();
      const launcher: AgentLauncher = vi.fn();
      const runtime = createRuntime({
        runId: 'demo-invalid-input-shape',
        mode: 'execute',
        manifest: workflow.meta,
        agentLauncher: launcher,
        onConfirm: async () => false,
      });

      await expect(workflow.run!(runtime, args)).rejects.toThrow(message);
      expect(launcher).not.toHaveBeenCalled();
    },
  );
});
