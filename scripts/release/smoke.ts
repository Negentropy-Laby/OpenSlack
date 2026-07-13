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
  const sourceRoot = resolve(process.cwd());
  if (readFileSync(executable).includes(Buffer.from(sourceRoot))) {
    throw new Error('Packaged executable embeds the source checkout path.');
  }
  const buildInfo = JSON.parse(readFileSync(join(bundleDir, 'build-info.json'), 'utf-8')) as {
    version: string;
    commit: string;
    target: string;
  };
  const git = findExecutable('git');
  const workspace = mkdtempSync(join(tmpdir(), 'OpenSlack Artifact Smoke 空格-'));
  const checks: string[] = [];
  try {
    const { root: workspaceRoot, env } = initializeSmokeRepository(workspace, git);
    const version = run(executable, ['version', '--format', 'json'], {
      cwd: workspaceRoot,
      env,
    });
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
        workspaceRoot,
        '--name',
        'Artifact Smoke',
        '--repo',
        'acme/artifact-smoke',
        '--apply',
      ],
      { cwd: workspaceRoot, env },
    );
    run(executable, ['workspace', 'validate'], { cwd: workspaceRoot, env });
    checks.push('workspace-init-validate');

    const workflowList = run(executable, ['collaboration', 'workflow', 'list'], {
      cwd: workspaceRoot,
      env,
    }).stdout;
    if (!workflowList.includes('profile-sync') || !workflowList.includes('bugfix')) {
      throw new Error('Packaged workflow assets were not discovered.');
    }
    run(executable, ['collaboration', 'workflow', 'show', 'profile-sync'], {
      cwd: workspaceRoot,
      env,
    });
    checks.push('builtin-workflows');

    const externalWorkflow = join(workspaceRoot, '.openslack', 'workflows', 'artifact-smoke.ts');
    writeFileSync(
      externalWorkflow,
      [
        "export const meta = { name: 'artifact-smoke', description: 'External workflow smoke', phases: [{ title: 'Inspect', detail: 'Read-only smoke' }], permissions: {}, risk: 'low' }",
        "export async function preview() { return { status: 'preview', summary: 'ok' } }",
      ].join('\n'),
      'utf-8',
    );
    run(executable, ['collaboration', 'workflow', 'show', 'artifact-smoke'], {
      cwd: workspaceRoot,
      env,
    });
    checks.push('external-workflow-discovery');

    const tui = run(executable, ['tui', 'doctor'], { cwd: workspaceRoot, env }).stdout;
    if (!tui.includes('TUI Terminal Diagnostics')) throw new Error('Packaged TUI did not load.');
    checks.push('tui-load');

    const doctor = run(executable, ['doctor'], {
      cwd: workspaceRoot,
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
    // Repository-relative evidence references are valid product metadata. Fail
    // only when output exposes the build checkout itself or a runtime-only
    // source script entrypoint.
    const forbidden = ['scripts/genesis-validate.sh', sourceRoot];
    if (forbidden.some((value) => combined.includes(value))) {
      throw new Error('Packaged output leaked a source-checkout path.');
    }
    checks.push('source-independence');
    return { target, version: actual.version, commit: actual.commit, checks };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function initializeSmokeRepository(
  workspace: string,
  git = findExecutable('git'),
): { root: string; env: NodeJS.ProcessEnv } {
  const env = artifactEnvironment(dirname(git));
  // Initialize and inspect the repository under the exact environment inherited
  // by the packaged executable. Git's reported root is authoritative on Windows,
  // where runner temp paths can differ in casing or canonical spelling.
  run(git, ['init', '-q', workspace], { env });
  const root = resolve(
    run(git, ['rev-parse', '--show-toplevel'], { cwd: workspace, env }).stdout.trim(),
  );
  return { root, env };
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
