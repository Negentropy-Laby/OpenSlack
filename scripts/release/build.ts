import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getGitContentState,
  hasArg,
  hostTarget,
  parseArg,
  run,
  sha256File,
  TARGETS,
  type ReleaseTarget,
  writeJson,
} from './lib.js';
import { buildCycloneDxSbom } from './sbom.js';
import { consumeReleaseSigningEnvironment, createProvenanceSignature } from './signature.js';
import { smokeBundle, smokeReleaseVerifierFromArchive, type ArtifactSmokeResult } from './smoke.js';
import { createReleaseArchive, extractReleaseArchive } from './archive.js';

// This must run before the first Git/build/smoke child process. Never allow the
// signing private key to flow into inherited child environments.
const releaseSigningEnvironment = consumeReleaseSigningEnvironment();
const requireSignature = hasArg('--require-signature');
if (
  requireSignature &&
  (!releaseSigningEnvironment.privateKey || !releaseSigningEnvironment.trustedPublicKey)
) {
  throw new Error(
    'Signed release builds require OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY and OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY.',
  );
}

const root = resolve(import.meta.dirname, '..', '..');
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  version: string;
};
const version = rootManifest.version;
const target = (parseArg('--target') as ReleaseTarget | undefined) ?? hostTarget();
const definition = TARGETS[target];
if (!definition) throw new Error(`Unsupported release target: ${target}`);
if (target !== hostTarget()) {
  throw new Error('Reference artifacts must be built and smoked on their native target host.');
}
const channel = parseArg('--channel') ?? 'dev';
const releaseRoot = resolve(parseArg('--out-dir') ?? join(root, 'dist', 'release', `v${version}`));
const bundleName = `openslack-v${version}-${target}`;
const bundleDir = join(releaseRoot, bundleName);
const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
const dirty = getGitContentState(root).dirty;
if (dirty && !hasArg('--allow-dirty')) {
  throw new Error(
    'Release build requires a clean worktree. Use --allow-dirty only for local spikes.',
  );
}

// Never package maturity claims that fail canonical schema, evidence, or
// deterministic generated-status verification in the source checkout.
run(process.execPath, ['apps/cli/src/index.ts', 'status', 'verify'], { cwd: root });

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(join(bundleDir, 'native'), { recursive: true });
mkdirSync(join(bundleDir, 'assets', 'workflows'), { recursive: true });
mkdirSync(join(bundleDir, 'assets', 'product'), { recursive: true });
mkdirSync(join(bundleDir, 'LICENSES'), { recursive: true });

run(process.execPath, ['run', 'build'], { cwd: root });

const executable = join(bundleDir, definition.executable);
const define = (name: string, value: string) => ['--define', `${name}=${JSON.stringify(value)}`];
run(
  process.execPath,
  [
    'build',
    'apps/cli/src/index.ts',
    '--compile',
    `--target=${definition.bunTarget}`,
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    ...define('__OPENSLACK_BUILD_VERSION__', version),
    ...define('__OPENSLACK_BUILD_COMMIT__', commit),
    ...define('__OPENSLACK_BUILD_CHANNEL__', channel),
    ...define('__OPENSLACK_BUILD_TARGET__', target),
    ...define('__OPENSLACK_ARTIFACT_FORMAT__', 'archive'),
    `--outfile=${executable}`,
  ],
  { cwd: root },
);
if (process.platform !== 'win32') chmodSync(executable, 0o755);

const credentialsRequire = createRequire(join(root, 'packages', 'credentials', 'package.json'));
const keyringPackage = credentialsRequire.resolve('@napi-rs/keyring/package.json');
const nativeRequire = createRequire(keyringPackage);
const nativeManifest = nativeRequire.resolve(`${definition.nativePackage}/package.json`);
copyFileSync(
  join(dirname(nativeManifest), definition.nativeFile),
  join(bundleDir, 'native', definition.nativeFile),
);
copyFileSync(
  join(dirname(keyringPackage), 'LICENSE'),
  join(bundleDir, 'LICENSES', 'napi-rs-keyring-LICENSE'),
);
for (const file of readdirSync(join(root, 'templates', 'workflows'))) {
  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    copyFileSync(
      join(root, 'templates', 'workflows', file),
      join(bundleDir, 'assets', 'workflows', file),
    );
  }
}
copyFileSync(
  join(root, '.openslack', 'modules.yaml'),
  join(bundleDir, 'assets', 'product', 'modules.yaml'),
);
for (const file of ['install-openslack.md', 'manual-upgrade-rollback.md']) {
  copyFileSync(join(root, 'docs', 'guides', file), join(bundleDir, file));
}

const buildInfo = {
  schema: 'openslack.build_info.v1',
  version,
  commit,
  channel,
  target,
  runtime: `bun-${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`,
  artifactFormat: 'archive',
  workspaceSchemaCompatibility: { min: 1, max: 1 },
  stateSchemaCompatibility: [
    'openslack.onboarding.v1',
    'openslack.github_app_local.v1',
    'openslack.agent_runtime.v1',
  ],
};
writeJson(join(bundleDir, 'build-info.json'), buildInfo);

