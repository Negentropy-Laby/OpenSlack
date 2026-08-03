import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWorkflowControlShadowHttpPublisher } from '../../packages/workflows/src/workflow-control-shadow-http.js';
import {
  validateWorkflowControlShadowEnvelope,
  type WorkflowControlShadowEnvelope,
} from '../../packages/workflows/src/workflow-control-shadow.js';

const origin = process.env.OPENSLACK_GS7B_SHADOW_ORIGIN;
if (origin === undefined || origin.length === 0) {
  throw new Error('OPENSLACK_GS7B_SHADOW_ORIGIN is required.');
}

const bundle = JSON.parse(
  await readFile(
    resolve('packages/workflows/contracts/workflow-control-shadow/v1/golden-vectors.json'),
    'utf8',
  ),
) as { vectors?: Array<{ envelope?: unknown }> };
const goldenEnvelope = validateWorkflowControlShadowEnvelope(
  bundle.vectors?.[0]?.envelope,
) as WorkflowControlShadowEnvelope;
const envelope = validateWorkflowControlShadowEnvelope({
  ...goldenEnvelope,
  source: { ...goldenEnvelope.source, sourceSequence: 1 },
});
const publisher = createWorkflowControlShadowHttpPublisher({
  origin,
  timeoutMs: 10_000,
});
const receipt = await publisher.publish(envelope);
process.stdout.write(
  `${JSON.stringify({
    schema: 'openslack.gs7b_cross_language_qualification.v1',
    status: 'passed',
    receiptStatus: receipt.status,
    parity: receipt.parity,
    workspaceId: receipt.workspaceId,
    runId: receipt.runId,
    sourceSequence: receipt.sourceSequence,
    observationHash: receipt.observationHash,
  })}\n`,
);
