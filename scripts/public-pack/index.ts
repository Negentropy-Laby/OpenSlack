import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import {
  PUBLIC_PACKAGES,
  PUBLIC_VERSION,
  assertExpectedTarballFiles,
  assertFile,
  canonicalDirectoryManifest,
  copyPackagePayload,
  readJson,
  resetDirectory,
  sha256Canonical,
  sha256File,
  stageManifest,
  validatePublicManifest,
  writeJson,
  type PublicPackArtifact,
} from './lib.js';

const root = resolve(import.meta.dirname, '..', '..');
const outputRoot = resolve(root, '.openslack.local', 'public-pack', `v${PUBLIC_VERSION}`);
const command = process.argv[2];

if (command !== 'pack' && command !== 'verify') {
  throw new Error('Usage: bun scripts/public-pack/index.ts <pack|verify>');
}

assertRootVersion();
if (command === 'pack') {
  resetDirectory(outputRoot);
  const artifacts = createPackSet(resolve(outputRoot, 'current'));
  writeJson(resolve(outputRoot, 'artifacts.json'), artifactReport(artifacts));
  process.stdout.write(`Packed ${artifacts.length} public packages in ${outputRoot}\n`);
} else {
  resetDirectory(outputRoot);
  const current = createPackSet(resolve(outputRoot, 'current'));
  const repeat = createPackSet(resolve(outputRoot, 'repeat'));
  assertReproducible(current, repeat);
  verifyCleanConsumer(current);
  writeJson(resolve(outputRoot, 'verification.json'), {
    schema: 'openslack.public_pack_verification.v1',
    version: PUBLIC_VERSION,
    platform: `${process.platform}-${process.arch}`,
    reproducibleCanonicalManifests: true,
    cleanConsumer: {
      installedTarballs: current.map((item) => item.name),
      esmImports: 'PASS',
      declarations: 'PASS',
      typescriptConsumer: 'PASS',
      isolatedPluginHosts: 'PASS',
    },
    artifacts: artifactReport(current).artifacts,
  });
  process.stdout.write(`Verified ${current.length} public packages in ${outputRoot}\n`);
}

function assertRootVersion(): void {
  const manifest = readJson(resolve(root, 'package.json'));
  if (manifest.version !== PUBLIC_VERSION) {
    throw new Error(`Root package version must be ${PUBLIC_VERSION}.`);
  }
}

function createPackSet(destination: string): readonly PublicPackArtifact[] {
  resetDirectory(destination);
  const stageRoot = resolve(destination, 'stage');
  const tarballRoot = resolve(destination, 'tarballs');
  const unpackedRoot = resolve(destination, 'unpacked');
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(tarballRoot, { recursive: true });
  mkdirSync(unpackedRoot, { recursive: true });
  const artifacts: PublicPackArtifact[] = [];

  for (const definition of PUBLIC_PACKAGES) {
    const source = resolve(root, definition.directory);
    const manifest = readJson(resolve(source, 'package.json'));
    validatePublicManifest(manifest, definition);
    const staged = stageManifest(manifest);
    validateStagedDependencyVersions(staged);

    const safeName = definition.name.replace('@openslack/', '');
    const stage = resolve(stageRoot, safeName);
    mkdirSync(stage, { recursive: true });
    copyPackagePayload(source, stage);
    copyFileSync(resolve(root, 'LICENSE'), resolve(stage, 'LICENSE'));
    copyFileSync(resolve(root, 'NOTICE'), resolve(stage, 'NOTICE'));
    writeJson(resolve(stage, 'package.json'), staged);

    run(
      npmCommand(),
      ['pack', '.', '--pack-destination', tarballRoot, '--json', '--ignore-scripts'],
      {
        cwd: stage,
      },
    );
    const tarballName = `openslack-${safeName}-${PUBLIC_VERSION}.tgz`;
    const tarball = resolve(tarballRoot, tarballName);
    assertFile(tarball);

    const unpacked = resolve(unpackedRoot, safeName);
    mkdirSync(unpacked, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', unpacked], { cwd: root });
    const packageRoot = resolve(unpacked, 'package');
    const files = canonicalDirectoryManifest(packageRoot);
    assertExpectedTarballFiles(files);
    validatePackedManifest(readJson(resolve(packageRoot, 'package.json')), definition.name);
    const canonicalPath = resolve(unpacked, 'canonical-manifest.json');
    writeJson(canonicalPath, {
      schema: 'openslack.public_package_canonical_manifest.v1',
      name: definition.name,
      version: PUBLIC_VERSION,
      files,
    });
    artifacts.push({
      name: definition.name,
      version: PUBLIC_VERSION,
      tarball: normalizePath(relative(root, tarball)),
      tarballSha256: sha256File(tarball),
      manifestSha256: sha256Canonical(files),
      files,
    });
  }
  return Object.freeze(artifacts);
}

function validateStagedDependencyVersions(manifest: Record<string, unknown>): void {
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    const dependencies = manifest[field] as Record<string, unknown> | undefined;
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        throw new Error(`${String(manifest.name)} retained workspace dependency ${name}.`);
      }
      if (name.startsWith('@openslack/') && version !== PUBLIC_VERSION) {
        throw new Error(`${String(manifest.name)} must pin ${name} to ${PUBLIC_VERSION}.`);
      }
    }
  }
}

