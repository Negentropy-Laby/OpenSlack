import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyRelease } from '../verify.js';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('release manifest verification', () => {
  let root: string;
  let manifestPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-release-verify-'));
    const archive = join(root, 'openslack.zip');
    const sbom = join(root, 'openslack.sbom.cdx.json');
    const provenance = join(root, 'openslack.provenance.intoto.json');
    writeFileSync(archive, 'archive');
    writeFileSync(sbom, '{"bomFormat":"CycloneDX"}');
    const archiveHash = sha256(archive);
    writeFileSync(
      provenance,
      JSON.stringify({
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://slsa.dev/provenance/v1',
        subject: [{ name: 'openslack.zip', digest: { sha256: archiveHash } }],
      }),
    );
    manifestPath = join(root, 'openslack.release-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 'openslack.release_manifest.v1',
        buildInfoSchema: 'openslack.build_info.v1',
        archive: { file: 'openslack.zip', sha256: archiveHash },
        sbom: { file: 'openslack.sbom.cdx.json', sha256: sha256(sbom) },
        provenance: {
          file: 'openslack.provenance.intoto.json',
          sha256: sha256(provenance),
        },
      }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('verifies all release subjects and digests', () => {
    expect(verifyRelease(manifestPath)).toContain('match the release manifest');
  });

  it('rejects a tampered release component', () => {
    writeFileSync(join(root, 'openslack.sbom.cdx.json'), 'tampered');
    expect(() => verifyRelease(manifestPath)).toThrow('Release checksum mismatch');
  });

  it('rejects path traversal in artifact references', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      archive: { file: string };
    };
    manifest.archive.file = '../openslack.zip';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyRelease(manifestPath)).toThrow('unsafe or invalid artifact reference');
  });

  it('rejects provenance for a different archive digest', () => {
    const provenancePath = join(root, 'openslack.provenance.intoto.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf-8')) as {
      subject: Array<{ digest: { sha256: string } }>;
    };
    provenance.subject[0].digest.sha256 = '0'.repeat(64);
    writeFileSync(provenancePath, JSON.stringify(provenance));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      provenance: { sha256: string };
    };
    manifest.provenance.sha256 = sha256(provenancePath);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyRelease(manifestPath)).toThrow(
      'Provenance subject does not match the release archive',
    );
  });
});
