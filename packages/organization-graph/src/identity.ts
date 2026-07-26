import { createHash } from 'node:crypto';
import type { AuthorityRef } from './types.js';

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function authorityIdentity(
  value: Pick<AuthorityRef, 'provider' | 'objectType' | 'objectId'>,
): Pick<AuthorityRef, 'provider' | 'objectType' | 'objectId'> {
  return {
    objectId: value.objectId,
    objectType: value.objectType,
    provider: value.provider,
  };
}

export function deriveGraphNodeId(input: {
  scenarioInstanceId: string;
  type: string;
  authorityRef: Pick<AuthorityRef, 'provider' | 'objectType' | 'objectId'>;
}): string {
  return `node:sha256:${sha256({
    authority: authorityIdentity(input.authorityRef),
    scenarioInstanceId: input.scenarioInstanceId,
    type: input.type,
  })}`;
}

export function deriveGraphEdgeId(input: {
  scenarioInstanceId: string;
  type: string;
  from: string;
  to: string;
  authorityRef?: Pick<AuthorityRef, 'provider' | 'objectType' | 'objectId'>;
}): string {
  return `edge:sha256:${sha256({
    ...(input.authorityRef === undefined
      ? {}
      : { authority: authorityIdentity(input.authorityRef) }),
    from: input.from,
    scenarioInstanceId: input.scenarioInstanceId,
    to: input.to,
    type: input.type,
  })}`;
}
