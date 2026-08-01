import { createBlockedMcpResult, type OpenSlackMcpResult } from '@openslack/qoder-adapter';
import {
  GraphReadCanaryError,
  type GraphExplainInput,
  type GraphQueryInput,
} from '@openslack/organization-graph';
import { ProjectionEvidenceUnavailableError, type OpenSlackMcpContext } from '../context.js';
import { completedProjection, numberArg, stringArg, stringArrayArg } from './shared.js';

function blocked(error: ProjectionEvidenceUnavailableError): OpenSlackMcpResult {
  return createBlockedMcpResult(error.message, error.code);
}

function blockedCanary(error: GraphReadCanaryError): OpenSlackMcpResult {
  return createBlockedMcpResult(
    'The explicitly selected Organization Graph read authority failed closed.',
    error.code,
  );
}

export async function listScenarios(context: OpenSlackMcpContext): Promise<OpenSlackMcpResult> {
  try {
    return completedProjection(
      'Locked OpenSlack Scenario Definitions are ready.',
      await context.readers.scenarios(),
    );
  } catch (error) {
    if (error instanceof ProjectionEvidenceUnavailableError) return blocked(error);
    throw error;
  }
}

export async function queryOrganizationGraph(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const rootNodeIds = stringArrayArg(input, 'rootNodeIds');
  const nodeTypes = stringArrayArg(input, 'nodeTypes');
  const edgeTypes = stringArrayArg(input, 'edgeTypes');
  const statuses = stringArrayArg(input, 'statuses');
  const query: GraphQueryInput = {
    scenarioInstanceId: stringArg(input, 'scenarioInstanceId')!,
    ...(rootNodeIds ? { rootNodeIds: [...rootNodeIds] } : {}),
    ...(nodeTypes ? { nodeTypes: [...nodeTypes] } : {}),
    ...(edgeTypes ? { edgeTypes: [...edgeTypes] } : {}),
    ...(statuses ? { statuses: [...statuses] } : {}),
    ...(stringArg(input, 'direction')
      ? { direction: stringArg(input, 'direction') as GraphQueryInput['direction'] }
      : {}),
    ...(input.depth === undefined ? {} : { depth: numberArg(input, 'depth', 1) }),
    ...(input.maxNodes === undefined ? {} : { maxNodes: numberArg(input, 'maxNodes', 200) }),
    ...(input.maxEdges === undefined ? {} : { maxEdges: numberArg(input, 'maxEdges', 500) }),
    ...(input.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: numberArg(input, 'maxResponseBytes', 512 * 1_024) }),
    ...(typeof input.includeEvidence === 'boolean'
      ? { includeEvidence: input.includeEvidence }
      : {}),
    ...(stringArg(input, 'cursor') ? { cursor: stringArg(input, 'cursor') } : {}),
  };
  try {
    return completedProjection(
      'The bounded current Organization Graph query is ready.',
      await context.readers.graphQuery(query),
    );
  } catch (error) {
    if (error instanceof ProjectionEvidenceUnavailableError) return blocked(error);
    if (error instanceof GraphReadCanaryError) return blockedCanary(error);
    throw error;
  }
}

export async function explainOrganizationGraph(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const explain: GraphExplainInput = {
    scenarioInstanceId: stringArg(input, 'scenarioInstanceId')!,
    targetId: stringArg(input, 'targetId')!,
    ...(stringArg(input, 'rootNodeId') ? { rootNodeId: stringArg(input, 'rootNodeId') } : {}),
    ...(stringArg(input, 'direction')
      ? { direction: stringArg(input, 'direction') as GraphExplainInput['direction'] }
      : {}),
    ...(input.depth === undefined ? {} : { depth: numberArg(input, 'depth', 3) }),
  };
  try {
    return completedProjection(
      'The bounded Organization Graph provenance explanation is ready.',
      await context.readers.graphExplain(explain),
    );
  } catch (error) {
    if (error instanceof ProjectionEvidenceUnavailableError) return blocked(error);
    if (error instanceof GraphReadCanaryError) return blockedCanary(error);
    throw error;
  }
}
