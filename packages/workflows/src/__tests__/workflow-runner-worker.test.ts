import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowRunnerExecutionDescriptor } from '../workflow-runner-descriptor.js';
import { getEmbeddedBuiltin } from '../embedded-builtins.js';
import {
  createSealedWorkflowRunnerSourceLoader,
  loadWorkflowRunnerWorkerConfig,
  WorkflowRunnerWorkerConfigError,
} from '../workflow-runner-worker.js';
import {
  classifyWorkflowRunnerRunState,
  WorkflowRunnerRunStateError,
} from '../workflow-runner-run-state.js';
import type { WorkflowMeta } from '../types.js';

const roots: string[] = [];
const sourceBytes = Buffer.from('this is deliberately not valid JavaScript', 'utf8');
const manifest: WorkflowMeta = {
  name: 'sealed-test',
  version: '1.0.0',
  description: 'Sealed runner worker test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};

function shortWindowsPath(path: string): string {
  const output = execFileSync(
    'cmd.exe',
    ['/d', '/c', 'for %I in ("%OPENSLACK_TEST_LONG_PATH%") do @echo %~sI'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env: { ...process.env, OPENSLACK_TEST_LONG_PATH: path },
    },
  ).trim();
  const windowsPaths = output.match(/[A-Za-z]:\\[^"\r\n]*/gu);
  return resolve(windowsPaths?.sort((left, right) => right.length - left.length)[0] ?? output);
}

function descriptor(workflowSourceBytes: Uint8Array = sourceBytes, workflowRunId = 'run.worker.1') {
  return createWorkflowRunnerExecutionDescriptor({
    descriptorRef: 'descriptor.worker.1',
    workspaceId: 'workspace.test',
    workflowRunId,
    correlationId: 'correlation.worker.1',
    workflowId: 'sealed-test',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes,
    manifest,
    input: {},
    budget: { tokens: 1_000, costUsd: 1 },
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'test-actor',
      runId: workflowRunId,
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    createdAt: '2026-08-04T01:00:00.000Z',
    expiresAt: '2026-08-04T02:00:00.000Z',
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GS8-B workflow runner worker', () => {
  it('is default-off and requires a closed valid startup configuration', () => {
    expect(() => loadWorkflowRunnerWorkerConfig({})).toThrow(WorkflowRunnerWorkerConfigError);
    expect(() =>
      loadWorkflowRunnerWorkerConfig({ OPENSLACK_WORKFLOW_RUNNER_ENABLED: 'true' }),
    ).toThrowError(/explicit enablement/u);
  });

  it('confines the checkpoint shadow journal to the canonical local-state root', () => {
    const workspaceRoot = resolve('workflow-runner-config-workspace');
    const base = {
      OPENSLACK_WORKFLOW_RUNNER_ENABLED: '1',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID: 'workspace.test',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT: workspaceRoot,
      OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: join(workspaceRoot, 'descriptors'),
      OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH: 'a'.repeat(64),
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED: '1',
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT: 'http://127.0.0.1:8085',
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN: 'b'.repeat(32),
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID: 'runner.test',
    } satisfies NodeJS.ProcessEnv;

    expect(
      loadWorkflowRunnerWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT: join(
          workspaceRoot,
          '.openslack.local',
          'checkpoint-shadow',
        ),
      }).checkpointShadow?.journalRoot,
    ).toBe(join(workspaceRoot, '.openslack.local', 'checkpoint-shadow'));

    expect(() =>
      loadWorkflowRunnerWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT: join(
          workspaceRoot,
          'nested',
          '.openslack.local',
          'checkpoint-shadow',
        ),
      }),
    ).toThrowError(/workspace-local journal/u);
  });

  it('keeps the effect shadow default-off and confines its exact route and journal', () => {
    const workspaceRoot = resolve('workflow-runner-effect-shadow-workspace');
    const base = {
      OPENSLACK_WORKFLOW_RUNNER_ENABLED: '1',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID: 'workspace.test',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT: workspaceRoot,
      OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: join(workspaceRoot, 'descriptors'),
      OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH: 'a'.repeat(64),
    } satisfies NodeJS.ProcessEnv;
    const enabled = {
      ...base,
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED: '1',
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT:
        'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN: 'b'.repeat(32),
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_CALLER_ID: 'runner.test',
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT: join(
        workspaceRoot,
        '.openslack.local',
        'workflow-effect-shadow',
      ),
    } satisfies NodeJS.ProcessEnv;

    expect(loadWorkflowRunnerWorkerConfig(base).effectShadow).toBeUndefined();
    expect(loadWorkflowRunnerWorkerConfig(enabled).effectShadow).toMatchObject({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      journalRoot: join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow'),
    });
    expect(() =>
      loadWorkflowRunnerWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN: 'b'.repeat(32),
      }),
    ).toThrowError(/Disabled Workflow effect shadow configuration must be empty/u);
    for (const endpoint of [
      'https://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      'http://example.com:8084/v1/shadow/workflow-control/effect-events',
      'http://127.0.0.1:8084/v1/shadow/workflow-control/checkpoints',
      'http://user:pass@127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
    ]) {
      expect(() =>
        loadWorkflowRunnerWorkerConfig({
          ...enabled,
          OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT: endpoint,
        }),
      ).toThrowError(/exact loopback route/u);
    }
    expect(() =>
      loadWorkflowRunnerWorkerConfig({
        ...enabled,
        OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT: join(workspaceRoot, 'outside-local-state'),
      }),
    ).toThrowError(/workspace-local journal/u);
    for (const journalRoot of [
      join(workspaceRoot, '.openslack.local', 'workflows'),
      join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals', 'shadow'),
      join(workspaceRoot, '.openslack.local', 'workflows', 'effect-authority', 'shadow'),
    ]) {
      expect(() =>
        loadWorkflowRunnerWorkerConfig({
          ...enabled,
          OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT: journalRoot,
        }),
      ).toThrowError(/workspace-local journal/u);
    }
  });

  it('reads and hashes the sealed source during prepare without dynamically importing it', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    const sourcePath = join(sourceDirectory, 'sealed-test.js');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, sourceBytes);

    const loader = createSealedWorkflowRunnerSourceLoader(workspaceRoot);
    const prepared = await loader.prepare(descriptor());

    expect(prepared).toMatchObject({
      path: await realpath(sourcePath),
      bytes: sourceBytes,
    });
  });

  it('accepts a hash-bound reviewed builtin while project catalogs remain self-contained', async () => {
    const workflow = getEmbeddedBuiltin('openslack:builtin/profile-sync');
    expect(workflow).toBeDefined();
    const bytes = await readFile(join(import.meta.dirname, '..', 'builtins', 'profile-sync.ts'));
    const builtinDescriptor = createWorkflowRunnerExecutionDescriptor({
      descriptorRef: 'descriptor.worker.builtin',
      workspaceId: 'workspace.test',
      workflowRunId: 'run.worker.builtin',
      correlationId: 'correlation.worker.builtin',
      workflowId: workflow!.meta.name,
      workflowVersion: workflow!.meta.version ?? '0.0.0',
      workflowSource: 'builtin',
      workflowSourceBytes: bytes,
      manifest: workflow!.meta,
      input: {},
      budget: { tokens: 1_000, costUsd: 1 },
      confirmationPolicy: {
        mode: 'unattended-explicit',
        actorId: 'test-actor',
        runId: 'run.worker.builtin',
        allowUnattended: true,
        onUnexpectedEffect: 'fail',
      },
      createdAt: '2026-08-04T01:00:00.000Z',
      expiresAt: '2026-08-04T02:00:00.000Z',
    });

    await expect(
      createSealedWorkflowRunnerSourceLoader(resolve('.')).prepare(builtinDescriptor),
    ).resolves.toMatchObject({ bytes });
  });

  it('initializes only missing runs, resumes paused states, and rejects automatic replay', () => {
    expect(classifyWorkflowRunnerRunState('run.worker.1', false, null)).toBe('initialize');
    for (const status of ['paused', 'paused_waiting_approval', 'resuming'] as const) {
      expect(classifyWorkflowRunnerRunState('run.worker.1', true, status)).toBe('resume');
    }
    for (const status of ['running', 'completed', 'failed', 'cancelled'] as const) {
      expect(() => classifyWorkflowRunnerRunState('run.worker.1', true, status)).toThrowError(
        WorkflowRunnerRunStateError,
      );
    }
    expect(() => classifyWorkflowRunnerRunState('run.worker.1', true, null)).toThrow(
      /operator recovery/u,
    );
  });

  it('accepts a Windows 8.3 alias for the same non-reparse workflow catalog', async () => {
    if (process.platform !== 'win32') return;
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-long-worker-root-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'sealed-test.js'), sourceBytes);
    const shortRoot = shortWindowsPath(workspaceRoot);
    if (shortRoot.toUpperCase() === workspaceRoot.toUpperCase()) return;

    const prepared = await createSealedWorkflowRunnerSourceLoader(shortRoot).prepare(descriptor());
    expect(prepared).toMatchObject({
      path: join(await realpath(workspaceRoot), '.openslack', 'workflows', 'sealed-test.js'),
      bytes: sourceBytes,
    });
  }, 30_000);

  it.each([
    ['static import', 'import value from "./unbound.js";'],
    ['side-effect import', 'import "./unbound.js";'],
    ['type import', 'import type { Value } from "./unbound.js";'],
    ['dynamic import', 'const value = import("./unbound.js");'],
    ['comment-separated dynamic import', 'const value = import/* gap */("./unbound.js");'],
    ['require call', 'const value = require("./unbound.cjs");'],
    ['escaped require call', 'const value = requ\\u0069re("./unbound.cjs");'],
    ['export-from', 'export { value } from "./unbound.js";'],
    ['comment-separated export-from', 'export/* gap */{ value }/* gap */from "./unbound.js";'],
    ['star export-from', 'export * as values from "./unbound.js";'],
    ['template-expression import', 'const value = `${import("./unbound.js")}`;'],
    ['eval import string', 'eval("import(\\\"./unbound.js\\\")");'],
    ['Function import string', 'Function("return import(\\\"./unbound.js\\\")")();'],
    ['eval require string', 'eval("require(\\\"./unbound.cjs\\\")");'],
    ['Node builtin module loader', 'const fs = process.getBuiltinModule("node:fs");'],
    [
      'global Node builtin module loader',
      'const childProcess = globalThis.process.getBuiltinModule("node:child_process");',
    ],
    ['escaped Node builtin module loader', 'const fs = pro\\u0063ess.getBuiltinModule("node:fs");'],
  ])('rejects %s during prepare before lease acceptance', async (_name, source) => {
    const sourceBytes = Buffer.from(source, 'utf8');
    const { loader } = await sealedSourceLoader(sourceBytes);

    await expect(loader.prepare(descriptor(sourceBytes))).rejects.toThrow(
      /may not (?:contain static or dynamic imports|dynamically evaluate|reference (?:Node process or global module-loader surfaces|require)|re-export)/u,
    );
  });

  it('does not mistake comments, string/template bodies, regexes, or import.meta for imports', async () => {
    const inert = Buffer.from(
      [
        '// import value from "./comment.js"; require("./comment.cjs")',
        '/* export { value } from "./comment.js"; */',
        'const quoted = "import(\\\"./string.js\\\") require(\\\"./string.cjs\\\")";',
        'const templated = `export { value } from "./template.js"; import("./template.js")`;',
        'const pattern = /import\\(require\\(export from/gu;',
        'const location = import.meta.url;',
        `export const meta = ${JSON.stringify(manifest)};`,
        'export async function run() { return { status: "completed" }; }',
      ].join('\n'),
      'utf8',
    );
    const { loader, sourcePath } = await sealedSourceLoader(inert);

    await expect(loader.prepare(descriptor(inert))).resolves.toMatchObject({
      path: sourcePath,
      bytes: inert,
    });
  });

  it('rejects an ordinary workflow catalog below an ancestor reparse or symlink', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-ancestor-'));
    roots.push(parent);
    const target = join(parent, 'target');
    const targetWorkspace = join(target, 'workspace');
    const sourceDirectory = join(targetWorkspace, '.openslack', 'workflows');
    const alias = join(parent, 'alias');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'sealed-test.js'), sourceBytes);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const loader = createSealedWorkflowRunnerSourceLoader(join(alias, 'workspace'));
    await expect(loader.prepare(descriptor())).rejects.toThrow(
      /(?:reparse component|canonical and non-symlinked)/u,
    );
  });

  it('rejects a source replacement between prepare and post-receipt load', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    const sourcePath = join(sourceDirectory, 'sealed-test.js');
    await mkdir(sourceDirectory, { recursive: true });
    const first = workflowSource(1);
    await writeFile(sourcePath, first);

    const loader = createSealedWorkflowRunnerSourceLoader(workspaceRoot);
    const prepared = await loader.prepare(descriptor(first));
    await writeFile(sourcePath, workflowSource(2));

    await expect(loader.load(descriptor(first), prepared)).rejects.toThrow(
      'changed after lease acceptance',
    );
  });

  it('cache-busts ESM by full source hash across sequential source revisions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    const sourcePath = join(sourceDirectory, 'sealed-test.js');
    await mkdir(sourceDirectory, { recursive: true });
    const loader = createSealedWorkflowRunnerSourceLoader(workspaceRoot);

    const first = workflowSource(1);
    await writeFile(sourcePath, first);
    const firstDescriptor = descriptor(first);
    const firstWorkflow = await loader.load(firstDescriptor, await loader.prepare(firstDescriptor));
    expect(await firstWorkflow.run!({} as never, {})).toMatchObject({ revision: 1 });

    const second = workflowSource(2);
    await writeFile(sourcePath, second);
    const secondDescriptor = descriptor(second);
    const secondWorkflow = await loader.load(
      secondDescriptor,
      await loader.prepare(secondDescriptor),
    );
    expect(await secondWorkflow.run!({} as never, {})).toMatchObject({ revision: 2 });
  }, 15_000);
});

async function sealedSourceLoader(source: Uint8Array) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
  roots.push(workspaceRoot);
  const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
  const sourcePath = join(sourceDirectory, 'sealed-test.js');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(sourcePath, source);
  return {
    loader: createSealedWorkflowRunnerSourceLoader(workspaceRoot),
    sourcePath: await realpath(sourcePath),
  };
}

function workflowSource(revision: number): Buffer {
  return Buffer.from(
    `export const meta = ${JSON.stringify(manifest)};\n` +
      `export async function run() { return { status: "completed", revision: ${revision} }; }\n`,
    'utf8',
  );
}