// Exercise a disposable copy so the archive input has never been executed.
// Windows security tooling may retain a short-lived handle to an executable
// after its process exits, which makes Compress-Archive fail on the original
// bundle even though spawnSync has already returned.
const smokeRoot = mkdtempSync(join(tmpdir(), 'openslack-bundle-smoke-'));
let smoke: ArtifactSmokeResult;
try {
  const smokeBundleDir = join(smokeRoot, bundleName);
  cpSync(bundleDir, smokeBundleDir, { recursive: true, errorOnExist: true });
  smoke = smokeBundle(smokeBundleDir, target);
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
writeJson(join(bundleDir, 'smoke-report.json'), smoke);

mkdirSync(releaseRoot, { recursive: true });
const archiveName = `${bundleName}${definition.archiveExtension}`;
const archivePath = join(releaseRoot, archiveName);
rmSync(archivePath, { force: true });
createReleaseArchive(bundleDir, archivePath, target);

const extractionRoot = mkdtempSync(join(tmpdir(), 'openslack-release-extract-'));
let archiveSmoke: ArtifactSmokeResult;
try {
  extractReleaseArchive(archivePath, extractionRoot, target);
  archiveSmoke = smokeBundle(join(extractionRoot, bundleName), target);
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}

const sbomName = `${bundleName}.sbom.cdx.json`;
const sbomPath = join(releaseRoot, sbomName);
writeJson(sbomPath, buildCycloneDxSbom(root, version));
const provenanceName = `${bundleName}.provenance.intoto.json`;
const provenancePath = join(releaseRoot, provenanceName);
writeJson(provenancePath, {
  _type: 'https://in-toto.io/Statement/v1',
  subject: [
    { name: archiveName, digest: { sha256: sha256File(archivePath) } },
    { name: sbomName, digest: { sha256: sha256File(sbomPath) } },
  ],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: 'https://openslack.dev/build/bun-archive/v1',
      externalParameters: { version, commit, channel, target },
      internalParameters: { autoloadDotenv: false, autoloadBunfig: false },
      resolvedDependencies: [
        {
          uri: 'git+https://github.com/Negentropy-Laby/OpenSlack',
          digest: { gitCommit: commit },
        },
      ],
    },
    runDetails: { builder: { id: 'https://openslack.dev/release-builder/v1' } },
  },
});

let provenanceSignature:
  | {
      status: 'signed';
      file: string;
      sha256: string;
      algorithm: 'ed25519';
      keyId: string;
    }
  | { status: 'unsigned'; reason: 'operator-signing-not-configured' };
let signatureName: string | undefined;
if (requireSignature) {
  const privateKey = releaseSigningEnvironment.privateKey!;
  const trustedPublicKey = releaseSigningEnvironment.trustedPublicKey!;
  signatureName = `${provenanceName}.sig`;
  const signaturePath = join(releaseRoot, signatureName);
  const envelope = createProvenanceSignature(
    readFileSync(provenancePath),
    privateKey,
    trustedPublicKey,
  );
  writeJson(signaturePath, envelope);
  provenanceSignature = {
    status: 'signed',
    file: signatureName,
    sha256: sha256File(signaturePath),
    algorithm: 'ed25519',
    keyId: envelope.keyId,
  };
} else {
  provenanceSignature = {
    status: 'unsigned',
    reason: 'operator-signing-not-configured',
  };
}

const manifestName = `${bundleName}.release-manifest.json`;
const manifestPath = join(releaseRoot, manifestName);
const manifest = {
  ...buildInfo,
  schema: 'openslack.release_manifest.v1',
  buildInfoSchema: buildInfo.schema,
  dirty,
  autoload: { dotenv: false, bunfig: false },
  archive: { file: archiveName, sha256: sha256File(archivePath) },
  sbom: { file: sbomName, sha256: sha256File(sbomPath), format: 'CycloneDX-1.6' },
  provenance: {
    file: provenanceName,
    sha256: sha256File(provenancePath),
    format: 'in-toto/SLSA-1',
    signature: provenanceSignature,
  },
  smoke: { bundleChecks: smoke.checks, archiveChecks: archiveSmoke.checks },
};
writeJson(manifestPath, manifest);

const releaseVerifierSmoke = smokeReleaseVerifierFromArchive({
  archivePath,
  bundleName,
  manifestPath,
  target,
  expectedSigned: requireSignature,
  trustedPublicKey: releaseSigningEnvironment.trustedPublicKey,
});

const checksumFiles = [archiveName, sbomName, manifestName, provenanceName];
if (signatureName) checksumFiles.push(signatureName);
const checksums = checksumFiles
  .map((file) => `${sha256File(join(releaseRoot, file))}  ${file}`)
  .join('\n');
writeFileSync(join(releaseRoot, `${bundleName}.SHA256SUMS`), `${checksums}\n`, 'utf-8');
console.log(
  JSON.stringify(
    {
      releaseRoot,
      bundleDir,
      archivePath,
      manifestPath,
      smoke,
      archiveSmoke,
      releaseVerifierSmoke,
    },
    null,
    2,
  ),
);
