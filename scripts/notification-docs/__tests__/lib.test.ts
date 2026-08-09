import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type NotificationDocErrorCode, verifyNotificationDocs } from '../lib.js';

const roots: string[] = [];
const SERVICE_ROOT = 'services/notification-delivery';
const SERVICE_INDEX = `${SERVICE_ROOT}/docs/README.md`;
const MANIFEST = `${SERVICE_ROOT}/docs/testing/workspace-manifest.sha256`;
const RECEIPT = 'integration/gates/ib6-history-import.json';
const PX2_RECEIPT = 'integration/gates/ib6-px2-post-merge-audit.json';
const REQUIRED_DOCS = [
  'design/cdd/workstreams/notification-delivery/README.md',
  'docs/user/guides/notification-delivery-operations.md',
  'docs/contributor/notification-delivery/README.md',
  'docs/contributor/notification-delivery/repository-boundaries.md',
  'docs/contributor/notification-delivery/change-and-test-guide.md',
  'docs/security/notification-delivery-boundary.md',
  'docs/evidence/notification-delivery-evidence.md',
] as const;

const SERVICE_SECTIONS = [
  {
    heading: '## Current Implementation Docs',
    targets: [
      `${SERVICE_ROOT}/docs/design.md`,
      `${SERVICE_ROOT}/docs/api/openapi.yaml`,
      `${SERVICE_ROOT}/docs/architecture/architecture.md`,
      `${SERVICE_ROOT}/docs/architecture/data-model.md`,
      `${SERVICE_ROOT}/docs/architecture/adr-registry.yaml`,
      `${SERVICE_ROOT}/docs/security/threat-model.md`,
      `${SERVICE_ROOT}/docs/operations/runbook.md`,
      `${SERVICE_ROOT}/docs/testing/test-strategy.md`,
    ],
  },
  {
    heading: '## Current Evidence',
    targets: [
      `${SERVICE_ROOT}/docs/testing/ac-evidence.json`,
      `${SERVICE_ROOT}/docs/testing/acceptance-report.json`,
      `${SERVICE_ROOT}/docs/testing/fault-drill-report.md`,
      `${SERVICE_ROOT}/docs/testing/pitr-report.md`,
      `${SERVICE_ROOT}/docs/testing/capacity-report.md`,
      `${SERVICE_ROOT}/docs/testing/marker-scan-report.md`,
      `${SERVICE_ROOT}/docs/testing/ib4-r1-local-report.json`,
      MANIFEST,
    ],
  },
  {
    heading: '## Governance and Imported History',
    targets: [
      `${SERVICE_ROOT}/docs/development-plan.md`,
      `${SERVICE_ROOT}/docs/ai-usage.md`,
      `${SERVICE_ROOT}/design/cdd/module-index.md`,
      'memory_bank/t0_core/active_context.md',
      'memory_bank/t0_core/current_state.md',
      `${SERVICE_ROOT}/production/stage.txt`,
      `${SERVICE_ROOT}/design/cdd/reviews/review-archive.md`,
      `${SERVICE_ROOT}/docs/architecture/architecture-review-archive.md`,
      'memory_bank/t3_archive/reviews/notification-delivery-implementation.md',
      'memory_bank/t3_archive/reviews/review-index.md',
      'memory_bank/t3_archive/gate_runs/notification-delivery.md',
    ],
  },
] as const;

