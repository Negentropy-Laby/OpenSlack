/** Offline process-race fixture: never opens a provider transport. */
import {
  createWorkflowSendAdmissionPort,
  type SendCampaignBinding,
} from '../internal/workflow-send-admission.js';
const { root, b, digest } = JSON.parse(process.argv[2]!) as {
  root: string;
  b: SendCampaignBinding;
  digest: string;
};
let calls = 0;
try {
  const port = await createWorkflowSendAdmissionPort({
    root,
    bindingHash: digest,
    runId: b.runId,
    workspaceId: b.workspaceId,
    sourceHash: b.workflowSourceHash,
    workerHash: b.workerHash,
    route: b.route,
    purpose: 'initial',
    go: {
      reserve: async () => {
        calls++;
        return Object.freeze({
          reservationId: 'reservation.race',
          callId: 'call.race',
          authorizedTokens: '8192',
        });
      },
      settle: async () => {
        throw new Error('No transport was started.');
      },
    },
    goFrontier: async () => ({
      reservedCalls: String(calls),
      settledCalls: '0',
      settledTokens: '0',
    }),
    readGoSettlement: async () => null,
    noOpenGoReservations: async () => false,
    isDefiniteGoRejection: () => false,
  });
  await port.reserve({
    providerId: b.providerId,
    modelId: b.modelId,
    providerRunId: 'RUN-RACE',
    providerAttempt: '1',
    requestedTokens: '8192',
  });
  process.stdout.write(JSON.stringify({ status: 'RESERVED', calls }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ status: 'REFUSED', calls }) + '\n');
}
