import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  explainGraph,
  projectSoftwareDeliverySnapshot,
  type SoftwareDeliveryCommitObservation,
  type SoftwareDeliveryRepositoryObservation,
} from '../index.js';
import { softwareDeliverySource } from './software-delivery-fixtures.js';

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

describe('software delivery repository-local rebuild', () => {
  it('explains bounded facts injected from the current repository without a network read', () => {
    const headSha = git('rev-parse', 'HEAD');
    const authoredAt = git('show', '-s', '--format=%aI', 'HEAD');
    const source = softwareDeliverySource();
    for (const batch of Object.values(source.sources)) {
      batch.items = [] as never;
      if (batch.status !== 'missing') batch.warningCodes = [];
    }
    source.cursor = `repository-${headSha}`;
    source.generatedAt = authoredAt;
    source.sources.repository.items = [
      {
        id: 'local-repository',
        authorityVersion: headSha,
        observationKind: 'local_store',
        observedAt: authoredAt,
        sourceEventIds: [`git-head:${headSha}`],
        evidenceRefs: [`git-object:${headSha}`],
        repositoryId: 'local-repository',
        fullName: 'local/openslack',
        defaultBranch: git('branch', '--show-current') || 'detached',
      },
    ] as SoftwareDeliveryRepositoryObservation[];
    source.sources.commits.items = [
      {
        id: `local-commit-${headSha}`,
        authorityVersion: headSha,
        observationKind: 'local_store',
        observedAt: authoredAt,
        sourceEventIds: [`git-head:${headSha}`],
        evidenceRefs: [`git-object:${headSha}`],
        repositoryId: 'local-repository',
        sha: headSha,
        issueIds: [],
        authoredAt,
      },
    ] as SoftwareDeliveryCommitObservation[];

    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;
    const commit = snapshot.nodes.find(
      (node) =>
        node.type === 'informational.commit_observation' && node.authorityRef.objectId === headSha,
    );
    expect(commit).toBeDefined();
    expect(
      explainGraph(snapshot, {
        scenarioInstanceId: source.scenarioInstanceId,
        targetId: commit!.id,
      }),
    ).toMatchObject({
      authorityRef: {
        provider: 'openslack',
        objectId: headSha,
        version: headSha,
      },
      evidenceRefs: [`git-object:${headSha}`],
      projectorVersion: 'openslack.software_delivery.v1',
    });
  });
});
