import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  OPENSLACK_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
} from '../../../packages/qoder-adapter/src/index.js';
import {
  cleanupHumanQualificationWorkspace,
  createHumanQualificationWorkspace,
  HUMAN_ATTESTED_QUALIFICATION_AGENT,
  HUMAN_ATTESTED_QUALIFICATION_CLAIM,
  HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL,
  HUMAN_ATTESTED_QUALIFICATION_SCHEMA,
  humanQualificationRegistryYaml,
  validateHumanAttestedReceipt,
  type HumanAttestedQualificationReceipt,
} from '../human-attested.js';

function receipt(): HumanAttestedQualificationReceipt {
  return {
    schema: HUMAN_ATTESTED_QUALIFICATION_SCHEMA,
    status: 'completed',
    claim: HUMAN_ATTESTED_QUALIFICATION_CLAIM,
    candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    profile: {
      toolCount: 17,
      toolNames: [...OPENSLACK_READ_TOOL_NAMES, ...OPENSLACK_MUTATION_TOOL_NAMES],
    },
    principal: {
      agentRef: HUMAN_ATTESTED_QUALIFICATION_AGENT,
      humanPrincipalId: HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL,
      osSubjectProvider: 'windows_os_subject',
    },
    transport: { mcp: 'stdio', humanAttestation: 'CON', separated: true },
    decision: {
      runId: 'run-qoder-human-attested-qualification',
      approvalId: 'approval-qoder-human-attested-synthetic-effect',
      correlationId: 'correlation-qoder-human-attested-qualification',
      value: 'approved',
      reasonHash: createHash('sha256').update('reason').digest('hex'),
      revisionBefore: 0,
      revisionAfter: 2,
      auditProjection: 'recorded',
      auditEventId: `WFAPPROVAL-AUDIT-${'c'.repeat(64)}`,
    },
    cleanup: {
      temporaryWorkspace: 'removed',
      subjectMapping: 'removed',
      approvalStore: 'removed',
    },
    completedAt: '2026-07-29T00:00:00.000Z',
  };
}

describe('human-attested qualification harness', () => {
  it('creates a temporary agent with only the two reviewed actions and no live authority', () => {
    const registry = YAML.parse(humanQualificationRegistryYaml()) as {
      agent_id: string;
      permissions: {
        actions: Record<string, string>;
        github: Record<string, boolean>;
      };
    };

    expect(registry.agent_id).toBe(HUMAN_ATTESTED_QUALIFICATION_AGENT);
    expect(registry.permissions.actions).toEqual({
      'scenario.instantiate': 'allow',
      'openslack.collaboration.recordEvent': 'allow',
    });
    expect(Object.values(registry.permissions.github)).toEqual([false, false, false, false]);
    expect(humanQualificationRegistryYaml()).not.toMatch(
      /^    (?:github\.pr\.(?:approve|merge)|shell(?:\.run)?|notification(?:\.|:)|policy\.|registry\.)/im,
    );
  });

  it('rejects a forged stdin TTY, a different human principal, and an unrecorded audit', () => {
    expect(() =>
      validateHumanAttestedReceipt({
        ...receipt(),
        transport: { mcp: 'stdio', humanAttestation: 'stdin', separated: true },
      }),
    ).toThrow(/closed contract/);
    expect(() =>
      validateHumanAttestedReceipt({
        ...receipt(),
        principal: { ...receipt().principal, humanPrincipalId: 'human:other' },
      }),
    ).toThrow(/closed contract/);
    expect(() =>
      validateHumanAttestedReceipt({
        ...receipt(),
        decision: { ...receipt().decision, auditProjection: 'pending' },
      }),
    ).toThrow(/closed contract/);
  });

  it('removes the temporary workspace, subject mapping, and approval-store stand-ins', () => {
    const root = createHumanQualificationWorkspace();
    mkdirSync(resolve(root, '.openslack.local', 'human-attestation'), { recursive: true });
    writeFileSync(
      resolve(root, '.openslack.local', 'human-attestation', 'human-subjects.json'),
      '{}',
    );
    mkdirSync(resolve(root, '.openslack.local', 'workflow-effect-approvals'), {
      recursive: true,
    });
    expect(existsSync(root)).toBe(true);

    cleanupHumanQualificationWorkspace(root);

    expect(existsSync(root)).toBe(false);
  });

  it('keeps the production STDIO server on real composition and away from test/stdio attestation', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'human-attested-server.ts'),
      'utf8',
    );
    const cli = readFileSync(resolve(import.meta.dirname, '..', 'human-attested-cli.ts'), 'utf8');

    expect(source).toContain('createOpenSlackHumanAttestedMcpComposition');
    expect(source).toContain('createOpenSlackMcpServer');
    expect(source).not.toMatch(/ForTest|issueHumanDecisionBinding|process\.stdin|readline/i);
    expect(cli).toContain('runProductionHumanAttestedQualification');
    expect(cli).not.toMatch(/ForTest|process\.stdin|issueHumanDecisionBinding/i);
  });
});
