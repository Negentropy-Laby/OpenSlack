import { describe, expect, it, vi } from 'vitest';
import { canonicalWorkflowControlJson } from '../workflow-control-contract.js';
import {
  WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
  prepareWorkflowControlShadowRequest,
} from '../workflow-control-shadow.js';
import {
  WorkflowControlShadowHttpError,
  createWorkflowControlShadowHttpPublisher,
} from '../workflow-control-shadow-http.js';
import { acceptedReceipt, shadowEnvelope } from './workflow-control-shadow-fixtures.js';

function response(value: unknown, status = 201): Response {
  return new Response(`${canonicalWorkflowControlJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

describe('Workflow Control GS7-B HTTP publisher', () => {
  it('posts exact canonical bytes and strict idempotency to the frozen route', async () => {
    const envelope = shadowEnvelope();
    const expected = prepareWorkflowControlShadowRequest(envelope);
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(String(_input)).toBe('http://127.0.0.1:7878/v1/shadow/workflow-control/observations');
      expect(init?.body).toBe(expected.body);
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(expected.idempotencyKey);
      return response(acceptedReceipt());
    });
    const publisher = createWorkflowControlShadowHttpPublisher({
      origin: 'http://127.0.0.1:7878',
      fetch: transport,
    });
    await expect(publisher.publish(envelope)).resolves.toMatchObject({
      status: 'accepted',
      parity: 'matched',
      sourceSequence: 1,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects DNS, redirects, and a canonical receipt with drifted binding', async () => {
    expect(() =>
      createWorkflowControlShadowHttpPublisher({ origin: 'http://localhost:7878' }),
    ).toThrow(WorkflowControlShadowHttpError);
    const envelope = shadowEnvelope();
    const drifted = {
      ...acceptedReceipt(),
      schema: WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
      runId: 'run-other',
    };
    const publisher = createWorkflowControlShadowHttpPublisher({
      origin: 'http://127.0.0.1:7878',
      fetch: async () => response(drifted),
    });
    await expect(publisher.publish(envelope)).rejects.toMatchObject({
      code: 'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
    });
    const redirect = createWorkflowControlShadowHttpPublisher({
      origin: 'http://127.0.0.1:7878',
      fetch: async () => new Response(null, { status: 307 }),
    });
    await expect(redirect.publish(envelope)).rejects.toMatchObject({
      code: 'WORKFLOW_CONTROL_SHADOW_HTTP_ERROR',
    });
  });
});
