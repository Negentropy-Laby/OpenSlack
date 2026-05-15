import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { classifyPaths } from '@openslack/policy';
import { classifySelfEvolutionPR, createRollbackTask, computeFitnessScore } from '@openslack/self-evolution';
import { ClaimBroker } from '@openslack/core';
import { validateWorkspace } from '@openslack/workspace-engine';
import { stringify } from 'yaml';
import type { EvalSuite, EvalResult, EvalCase } from './types.js';
import { loadGoldenSuite } from './suites/golden.js';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function evaluateAssertion(evalCase: EvalCase, assertion: { description: string; check: string }): { passed: boolean; detail: string } {
  const root = findRepoRoot();
  const check = assertion.check.trim();

  try {
    // file_exists(path) — check relative to repo root
    const fileMatch = check.match(/^file_exists\((.+)\)$/);
    if (fileMatch) {
      const filePath = fileMatch[1];
      const fullPath = join(root, filePath);
      const exists = existsSync(fullPath);
      return { passed: exists, detail: `${filePath}: ${exists ? 'exists' : 'not found'}` };
    }

    // command(cmd) — run shell command, with in-process dispatch for known openslack commands
    const cmdMatch = check.match(/^command\((.+)\)$/);
    if (cmdMatch) {
      const cmd = cmdMatch[1].trim();

      // In-process dispatch for known openslack commands
      if (cmd === 'openslack workspace validate') {
        const result = validateWorkspace(root);
        return { passed: result.valid, detail: `workspace validate: ${result.valid ? 'PASS' : result.errors.map((e) => e.message).join('; ')}` };
      }
      if (cmd === 'pnpm openslack workspace validate') {
        const result = validateWorkspace(root);
        return { passed: result.valid, detail: `workspace validate: ${result.valid ? 'PASS' : result.errors.map((e) => e.message).join('; ')}` };
      }

      // Generic shell command
      try {
        execSync(cmd, { cwd: root, stdio: 'pipe', timeout: 30000 });
        return { passed: true, detail: `command "${cmd}" succeeded` };
      } catch (e) {
        return { passed: false, detail: `command "${cmd}" failed: ${(e as Error).message.slice(0, 200)}` };
      }
    }

    // Zone-based assertions using changed_paths from setup
    if (evalCase.setup?.changed_paths) {
      const paths = evalCase.setup.changed_paths;

      // classify_pr_zone == <zone>
      const zoneMatch = check.match(/^(classify_pr_zone|risk_zone)\s*==\s*(\w+)$/);
      if (zoneMatch) {
        const zone = classifyPaths(paths);
        const expected = zoneMatch[2];
        return { passed: zone === expected, detail: `risk zone: ${zone} (expected ${expected})` };
      }

      // human_approval_required == true/false
      const humanMatch = check.match(/^human_approval_required\s*==\s*(true|false)$/);
      if (humanMatch) {
        const classification = classifySelfEvolutionPR(paths);
        const expected = humanMatch[1] === 'true';
        return { passed: classification.humanApprovalRequired === expected, detail: `human_approval_required: ${classification.humanApprovalRequired} (expected ${expected})` };
      }

      // auto_merge_allowed == true/false
      const autoMatch = check.match(/^auto_merge_allowed\s*==\s*(true|false)$/);
      if (autoMatch) {
        const classification = classifySelfEvolutionPR(paths);
        const expected = autoMatch[1] === 'true';
        return { passed: classification.autoMergeAllowed === expected, detail: `auto_merge_allowed: ${classification.autoMergeAllowed} (expected ${expected})` };
      }

      // merge_decision == deny/merge_queue/require_human/wait
      const mergeMatch = check.match(/^merge_decision\s*==\s*(\w+)$/);
      if (mergeMatch) {
        const classification = classifySelfEvolutionPR(paths);
        const expected = mergeMatch[1];
        const decision = classification.riskZone === 'black' ? 'deny' :
          classification.humanApprovalRequired ? 'require_human' :
          classification.autoMergeAllowed ? 'merge_queue' : 'wait';
        return { passed: decision === expected, detail: `merge_decision: ${decision} (expected ${expected})` };
      }
    }

    // Scenario-based assertions
    if (evalCase.scenario) {
      // EV-GOLDEN-004: Concurrent claim — real assertion using ClaimBroker
      const claimGrantedMatch = check.match(/^granted_claims\s*==\s*(\d+)$/);
      const claimDeniedMatch = check.match(/^denied_claims\s*==\s*(\d+)$/);
      if (claimGrantedMatch || claimDeniedMatch) {
        const broker = new ClaimBroker();
        const taskId = 'TASK-FAKE-001';
        broker.setTaskReady(taskId);
        let granted = 0;
        let denied = 0;
        for (let i = 0; i < 10; i++) {
          const r = broker.claimTask({ agentId: `agent-${i}`, taskId, capabilities: [] });
          if (r.claimStatus === 'granted') granted++;
          else denied++;
        }
        if (claimGrantedMatch) {
          const expected = parseInt(claimGrantedMatch[1], 10);
          return { passed: granted === expected, detail: `granted_claims: ${granted} (expected ${expected})` };
        }
        if (claimDeniedMatch) {
          const expected = parseInt(claimDeniedMatch[1], 10);
          return { passed: denied === expected, detail: `denied_claims: ${denied} (expected ${expected})` };
        }
      }
      // EV-GOLDEN-007: Regression → rollback — real assertion
      if (check === 'rollback_task_created == true' || check === 'revert_pr_proposed == true') {
        const taskId = createRollbackTask('EXP-FAKE-001');
        const fileExists = existsSync(join(findRepoRoot(), '.openslack', 'self', 'evolution_backlog', `${taskId}.yaml`));
        return { passed: fileExists, detail: `rollback task ${taskId} created` };
      }
    }

    return { passed: false, detail: `unknown check format: "${check}"` };
  } catch (err) {
    return { passed: false, detail: `error evaluating: ${(err as Error).message}` };
  }
}