function validatePackedManifest(manifest: Record<string, unknown>, expectedName: string): void {
  if (manifest.name !== expectedName || manifest.version !== PUBLIC_VERSION) {
    throw new Error(`Packed manifest identity mismatch for ${expectedName}.`);
  }
  if (manifest.private === true) throw new Error(`${expectedName} packed as private.`);
  validateStagedDependencyVersions(manifest);
  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  for (const lifecycle of [
    'preinstall',
    'install',
    'postinstall',
    'prepare',
    'prepack',
    'postpack',
    'prepublish',
    'prepublishOnly',
  ]) {
    if (Object.hasOwn(scripts ?? {}, lifecycle)) {
      throw new Error(`${expectedName} tarball contains lifecycle script ${lifecycle}.`);
    }
  }
}

function assertReproducible(
  current: readonly PublicPackArtifact[],
  repeat: readonly PublicPackArtifact[],
): void {
  if (current.length !== repeat.length) throw new Error('Public pack set length changed.');
  for (let index = 0; index < current.length; index += 1) {
    const left = current[index]!;
    const right = repeat[index]!;
    if (left.name !== right.name || left.manifestSha256 !== right.manifestSha256) {
      throw new Error(`Canonical package manifest is not reproducible for ${left.name}.`);
    }
  }
}