const NAVIGATION_CASES = [
  ['README.md', 'design/cdd/workstreams/notification-delivery/README.md'],
  ['README.md', 'docs/user/guides/notification-delivery-operations.md'],
  ['docs/README.md', 'design/cdd/workstreams/notification-delivery/README.md'],
  ['docs/README.md', 'docs/user/guides/notification-delivery-operations.md'],
  ['docs/README.md', 'docs/contributor/notification-delivery/README.md'],
  ['docs/README.md', 'docs/security/notification-delivery-boundary.md'],
  ['docs/README.md', 'docs/evidence/notification-delivery-evidence.md'],
  ['docs/README.md', SERVICE_INDEX],
  ['design/cdd/module-index.md', 'design/cdd/workstreams/notification-delivery/README.md'],
  ['design/cdd/module-index.md', 'docs/user/guides/notification-delivery-operations.md'],
  ['design/cdd/module-index.md', 'docs/contributor/notification-delivery/README.md'],
  ['design/cdd/module-index.md', 'docs/security/notification-delivery-boundary.md'],
  ['design/cdd/module-index.md', 'docs/evidence/notification-delivery-evidence.md'],
  ['docs/user/cli-reference.md', 'design/cdd/workstreams/notification-delivery/README.md'],
  ['docs/user/cli-reference.md', 'docs/user/guides/notification-delivery-operations.md'],
  ['docs/user/guides/core-workflows.md', 'docs/user/guides/notification-delivery-operations.md'],
  ['docs/architecture/integrations/notification-delivery.md', RECEIPT],
  [
    'docs/architecture/integrations/notification-delivery.md',
    'design/cdd/workstreams/notification-delivery/README.md',
  ],
  [
    'docs/architecture/integrations/notification-delivery.md',
    'docs/user/guides/notification-delivery-operations.md',
  ],
  [
    'docs/architecture/integrations/notification-delivery.md',
    'docs/contributor/notification-delivery/README.md',
  ],
  [
    'docs/architecture/integrations/notification-delivery.md',
    'docs/security/notification-delivery-boundary.md',
  ],
  [
    'docs/architecture/integrations/notification-delivery.md',
    'docs/evidence/notification-delivery-evidence.md',
  ],
  [`${SERVICE_ROOT}/README.md`, 'docs/README.md'],
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-notification-docs-'));
  roots.push(root);

  write(
    root,
    RECEIPT,
    `${JSON.stringify(
      {
        $schema: '../../docs/integration/notification-delivery-ib6-history-import.v1.schema.json',
        schema: 'openslack.notification_delivery_ib6_history_import.v1',
        gate: {
          name: 'IB6-HISTORY-IMPORT',
          status: 'PASS',
          closed: true,
          px2_exit: 'PENDING_POST_MERGE_AUDIT',
        },
        predecessor_manifest: { phase_f_binding: { status: 'PENDING_PHASE_F' } },
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    PX2_RECEIPT,
    `${JSON.stringify(
      {
        $schema:
          '../../docs/reference/schemas/integration/notification-delivery-px2-post-merge-audit.v1.schema.json',
        schema: 'openslack.notification_delivery_px2_post_merge_audit.v1',
        receipt_id: 'notification-delivery-px2-pr308',
        recorded_at: '2026-08-09T00:00:00Z',
        gate: {
          name: 'IB6-MERGE-TRAIN/PX2-EXIT',
          status: 'PASS',
          effectivity: 'EFFECTIVE_ON_GOVERNED_CANONICAL_MAIN_MERGE',
        },
        pull_request: {
          number: 308,
          head: '150475773f2edfb937b2e852d205d87ca87d3f35',
          review: {
            actor: 'wsman',
            state: 'APPROVED',
            reviewed_head: '150475773f2edfb937b2e852d205d87ca87d3f35',
          },
          merge_commit: '9801d2d6c7c3368804eb0ff27c34ab4e69049722',
          merge_parents: [
            '937b0566797828a9f8f0868821e21857c3345d1e',
            '150475773f2edfb937b2e852d205d87ca87d3f35',
          ],
        },
        canonical_main: {
          observed_head: 'fb17bf92b7508eddcb1c9d4acf286588527da697',
          merge_commit_is_ancestor: true,
        },
        ruleset: {
          id: 16756623,
          name: 'Protect main',
          enforcement: 'active',
          target: 'branch',
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
          deletion_blocked: true,
          non_fast_forward_blocked: true,
          pull_request: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: true,
            required_review_thread_resolution: true,
          },
          required_status_checks: {
            strict: true,
            contexts: ['classify', 'validate / validate', 'canary', 'canonical-base'],
          },
        },
        authorization: 'PX2_POST_MERGE_AUDIT_ONLY',
      },
      null,
      2,
    )}\n`,
  );
  write(root, '.openslack/modules.yaml', 'schema: openslack.modules.v2\nmodules: []\n');

  write(
    root,
    'README.md',
    lines(
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
    ),
  );
  write(
    root,
    'docs/README.md',
    lines(
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
      'docs/contributor/notification-delivery/README.md',
      'docs/security/notification-delivery-boundary.md',
      'docs/evidence/notification-delivery-evidence.md',
      SERVICE_INDEX,
    ),
  );
  write(
    root,
    'design/cdd/module-index.md',
    lines(
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
      'docs/contributor/notification-delivery/README.md',
      'docs/security/notification-delivery-boundary.md',
      'docs/evidence/notification-delivery-evidence.md',
    ),
  );
  write(root, 'design/cdd/workstreams/notification-delivery/README.md', productPage());
  write(root, 'docs/user/guides/notification-delivery-operations.md', '# Operations\n');
  write(
    root,
    'docs/user/guides/core-workflows.md',
    'docs/user/guides/notification-delivery-operations.md\n',
  );
  write(
    root,
    'docs/user/cli-reference.md',
    lines(
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
    ),
  );
  write(root, 'docs/contributor/notification-delivery/README.md', '# Developer\n');
  write(root, 'docs/contributor/notification-delivery/repository-boundaries.md', '# Boundaries\n');
  write(
    root,
    'docs/contributor/notification-delivery/change-and-test-guide.md',
    '# Change and test\n',
  );
  write(
    root,
    'docs/architecture/integrations/notification-delivery.md',
    lines(
      RECEIPT,
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
      'docs/contributor/notification-delivery/README.md',
      'docs/security/notification-delivery-boundary.md',
      'docs/evidence/notification-delivery-evidence.md',
    ),
  );
  write(root, 'docs/security/notification-delivery-boundary.md', '# Security\n');
  write(root, 'docs/evidence/notification-delivery-evidence.md', '# Evidence\n');

  write(
    root,
    `${SERVICE_ROOT}/README.md`,
    lines(
      '# Service',
      '[service index](docs/README.md)',
      '[integration](../../docs/architecture/integrations/notification-delivery.md)',
    ),
  );
  write(root, SERVICE_INDEX, serviceIndex());
  for (const section of SERVICE_SECTIONS) {
    for (const target of section.targets) {
      if (target !== MANIFEST) write(root, target, placeholder(target));
    }
  }
  write(
    root,
    `${SERVICE_ROOT}/integration/source-manifest.v2.json`,
    '{"historical_status":"PENDING_PHASE_F"}\n',
  );
  writeManifest(root);
  return root;
}

function productPage(): string {
  return lines(
    '# Notification Delivery',
    '',
    '| Field | Value |',
    '| --- | --- |',
    '| Repository import | `PASS` |',
    '| IB6 receipt closed | `true` |',
    '| PX2 exit | `PASS` |',
    '| Repository | `services/notification-delivery` |',
    '| Runtime admission | `GATED` |',
    '| IB7 default cutover | `NOT_AUTHORIZED` |',
    '| Release | `UNRELEASED` |',
    '| LIVE_VERIFIED | `NOT_CLAIMED` |',
  );
}

function serviceIndex(): string {
  const output = [
    '# Service docs',
    '',
    '[product](../../../design/cdd/workstreams/notification-delivery/README.md)',
    '[integration](../../../docs/architecture/integrations/notification-delivery.md)',
    '[evidence](../../../docs/evidence/notification-delivery-evidence.md)',
    '',
  ];
  for (const section of SERVICE_SECTIONS) {
    output.push(section.heading, '');
    for (const target of section.targets) {
      const link = posix.relative(posix.dirname(SERVICE_INDEX), target);
      output.push(`- [${posix.basename(target)}](${link})`);
    }
    output.push('');
  }
  return lines(...output);
}

function placeholder(path: string): string {
  if (path.endsWith('.json')) return '{}\n';
  if (path.endsWith('.yaml')) return 'schema: fixture\n';
  return `# ${posix.basename(path)}\n`;
}

