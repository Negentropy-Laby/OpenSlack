import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifestValidationResult, PluginManifestV1 } from '@openslack/plugin-api';
import { validatePluginManifest } from '@openslack/plugin-api';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCanonicalPluginSourceRef,
  loadPluginManifest,
  loadPluginManifestForTest,
  PluginManifestLoadError,
  PLUGIN_MANIFEST_MAX_BYTES,
  type PluginManifestSource,
  type PluginManifestValidator,
} from '../loader.js';

const temporaryRoots: string[] = [];
const noExecutionFixture = path.resolve(
  fileURLToPath(new URL('../__fixtures__/loader/no-execution/', import.meta.url)),
);

function manifest(id = 'safe-observer'): Record<string, unknown> {
  return {
    schema: 'openslack.plugin.v1',
    id,
    version: '1.0.0',
    name: 'Safe observer',
    requires: { openslack: '>=0.1.0 <1.0.0' },
    gate: { mode: 'SHADOW', gateId: 'host.read-only' },
    capabilities: ['host.actions.read'],
    contributes: [
      {
        kind: 'action_alias',
        id: 'status',
        target: { kind: 'host_action', id: 'status.show' },
      },
    ],
  };
}

function manifestBytes(value: Record<string, unknown> = manifest()): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

async function tempRoot(prefix = 'openslack-loader-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function createWorkspacePlugin(
  bytes: Buffer = manifestBytes(),
  id = 'safe-observer',
): Promise<{ readonly workspaceRoot: string; readonly manifestPath: string }> {
  const workspaceRoot = await tempRoot();
  const pluginDirectory = path.join(workspaceRoot, '.openslack', 'plugins', id);
  await mkdir(pluginDirectory, { recursive: true });
  const manifestPath = path.join(pluginDirectory, 'plugin.json');
  await writeFile(manifestPath, bytes);
  return { workspaceRoot, manifestPath };
}

function workspaceSource(workspaceRoot: string, pluginId = 'safe-observer'): PluginManifestSource {
  return { providerKind: 'workspace', workspaceRoot, pluginId };
}

