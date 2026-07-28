import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSoftwareDeliverySnapshot,
  SOFTWARE_DELIVERY_PROJECTOR_CONTRACT,
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  type SoftwareDeliverySourceSnapshot,
} from '@openslack/organization-graph';
import {
  assertLoadedScenarioDefinition,
  createSoftwareDeliveryScenarioCatalog,
  isCanonicalScenarioPackId,
  isCanonicalScenarioSemver,
  loadScenarioPack,
} from '../index.js';
import { loadScenarioPackForTest } from '../pack-loader.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const sourceRoot = join(repositoryRoot, 'scenarios');
const temporaryRoots: string[] = [];
const softwareDeliveryFixtureModule =
  '../../../organization-graph/src/__tests__/software-delivery-fixtures.ts';

async function copyPack(): Promise<{ root: string; pack: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'openslack-scenario-pack-'));
  temporaryRoots.push(parent);
  const root = join(parent, 'scenarios');
  const pack = join(root, 'software-delivery');
  await mkdir(root);
  await cp(join(sourceRoot, 'software-delivery'), pack, { recursive: true });
  return { root, pack };
}

async function rewriteLock(pack: string): Promise<void> {
  const lockPath = join(pack, 'scenario.lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  for (const entry of lock.files) {
    const bytes = await readFile(join(pack, ...entry.path.split('/')));
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function mutateAndRelock(
  pack: string,
  path: string,
  mutation: (text: string) => string,
): Promise<void> {
  const target = join(pack, ...path.split('/'));
  await writeFile(target, mutation(await readFile(target, 'utf8')), 'utf8');
  await rewriteLock(pack);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Scenario Pack exact-byte loader', () => {
  it('exports the loader-owned canonical Pack ID validator', () => {
    expect(isCanonicalScenarioPackId('software-delivery')).toBe(true);
    expect(isCanonicalScenarioPackId('contract-to-delivery-lite')).toBe(true);
    expect(isCanonicalScenarioPackId('Software-Delivery')).toBe(false);
    expect(isCanonicalScenarioPackId('software_delivery')).toBe(false);
    expect(isCanonicalScenarioPackId('../software-delivery')).toBe(false);
    expect(isCanonicalScenarioPackId(`s${'a'.repeat(64)}`)).toBe(false);
  });

  it('loads the real projection-only software-delivery pack through the host-owned catalog', async () => {
    const definition = await loadScenarioPack({
      scenarioRoot: sourceRoot,
      scenarioId: 'software-delivery',
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });
    expect(definition.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(definition.projections.projectors).toEqual([
      {
        id: 'openslack.software_delivery.v1',
        adapterId: 'openslack.software_delivery.v1',
      },
    ]);
    expect(definition.workflows.workflows).toEqual([]);
    expect(definition.capabilities.requested).toEqual([]);
    expect(definition.fixtures[0]?.contentHash).toBe(
      definition.files.find((file) => file.path === 'fixtures/example.yaml')?.sha256,
    );
    expect(definition.fixtures[0]).not.toHaveProperty('version');
    expect(definition.fixtures[0]?.semanticVersion).toBe('1.0.0');
    expect(Object.isFrozen(definition)).toBe(true);
    expect(() => assertLoadedScenarioDefinition(definition)).not.toThrow();
  });

  it('declares ontology types that are actually emitted by the registered projector', async () => {
    const definition = await loadScenarioPack({
      scenarioRoot: sourceRoot,
      scenarioId: 'software-delivery',
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });
    const fixtureModule = (await import(softwareDeliveryFixtureModule)) as {
      softwareDeliverySource(): SoftwareDeliverySourceSnapshot;
    };
    const mixedSource = fixtureModule.softwareDeliverySource();
    const projection = projectSoftwareDeliverySnapshot(mixedSource);
    const allInformationalSource = structuredClone(mixedSource);
    for (const batch of Object.values(allInformationalSource.sources) as Array<{
      items: Array<{ observationKind: string }>;
    }>) {
      for (const item of batch.items) item.observationKind = 'cache';
    }
    const allInformational = projectSoftwareDeliverySnapshot(allInformationalSource);
    const allSyntheticSource = structuredClone(mixedSource);
    for (const batch of Object.values(allSyntheticSource.sources) as Array<{
      items: Array<{ observationKind: string }>;
    }>) {
      for (const item of batch.items) item.observationKind = 'synthetic';
    }
    const allSynthetic = projectSoftwareDeliverySnapshot(allSyntheticSource);
    const edgeVariantsSource = structuredClone(mixedSource);
    edgeVariantsSource.sources.prmsReports.items[0]!.observationKind = 'cache';
    edgeVariantsSource.sources.merges.items[0]!.observationKind = 'cache';
    const edgeVariants = projectSoftwareDeliverySnapshot(edgeVariantsSource);
    const staleLiveSource = structuredClone(mixedSource);
    delete staleLiveSource.sources.pullRequests.items[0]!.headSha;
    const staleLive = projectSoftwareDeliverySnapshot(staleLiveSource);

    expect(projection.projectorId).toBe(SOFTWARE_DELIVERY_PROJECTOR_ID);
    expect(Object.isFrozen(SOFTWARE_DELIVERY_PROJECTOR_CONTRACT)).toBe(true);
    expect(Object.isFrozen(SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.nodeTypes)).toBe(true);
    expect(Object.isFrozen(SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.edgeTypes)).toBe(true);
    expect(definition.projections.projectors.map((projector) => projector.id)).toEqual([
      projection.projectorId,
    ]);
    const declaredTypes = definition.ontology.types.map((type) => type.id).sort();
    expect(declaredTypes).toEqual([...SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.nodeTypes].sort());
    expect([...new Set(definition.ontology.relationships.map((item) => item.id))].sort()).toEqual(
      [...SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.edgeTypes].sort(),
    );

    const snapshots = [
      projection.snapshot,
      allInformational.snapshot,
      allSynthetic.snapshot,
      edgeVariants.snapshot,
      staleLive.snapshot,
    ] as const;
    const emittedTypes = [
      ...new Set(snapshots.flatMap((snapshot) => snapshot.nodes.map((node) => node.type))),
    ].sort();
    const emittedEdges = [
      ...new Set(snapshots.flatMap((snapshot) => snapshot.edges.map((edge) => edge.type))),
    ].sort();
    expect(emittedTypes).toEqual([...SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.nodeTypes].sort());
    expect(emittedEdges).toEqual([...SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.edgeTypes].sort());

    const emittedTriples = new Set(
      snapshots.flatMap((snapshot) => {
        const nodeTypes = new Map(snapshot.nodes.map((node) => [node.id, node.type]));
        return snapshot.edges.map(
          (edge) => `${edge.type}\0${nodeTypes.get(edge.from)}\0${nodeTypes.get(edge.to)}`,
        );
      }),
    );
    expect(
      definition.ontology.relationships.every((relationship) =>
        emittedTriples.has(`${relationship.id}\0${relationship.from}\0${relationship.to}`),
      ),
    ).toBe(true);

    const emittedNodes = snapshots.flatMap((snapshot) => snapshot.nodes);
    for (const type of definition.ontology.types) {
      const nodes = emittedNodes.filter((node) => node.type === type.id);
      expect(nodes.length, type.id).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(type.authorityProviders, `${type.id}.${node.authorityRef.provider}`).toContain(
          node.authorityRef.provider,
        );
        expect(
          Object.keys(node.properties).every((field) => type.fields.includes(field)),
          `${type.id} property vocabulary`,
        ).toBe(true);
      }
      for (const field of type.fields) {
        expect(
          nodes.some((node) => Object.hasOwn(node.properties, field)),
          `${type.id}.${field}`,
        ).toBe(true);
      }
    }
    expect(definition.views.views).toEqual([
      {
        id: 'delivery-core',
        title: 'Governed Delivery Core',
        nodeTypes: [
          'core.work_item',
          'human_decision',
          'outcome',
          'reviewable_deliverable',
          'verification_evidence',
        ],
        fields: ['status', 'title'],
      },
    ]);
  });

  it('rejects a relocked ontology that lies about sealed projector vocabulary', async () => {
    const { root, pack } = await copyPack();
    await mutateAndRelock(pack, 'ontology.yaml', (text) =>
      text.replace(
        'relationships:\n',
        [
          '  - id: fabricated.business_object',
          '    title: Fabricated Business Object',
          '    authorityProviders: [demo_fixture]',
          '    fields: [fabricatedField]',
          'relationships:',
          '',
        ].join('\n'),
      ),
    );
    await expect(
      loadScenarioPack({
        scenarioRoot: root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_REFERENCE_MISSING' });
  });

  it.each([
    ['1.2.3', true],
    ['1.2.3-rc.1+build.7', true],
    ['1.2.3-01', false],
    ['1.2.3-', false],
    ['1.2.', false],
  ])('applies one strict SemVer grammar to %s', (value, expected) => {
    expect(isCanonicalScenarioSemver(value)).toBe(expected);
  });

  it('rejects exact-byte drift and undeclared files', async () => {
    const { root, pack } = await copyPack();
    await writeFile(join(pack, 'capabilities.yaml'), 'schema: changed\nrequested: []\n', 'utf8');
    await expect(
      loadScenarioPack({
        scenarioRoot: root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_INTEGRITY_MISMATCH' });

    await cp(join(sourceRoot, 'software-delivery'), pack, { recursive: true, force: true });
    await writeFile(join(pack, 'fixtures', 'undeclared.yaml'), 'schema: no\n', 'utf8');
    await expect(
      loadScenarioPack({
        scenarioRoot: root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_FILE_SET_MISMATCH' });
  });

  it.each([
    'commandLine',
    'modulePath',
    'executablePath',
    'dynamicImport',
    'sourceCode',
    'tokenRef',
    'apiKeyRef',
    'authRef',
    'vaultRef',
    'connectionString',
    'isApproved',
    'approvedBy',
    'reviewDecision',
    'mergeable',
    'githubToken',
  ])('rejects forbidden open fixture field %s after valid relocking', async (field) => {
    const { root, pack } = await copyPack();
    await mutateAndRelock(pack, 'fixtures/example.yaml', (text) =>
      text.replace('      state: open\n', `      state: open\n      ${field}: canary\n`),
    );
    const error = await loadScenarioPack({
      scenarioRoot: root,
      scenarioId: 'software-delivery',
      catalog: createSoftwareDeliveryScenarioCatalog(),
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'SCENARIO_PACK_FORBIDDEN_CONTENT' });
    expect(JSON.stringify(error)).not.toContain('canary');
  });

  it.each([
    ['URL', '      redirect: https://evil.example\n'],
    ['credential value', '      note: github_pat_abcdefghijklmnopqrstuvwxyz012345\n'],
    ['executable value', '      source: payload.mjs\n'],
  ])('rejects %s content without echoing it', async (_name, line) => {
    const { root, pack } = await copyPack();
    await mutateAndRelock(pack, 'fixtures/example.yaml', (text) =>
      text.replace('      state: open\n', `      state: open\n${line}`),
    );
    await expect(
      loadScenarioPack({
        scenarioRoot: root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_FORBIDDEN_CONTENT' });
  });

  it.each([
    ['anchor', 'requested: &capabilities []\n'],
    ['alias', 'requested: &caps []\ncopy: *caps\n'],
    ['merge', 'requested: []\nextra: { <<: {} }\n'],
    ['custom tag', 'requested: !unsafe []\n'],
    ['duplicate key', 'requested: []\nrequested: []\n'],
  ])('rejects unsafe YAML feature %s', async (_name, body) => {
    const { root, pack } = await copyPack();
    await writeFile(
      join(pack, 'capabilities.yaml'),
      `schema: openslack.scenario_capabilities.v1\n${body}`,
      'utf8',
    );
    await rewriteLock(pack);
    await expect(
      loadScenarioPack({
        scenarioRoot: root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/SCENARIO_PACK_(YAML|SCHEMA)/) });
  });

  it('rejects unregistered references and pack-owned target broadening', async () => {
    const first = await copyPack();
    await mutateAndRelock(first.pack, 'projections.yaml', (text) =>
      text.replaceAll('openslack.software_delivery.v1', 'openslack.unknown_projector.v1'),
    );
    await expect(
      loadScenarioPack({
        scenarioRoot: first.root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_REFERENCE_MISSING' });

    const second = await copyPack();
    await mutateAndRelock(second.pack, 'policies.yaml', (text) =>
      text.replace('allowExternalTargets: false', 'allowExternalTargets: true'),
    );
    await expect(
      loadScenarioPack({
        scenarioRoot: second.root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_POLICY_DENIED' });
  });

  it('detects early-file mutation and directory replacement after initial reads', async () => {
    const first = await copyPack();
    let changed = false;
    await expect(
      loadScenarioPackForTest(
        {
          scenarioRoot: first.root,
          scenarioId: 'software-delivery',
          catalog: createSoftwareDeliveryScenarioCatalog(),
        },
        {
          afterBoundedRead: async (path) => {
            if (!changed && path.endsWith('workflows.yaml')) {
              changed = true;
              await writeFile(
                join(first.pack, 'capabilities.yaml'),
                'schema: openslack.scenario_capabilities.v1\nrequested: []\n ',
                'utf8',
              );
            }
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_FILE_CHANGED' });

    const second = await copyPack();
    let replaced = false;
    await expect(
      loadScenarioPackForTest(
        {
          scenarioRoot: second.root,
          scenarioId: 'software-delivery',
          catalog: createSoftwareDeliveryScenarioCatalog(),
        },
        {
          afterBoundedRead: async (path) => {
            if (!replaced && path.endsWith('workflows.yaml')) {
              replaced = true;
              const old = join(second.pack, 'fixtures');
              const moved = join(second.pack, 'fixtures-old');
              await rename(old, moved);
              await mkdir(old);
              await cp(join(moved, 'example.yaml'), join(old, 'example.yaml'));
            }
          },
        },
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/SCENARIO_PACK_(FILE_CHANGED|FILE_SET_MISMATCH)/),
    });
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked declared leaf', async () => {
    const { root, pack } = await copyPack();
    const target = join(pack, 'views.yaml');
    const bytes = await readFile(target);
    await rm(target);
    const outside = join(dirname(root), 'outside.yaml');
    await writeFile(outside, bytes);
    await symlink(outside, target);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    await expect(
      loadScenarioPack({
        scenarioRoot: root,
        scenarioId: 'software-delivery',
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_SOURCE_SYMLINK' });
  });
});