function write(root: string, path: string, content: string): void {
  const target = resolve(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function lines(...values: string[]): string {
  return `${values.join('\n')}\n`;
}

function writeManifest(root: string): void {
  const serviceRoot = resolve(root, SERVICE_ROOT);
  const manifestPath = resolve(root, MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const paths = files(serviceRoot)
    .filter((path) => path !== 'docs/testing/workspace-manifest.sha256')
    .sort();
  const rows = paths.map((path) => {
    const hash = createHash('sha256')
      .update(readFileSync(resolve(serviceRoot, ...path.split('/'))))
      .digest('hex');
    return `${hash}  ${path}`;
  });
  writeFileSync(manifestPath, `${rows.join('\n')}\n`, 'utf8');
}

function files(root: string, directory = root): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...files(root, path));
    else if (entry.isFile()) output.push(relative(root, path).split(sep).join('/'));
  }
  return output;
}

function mutateReceipt(root: string, mutate: (receipt: Record<string, unknown>) => void): void {
  const receipt = JSON.parse(readFileSync(resolve(root, RECEIPT), 'utf8')) as Record<
    string,
    unknown
  >;
  mutate(receipt);
  write(root, RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
}

function mutatePx2Receipt(root: string, mutate: (receipt: Record<string, unknown>) => void): void {
  const receipt = JSON.parse(readFileSync(resolve(root, PX2_RECEIPT), 'utf8')) as Record<
    string,
    unknown
  >;
  mutate(receipt);
  write(root, PX2_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
}

function expectFailure(root: string, code: NotificationDocErrorCode): void {
  const result = verifyNotificationDocs(root);
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.code).toBe(code);
  expect(result.errors[0]?.path).toMatch(/^[A-Za-z0-9._/-]+$/u);
}

describe('notification documentation verifier', () => {
  it('accepts a complete fixture while retaining historical PENDING_PHASE_F values', () => {
    const result = verifyNotificationDocs(fixture());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks).toHaveLength(10);
  });

  it.each([
    [
      'receipt schema reference mismatch',
      (receipt: Record<string, unknown>) => {
        receipt.$schema = './unexpected.schema.json';
      },
      'IB6_RECEIPT_INVALID',
    ],
    [
      'receipt schema name mismatch',
      (receipt: Record<string, unknown>) => {
        receipt.schema = 'openslack.notification_delivery_ib6_history_import.v2';
      },
      'IB6_RECEIPT_INVALID',
    ],
    [
      'receipt gate name mismatch',
      (receipt: Record<string, unknown>) => {
        (receipt.gate as Record<string, unknown>).name = 'IB7-CUTOVER';
      },
      'IB6_RECEIPT_INVALID',
    ],
    [
      'non-PASS receipt',
      (receipt: Record<string, unknown>) => {
        (receipt.gate as Record<string, unknown>).status = 'FAIL';
      },
      'IB6_RECEIPT_INVALID',
    ],
    [
      'open receipt',
      (receipt: Record<string, unknown>) => {
        (receipt.gate as Record<string, unknown>).closed = false;
      },
      'IB6_RECEIPT_INVALID',
    ],
    [
      'PX2 transition',
      (receipt: Record<string, unknown>) => {
        (receipt.gate as Record<string, unknown>).px2_exit = 'PASS';
      },
      'STATUS_TRANSITION_REQUIRES_DOC_UPDATE',
    ],
  ] as const)('rejects a %s', (_name, mutate, code) => {
    const root = fixture();
    mutateReceipt(root, mutate);
    expectFailure(root, code);
  });

  it.each([
    [
      'wrong PR head',
      (receipt: Record<string, unknown>) => {
        (receipt.pull_request as Record<string, unknown>).head = '0'.repeat(40);
      },
    ],
    [
      'wrong merge binding',
      (receipt: Record<string, unknown>) => {
        (receipt.pull_request as Record<string, unknown>).merge_commit = '0'.repeat(40);
      },
    ],
    [
      'wrong ruleset',
      (receipt: Record<string, unknown>) => {
        (receipt.ruleset as Record<string, unknown>).id = 1;
      },
    ],
    [
      'missing ancestor proof',
      (receipt: Record<string, unknown>) => {
        delete (receipt.canonical_main as Record<string, unknown>).merge_commit_is_ancestor;
      },
    ],
  ] as const)('rejects PX2 receipt with %s', (_name, mutate) => {
    const root = fixture();
    mutatePx2Receipt(root, mutate);
    expectFailure(root, 'PX2_RECEIPT_INVALID');
  });

  it('requires the independent PX2 receipt', () => {
    const root = fixture();
    rmSync(resolve(root, PX2_RECEIPT));
    expectFailure(root, 'PX2_RECEIPT_INVALID');
  });

  it('rejects PENDING_PHASE_F when it returns to a current document', () => {
    const root = fixture();
    write(
      root,
      'docs/user/guides/notification-delivery-operations.md',
      '# Operations\nPENDING_PHASE_F\n',
    );
    expectFailure(root, 'CURRENT_DOC_STATUS_STALE');
  });

  it.each(REQUIRED_DOCS)('requires root entrypoint %s as an ordinary file', (path) => {
    const root = fixture();
    rmSync(resolve(root, path));
    expectFailure(root, 'REQUIRED_DOC_MISSING');
  });

  it('rejects a symlinked root entrypoint', () => {
    const root = fixture();
    const path = resolve(root, REQUIRED_DOCS[0]);
    rmSync(path);
    try {
      symlinkSync('openslack-product-current.md', path, 'file');
    } catch {
      return;
    }
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expectFailure(root, 'REQUIRED_DOC_MISSING');
  });

  it.each(NAVIGATION_CASES)('requires navigation from %s using %s', (source, marker) => {
    const root = fixture();
    const path = resolve(root, source);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain(marker);
    writeFileSync(path, body.replace(marker, ''), 'utf8');
    expectFailure(root, 'NAVIGATION_EDGE_MISSING');
  });

  it('rejects a missing service link target', () => {
    const root = fixture();
    rmSync(resolve(root, `${SERVICE_ROOT}/docs/design.md`));
    expectFailure(root, 'SERVICE_LINK_UNRESOLVED');
  });

  it('rejects a service link that escapes the repository', () => {
    const root = fixture();
    const path = resolve(root, `${SERVICE_ROOT}/README.md`);
    writeFileSync(path, `${readFileSync(path, 'utf8')}[escape](../../../../outside.md)\n`);
    expectFailure(root, 'SERVICE_LINK_UNRESOLVED');
  });

  it('rejects a symlinked service link target', () => {
    const root = fixture();
    const path = resolve(root, `${SERVICE_ROOT}/docs/design.md`);
    rmSync(path);
    try {
      symlinkSync('architecture/architecture.md', path, 'file');
    } catch {
      return;
    }
    expectFailure(root, 'SERVICE_LINK_UNRESOLVED');
  });

  it('requires all three service documentation groups', () => {
    const root = fixture();
    const path = resolve(root, SERVICE_INDEX);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('## Current Evidence', '## Other Evidence'),
      'utf8',
    );
    expectFailure(root, 'SERVICE_DOC_UNCLASSIFIED');
  });

  it('requires every predetermined service document classification', () => {
    const root = fixture();
    const path = resolve(root, SERVICE_INDEX);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('- [design.md](design.md)\n', ''),
      'utf8',
    );
    expectFailure(root, 'SERVICE_DOC_UNCLASSIFIED');
  });

  it.each([
    ['missing entry', (lines: string[]) => lines.slice(1)],
    ['extra entry', (lines: string[]) => [...lines, `${'0'.repeat(64)}  stale.txt`]],
    ['unsorted entries', (lines: string[]) => [lines[1]!, lines[0]!, ...lines.slice(2)]],
    [
      'hash mismatch',
      (lines: string[]) => [`${'0'.repeat(64)}${lines[0]!.slice(64)}`, ...lines.slice(1)],
    ],
    ['illegal path', (lines: string[]) => [...lines, `${'0'.repeat(64)}  ../outside.txt`]],
    ['duplicate path', (lines: string[]) => [...lines, lines.at(-1)!]],
  ] as const)('rejects a manifest with %s', (_name, mutate) => {
    const root = fixture();
    const path = resolve(root, MANIFEST);
    const rows = readFileSync(path, 'utf8').trimEnd().split('\n');
    writeFileSync(path, `${mutate(rows).join('\n')}\n`, 'utf8');
    expectFailure(root, 'WORKSPACE_MANIFEST_INVALID');
  });

  it.each([
    'IB7_CUTOVER=AUTHORIZED',
    'LIVE_VERIFIED=PASS',
    'RELEASE=RELEASED',
    'PRODUCTION_READY=true',
  ])('rejects premature product claim %s', (claim) => {
    const root = fixture();
    const path = resolve(root, 'design/cdd/workstreams/notification-delivery/README.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}${claim}\n`, 'utf8');
    expectFailure(root, 'PREMATURE_PRODUCT_CLAIM');
  });

  it('requires the fixed lifecycle non-claims', () => {
    const root = fixture();
    const path = resolve(root, 'design/cdd/workstreams/notification-delivery/README.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('NOT_AUTHORIZED', 'AUTHORIZED'), 'utf8');
    expectFailure(root, 'PREMATURE_PRODUCT_CLAIM');
  });

  it('allows module registration only after the independent PX2 receipt passes', () => {
    const root = fixture();
    write(
      root,
      '.openslack/modules.yaml',
      'schema: openslack.modules.v2\npath: services/notification-delivery\n',
    );
    expect(verifyNotificationDocs(root).ok).toBe(true);
  });
});