function verifyCleanConsumer(artifacts: readonly PublicPackArtifact[]): void {
  const consumer = resolve(outputRoot, 'consumer');
  resetDirectory(consumer);
  const dependencies = Object.fromEntries(
    artifacts.map((artifact) => [
      artifact.name,
      `file:${normalizePath(relative(consumer, resolve(root, artifact.tarball)))}`,
    ]),
  );
  writeJson(resolve(consumer, 'package.json'), {
    name: 'openslack-public-clean-consumer',
    private: true,
    version: '1.0.0',
    type: 'module',
    dependencies,
  });
  writeJson(resolve(consumer, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      resolveJsonModule: true,
      skipLibCheck: false,
      outDir: 'build',
    },
    include: ['consumer.ts'],
  });
  writeFileSync(resolve(consumer, 'consumer.ts'), consumerSource(), 'utf8');

  run(
    npmCommand(),
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--offline'],
    { cwd: consumer },
  );
  assertOnlyExpectedConsumerPackages(consumer);
  run(
    process.execPath,
    [resolve(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    { cwd: consumer },
  );
  run(process.execPath, [resolve(consumer, 'build', 'consumer.js')], { cwd: consumer });
}

function consumerSource(): string {
  return `import {
  DECLARATIVE_PLUGIN_CAPABILITIES,
  type ActionAuthorizationRequest,
  type ActivationAuthorizationRequest,
  type HostPlanStep,
  type HostPolicyDecision,
  type HostPolicyPort,
  type PlanStepValidationRequest,
  type PluginAuditEvent,
} from '@openslack/plugin-api';
import manifestSchema from '@openslack/plugin-api/plugin-manifest.schema.json' with { type: 'json' };
import { PluginHost } from '@openslack/plugin-host';
import { defineManifest } from '@openslack/sdk';
import { PLUGIN_CHECK_IDS, checkPlugin } from '@openslack/plugin-testkit';

class ConsumerPolicy implements HostPolicyPort<HostPlanStep> {
  constructor(readonly marker: string) {}
  authorizeActivation(request: ActivationAuthorizationRequest) {
    return {
      outcome: 'allow' as const,
      code: 'PLUGIN_ACTIVATION_ALLOWED' as const,
      reason: this.marker,
      hostAllowedCapabilities: [...request.requestedCapabilities],
      actorAllowedCapabilities: [...request.requestedCapabilities],
      evidenceRefs: [this.marker],
    };
  }
  authorizeAction(_request: ActionAuthorizationRequest): HostPolicyDecision {
    return { outcome: 'allow', code: this.marker, reason: this.marker, evidenceRefs: [this.marker] };
  }
  validatePlanStep(_request: PlanStepValidationRequest<HostPlanStep>): HostPolicyDecision {
    return { outcome: 'allow', code: this.marker, reason: this.marker, evidenceRefs: [this.marker] };
  }
  recordAuditEvent(_event: PluginAuditEvent): void {}
}

const host = (marker: string) => new PluginHost({
  policy: new ConsumerPolicy(marker),
  binding: {
    compositionId: \`consumer.\${marker}\`,
    openslackVersion: '${PUBLIC_VERSION}',
    gateIds: [],
    targets: { actions: [], workflows: [] },
  },
});
const first = host('first');
const second = host('second');
const manifest = defineManifest({
  schema: 'openslack.plugin.v1',
  id: 'consumer.fixture',
  version: '1.0.0',
  name: 'Consumer fixture',
  requires: { openslack: '>=0.2.0 <1.0.0' },
  gate: { mode: 'SHADOW', gateId: 'consumer.shadow' },
  capabilities: ['host.actions.read'],
  contributes: [],
});
if (
  first === second ||
  first.snapshot().registryRevision !== 0 ||
  second.snapshot().registryRevision !== 0 ||
  manifest.schema !== 'openslack.plugin.v1' ||
  manifestSchema.title !== 'OpenSlack Plugin Manifest v1' ||
  !DECLARATIVE_PLUGIN_CAPABILITIES.includes('host.actions.read') ||
  !PLUGIN_CHECK_IDS.includes('G17') ||
  typeof checkPlugin !== 'function'
) {
  throw new Error('Public consumer verification failed.');
}
`;
}

function assertOnlyExpectedConsumerPackages(consumer: string): void {
  const scope = resolve(consumer, 'node_modules', '@openslack');
  const actual = readdirSync(scope).sort();
  const expected = PUBLIC_PACKAGES.map((item) => item.name.replace('@openslack/', '')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected clean consumer packages: ${actual.join(', ')}`);
  }
}

function artifactReport(artifacts: readonly PublicPackArtifact[]) {
  return {
    schema: 'openslack.public_pack_artifacts.v1',
    version: PUBLIC_VERSION,
    platform: `${process.platform}-${process.arch}`,
    artifacts,
  };
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMFILES',
    'ProgramFiles',
    'PROGRAMFILES(X86)',
    'ProgramFiles(x86)',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_cache: resolve(outputRoot, 'npm-cache'),
  };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function run(executable: string, args: readonly string[], options: { readonly cwd: string }): void {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: safeChildEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${executable} ${args.join(' ')}`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}
