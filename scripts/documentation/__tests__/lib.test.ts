import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, test } from 'vitest';

import { testExecutable } from '../../testing/process-fixture.mjs';

import {
  generateDocumentation,
  renderGeneratedDocuments,
  validateDocumentMetadata,
  validateProjectStateObject,
  validateReleaseStateObject,
  validateRepositoryPath,
  validateWorkAssignmentsObject,
  verifyDocumentation,
  verifyMigration,
} from '../lib.js';
import { parseIssueTaskManifest } from '../../../packages/github/src/manifest.js';

const project = {
  schema: 'openslack.project_state.v1',
  updated: '2026-07-28',
  last_verified: '2026-07-28T00:00:00Z',
  portfolio_status: 'active_development',
  release_train: '0.2.0',
  modules: [
    {
      id: 'operator',
      name: 'Operator',
      stage: 'Implementation',
      maturity: 'local_ready',
      blockers: [],
      evidence: ['repo:apps/cli'],
    },
  ],
  workstreams: [
    {
      id: 'workflow-runtime',
      name: 'Workflow Runtime',
      stage: 'Implementation',
      maturity: 'local_ready',
      blockers: [],
      evidence: ['repo:packages/workflows'],
    },
  ],
};

const release = {
  schema: 'openslack.release_state.v1',
  updated: '2026-07-28',
  train: '0.2.0',
  status: 'blocked',
  human_approval: 'not_requested',
  gates: [{ id: 'local', status: 'passed', evidence: ['test:local'], notes: '' }],
};

const assignments = {
  schema: 'openslack.work_assignments.v1',
  updated: '2026-07-28',
  assignments: [
    {
      id: 'issue-1',
      title: 'Example',
      status: 'ready',
      planned_owner: 'unassigned',
      module_or_workstream: 'operator',
      execution: { agent_id: null, claim_ref: null, started_at: null },
      github_issue: { number: 1, url: 'https://github.com/example/repo/issues/1' },
      pull_request: null,
      acceptance_criteria: ['Evidence is recorded.'],
      dependencies: [],
      blockers: [],
      evidence: [],
      last_verified_at: '2026-07-28T00:00:00Z',
    },
  ],
};

const consolidationSources = [
  'memory_bank/document_map.yaml',
  'memory_bank/t0_core/project_state.yaml',
  'memory_bank/t0_core/release_state.yaml',
  'memory_bank/t1_axioms/module_support_map.yaml',
  'memory_bank/t2_execution/work_assignments.yaml',
  'services/notification-delivery/memory_bank/t0_core/active_context.md',
  'services/notification-delivery/memory_bank/t0_core/amendment_log.md',
  'services/notification-delivery/memory_bank/t0_core/basic_law_index.md',
  'services/notification-delivery/memory_bank/t0_core/current_state.md',
  'services/notification-delivery/memory_bank/t1_axioms/architecture_context.md',
  'services/notification-delivery/memory_bank/t1_axioms/behavior_context.md',
  'services/notification-delivery/memory_bank/t1_axioms/knowledge_graph.md',
  'services/notification-delivery/memory_bank/t1_axioms/module_support_map.yaml',
  'services/notification-delivery/memory_bank/t1_axioms/qa_context.md',
  'services/notification-delivery/memory_bank/t1_axioms/system_patterns.md',
  'services/notification-delivery/memory_bank/t1_axioms/tech_context.md',
  'services/notification-delivery/memory_bank/t1_axioms/ux_accessibility_context.md',
  'services/notification-delivery/memory_bank/t2_execution/workflow_contract.md',
  'services/notification-delivery/memory_bank/t3_archive/amendments/amendment-v1.0-2026-07-18.md',
  'services/notification-delivery/memory_bank/t3_archive/gate-archive.md',
  'services/notification-delivery/memory_bank/t3_archive/reviews/implementation-review-archive.md',
  'services/notification-delivery/memory_bank/t3_archive/reviews/review-index.md',
] as const;

const temporaryRoots: string[] = [];

const claimContract = 'docs/architecture/contracts/task-claim-v2-c0.md';
const claimSchema = 'docs/reference/schemas/task-claim/task-claim-v2-c0.schema.json';
const claimVectors = 'docs/reference/vectors/task-claim/task-claim-v2-c0-vectors.json';
const manifestSchema = 'packages/github/src/task-manifest.schema.json';

function claimRepository(): string {
  const root = temporaryRepository();
  for (const path of [claimSchema, claimVectors, manifestSchema]) {
    writeRepositoryFile(root, path, readFileSync(join(process.cwd(), path), 'utf8'));
  }
  writeRepositoryFile(root, claimContract, documentMetadata('architecture-task-claim-v2-c0'));
  writeDocumentMap(
    root,
    documentMap({
      authorities: [{ fact: 'claim-contract', canonical: claimContract }],
      documents: [
        { id: 'architecture-task-claim-v2-c0', path: claimContract, status: 'active' },
        { id: 'legacy', path: 'docs/legacy.md', status: 'archived' },
      ],
    }),
  );
  return root;
}

