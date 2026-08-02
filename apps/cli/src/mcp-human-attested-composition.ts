import {
  createGovernedPlanCollaborationAuditSink,
  createOpenSlackAgentBoundMutationComposition,
  createOpenSlackWorkflowApprovalAttestationPort,
  createOpenSlackWorkflowApprovalPort,
  type OpenSlackAgentBoundMutationComposition,
  type GovernedPlanAuthorityCompositionOptions,
  type OpenSlackWorkflowApprovalPort,
} from '@openslack/mcp';
import {
  createLocalHumanAttestationProvider,
  LocalWorkflowEffectApprovalStore,
} from '@openslack/workflows';

export interface CreateOpenSlackHumanAttestedMcpCompositionOptions {
  readonly workspaceRoot: string;
  readonly principalRef: string;
  readonly humanPrincipalAssertion: string;
  readonly workspaceIdAssertion?: string;
  readonly governanceAuthority?: GovernedPlanAuthorityCompositionOptions;
}

export interface OpenSlackHumanAttestedMcpComposition extends OpenSlackAgentBoundMutationComposition {
  readonly humanPrincipalId: string;
  readonly workflowApprovalAuthority: OpenSlackWorkflowApprovalPort;
  readonly workflowApprovalStoreRoot: string;
}

export async function createOpenSlackHumanAttestedMcpComposition(
  options: CreateOpenSlackHumanAttestedMcpCompositionOptions,
): Promise<OpenSlackHumanAttestedMcpComposition> {
  const agent = await createOpenSlackAgentBoundMutationComposition({
    workspaceRoot: options.workspaceRoot,
    principalRef: options.principalRef,
    provider: 'cli',
    ...(options.workspaceIdAssertion === undefined
      ? {}
      : { workspaceIdAssertion: options.workspaceIdAssertion }),
    ...(options.governanceAuthority === undefined
      ? {}
      : { governanceAuthority: options.governanceAuthority }),
  });
  const provider = createLocalHumanAttestationProvider({
    workspaceRoot: options.workspaceRoot,
    workspaceId: agent.authority.workspaceId,
    humanPrincipalAssertion: options.humanPrincipalAssertion,
  });
  const store = new LocalWorkflowEffectApprovalStore(
    provider.approvalStoreRoot,
    provider.authority,
  );
  const attestation = createOpenSlackWorkflowApprovalAttestationPort((request) =>
    provider.attest(request),
  );
  const workflowApprovalAuthority = createOpenSlackWorkflowApprovalPort({
    store,
    attestation,
    audit: createGovernedPlanCollaborationAuditSink(options.workspaceRoot),
  });
  return Object.freeze({
    ...agent,
    humanPrincipalId: provider.humanPrincipalId,
    workflowApprovalAuthority,
    workflowApprovalStoreRoot: provider.approvalStoreRoot,
  });
}