function runEvalCase(evalCase: EvalCase): EvalResult {
  const details: string[] = [];
  let allPassed = true;

  for (const assertion of evalCase.assertions) {
    const result = evaluateAssertion(evalCase, assertion);
    const prefix = result.passed ? 'PASS' : 'FAIL';
    details.push(`${prefix}: ${assertion.description} — ${result.detail}`);
    if (!result.passed) allPassed = false;
  }

  return {
    caseId: evalCase.id,
    title: evalCase.title,
    passed: allPassed,
    details,
    onFailure: evalCase.onFailure,
  };
}

export function runEvalSuite(suite: EvalSuite): EvalResult[] {
  return suite.cases.map(runEvalCase);
}

export function runGoldenEval(): EvalResult[] {
  const suite = loadGoldenSuite();
  return runEvalSuite(suite);
}

export function generateScorecard(evalResults: EvalResult[]): string | null {
  const root = findRepoRoot();
  const checks: Record<string, { result: 'pass' | 'fail'; command: string }> = {};
  for (const r of evalResults) {
    checks[r.caseId] = { result: r.passed ? 'pass' : 'fail', command: `golden-eval:${r.caseId}` };
  }
  const score = computeFitnessScore({
    checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { ...v, result: v.result as 'pass' | 'fail' }])),
  });
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const scoreSeq = String(Date.now() % 1000000).padStart(6, '0');
  const scoreDir = join(root, '.openslack', 'self', 'scorecards', String(year), month);
  mkdirSync(scoreDir, { recursive: true });
  const scorePath = join(scoreDir, `SCORE-${year}-${scoreSeq}.yaml`);
  writeFileSync(scorePath, stringify({
    schema: 'openslack.fitness_score.v1',
    experiment_id: 'golden-eval',
    dimensions: score.dimensions,
    overall: score.overall,
    decision: score.decision,
    generated_at: now.toISOString(),
  }, { lineWidth: 120 }), 'utf-8');
  return scorePath;
}