function claimValidators() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const source = JSON.parse(readFileSync(join(process.cwd(), manifestSchema), 'utf8'));
  const schema = JSON.parse(readFileSync(join(process.cwd(), claimSchema), 'utf8'));
  ajv.addSchema(source);
  ajv.addSchema(schema);
  return {
    manifest: ajv.getSchema(source.$id)!,
    projected: ajv.getSchema(`${schema.$id}#/$defs/manifest`)!,
    identity: ajv.getSchema(`${schema.$id}#/$defs/taskIdentity`)!,
    bound: ajv.getSchema(`${schema.$id}#/$defs/boundTask`)!,
  };
}

describe('Task Claim C0 candidate conformance', () => {
  const base = {
    schema: 'openslack.github_issue_task.v1',
    task_id: 'TASK-2026-000042',
    title: 'Example',
    agent_type: 'codex',
    risk_level: 'medium',
  };

  test.each([
    ['custom type', { task_type: 'chore' }],
    ['long title', { title: 't'.repeat(1025) }],
    ['empty idempotency key', { idempotency_key: '' }],
    ['long or empty criterion', { success_criteria: ['c'.repeat(8193), ''] }],
    [
      'v1 set member strings',
      { required_capabilities: ['custom capability'], allowed_paths: [''] },
    ],
  ] as const)('preserves v1 manifest input range: %s', (_label, fields) => {
    const validate = claimValidators();
    expect(validate.manifest({ ...base, ...fields, status: 'ready' })).toBe(true);
    expect(
      parseIssueTaskManifest(
        `\`\`\`openslack-task\n${JSON.stringify({ ...base, ...fields, status: 'ready' })}\n\`\`\``,
      ).valid,
    ).toBe(true);
    expect(validate.projected({ ...base, ...fields })).toBe(true);
  });

  test('rejects an invalid task ID and lifecycle fields in the projected manifest', () => {
    const validate = claimValidators();
    expect(validate.projected({ ...base, task_id: 'generic-id' })).toBe(false);
    expect(validate.projected({ ...base, status: 'ready' })).toBe(false);
    expect(validate.projected({ ...base, linked_pr: 42 })).toBe(false);
  });

  test('keeps both task identity wrappers closed and independently required', () => {
    const validate = claimValidators();
    const task = {
      workspaceId: 'fixture',
      provider: 'github',
      host: 'github.com',
      repositoryId: '1381124543',
      issueNodeId: 'I_fixture',
      issueNumber: '42',
      taskId: 'TASK-2026-000042',
    };
    const bound = {
      ...task,
      definitionSchema: 'openslack.task_definition.v1',
      definitionDigest: `sha256:${'a'.repeat(64)}`,
    };
    for (const [check, value] of [
      [validate.identity, task],
      [validate.bound, bound],
    ] as const) {
      expect(check(value)).toBe(true);
      expect(check({ ...value, unexpected: true })).toBe(false);
      const missing = { ...value } as Record<string, unknown>;
      delete missing.issueNodeId;
      expect(check(missing)).toBe(false);
    }
  });

  test('retains transformed lease decimal bounds without accepting raw JSON numbers', () => {
    const validate = claimValidators();
    expect(
      validate.projected({ ...base, lease: { ttl_minutes: '480', heartbeat_minutes: '120' } }),
    ).toBe(true);
    for (const lease of [
      { ttl_minutes: '481', heartbeat_minutes: '1' },
      { ttl_minutes: '1', heartbeat_minutes: '121' },
      { ttl_minutes: '0', heartbeat_minutes: '1' },
      { ttl_minutes: '01', heartbeat_minutes: '1' },
      { ttl_minutes: 1, heartbeat_minutes: 1 },
    ])
      expect(validate.projected({ ...base, lease })).toBe(false);
  });

  test.each(['digest', 'byteLength', 'canonicalUTF8Base64', 'inputUTF8Base64'])(
    'docs:verify reads current vector %s bytes after an earlier pass',
    (field) => {
      const root = claimRepository();
      expect(() => verifyDocumentation(root)).not.toThrow();
      const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
      vectors.accept[0][field] =
        field === 'byteLength' ? 1 : field === 'digest' ? `sha256:${'0'.repeat(64)}` : 'e30=';
      writeJsonFile(root, claimVectors, vectors);
      expect(() => verifyDocumentation(root)).toThrow(/Task Claim C0/);
    },
  );

  test.each([
    [
      'v1 pin',
      (root: string) => {
        const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
        vectors.sourceSchema.sha256 = '0'.repeat(64);
        writeJsonFile(root, claimVectors, vectors);
      },
    ],
    [
      'v1 bytes',
      (root: string) =>
        writeFileSync(
          join(root, manifestSchema),
          `${readFileSync(join(root, manifestSchema), 'utf8')} `,
        ),
    ],
    [
      'unresolved local reference',
      (root: string) => {
        const schema = JSON.parse(readFileSync(join(root, claimSchema), 'utf8'));
        schema.oneOf[0].$ref = '#/$defs/nonexistent';
        writeJsonFile(root, claimSchema, schema);
      },
    ],
    ['missing vectors', (root: string) => unlinkSync(join(root, claimVectors))],
    [
      'duplicate JSON keys',
      (root: string) => {
        const raw = readFileSync(join(root, claimVectors), 'utf8');
        writeFileSync(join(root, claimVectors), raw.replace('{', '{"schema":"duplicate",'));
      },
    ],
    [
      'unknown projection reference',
      (root: string) => {
        const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
        vectors.projectionCases[0].expectedProjection = 'missing-vector';
        writeJsonFile(root, claimVectors, vectors);
      },
    ],
    [
      'unknown transition reference',
      (root: string) => {
        const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
        vectors.transitionCases[0].operationVector = 'missing-vector';
        writeJsonFile(root, claimVectors, vectors);
      },
    ],
    [
      'unrelated failure in unknown-field negative',
      (root: string) => {
        const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
        const vector = vectors.reject.find(
          (item: { id: string }) => item.id === 'unknown-definition-field',
        );
        const input = JSON.parse(Buffer.from(vector.inputUTF8Base64, 'base64').toString());
        delete input.task;
        vector.inputUTF8Base64 = Buffer.from(JSON.stringify(input)).toString('base64');
        writeJsonFile(root, claimVectors, vectors);
      },
    ],
    [
      'schema-invalid semantic observation',
      (root: string) => {
        const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
        delete vectors.observationReject.find(
          (item: { layer: string }) => item.layer === 'semantic',
        ).input.task;
        writeJsonFile(root, claimVectors, vectors);
      },
    ],
  ] as const)('fails closed on changed %s in the same process', (_label, mutate) => {
    const root = claimRepository();
    expect(() => verifyDocumentation(root)).not.toThrow();
    mutate(root);
    expect(() => verifyDocumentation(root)).toThrow(/Task Claim C0/);
  });

  test.each([
    ['malformed Base64', '%%%'],
    ['invalid UTF-8', Buffer.from([0xff]).toString('base64')],
    ['duplicate decoded key', Buffer.from('{"a":"x","\\u0061":"y"}').toString('base64')],
    ['lone surrogate', Buffer.from('{"a":"\\ud800"}').toString('base64')],
    ['numeric payload', Buffer.from('{"a":1}').toString('base64')],
  ])('rejects %s before digest or schema checks', (_label, encoded) => {
    const root = claimRepository();
    const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
    vectors.accept[0].inputUTF8Base64 = encoded;
    writeJsonFile(root, claimVectors, vectors);
    expect(() => verifyDocumentation(root)).toThrow(/Task Claim C0/);
  });

  test('reports mechanically counted categories without claiming semantic execution', () => {
    const result = verifyDocumentation(claimRepository()).taskClaimC0;
    expect(result).toMatchObject({
      canonicalDigests: 22,
      schemaAccepted: 20,
      codecOnly: 2,
      rejected: 6,
      projectionCases: 9,
      transitionReferences: 6,
      schemaObservationNegatives: 2,
      semanticObservationCases: 4,
      semanticExecution: 'NOT_RUN',
    });
  });

  test('the actual docs:verify entrypoint rejects corrupted evidence', () => {
    const root = claimRepository();
    const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
    vectors.accept[0].digest = `sha256:${'0'.repeat(64)}`;
    writeJsonFile(root, claimVectors, vectors);
    const result = spawnSync(
      testExecutable('bun'),
      [join(process.cwd(), 'scripts/documentation/index.ts'), 'verify'],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Task Claim C0: domain-separated digest mismatch');
    expect(result.stdout).not.toContain('Documentation verified');
  });

  test('a BOM-only codec failure cannot stand in for the duplicate-key negative', () => {
    const root = claimRepository();
    const vectors = JSON.parse(readFileSync(join(root, claimVectors), 'utf8'));
    const duplicate = vectors.reject.find(
      (item: { id: string }) => item.id === 'escaped-duplicate-key',
    );
    duplicate.inputUTF8Base64 = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"a":"single key"}'),
    ]).toString('base64');
    writeJsonFile(root, claimVectors, vectors);
    expect(() => verifyDocumentation(root)).toThrow(/Task Claim C0/);
  });
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeRepositoryFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function writeJsonFile(root: string, path: string, value: unknown): void {
  writeRepositoryFile(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function migrationManifest(
  overrides: Partial<{
    phase: 'planning' | 'migrated';
    baseline_document_count: number;
    entries: Array<{
      id: string;
      old_path: string;
      new_path: string;
      document_id: string;
      migration_type: 'retained' | 'moved' | 'archived' | 'replaced' | 'generated';
    }>;
    reference_exceptions: string[];
  }> = {},
): Record<string, unknown> {
  return {
    schema: 'openslack.document_path_migration.v1',
    phase: 'planning',
    baseline_document_count: 1,
    entries: [
      {
        id: 'DPM-001',
        old_path: 'docs/legacy.md',
        new_path: 'docs/legacy.md',
        document_id: 'legacy',
        migration_type: 'retained',
      },
    ],
    ...overrides,
  };
}

function writeMigrationManifest(root: string, value = migrationManifest()): void {
  writeJsonFile(root, 'docs/reference/document-path-migration-v1.yaml', value);
}

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-documentation-'));
  temporaryRoots.push(root);
  const sourceSchemas = join(process.cwd(), 'docs/reference/schemas/documentation');
  const targetSchemas = join(root, 'docs/reference/schemas/documentation');
  mkdirSync(dirname(targetSchemas), { recursive: true });
  cpSync(sourceSchemas, targetSchemas, { recursive: true });
  writeRepositoryFile(root, 'docs/legacy.md', '# Legacy\n');
  writeRepositoryFile(
    root,
    'memory_bank/t0_core/basic_law_index.md',
    '# Laws\n\n### ND-BL-01 — One\n### ND-BL-02 — Two\n### ND-BL-03 — Three\n### ND-BL-04 — Four\n### ND-BL-05 — Five\n### ND-BL-06 — Six\n',
  );
  writeMigrationManifest(root);
  return root;
}

function migratedRepository(): string {
  const root = temporaryRepository();
  unlinkSync(join(root, 'docs/legacy.md'));
  writeRepositoryFile(root, 'docs/current.md', '# Current\n');
  writeMigrationManifest(
    root,
    migrationManifest({
      phase: 'migrated',
      entries: [
        {
          id: 'DPM-001',
          old_path: 'docs/legacy.md',
          new_path: 'docs/current.md',
          document_id: 'legacy',
          migration_type: 'moved',
        },
      ],
    }),
  );
  return root;
}

function documentMetadata(id: string, body = ''): string {
  return `---
schema: openslack.document.v1
id: ${id}
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-28
sources: []
---

# Active

${body}`;
}

function documentMap(
  overrides: Partial<{
    authorities: Array<Record<string, unknown>>;
    documents: Array<Record<string, unknown>>;
  }> = {},
): Record<string, unknown> {
  return {
    schema: 'openslack.document_map.v1',
    authorities: [{ fact: 'portfolio', canonical: 'docs/active.md' }],
    documents: [
      { id: 'active', path: 'docs/active.md', status: 'active' },
      { id: 'legacy', path: 'docs/legacy.md', status: 'archived' },
    ],
    ...overrides,
  };
}

function generatedDocumentRecords(): Array<Record<string, unknown>> {
  return [
    {
      id: 'state-current',
      path: 'memory_bank/t0_core/current_state.md',
      status: 'generated',
    },
    {
      id: 'release-current',
      path: 'memory_bank/t0_core/release_state.md',
      status: 'generated',
    },
    {
      id: 'roadmap-memory-current',
      path: 'memory_bank/t2_execution/current_roadmap.md',
      status: 'generated',
    },
    {
      id: 'roadmap-production-current',
      path: 'production/project-roadmap.md',
      status: 'generated',
    },
  ];
}

function controlPlane(
  map: Record<string, unknown> = documentMap(),
  assignmentState: Record<string, unknown> = assignments,
  releaseState: Record<string, unknown> = release,
): Record<string, unknown> {
  return {
    $schema: '../docs/reference/schemas/documentation/control-plane.schema.json',
    schema: 'openslack.control_plane.v1',
    updated: '2026-07-28',
    authorities: map.authorities,
    documents: map.documents,
    portfolio: project,
    release: releaseState,
    assignments: assignmentState,
    support: {
      schema: 'openslack.support_map.v1',
      productModules: {
        'self-evolution': {
          cdd: 'docs/legacy.md',
          architecture: 'docs/legacy.md',
          telemetry: 'docs/legacy.md',
        },
        'github-task-loop': {
          cdd: 'docs/legacy.md',
          architecture: 'docs/legacy.md',
          telemetry: 'docs/legacy.md',
        },
        operator: {
          cdd: 'docs/legacy.md',
          architecture: 'docs/legacy.md',
          telemetry: 'docs/legacy.md',
        },
        'pr-review-merge': {
          cdd: 'docs/legacy.md',
          architecture: 'docs/legacy.md',
          telemetry: 'docs/legacy.md',
        },
        collaboration: {
          cdd: 'docs/legacy.md',
          architecture: 'docs/legacy.md',
          telemetry: 'docs/legacy.md',
        },
      },
      notificationDelivery: {
        'notification-store': {
          laws: ['ND-BL-03'],
          cdds: ['docs/legacy.md'],
          adrs: ['docs/legacy.md'],
          evidence: ['docs/legacy.md'],
        },
        'vendor-registry': {
          laws: ['ND-BL-05'],
          cdds: ['docs/legacy.md'],
          adrs: ['docs/legacy.md'],
          evidence: ['docs/legacy.md'],
        },
        'caller-access': {
          laws: ['ND-BL-02'],
          cdds: ['docs/legacy.md'],
          adrs: ['docs/legacy.md'],
          evidence: ['docs/legacy.md'],
        },
        delivery: {
          laws: ['ND-BL-04'],
          cdds: ['docs/legacy.md'],
          adrs: ['docs/legacy.md'],
          evidence: ['docs/legacy.md'],
        },
        'operations-control': {
          laws: ['ND-BL-04'],
          cdds: ['docs/legacy.md'],
          adrs: ['docs/legacy.md'],
          evidence: ['docs/legacy.md'],
        },
        'reliability-observability': {
          laws: ['ND-BL-06'],
          cdds: ['docs/legacy.md'],
          adrs: ['docs/legacy.md'],
          evidence: ['docs/legacy.md'],
        },
      },
    },
    migrations: {
      memoryBankConsolidation: {
        schema: 'openslack.memory_bank_consolidation.v1',
        updated: '2026-07-28',
        sources: consolidationSources.map((source) => ({
          source,
          targets: ['memory_bank/control-plane.json#/portfolio'],
          disposition: 'merged',
        })),
      },
    },
  };
}

function writeDocumentMap(root: string, value = documentMap()): void {
  const documents = Array.isArray(value.documents) ? value.documents : [];
  const withGenerated = {
    ...value,
    documents: [
      ...documents,
      ...(documents.some((document) => document.path === 'memory_bank/t0_core/basic_law_index.md')
        ? []
        : [
            {
              id: 'basic-law',
              path: 'memory_bank/t0_core/basic_law_index.md',
              status: 'archived',
            },
          ]),
      ...generatedDocumentRecords().filter(
        (generated) =>
          !documents.some(
            (document) => document.path === generated.path || document.id === generated.id,
          ),
      ),
    ],
  };
  writeJsonFile(root, 'memory_bank/control-plane.json', controlPlane(withGenerated));
  mkdirSync(join(root, 'memory_bank/t0_core'), { recursive: true });
  mkdirSync(join(root, 'memory_bank/t2_execution'), { recursive: true });
  mkdirSync(join(root, 'production'), { recursive: true });
  generateDocumentation(root);
}

function writeCanonicalState(
  root: string,
  assignmentState: Record<string, unknown> = assignments,
  releaseState: Record<string, unknown> = release,
): void {
  const map = {
    schema: 'openslack.document_map.v1',
    authorities: [
      {
        fact: 'portfolio',
        canonical: 'memory_bank/control-plane.json#/portfolio',
      },
    ],
    documents: [
      { id: 'legacy', path: 'docs/legacy.md', status: 'archived' },
      {
        id: 'basic-law',
        path: 'memory_bank/t0_core/basic_law_index.md',
        status: 'archived',
      },
      ...generatedDocumentRecords(),
    ],
  };
  writeJsonFile(
    root,
    'memory_bank/control-plane.json',
    controlPlane(map, assignmentState, releaseState),
  );
  mkdirSync(join(root, 'memory_bank/t0_core'), { recursive: true });
  mkdirSync(join(root, 'memory_bank/t2_execution'), { recursive: true });
  mkdirSync(join(root, 'production'), { recursive: true });
}

describe('documentation governance validation', () => {
  test('preserves the exact documentation-governance human approval binding', () => {
    const repositoryControlPlane = JSON.parse(
      readFileSync(join(process.cwd(), 'memory_bank/control-plane.json'), 'utf8'),
    ) as {
      assignments: {
        assignments: Array<{ id: string; evidence: string[]; last_verified_at: string }>;
      };
    };
    const assignment = repositoryControlPlane.assignments.assignments.find(
      (candidate) => candidate.id === 'documentation-governance-v1',
    );

    expect(assignment?.evidence).toEqual(
      expect.arrayContaining([
        'commit:c61118c4f18ac7326b0b3b7ce392b9a56797b838',
        'github:pr-329:approval:4800139148:c61118c4f18ac7326b0b3b7ce392b9a56797b838',
      ]),
    );
    expect(assignment?.last_verified_at).toBe('2026-07-29T01:28:42+08:00');
  });

  test('records the superseded PR 328 service Memory Bank boundary in the ADR', () => {
    const adr = readFileSync(
      join(process.cwd(), 'docs/architecture/adr/adr-0001-single-root-memory-bank.md'),
      'utf8',
    );

    expect(adr).toContain("supersedes only PR #328's explicit migration boundary that left");
    expect(adr).toMatch(/It does not\s+reclassify the service CDD corpus/u);
  });

  test('rejects missing document owner', () => {
    expect(() =>
      validateDocumentMetadata({
        schema: 'openslack.document.v1',
        id: 'example',
        status: 'Draft',
        authority: 'canonical',
        audience: ['contributors'],
        updated: '2026-07-28',
        sources: [],
      }),
    ).toThrow(/owner/);
  });

  test('rejects path traversal', () => {
    expect(() => validateRepositoryPath('../outside.md')).toThrow(/escapes/);
  });

  test('rejects unknown modules', () => {
    expect(() =>
      validateProjectStateObject({
        ...project,
        modules: [{ ...(project.modules[0] ?? {}), id: 'unknown-module' }],
      }),
    ).toThrow(/Unknown project module/);
  });

  test('rejects evidence-free state promotion', () => {
    expect(() =>
      validateProjectStateObject({
        ...project,
        modules: [
          {
            ...(project.modules[0] ?? {}),
            maturity: 'production_ready',
            evidence: [],
          },
        ],
      }),
    ).toThrow(/without evidence/);
  });

  test('rejects invalid Issue and PR references', () => {
    expect(() =>
      validateWorkAssignmentsObject({
        ...assignments,
        assignments: [
          {
            ...(assignments.assignments[0] ?? {}),
            github_issue: { number: 0, url: 'not-an-issue' },
          },
        ],
      }),
    ).toThrow(/invalid GitHub Issue/);

    expect(() =>
      validateWorkAssignmentsObject({
        ...assignments,
        assignments: [{ ...(assignments.assignments[0] ?? {}), github_issue: null }],
      }),
    ).not.toThrow();
  });

  test.each(['claimed', 'running', 'review', 'done'])(
    'requires execution authority for %s assignments',
    (status) => {
      expect(() =>
        validateWorkAssignmentsObject({
          ...assignments,
          assignments: [{ ...(assignments.assignments[0] ?? {}), status }],
        }),
      ).toThrow(/execution\.agent_id/);

      expect(() =>
        validateWorkAssignmentsObject({
          ...assignments,
          assignments: [
            {
              ...(assignments.assignments[0] ?? {}),
              status,
              execution: {
                agent_id: 'codex',
                claim_ref: 'refs/heads/openslack/claims/issue-1',
                started_at: '2026-07-28T00:00:00Z',
              },
            },
          ],
        }),
      ).not.toThrow();
    },
  );

  test('rejects duplicate assignment ids and unknown scopes', () => {
    expect(() =>
      validateWorkAssignmentsObject({
        ...assignments,
        assignments: [
          assignments.assignments[0],
          {
            ...assignments.assignments[0],
            module_or_workstream: 'unknown-scope',
          },
        ],
      }),
    ).toThrow(/Duplicate assignment id/);
    expect(() =>
      validateWorkAssignmentsObject({
        ...assignments,
        assignments: [
          {
            ...assignments.assignments[0],
            module_or_workstream: 'unknown-scope',
          },
        ],
      }),
    ).toThrow(/unknown module_or_workstream/);
  });

  test('rejects evidence-free release and approval promotions', () => {
    expect(() =>
      validateReleaseStateObject({
        ...release,
        gates: [{ id: 'local', status: 'passed', evidence: [], notes: '' }],
      }),
    ).toThrow(/cannot pass without evidence/);
    expect(() =>
      validateReleaseStateObject({
        ...release,
        human_approval: 'approved',
      }),
    ).toThrow(/human_approval gate with evidence/);
  });

  test('mirrors the human approval evidence invariant in the release-state schema', () => {
    const root = temporaryRepository();
    writeCanonicalState(root, assignments, { ...release, human_approval: 'approved' });

    expect(() => verifyDocumentation(root)).toThrow(
      /control-plane\.schema\.json|release-state\.schema\.json/,
    );
  });

  test('generates byte-identical projections for identical input', () => {
    expect(renderGeneratedDocuments(project, release, assignments)).toEqual(
      renderGeneratedDocuments(project, release, assignments),
    );
  });

  test('verifies planning and migrated manifests and rejects missing paths', () => {
    const planningRoot = temporaryRepository();
    expect(verifyMigration(planningRoot)).toEqual({ phase: 'planning', entries: 1 });
    unlinkSync(join(planningRoot, 'docs/legacy.md'));
    expect(() => verifyMigration(planningRoot)).toThrow(/Planning source is missing/);

    const migratedRoot = migratedRepository();
    expect(verifyMigration(migratedRoot)).toEqual({ phase: 'migrated', entries: 1 });
    unlinkSync(join(migratedRoot, 'docs/current.md'));
    expect(() => verifyMigration(migratedRoot)).toThrow(/Migrated target is missing/);
  });

  test('rejects duplicate migration identities before scanning content', () => {
    const root = temporaryRepository();
    writeRepositoryFile(root, 'docs/other.md', '# Other\n');
    writeMigrationManifest(
      root,
      migrationManifest({
        baseline_document_count: 2,
        entries: [
          {
            id: 'DPM-001',
            old_path: 'docs/legacy.md',
            new_path: 'docs/legacy.md',
            document_id: 'legacy',
            migration_type: 'retained',
          },
          {
            id: 'DPM-001',
            old_path: 'docs/other.md',
            new_path: 'docs/other.md',
            document_id: 'other',
            migration_type: 'retained',
          },
        ],
      }),
    );
    expect(() => verifyMigration(root)).toThrow(/Duplicate migration entry id/);
  });

  test('matches legacy paths at path boundaries without substring noise', () => {
    const root = migratedRepository();
    writeRepositoryFile(root, 'notes.md', 'The suffix docs/legacy.md-extra is unrelated.\n');
    expect(() => verifyMigration(root)).not.toThrow();

    writeRepositoryFile(root, 'notes.md', 'The backup docs/legacy.md.bak is unrelated.\n');
    expect(() => verifyMigration(root)).not.toThrow();

    writeRepositoryFile(root, 'notes.md', 'Moved from docs/legacy.md.\n');
    expect(() => verifyMigration(root)).toThrow(/Legacy path reference docs\/legacy\.md/);

    writeRepositoryFile(root, 'notes.md', 'Moved from `DOCS/LEGACY.MD`.\n');
    expect(() => verifyMigration(root)).toThrow(/Legacy path reference docs\/legacy\.md/);
  });

  test('documents migration scan exclusions for local and service-owned evidence', () => {
    const root = migratedRepository();
    writeRepositoryFile(
      root,
      '.openslack.local/graph-snapshot.json',
      '{"source":"docs/legacy.md"}\n',
    );
    writeRepositoryFile(
      root,
      'services/notification-delivery/history.md',
      'Historical source: docs/legacy.md\n',
    );
    expect(() => verifyMigration(root)).not.toThrow();
  });

  test('rejects module telemetry that attempts to own project governance', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeJsonFile(root, '.openslack/modules.yaml', {
      modules: [{ id: 'operator', nested: { planned_owner: 'operator-team' } }],
    });
    expect(() => verifyDocumentation(root)).toThrow(
      /\.openslack\/modules\.yaml cannot own project-governance field planned_owner/,
    );
  });

  test('rejects duplicate document authority and document paths', () => {
    const root = temporaryRepository();
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    writeDocumentMap(
      root,
      documentMap({
        authorities: [
          { fact: 'portfolio', canonical: 'docs/active.md' },
          { fact: 'release', canonical: 'docs/active.md' },
        ],
      }),
    );
    expect(() => verifyDocumentation(root)).toThrow(/Duplicate canonical authority path/);

    writeDocumentMap(
      root,
      documentMap({
        documents: [
          { id: 'active', path: 'docs/active.md', status: 'active' },
          { id: 'second', path: 'docs/active.md', status: 'index' },
        ],
      }),
    );
    expect(() => verifyDocumentation(root)).toThrow(/Duplicate active document path/);
  });

  test('rejects frontmatter defects and document id mismatches', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeRepositoryFile(root, 'docs/active.md', '# Missing frontmatter\n');
    expect(() => verifyDocumentation(root)).toThrow(/missing YAML frontmatter/);

    writeRepositoryFile(root, 'docs/active.md', '---\nid: active\n# Unterminated\n');
    expect(() => verifyDocumentation(root)).toThrow(/unterminated YAML frontmatter/);

    writeRepositoryFile(root, 'docs/active.md', documentMetadata('different'));
    expect(() => verifyDocumentation(root)).toThrow(/frontmatter id does not match/);
  });

  test('rejects unregistered governed Markdown and active template placeholders', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    writeRepositoryFile(root, 'docs/unregistered.md', '# Unregistered\n');
    expect(() => verifyDocumentation(root)).toThrow(
      /Governed Markdown document is not registered.*docs\/unregistered\.md/,
    );

    unlinkSync(join(root, 'docs/unregistered.md'));
    writeRepositoryFile(
      root,
      'docs/active.md',
      documentMetadata('active', 'TODO: replace this template value.\n'),
    );
    expect(() => verifyDocumentation(root)).toThrow(
      /active document contains a template placeholder/i,
    );

    writeRepositoryFile(
      root,
      'docs/active.md',
      documentMetadata('active', 'A lowercase todo is ordinary prose.\n'),
    );
    expect(() => verifyDocumentation(root)).not.toThrow();

    writeRepositoryFile(
      root,
      'docs/active.md',
      documentMetadata('active', 'A literal `{{mustache}}` value remains template-shaped.\n'),
    );
    expect(() => verifyDocumentation(root)).toThrow(
      /active document contains a template placeholder/i,
    );
  });

  test.skipIf(process.platform === 'win32')(
    'rejects registered document symbolic links before reading them',
    () => {
      const root = temporaryRepository();
      writeDocumentMap(root);
      const outside = mkdtempSync(join(tmpdir(), 'openslack-documentation-outside-'));
      temporaryRoots.push(outside);
      writeRepositoryFile(outside, 'outside.md', '# Outside\n');
      symlinkSync(join(outside, 'outside.md'), join(root, 'docs', 'active.md'), 'file');

      expect(() => verifyDocumentation(root)).toThrow(/ordinary file|symbolic link/);
    },
  );

  test('rejects linked governed roots before a documentation scan can leave the repository', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    const outside = mkdtempSync(join(tmpdir(), 'openslack-documentation-outside-'));
    temporaryRoots.push(outside);
    writeRepositoryFile(outside, 'outside.md', '# Outside\n');
    symlinkSync(outside, join(root, 'design'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => verifyDocumentation(root)).toThrow(/ordinary directory/);
  });

  test('parses Markdown link titles and GitHub-style ATX anchors', () => {
    const root = temporaryRepository();
    writeDocumentMap(
      root,
      documentMap({
        documents: [
          { id: 'active', path: 'docs/active.md', status: 'active' },
          { id: 'legacy', path: 'docs/legacy.md', status: 'archived' },
          { id: 'target', path: 'docs/target.md', status: 'archived' },
        ],
      }),
    );
    writeRepositoryFile(
      root,
      'docs/active.md',
      documentMetadata(
        'active',
        '[Target](target.md "friendly title")\n[Second](target.md#heading-1)\n`^[a-z](?:[a-z0-9-]+)$`\n',
      ),
    );
    writeRepositoryFile(root, 'docs/target.md', '## Heading ##\n\n## Heading ##\n');
    expect(() => verifyDocumentation(root)).not.toThrow();

    writeRepositoryFile(
      root,
      'docs/active.md',
      documentMetadata('active', '[Missing](target.md#not-present "friendly title")\n'),
    );
    expect(() => verifyDocumentation(root)).toThrow(/Broken Markdown anchor/);
  });

  test('rejects broken Markdown link targets', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeRepositoryFile(
      root,
      'docs/active.md',
      documentMetadata('active', '[Missing](does-not-exist.md "friendly title")\n'),
    );
    expect(() => verifyDocumentation(root)).toThrow(/Broken Markdown link/);
  });

  test('reports malformed Markdown link encoding with document context', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeRepositoryFile(
      root,
      'docs/active.md',
      documentMetadata('active', '[Malformed](target%ZZ.md)\n'),
    );

    expect(() => verifyDocumentation(root)).toThrow(
      /Malformed Markdown link in docs\/active\.md: target%ZZ\.md/,
    );
  });

  test('rejects stale generated projections', () => {
    const root = temporaryRepository();
    writeCanonicalState(root);
    expect(generateDocumentation(root)).toHaveLength(4);
    expect(verifyDocumentation(root).generated).toBe(4);

    const roadmap = join(root, 'production/project-roadmap.md');
    writeFileSync(roadmap, `${readFileSync(roadmap, 'utf8')}\nmanual edit\n`, 'utf8');
    expect(() => verifyDocumentation(root)).toThrow(/stale or hand-edited/);
  });

  test('enforces execution authority through the work-assignment schema', () => {
    const root = temporaryRepository();
    writeCanonicalState(root, {
      ...assignments,
      assignments: [{ ...(assignments.assignments[0] ?? {}), status: 'claimed' }],
    });
    expect(() => verifyDocumentation(root)).toThrow(
      /control-plane\.schema\.json|work-assignments\.schema\.json/,
    );
  });

  test('rejects nested Memory Banks and YAML inside the root Memory Bank', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    writeRepositoryFile(root, 'services/example/memory_bank/state.md', '# Nested\n');
    expect(() => verifyDocumentation(root)).toThrow(/exactly one root memory_bank/);

    rmSync(join(root, 'services'), { recursive: true, force: true });
    writeRepositoryFile(root, 'memory_bank/legacy.yaml', 'legacy: true\n');
    expect(() => verifyDocumentation(root)).toThrow(/YAML is forbidden inside memory_bank/);
  });

  test('rejects the legacy root standards path', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    writeRepositoryFile(root, 'standards/legacy.md', '# Legacy standards\n');

    expect(() => verifyDocumentation(root)).toThrow(/legacy root standards path is forbidden/);
  });

  test('rejects unresolved control-plane authority pointers', () => {
    const root = temporaryRepository();
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    writeDocumentMap(
      root,
      documentMap({
        authorities: [
          {
            fact: 'portfolio',
            canonical: 'memory_bank/control-plane.json#/missing',
          },
        ],
      }),
    );
    expect(() => verifyDocumentation(root)).toThrow(/authority portfolio does not resolve/);
  });

  test('rejects inherited and malformed control-plane authority pointers', () => {
    const root = temporaryRepository();
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    for (const canonical of [
      'memory_bank/control-plane.json#/constructor',
      'memory_bank/control-plane.json#/portfolio/~2invalid',
    ]) {
      writeDocumentMap(
        root,
        documentMap({
          authorities: [{ fact: 'portfolio', canonical }],
        }),
      );
      expect(() => verifyDocumentation(root)).toThrow(/does not resolve|invalid JSON Pointer/);
    }
  });

  test('applies strict embedded schemas to the consolidated control plane', () => {
    const root = temporaryRepository();
    writeDocumentMap(root);
    const path = join(root, 'memory_bank/control-plane.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.portfolio = {};
    writeJsonFile(root, 'memory_bank/control-plane.json', value);
    expect(() => verifyDocumentation(root)).toThrow(/control-plane\.schema\.json/);
  });

  test('rejects duplicate JSON keys in the consolidated control plane', () => {
    const root = temporaryRepository();
    writeRepositoryFile(
      root,
      'memory_bank/control-plane.json',
      '{"schema":"openslack.control_plane.v1","schema":"duplicate"}\n',
    );
    expect(() => verifyDocumentation(root)).toThrow(/duplicate or invalid JSON keys/);
  });

  test('validates authority projections, indexes, and archives as ordinary files', () => {
    const root = temporaryRepository();
    writeRepositoryFile(root, 'docs/active.md', documentMetadata('active'));
    writeDocumentMap(
      root,
      documentMap({
        authorities: [
          {
            fact: 'portfolio',
            canonical: 'docs/active.md',
            projections: ['docs/missing.md'],
          },
        ],
      }),
    );
    expect(() => verifyDocumentation(root)).toThrow(/authority portfolio projection is missing/);
  });

  test.skipIf(process.platform === 'win32')(
    'refuses to generate through a symbolic-link target',
    () => {
      const root = temporaryRepository();
      writeCanonicalState(root);
      const outside = mkdtempSync(join(tmpdir(), 'openslack-documentation-outside-'));
      temporaryRoots.push(outside);
      writeRepositoryFile(outside, 'outside.md', 'outside remains unchanged\n');
      symlinkSync(
        join(outside, 'outside.md'),
        join(root, 'memory_bank/t0_core/current_state.md'),
        'file',
      );

      expect(() => generateDocumentation(root)).toThrow(/symbolic link/);
      expect(readFileSync(join(outside, 'outside.md'), 'utf8')).toBe('outside remains unchanged\n');
    },
  );

  test('preflights every generated target before replacing any projection', () => {
    const root = temporaryRepository();
    writeCanonicalState(root);
    writeRepositoryFile(root, 'memory_bank/t0_core/current_state.md', 'original state\n');
    mkdirSync(join(root, 'memory_bank/t0_core/release_state.md'), { recursive: true });

    expect(() => generateDocumentation(root)).toThrow(/ordinary directories to a regular file/);
    expect(readFileSync(join(root, 'memory_bank/t0_core/current_state.md'), 'utf8')).toBe(
      'original state\n',
    );
  });
});
