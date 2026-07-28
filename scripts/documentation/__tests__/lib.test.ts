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

import { afterEach, describe, expect, test } from 'vitest';

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

const temporaryRoots: string[] = [];

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

function writeDocumentMap(root: string, value = documentMap()): void {
  writeJsonFile(root, 'memory_bank/document_map.yaml', value);
}

function writeCanonicalState(
  root: string,
  assignmentState: Record<string, unknown> = assignments,
): void {
  writeJsonFile(root, 'memory_bank/t0_core/project_state.yaml', project);
  writeJsonFile(root, 'memory_bank/t0_core/release_state.yaml', release);
  writeJsonFile(root, 'memory_bank/t2_execution/work_assignments.yaml', assignmentState);
  mkdirSync(join(root, 'production'), { recursive: true });
}

describe('documentation governance validation', () => {
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
    writeCanonicalState(root);
    writeJsonFile(root, 'memory_bank/t0_core/release_state.yaml', {
      ...release,
      human_approval: 'approved',
    });

    expect(() => verifyDocumentation(root)).toThrow(/release-state\.schema\.json/);
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

      expect(() => verifyDocumentation(root)).toThrow(/ordinary file/);
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
    expect(() => verifyDocumentation(root)).toThrow(/work-assignments\.schema\.json/);
  });
});