async function expectLoadError(
  operation: Promise<unknown>,
  code: PluginManifestLoadError['code'],
): Promise<PluginManifestLoadError> {
  try {
    await operation;
    throw new Error('Expected plugin manifest loading to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestLoadError);
    expect((error as PluginManifestLoadError).code).toBe(code);
    return error as PluginManifestLoadError;
  }
}

function permissiveValidator(value: unknown): PluginManifestValidationResult {
  return { valid: true, manifest: value as PluginManifestV1, findings: [] };
}

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__OPENSLACK_PLUGIN_LOADER_EXECUTED__;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('loadPluginManifest', () => {
  it('loads only the fixed direct-child workspace plugin.json and hashes its exact bytes', async () => {
    const bytes = manifestBytes();
    const { workspaceRoot } = await createWorkspacePlugin(bytes);
    const loaded = await loadPluginManifest(workspaceSource(workspaceRoot), {
      validateManifest: validatePluginManifest,
    });

    expect(loaded).toMatchObject({
      providerKind: 'workspace',
      pluginId: 'safe-observer',
      sourceRef: '.openslack/plugins/safe-observer/plugin.json',
      gateMode: 'SHADOW',
      sizeBytes: bytes.length,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(loaded.manifest.id).toBe('safe-observer');
    expect(Object.getPrototypeOf(loaded.manifest)).toBeNull();
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.manifest)).toBe(true);
    expect(Object.isFrozen(loaded.manifest.gate)).toBe(true);
  });

  it('uses the installed entry provider kind and logical sourceRef without resolving package code', async () => {
    const loaded = await loadPluginManifest(
      {
        providerKind: 'plugin',
        installedRoot: noExecutionFixture,
        sourceRef: 'node_modules/no-execution/plugin.json',
        expectedPluginId: 'no-execution',
      },
      { validateManifest: validatePluginManifest },
    );

    expect(loaded.providerKind).toBe('plugin');
    expect(loaded.sourceRef).toBe('node_modules/no-execution/plugin.json');
    expect(
      (globalThis as Record<string, unknown>).__OPENSLACK_PLUGIN_LOADER_EXECUTED__,
    ).toBeUndefined();
  });

  it('does not import main, exports, entrypoint, or side-effect files', async () => {
    const packageText = await readFile(path.join(noExecutionFixture, 'package.json'), 'utf8');
    expect(packageText).toContain('index.js');
    await expect(
      loadPluginManifest(
        {
          providerKind: 'plugin',
          installedRoot: noExecutionFixture,
          sourceRef: 'node_modules/no-execution/plugin.json',
          expectedPluginId: 'no-execution',
        },
        { validateManifest: validatePluginManifest },
      ),
    ).resolves.toMatchObject({ pluginId: 'no-execution' });
    expect(
      (globalThis as Record<string, unknown>).__OPENSLACK_PLUGIN_LOADER_EXECUTED__,
    ).toBeUndefined();
  });

  it('makes byte-for-byte whitespace changes produce a different integrity hash', async () => {
    const compact = manifestBytes();
    const { workspaceRoot, manifestPath } = await createWorkspacePlugin(compact);
    const first = await loadPluginManifest(workspaceSource(workspaceRoot), {
      validateManifest: validatePluginManifest,
    });
    const pretty = Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    await writeFile(manifestPath, pretty);
    const second = await loadPluginManifest(workspaceSource(workspaceRoot), {
      validateManifest: validatePluginManifest,
    });

    expect(second.manifest).toEqual(first.manifest);
    expect(second.manifestSha256).not.toBe(first.manifestSha256);
    expect(second.manifestSha256).toBe(createHash('sha256').update(pretty).digest('hex'));
  });

  it.each([
    'entry',
    'Command',
    'argv',
    'rawCommand',
    'URL',
    'RiskZone',
    'providerKind',
    'evaluate',
    'Evaluator',
    'PrEdIcAtE',
    'callBack',
    'permissions',
    'AuthorityState',
    'authority_state',
    'APPROVED',
    'isApproved',
  ])(
    'rejects independently hard-denied field %s before invoking a permissive validator',
    async (field) => {
      const unsafe = manifest();
      unsafe[field] = field === 'argv' ? ['--unsafe'] : 'unsafe';
      const { workspaceRoot } = await createWorkspacePlugin(manifestBytes(unsafe));
      const validator = vi.fn(permissiveValidator);
      const error = await expectLoadError(
        loadPluginManifest(workspaceSource(workspaceRoot), { validateManifest: validator }),
        'PLUGIN_MANIFEST_HARD_POLICY_DENIED',
      );
      expect(error.findings[0]?.code).toMatch(/_FORBIDDEN$/);
      expect(validator).not.toHaveBeenCalled();
    },
  );

  it('rejects nested escaped executable fields before permissive validation', async () => {
    const raw = JSON.stringify(manifest());
    const bytes = Buffer.from(`${raw.slice(0, -1)},"metadata":{"\\u0065ntry":"x"}}`);
    const { workspaceRoot } = await createWorkspacePlugin(bytes);
    const validator = vi.fn(permissiveValidator);
    await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), { validateManifest: validator }),
      'PLUGIN_MANIFEST_HARD_POLICY_DENIED',
    );
    expect(validator).not.toHaveBeenCalled();
  });

  it('ignores a validator-provided replacement manifest and preserves the parsed snapshot', async () => {
    const { workspaceRoot } = await createWorkspacePlugin();
    const replacement = manifest('replacement') as unknown as PluginManifestV1;
    const validator: PluginManifestValidator = () => ({
      valid: true,
      manifest: replacement,
      findings: [],
    });
    const loaded = await loadPluginManifest(workspaceSource(workspaceRoot), {
      validateManifest: validator,
    });
    expect(loaded.manifest.id).toBe('safe-observer');
    expect(loaded.manifest).not.toBe(replacement);
  });

  it('freezes the exact parsed snapshot before handing it to the validator', async () => {
    const { workspaceRoot } = await createWorkspacePlugin();
    const validator: PluginManifestValidator = (value) => {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen((value as PluginManifestV1).gate)).toBe(true);
      expect(() => {
        (value as { id: string }).id = 'validator-mutation';
      }).toThrow(TypeError);
      return permissiveValidator(value);
    };
    const loaded = await loadPluginManifest(workspaceSource(workspaceRoot), {
      validateManifest: validator,
    });
    expect(loaded.pluginId).toBe('safe-observer');
    expect(loaded.manifest.id).toBe('safe-observer');
  });

  it('fails closed when validation rejects, throws, or returns an unsafe result', async () => {
    const { workspaceRoot } = await createWorkspacePlugin();
    const invalid = await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), {
        validateManifest: () => ({
          valid: false,
          findings: [
            {
              severity: 'error',
              code: 'PLUGIN_MANIFEST_FIELD_REQUIRED',
              path: '/name',
              message: 'required',
            },
          ],
        }),
      }),
      'PLUGIN_MANIFEST_VALIDATION_FAILED',
    );
    expect(invalid.findings).toEqual([
      expect.objectContaining({ code: 'PLUGIN_MANIFEST_FIELD_REQUIRED', path: '/name' }),
    ]);

    await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), {
        validateManifest: () => {
          throw new Error('validator failure');
        },
      }),
      'PLUGIN_MANIFEST_VALIDATOR_FAILED',
    );
    await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), {
        validateManifest: () => Object.create(null) as PluginManifestValidationResult,
      }),
      'PLUGIN_MANIFEST_VALIDATOR_FAILED',
    );
  });

  it('rejects strict-JSON violations before validation', async () => {
    for (const [bytes, strictCode] of [
      [
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifestBytes()]),
        'STRICT_JSON_BOM_FORBIDDEN',
      ],
      [Buffer.from([0xc3, 0x28]), 'STRICT_JSON_UTF8_INVALID'],
      [
        Buffer.from('{"schema":"openslack.plugin.v1","schema":"openslack.plugin.v1"}'),
        'STRICT_JSON_DUPLICATE_KEY',
      ],
    ] as const) {
      const { workspaceRoot } = await createWorkspacePlugin(bytes);
      const validator = vi.fn(permissiveValidator);
      const error = await expectLoadError(
        loadPluginManifest(workspaceSource(workspaceRoot), { validateManifest: validator }),
        'PLUGIN_MANIFEST_JSON_INVALID',
      );
      expect(error.findings[0]?.code).toBe(strictCode);
      expect(validator).not.toHaveBeenCalled();
    }
  });

  it('rejects source identity mismatches even with permissive validation', async () => {
    const { workspaceRoot } = await createWorkspacePlugin(manifestBytes(manifest('different')));
    await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), { validateManifest: permissiveValidator }),
      'PLUGIN_MANIFEST_ID_MISMATCH',
    );
  });

  it('applies caller byte limits only as stricter bounds and clamps attempted increases', async () => {
    const { workspaceRoot } = await createWorkspacePlugin();
    await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), {
        validateManifest: validatePluginManifest,
        maxBytes: 16,
      }),
      'PLUGIN_MANIFEST_SIZE_EXCEEDED',
    );

    const oversized = Buffer.alloc(PLUGIN_MANIFEST_MAX_BYTES + 1, 0x20);
    const oversizedPlugin = await createWorkspacePlugin(oversized);
    await expectLoadError(
      loadPluginManifest(workspaceSource(oversizedPlugin.workspaceRoot), {
        validateManifest: permissiveValidator,
        maxBytes: Number.MAX_SAFE_INTEGER,
      }),
      'PLUGIN_MANIFEST_SIZE_EXCEEDED',
    );
  });

  it.each([
    '',
    '/absolute/plugin.json',
    'C:/absolute/plugin.json',
    '../escape/plugin.json',
    'node_modules/../escape/plugin.json',
    'node_modules\\plugin.json',
    'node_modules//plugin.json',
    './plugin.json',
    'node_modules/package/manifest.json',
    'https://example.invalid/plugin.json',
  ])('rejects non-canonical installed sourceRef %j', (sourceRef) => {
    expect(isCanonicalPluginSourceRef(sourceRef)).toBe(false);
  });

  it.each([
    'plugin.json',
    'node_modules/package/plugin.json',
    'node_modules/@scope/package/plugin.json',
  ])('accepts canonical logical sourceRef %j', (sourceRef) => {
    expect(isCanonicalPluginSourceRef(sourceRef)).toBe(true);
  });

  it('rejects non-absolute roots, path-like IDs, and reserved IDs', async () => {
    await expectLoadError(
      loadPluginManifest(
        { providerKind: 'workspace', workspaceRoot: 'relative', pluginId: 'safe-observer' },
        { validateManifest: permissiveValidator },
      ),
      'PLUGIN_MANIFEST_SOURCE_INVALID',
    );
    const root = await tempRoot();
    for (const pluginId of ['../escape', 'nested/plugin', 'openslack']) {
      await expectLoadError(
        loadPluginManifest(
          { providerKind: 'workspace', workspaceRoot: root, pluginId },
          { validateManifest: permissiveValidator },
        ),
        'PLUGIN_MANIFEST_SOURCE_INVALID',
      );
    }
  });

  it('fails closed on a workspace plugin directory symlink or Windows junction', async () => {
    const workspaceRoot = await tempRoot();
    const outside = await tempRoot('openslack-loader-outside-');
    await writeFile(path.join(outside, 'plugin.json'), manifestBytes());
    const pluginsRoot = path.join(workspaceRoot, '.openslack', 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    const linked = path.join(pluginsRoot, 'safe-observer');
    try {
      await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      expect(['EPERM', 'EACCES', 'ENOSYS']).toContain(code);
      return;
    }

    await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), { validateManifest: permissiveValidator }),
      'PLUGIN_MANIFEST_SOURCE_SYMLINK',
    );
  });

  it('checks workspaceRoot and .openslack ancestors for symlinks or junctions', async () => {
    const physicalWorkspace = await tempRoot('openslack-physical-workspace-');
    const pluginDirectory = path.join(physicalWorkspace, '.openslack', 'plugins', 'safe-observer');
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, 'plugin.json'), manifestBytes());
    const linkParent = await tempRoot('openslack-workspace-link-parent-');
    const linkedWorkspace = path.join(linkParent, 'workspace-link');
    try {
      await symlink(
        physicalWorkspace,
        linkedWorkspace,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      expect(['EPERM', 'EACCES', 'ENOSYS']).toContain(code);
      return;
    }

    await expectLoadError(
      loadPluginManifest(workspaceSource(linkedWorkspace), {
        validateManifest: permissiveValidator,
      }),
      'PLUGIN_MANIFEST_SOURCE_SYMLINK',
    );
  });

  it('checks the .openslack ancestor itself for a symlink or Windows junction', async () => {
    const workspaceRoot = await tempRoot('openslack-logical-workspace-');
    const outside = await tempRoot('openslack-linked-state-');
    const outsideState = path.join(outside, '.openslack');
    const pluginDirectory = path.join(outsideState, 'plugins', 'safe-observer');
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, 'plugin.json'), manifestBytes());
    try {
      await symlink(
        outsideState,
        path.join(workspaceRoot, '.openslack'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      expect(['EPERM', 'EACCES', 'ENOSYS']).toContain(code);
      return;
    }
    await expectLoadError(
      loadPluginManifest(workspaceSource(workspaceRoot), { validateManifest: permissiveValidator }),
      'PLUGIN_MANIFEST_SOURCE_SYMLINK',
    );
  });

  it('rejects an installedRoot that is itself a symlink or Windows junction', async () => {
    const parent = await tempRoot('openslack-installed-link-');
    const installedRoot = path.join(parent, 'linked-package');
    try {
      await symlink(
        noExecutionFixture,
        installedRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      expect(['EPERM', 'EACCES', 'ENOSYS']).toContain(code);
      return;
    }
    await expectLoadError(
      loadPluginManifest(
        {
          providerKind: 'plugin',
          installedRoot,
          sourceRef: 'node_modules/no-execution/plugin.json',
          expectedPluginId: 'no-execution',
        },
        { validateManifest: permissiveValidator },
      ),
      'PLUGIN_MANIFEST_SOURCE_SYMLINK',
    );
  });

  it('requires a fixed regular plugin.json rather than directories or missing fallback entrypoints', async () => {
    const root = await tempRoot();
    const pluginDirectory = path.join(root, '.openslack', 'plugins', 'safe-observer');
    await mkdir(path.join(pluginDirectory, 'plugin.json'), { recursive: true });
    await writeFile(path.join(pluginDirectory, 'index.js'), 'throw new Error("must not execute")');
    await expectLoadError(
      loadPluginManifest(workspaceSource(root), { validateManifest: permissiveValidator }),
      'PLUGIN_MANIFEST_NOT_REGULAR_FILE',
    );
  });

  it('deterministically detects a path replacement after the bounded descriptor read', async () => {
    const { workspaceRoot, manifestPath } = await createWorkspacePlugin();
    await expectLoadError(
      loadPluginManifestForTest(
        workspaceSource(workspaceRoot),
        { validateManifest: permissiveValidator },
        {
          afterBoundedRead: async () => {
            await rm(manifestPath);
            await writeFile(manifestPath, manifestBytes());
          },
        },
      ),
      'PLUGIN_MANIFEST_FILE_CHANGED',
    );
  });

  it('rejects an unsupported runtime provider discriminant with a stable error', async () => {
    await expectLoadError(
      loadPluginManifest({ providerKind: 'bundled' } as unknown as PluginManifestSource, {
        validateManifest: permissiveValidator,
      }),
      'PLUGIN_MANIFEST_SOURCE_INVALID',
    );
  });

  it('contains no dynamic code-loading or evaluation primitive', async () => {
    const loaderPath = fileURLToPath(new URL('../loader.ts', import.meta.url));
    const sourceText = await readFile(loaderPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      loaderPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const forbidden: string[] = [];
    const forbiddenCalls = new Set(['require', 'eval', 'Function', 'createRequire']);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        forbidden.push('dynamic import');
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        forbiddenCalls.has(node.expression.text)
      ) {
        forbidden.push(node.expression.text);
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Function'
      ) {
        forbidden.push('new Function');
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(forbidden).toEqual([]);
    expect(sourceText).not.toMatch(/node:(?:module|vm|worker_threads)/);
  });
});
