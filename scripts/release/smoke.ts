import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { findExecutable, parseArg, run, type ReleaseTarget, TARGETS } from './lib.js';

export interface ArtifactSmokeResult {
  target: ReleaseTarget;
  version: string;
  commit: string;
  checks: string[];
}

export function smokeBundle(bundleDir: string, target: ReleaseTarget): ArtifactSmokeResult {
  const definition = TARGETS[target];
  const executable = join(bundleDir, definition.executable);
  const buildInfo = JSON.parse(readFileSync(join(bundleDir, 'build-info.json'), 'utf-8')) as {
    version: string;
    commit: string;
    target: string;
  };
  const git = findExecutable('git');
  const workspace = mkdtempSync(join(tmpdir(), 'OpenSlack Artifact Smoke 空格-'));
  const checks: string[] = [];
  try {
    run(git, ['init', '-q', workspace]);
    const env = artifactEnvironment(dirname(git));
    const version = run(executable, ['version', '--format', 'json'], { cwd: workspace, env });
    const actual = JSON.parse(version.stdout) as typeof buildInfo;
    if (
      actual.version !== buildInfo.version ||
      actual.commit !== buildInfo.commit ||
      actual.target !== buildInfo.target
    ) {
      throw new Error('Executable build info does not match build-info.json.');
    }
    checks.push('version');

    run(
      executable,
      [
        'init',
        '--root',
        workspace,
        '--name',
        'Artifact Smoke',
        '--repo',
        'acme/artifact-smoke',
        '--apply',
      ],
      { cwd: workspace, env },
    );
    run(executable, ['workspace', 'validate'], { cwd: workspace, env });
    checks.push('workspace-init-validate');

    const workflowList = run(executable, ['collaboration', 'workflow', 'list'], {
      cwd: workspace,
      env,
    }).stdout;
    if (!workflowList.includes('profile-sync') || !workflowList.includes('bugfix')) {
      throw new Error('Packaged workflow assets were not discovered.');
    }
    run(executable, ['collaboration', 'workflow', 'show', 'profile-sync'], {
      cwd: workspace,
      env,
    });
    checks.push('builtin-workflows');

    const externalWorkflow = join(workspace, '.openslack', 'workflows', 'artifact-smoke.ts');
    writeFileSync(
      externalWorkflow,
      [
        "export const meta = { name: 'artifact-smoke', description: 'External workflow smoke', phases: [{ title: 'Inspect', detail: 'Read-only smoke' }], permissions: {}, risk: 'low' }",
        "export async function preview() { return { status: 'preview', summary: 'ok' } }",
      ].join('\n'),
      'utf-8',
    );
    run(executable, ['collaboration', 'workflow', 'show', 'artifact-smoke'], {
      cwd: workspace,
      env,
    });
    checks.push('external-workflow-discovery');

    const tui = run(executable, ['tui', 'doctor'], { cwd: workspace, env }).stdout;
    if (!tui.includes('TUI Terminal Diagnostics')) throw new Error('Packaged TUI did not load.');
    checks.push('tui-load');

    const doctor = run(executable, ['doctor'], {
      cwd: workspace,
      env,
      allowFailure: true,
    });
    const doctorOutput = `${doctor.stdout}\n${doctor.stderr}`;
    if (!doctorOutput.includes('[PASS] OS keychain backend:')) {
      throw new Error('Packaged native keychain binding is unavailable.');
    }
    if (!doctorOutput.includes('openslack agent-runtime setup openai-compatible')) {
      throw new Error('Doctor did not provide standalone provider guidance.');
    }
    checks.push('keychain-binding-provider-guidance');

    const combined = [version.stdout, workflowList, tui, doctorOutput].join('\n');
    const forbidden = ['apps/cli/src', 'scripts/genesis-validate.sh', resolve(process.cwd())];
    if (forbidden.some((value) => combined.includes(value))) {
      throw new Error('Packaged output leaked a source-checkout path.');
    }
    checks.push('source-independence');
    return { target, version: actual.version, commit: actual.commit, checks };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function artifactEnvironment(gitDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: gitDir };
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

if (import.meta.main) {
  const bundle = parseArg('--bundle');
  const target = parseArg('--target') as ReleaseTarget | undefined;
  if (!bundle || !target || !TARGETS[target]) {
    throw new Error('Usage: bun scripts/release/smoke.ts --bundle <dir> --target <target>');
  }
  console.log(JSON.stringify(smokeBundle(resolve(bundle), target), null, 2));
}
