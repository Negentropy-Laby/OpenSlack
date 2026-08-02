import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('QW2 MCP source boundary', () => {
  it('uses the official stdio SDK and reserves stdout for protocol frames', () => {
    const server = readFileSync(join(sourceRoot, 'server.ts'), 'utf8');
    const index = readFileSync(join(sourceRoot, 'index.ts'), 'utf8');
    const combined = `${server}\n${index}`;

    expect(server).toContain('@modelcontextprotocol/sdk/server/stdio.js');
    expect(combined).not.toContain('console.log');
    expect(combined).not.toMatch(/createServer|listen\s*\(/);
  });

  it('does not import CLI internals or expose shell/command passthrough', () => {
    const files = [
      'context.ts',
      'core.ts',
      'contract-delivery-rehearsal.ts',
      'graph-read-mirror.ts',
      'graph-read-canary.ts',
      'governed-composition.ts',
      'mutations.ts',
      'workflow-approvals.ts',
      'server.ts',
      'index.ts',
      'tools/index.ts',
      'tools/mutations.ts',
      'tools/workflow-approvals.ts',
    ];
    const source = files.map((path) => readFileSync(join(sourceRoot, path), 'utf8')).join('\n');

    expect(source).not.toMatch(/apps\/cli|@openslack\/cli/);
    expect(source).not.toMatch(/child_process|execFile|spawn|run_shell|rawCommand/);
    expect(source).not.toMatch(/github\.approve|pr\.approve|direct_merge/);
  });

  it('keeps the governed mutation path isolated from legacy or dynamic executors', () => {
    const files = [
      'core.ts',
      'contract-delivery-rehearsal.ts',
      'governed-composition.ts',
      'mutations.ts',
      'workflow-approvals.ts',
      'tools/mutations.ts',
      'tools/workflow-approvals.ts',
    ];
    const source = files.map((path) => readFileSync(join(sourceRoot, path), 'utf8')).join('\n');

    expect(source).not.toMatch(
      /\b(?:child_process|executePlan|executeWorkflowTemplate|findWorkflow|loadWorkflow|resolvePendingApproval|RunStore|allowUnattended|mergeIfReady|execFile|spawn)\b/,
    );
    expect(source).not.toMatch(
      /(?:github\.pr\.approve|github\.pr\.merge|pr\.merge|ruleset\.bypass|run_shell|rawCommand)/,
    );
    expect(source).not.toMatch(
      /\b(?:issueHumanDecisionBinding|createWorkflowEffectDecisionAuthority)\b/,
    );
    expect(source).not.toMatch(
      /\b(?:createLocalHumanAttestationProvider|bindLocalHumanSubject|resolveProductionSubject)\b|local-human-attestation/,
    );
    expect(source).toContain('per-decision attestation');
    expect(source).toContain('reasonHash');
    expect(source).toContain('auditProjection');
  });

  it('builds the agent-bound composition only from reviewed resolvers and durable stores', () => {
    const source = readFileSync(join(sourceRoot, 'governed-composition.ts'), 'utf8');

    for (const required of [
      'resolveAgentPrincipal',
      'authorizeAgentAction',
      'loadScenarioPack',
      'previewScenario',
      'rehydrateScenarioInstantiationPlan',
      'LocalScenarioInstanceStore',
      'compileWorkflowStartPlan',
      'createContractDeliveryLiteWorkflowResolverEntry',
      'executeContractDeliveryLiteWorkflow',
      'createGovernedPlanCollaborationAuditSink',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toMatch(
      /\b(?:generateRuntimeIdentity|executePlan|executeWorkflowTemplate|findWorkflow|loadWorkflow|issueHumanDecisionBinding|createWorkflowEffectDecisionAuthority)\b/,
    );
    expect(source).not.toMatch(/apps\/cli|@openslack\/cli|node:child_process|execFile|spawn\s*\(/);
  });

  it('assembles rehearsal evidence before explicit sealed graph publication', () => {
    const source = readFileSync(join(sourceRoot, 'contract-delivery-rehearsal.ts'), 'utf8');

    for (const required of [
      'LocalGovernedPlanStore',
      'LocalScenarioInstanceStore',
      'createContractToDeliveryDemoSource',
      'validateContractToDeliverySourceSnapshot',
      'buildAndPublishGraphSnapshot',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toMatch(
      /\b(?:projectContractToDeliverySnapshot|projectSoftwareDeliverySnapshot|publishSnapshot|executePlan|executeWorkflowTemplate|loadWorkflow|RunStore|allowUnattended)\b/,
    );
    expect(source).not.toContain('__tests__/fixtures');
    expect(source).not.toMatch(/github\.pr\.(?:approve|merge)|shell\.run|command\.run/);
  });

  it('binds governed audit projection to one verified append descriptor', () => {
    const audit = readFileSync(join(sourceRoot, 'audit.ts'), 'utf8');
    const collaborationEvents = readFileSync(
      join(sourceRoot, '..', '..', '..', 'packages', 'collaboration', 'src', 'events.ts'),
      'utf8',
    );

    expect(audit).toContain('createBoundEventAppender');
    expect(audit).not.toMatch(/\bappendEvent\b/);
    expect(collaborationEvents).toContain('fsConstants.O_APPEND');
    expect(collaborationEvents).toContain('assertBoundEventTarget');
    expect(collaborationEvents).toContain('fsyncSync(descriptor)');
  });

  it('uses bounded read-model adapters instead of mutating or skip-invalid legacy stores', () => {
    const context = readFileSync(join(sourceRoot, 'context.ts'), 'utf8');
    const boundedRead = readFileSync(join(sourceRoot, 'bounded-read.ts'), 'utf8');

    expect(context).not.toMatch(/\b(?:readEvents|listHandoffs|listDecisions|readModules)\s*\(/);
    expect(context).not.toMatch(/\b(?:mkdirSync|writeFileSync|unlinkSync|renameSync)\b/);
    expect(context).toContain('readBoundedDirectoryFilesSync');
    expect(context).toContain('readBoundedJsonlFileSync');
    expect(boundedRead).toContain('opendirSync');
    expect(boundedRead).toContain('O_NOFOLLOW');
    expect(boundedRead).toContain('mtimeNs');
    expect(boundedRead).toContain('ctimeNs');
  });

  it('caps CODEOWNERS matching below the MCP read deadline budget', () => {
    const context = readFileSync(join(sourceRoot, 'context.ts'), 'utf8');

    expect(context).toMatch(/maxCodeownerMatchOperations:\s*50_000/);
  });
});
