import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  OPENSLACK_MCP_RESULT_SCHEMA,
  OPENSLACK_MCP_RESULT_V2_SCHEMA,
  createBlockedMcpResult,
  createOpenSlackMcpResult,
  openSlackMcpResultV2JsonSchema,
  upgradeOpenSlackMcpResult,
  validateOpenSlackMcpResultV2,
} from '../index.js';

function nestedJson(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe('OpenSlack MCP result contract', () => {
  it('uses a bounded immutable v1 result', () => {
    const result = createOpenSlackMcpResult({
      summary: 'Executive overview ready.',
      data: { count: 1 },
      evidenceRefs: ['event:1', 'event:1'],
    });

    expect(result).toEqual({
      schema: OPENSLACK_MCP_RESULT_SCHEMA,
      status: 'completed',
      summary: 'Executive overview ready.',
      data: { count: 1 },
      governance: { risk: 'none', approvalRequired: false },
      nextActions: [],
      evidenceRefs: ['event:1'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.governance)).toBe(true);
  });

  it('makes missing projection capability an explicit blocker', () => {
    expect(
      createBlockedMcpResult('Outcomes unavailable.', 'OUTCOMES_READER_NOT_BOUND'),
    ).toMatchObject({
      status: 'blocked',
      governance: {
        risk: 'none',
        approvalRequired: false,
        blocker: 'OUTCOMES_READER_NOT_BOUND',
      },
    });
  });

  it('bounds identifiers, errors, evidence, summary, and next actions', () => {
    const result = createOpenSlackMcpResult({
      status: 'failed',
      summary: 's'.repeat(3_000),
      planId: 'p'.repeat(300),
      executionId: 'e'.repeat(300),
      error: { code: 'C'.repeat(200), message: 'm'.repeat(2_000) },
      evidenceRefs: Array.from({ length: 80 }, (_, index) => `event:${index}`),
      nextActions: Array.from({ length: 20 }, (_, index) => ({
        id: `next-${index}`,
        label: `Next ${index}`,
      })),
    });

    expect(result.summary.length).toBe(2_000);
    expect(result.planId).toHaveLength(160);
    expect(result.executionId).toHaveLength(160);
    expect(result.error?.code).toHaveLength(100);
    expect(result.error?.message).toHaveLength(1_000);
    expect(result.evidenceRefs).toHaveLength(50);
    expect(result.nextActions).toHaveLength(12);
  });

  it('upgrades a frozen v1 foundation result without changing business data semantics', () => {
    const v1 = createOpenSlackMcpResult({
      summary: 'Foundation projection ready.',
      data: { status: 'blocked', count: 2 },
      governance: { blocker: 'HUMAN_REVIEW_REQUIRED' },
      nextActions: [{ id: 'read-pr', label: 'Read PR', tool: 'openslack_get_pr_readiness' }],
      evidenceRefs: ['event:QW2-1'],
    });
    const v2 = upgradeOpenSlackMcpResult(v1, {
      correlationId: 'mcp:test-1',
      authority: {
        mode: 'projection',
        sources: ['openslack.foundation_fixture'],
        observedAt: '2026-07-27T00:00:00.000Z',
      },
    });

    expect(v2).toMatchObject({
      schema: OPENSLACK_MCP_RESULT_V2_SCHEMA,
      correlationId: 'mcp:test-1',
      status: v1.status,
      summary: v1.summary,
      data: v1.data,
      governance: v1.governance,
      evidenceRefs: v1.evidenceRefs,
      nextActions: [
        {
          id: 'read-pr',
          label: 'Read PR',
          tool: 'openslack_get_pr_readiness',
          requiresConfirmation: false,
        },
      ],
    });
    expect(validateOpenSlackMcpResultV2(v2)).toBe(true);
  });

  it('marks only host-selected next actions as confirmation and validates workflow approvals', () => {
    const v1 = createOpenSlackMcpResult({
      status: 'needs_confirmation',
      summary: 'A canonical plan is ready.',
      planId: 'plan-1',
      nextActions: [
        {
          id: 'confirm-plan',
          label: 'Confirm plan',
          tool: 'openslack_confirm_plan',
          arguments: { planId: 'plan-1' },
        },
        {
          id: 'cancel-plan',
          label: 'Cancel plan',
          tool: 'openslack_cancel_plan',
          arguments: { planId: 'plan-1' },
        },
      ],
    });
    const v2 = upgradeOpenSlackMcpResult(v1, {
      correlationId: 'mcp:mutation-1',
      authority: {
        mode: 'governed_mutation',
        sources: ['openslack.operator_governed_plan'],
        observedAt: '2026-07-27T00:00:00.000Z',
      },
      confirmationActionIds: ['confirm-plan'],
      approval: {
        approvalId: 'approval-1',
        kind: 'openslack_workflow_effect',
        expiresAt: '2026-07-27T00:05:00.000Z',
        risk: 'medium',
      },
    });

    expect(v2.nextActions.map((action) => action.requiresConfirmation)).toEqual([true, false]);
    expect(v2.approval).toEqual({
      approvalId: 'approval-1',
      kind: 'openslack_workflow_effect',
      expiresAt: '2026-07-27T00:05:00.000Z',
      risk: 'medium',
    });
    expect(validateOpenSlackMcpResultV2(v2)).toBe(true);
  });

  it('carries a one-time confirmation capability only on a bound mutation preview', () => {
    const result = upgradeOpenSlackMcpResult(
      createOpenSlackMcpResult({
        status: 'needs_confirmation',
        summary: 'A canonical plan is ready.',
        planId: 'GPLAN-12345678-1234-4123-8123-123456789abc',
        governance: {
          risk: 'medium',
          approvalRequired: true,
          approvalKind: 'openslack_confirm',
        },
        nextActions: [
          {
            id: 'confirm-plan',
            label: 'Confirm exact plan',
            tool: 'openslack_confirm_plan',
          },
        ],
      }),
      {
        correlationId: 'CORR-12345678-1234-4123-8123-123456789abc',
        authority: {
          mode: 'governed_mutation',
          sources: ['openslack.operator_governed_plan'],
          observedAt: '2026-07-27T00:00:00.000Z',
        },
        confirmationActionIds: ['confirm-plan'],
        planHash: 'a'.repeat(64),
        confirmationToken: 'b'.repeat(43),
      },
    );

    expect(result).toMatchObject({
      planHash: 'a'.repeat(64),
      confirmationToken: 'b'.repeat(43),
      nextActions: [{ requiresConfirmation: true }],
    });
    expect(validateOpenSlackMcpResultV2(result)).toBe(true);
    expect(
      validateOpenSlackMcpResultV2({
        ...result,
        authority: { ...result.authority, mode: 'projection' },
      }),
    ).toBe(false);
    expect(
      validateOpenSlackMcpResultV2({
        ...result,
        governance: { ...result.governance, approvalRequired: false },
      }),
    ).toBe(false);
  });

  it('rejects proxied confirmation and approval options before executing traps', () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          traps += 1;
          throw new Error('trap');
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error('trap');
        },
        ownKeys() {
          traps += 1;
          throw new Error('trap');
        },
      },
    );
    const base = {
      correlationId: 'mcp:mutation-2',
      authority: {
        mode: 'governed_mutation' as const,
        sources: ['openslack.operator_governed_plan'],
        observedAt: '2026-07-27T00:00:00.000Z',
      },
    };
    expect(() =>
      upgradeOpenSlackMcpResult(createOpenSlackMcpResult({ summary: 'ready' }), {
        ...base,
        confirmationActionIds: proxy as never,
      }),
    ).toThrow(/confirmationActionIds/);
    expect(() =>
      upgradeOpenSlackMcpResult(createOpenSlackMcpResult({ summary: 'ready' }), {
        ...base,
        approval: proxy as never,
      }),
    ).toThrow(/approval/);
    expect(traps).toBe(0);
  });

  it('rejects open, non-canonical, and accessor-bearing v2 values without invoking getters', () => {
    const valid = upgradeOpenSlackMcpResult(createOpenSlackMcpResult({ summary: 'ready' }), {
      correlationId: 'mcp:test-2',
      authority: {
        mode: 'projection',
        sources: ['openslack.fixture'],
        observedAt: '2026-07-27T00:00:00.000Z',
      },
    });
    expect(validateOpenSlackMcpResultV2({ ...valid, unknown: true })).toBe(false);
    expect(
      validateOpenSlackMcpResultV2({
        ...valid,
        authority: { ...valid.authority, observedAt: '2026-07-27' },
      }),
    ).toBe(false);
    let invoked = false;
    const accessor = Object.defineProperty({ ...valid }, 'summary', {
      enumerable: true,
      get() {
        invoked = true;
        return 'unsafe';
      },
    });
    expect(validateOpenSlackMcpResultV2(accessor)).toBe(false);
    expect(invoked).toBe(false);
    expect(OPENSLACK_MCP_RESULT_SCHEMA).toBe('openslack.mcp_result.v1');
  });

  it('rejects nested proxies before any proxy trap executes', () => {
    const valid = upgradeOpenSlackMcpResult(createOpenSlackMcpResult({ summary: 'ready' }), {
      correlationId: 'mcp:proxy-test',
      authority: {
        mode: 'projection',
        sources: ['openslack.fixture'],
        observedAt: '2026-07-27T00:00:00.000Z',
      },
    });
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          traps += 1;
          throw new Error('get trap executed');
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error('descriptor trap executed');
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error('prototype trap executed');
        },
        ownKeys() {
          traps += 1;
          throw new Error('ownKeys trap executed');
        },
      },
    );

    expect(validateOpenSlackMcpResultV2({ ...valid, data: { nested: proxy } })).toBe(false);
    expect(traps).toBe(0);
    expect(
      validateOpenSlackMcpResultV2({
        ...valid,
        nextActions: [
          {
            id: 'read',
            label: 'Read',
            requiresConfirmation: false,
            arguments: proxy,
          },
        ],
      }),
    ).toBe(false);
    expect(traps).toBe(0);
    expect(
      validateOpenSlackMcpResultV2({
        ...valid,
        nextActions: [
          {
            id: 'read',
            label: 'Read',
            requiresConfirmation: false,
            arguments: { nested: proxy },
          },
        ],
      }),
    ).toBe(false);
    expect(traps).toBe(0);
    const proxiedActions = new Proxy(valid.nextActions, {
      get() {
        traps += 1;
        throw new Error('array get trap executed');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('array prototype trap executed');
      },
    });
    expect(validateOpenSlackMcpResultV2({ ...valid, nextActions: proxiedActions })).toBe(false);
    expect(traps).toBe(0);
  });

  it('keeps the runtime v2 validator and JSON schema aligned for positive and negative samples', () => {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'mcp-result.v2.schema.json',
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    expect(openSlackMcpResultV2JsonSchema).toEqual(schema);
    expect(Object.isFrozen(openSlackMcpResultV2JsonSchema)).toBe(true);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajvFormats.default(ajv, { mode: 'full' });
    const validateSchema = ajv.compile(schema);
    const result = upgradeOpenSlackMcpResult(
      createOpenSlackMcpResult({
        summary: 'Schema parity.',
        data: { count: 1 },
        evidenceRefs: ['event:schema-1'],
      }),
      {
        correlationId: 'mcp:schema-1',
        authority: {
          mode: 'projection',
          sources: ['openslack.schema_fixture'],
          observedAt: '2026-07-27T00:00:00.000Z',
        },
      },
    );
    const actionResult = upgradeOpenSlackMcpResult(
      createOpenSlackMcpResult({
        summary: 'Action sample.',
        nextActions: [{ id: 'read', label: 'Read', arguments: { nested: [1, true] } }],
      }),
      {
        correlationId: 'mcp:schema-action',
        authority: {
          mode: 'projection',
          sources: ['openslack.schema_fixture'],
          observedAt: '2026-07-27T00:00:00.000Z',
        },
      },
    );
    const errorResult = upgradeOpenSlackMcpResult(
      createOpenSlackMcpResult({
        status: 'failed',
        summary: 'Error sample.',
        error: { code: 'FAILED', message: 'Failed safely.' },
      }),
      {
        correlationId: 'mcp:schema-error',
        authority: {
          mode: 'projection',
          sources: ['openslack.schema_fixture'],
          observedAt: '2026-07-27T00:00:00.000Z',
        },
      },
    );
    const previewResult = upgradeOpenSlackMcpResult(
      createOpenSlackMcpResult({
        status: 'needs_confirmation',
        summary: 'Preview sample.',
        planId: 'GPLAN-12345678-1234-4123-8123-123456789abc',
        governance: {
          approvalRequired: true,
          approvalKind: 'openslack_confirm',
          risk: 'medium',
        },
      }),
      {
        correlationId: 'CORR-12345678-1234-4123-8123-123456789abc',
        authority: {
          mode: 'governed_mutation',
          sources: ['openslack.operator_governed_plan'],
          observedAt: '2026-07-27T00:00:00.000Z',
        },
        planHash: 'a'.repeat(64),
        confirmationToken: 'b'.repeat(43),
      },
    );
    const samples: Array<{ name: string; value: unknown; valid: boolean }> = [
      { name: 'valid', value: result, valid: true },
      { name: 'valid mutation preview', value: previewResult, valid: true },
      {
        name: 'plan hash without plan id',
        value: { ...result, planHash: 'a'.repeat(64) },
        valid: false,
      },
      {
        name: 'confirmation token on projection',
        value: {
          ...result,
          planId: 'plan-1',
          planHash: 'a'.repeat(64),
          confirmationToken: 'b'.repeat(43),
        },
        valid: false,
      },
      { name: 'valid inert arguments', value: actionResult, valid: true },
      { name: 'maximum inert depth', value: { ...result, data: nestedJson(12) }, valid: true },
      {
        name: 'maximum object node width',
        value: {
          ...result,
          data: Object.fromEntries(
            Array.from({ length: 1_000 }, (_, index) => [`node${index}`, index]),
          ),
        },
        valid: true,
      },
      {
        name: 'valid versioned repository evidence',
        value: {
          ...result,
          evidenceRefs: [`repo:${'a'.repeat(374)}#annualValue@v1`],
        },
        valid: true,
      },
      {
        name: 'empty owner',
        value: { ...result, governance: { ...result.governance, owner: '' } },
        valid: false,
      },
      {
        name: 'summary control character',
        value: { ...result, summary: 'bad\nvalue' },
        valid: false,
      },
      {
        name: 'empty action id',
        value: {
          ...actionResult,
          nextActions: [{ ...actionResult.nextActions[0], id: '' }],
        },
        valid: false,
      },
      {
        name: 'empty error code',
        value: { ...errorResult, error: { ...errorResult.error, code: '' } },
        valid: false,
      },
      { name: 'empty plan id', value: { ...result, planId: '' }, valid: false },
      {
        name: 'non-canonical observedAt',
        value: {
          ...result,
          authority: { ...result.authority, observedAt: '2026-07-27T00:00:00Z' },
        },
        valid: false,
      },
      {
        name: 'extended-year observedAt',
        value: {
          ...result,
          authority: { ...result.authority, observedAt: '+010000-01-01T00:00:00.000Z' },
        },
        valid: false,
      },
      {
        name: 'semantically invalid canonical-shaped observedAt',
        value: {
          ...result,
          authority: { ...result.authority, observedAt: '2026-02-30T00:00:00.000Z' },
        },
        valid: false,
      },
      {
        name: 'non-canonical approval expiry',
        value: {
          ...result,
          approval: {
            approvalId: 'approval-1',
            kind: 'openslack_workflow_effect',
            expiresAt: '2026-07-27T00:00:00Z',
            risk: 'low',
          },
        },
        valid: false,
      },
      {
        name: 'over-depth inert data',
        value: { ...result, data: nestedJson(13) },
        valid: false,
      },
      {
        name: 'over-wide object nodes',
        value: {
          ...result,
          data: Object.fromEntries(
            Array.from({ length: 1_001 }, (_, index) => [`node${index}`, index]),
          ),
        },
        valid: false,
      },
      { name: 'untyped evidence', value: { ...result, evidenceRefs: ['not-typed'] }, valid: false },
      {
        name: 'unknown evidence type',
        value: { ...result, evidenceRefs: ['unknown:value'] },
        valid: false,
      },
      {
        name: 'short commit evidence',
        value: { ...result, evidenceRefs: ['commit:abc123'] },
        valid: false,
      },
      {
        name: 'traversing repository evidence',
        value: {
          ...result,
          evidenceRefs: ['repo:examples/../assumptions.yaml#annualValue@v1'],
        },
        valid: false,
      },
      {
        name: 'over-bound repository evidence path',
        value: {
          ...result,
          evidenceRefs: [`repo:${'a'.repeat(375)}#annualValue@v1`],
        },
        valid: false,
      },
      {
        name: 'non-inert arguments',
        value: {
          ...actionResult,
          nextActions: [
            {
              ...actionResult.nextActions[0],
              arguments: { nested: undefined },
            },
          ],
        },
        valid: false,
      },
    ];
    for (const sample of samples) {
      const schemaValid = validateSchema(sample.value);
      const runtimeValid = validateOpenSlackMcpResultV2(sample.value);
      expect(schemaValid, `${sample.name}: ${JSON.stringify(validateSchema.errors)}`).toBe(
        sample.valid,
      );
      expect(runtimeValid, sample.name).toBe(sample.valid);
      expect(runtimeValid, `${sample.name} runtime/schema parity`).toBe(schemaValid);
    }
  });
});
