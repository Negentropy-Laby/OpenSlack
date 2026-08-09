import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, type Dirent, type Stats } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const NOTIFICATION_DOC_ERROR_CODES = Object.freeze([
  'IB6_RECEIPT_INVALID',
  'PX2_RECEIPT_INVALID',
  'CURRENT_DOC_STATUS_STALE',
  'REQUIRED_DOC_MISSING',
  'NAVIGATION_EDGE_MISSING',
  'SERVICE_LINK_UNRESOLVED',
  'SERVICE_DOC_UNCLASSIFIED',
  'WORKSPACE_MANIFEST_INVALID',
  'PREMATURE_PRODUCT_CLAIM',
  'PREMATURE_MODULE_REGISTRATION',
  'STATUS_TRANSITION_REQUIRES_DOC_UPDATE',
] as const);

export type NotificationDocErrorCode = (typeof NOTIFICATION_DOC_ERROR_CODES)[number];

export interface NotificationDocError {
  readonly code: NotificationDocErrorCode;
  readonly path: string;
}

export interface NotificationDocVerification {
  readonly ok: boolean;
  readonly checks: readonly string[];
  readonly errors: readonly NotificationDocError[];
}

const RECEIPT_PATH = 'integration/gates/ib6-history-import.json';
const PX2_RECEIPT_PATH = 'integration/gates/ib6-px2-post-merge-audit.json';
const MODULES_PATH = '.openslack/modules.yaml';
const PRODUCT_PATH = 'design/cdd/workstreams/notification-delivery/README.md';
const PRODUCT_INDEX_PATH = 'design/cdd/module-index.md';
const SERVICE_ROOT = 'services/notification-delivery';
const SERVICE_INDEX_PATH = `${SERVICE_ROOT}/docs/README.md`;
const SERVICE_MANIFEST_PATH = `${SERVICE_ROOT}/docs/testing/workspace-manifest.sha256`;
const DOCUMENT_MIGRATION_PATH = 'docs/reference/document-path-migration-v1.yaml';
const EXPECTED_RECEIPT_SCHEMA = 'openslack.notification_delivery_ib6_history_import.v1';
const EXPECTED_RECEIPT_SCHEMA_REFERENCE =
  '../../docs/integration/notification-delivery-ib6-history-import.v1.schema.json';
const EXPECTED_HISTORICAL_PX2_EXIT = 'PENDING_POST_MERGE_AUDIT';
const EXPECTED_PX2_EXIT = 'PASS';

const REQUIRED_ROOT_DOCS = Object.freeze([
  'design/cdd/workstreams/notification-delivery/README.md',
  'docs/user/guides/notification-delivery-operations.md',
  'docs/contributor/notification-delivery/README.md',
  'docs/contributor/notification-delivery/repository-boundaries.md',
  'docs/contributor/notification-delivery/change-and-test-guide.md',
  'docs/security/notification-delivery-boundary.md',
  'docs/evidence/notification-delivery-evidence.md',
] as const);

const CURRENT_DOC_STATUS_ALLOWLIST = Object.freeze([
  'README.md',
  'docs/README.md',
  PRODUCT_INDEX_PATH,
  PRODUCT_PATH,
  'docs/user/guides/notification-delivery-operations.md',
  'docs/user/guides/core-workflows.md',
  'docs/user/cli-reference.md',
  'docs/contributor/notification-delivery/README.md',
  'docs/contributor/notification-delivery/repository-boundaries.md',
  'docs/contributor/notification-delivery/change-and-test-guide.md',
  'docs/architecture/integrations/notification-delivery.md',
  'docs/security/notification-delivery-boundary.md',
  'docs/evidence/notification-delivery-evidence.md',
  `${SERVICE_ROOT}/README.md`,
  SERVICE_INDEX_PATH,
] as const);

const NAVIGATION_EDGES = Object.freeze([
  {
    source: 'README.md',
    targets: [
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
    ],
  },
  {
    source: 'docs/README.md',
    targets: [
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
      'docs/contributor/notification-delivery/README.md',
      'docs/security/notification-delivery-boundary.md',
      'docs/evidence/notification-delivery-evidence.md',
      SERVICE_INDEX_PATH,
    ],
  },
  {
    source: PRODUCT_INDEX_PATH,
    targets: [
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
      'docs/contributor/notification-delivery/README.md',
      'docs/security/notification-delivery-boundary.md',
      'docs/evidence/notification-delivery-evidence.md',
    ],
  },
  {
    source: 'docs/user/cli-reference.md',
    targets: [
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
    ],
  },
  {
    source: 'docs/user/guides/core-workflows.md',
    targets: ['docs/user/guides/notification-delivery-operations.md'],
  },
  {
    source: 'docs/architecture/integrations/notification-delivery.md',
    targets: [
      RECEIPT_PATH,
      'design/cdd/workstreams/notification-delivery/README.md',
      'docs/user/guides/notification-delivery-operations.md',
      'docs/contributor/notification-delivery/README.md',
      'docs/security/notification-delivery-boundary.md',
      'docs/evidence/notification-delivery-evidence.md',
    ],
  },
  {
    source: `${SERVICE_ROOT}/README.md`,
    targets: [SERVICE_INDEX_PATH],
  },
] as const);

const SERVICE_LINK_SOURCES = Object.freeze([
  `${SERVICE_ROOT}/README.md`,
  SERVICE_INDEX_PATH,
] as const);

const SERVICE_DOC_SECTIONS = Object.freeze([
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
      SERVICE_MANIFEST_PATH,
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
] as const);

const PRODUCT_LIFECYCLE = Object.freeze({
  'Repository import': 'PASS',
  'IB6 receipt closed': 'true',
  'PX2 exit': EXPECTED_PX2_EXIT,
  Repository: SERVICE_ROOT,
  'Runtime admission': 'GATED',
  'IB7 default cutover': 'NOT_AUTHORIZED',
  Release: 'UNRELEASED',
  LIVE_VERIFIED: 'NOT_CLAIMED',
});

const PREMATURE_CLAIMS = Object.freeze([
  /\bIB7_CUTOVER\s*=\s*(?:AUTHORIZED|PASS)\b/iu,
  /\bLIVE_VERIFIED\s*=\s*(?:true|PASS)\b/iu,
  /\bRELEASE\s*=\s*RELEASED\b/iu,
  /\bPRODUCTION_READY\s*=\s*(?:true|PASS)\b/iu,
] as const);

const SERVICE_ALLOWED_TOP_LEVEL = new Set([
  '.github',
  '.dockerignore',
  '.gitignore',
  'CLAUDE.md',
  'README.md',
  'Dockerfile',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'SBOM.cdx.json',
  'cmd',
  'deploy',
  'design',
  'docker-compose.yml',
  'docs',
  'go.mod',
  'go.sum',
  'internal',
  'integration',
  'migrations',
  'production',
  'scripts',
  'standards',
  'tests',
]);
const SERVICE_CACHE_DIRECTORIES = new Set(['.git', '.claude', '.aby', '.gomodcache', '.gocache']);
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/gu;

class VerificationFailure extends Error {
  readonly code: NotificationDocErrorCode;
  readonly path: string;

  constructor(code: NotificationDocErrorCode, path: string) {
    super(code);
    this.code = code;
    this.path = normalizeRepoPath(path);
  }
}

interface CheckDefinition {
  readonly label: string;
  readonly fallbackCode: NotificationDocErrorCode;
  readonly fallbackPath: string;
  readonly run: () => void;
}

export function verifyNotificationDocs(repositoryRoot: string): NotificationDocVerification {
  const root = resolve(repositoryRoot);
  const checks: string[] = [];
  const definitions: readonly CheckDefinition[] = [
    {
      label: 'IB6 receipt status',
      fallbackCode: 'IB6_RECEIPT_INVALID',
      fallbackPath: RECEIPT_PATH,
      run: () => verifyReceipt(root),
    },
    {
      label: 'PX2 post-merge audit',
      fallbackCode: 'PX2_RECEIPT_INVALID',
      fallbackPath: PX2_RECEIPT_PATH,
      run: () => verifyPx2Receipt(root),
    },
    {
      label: 'Current documentation status',
      fallbackCode: 'CURRENT_DOC_STATUS_STALE',
      fallbackPath: PRODUCT_PATH,
      run: () => verifyCurrentDocStatus(root),
    },
    {
      label: 'Required root documents',
      fallbackCode: 'REQUIRED_DOC_MISSING',
      fallbackPath: REQUIRED_ROOT_DOCS[0],
      run: () => verifyRequiredRootDocs(root),
    },
    {
      label: 'Required navigation edges',
      fallbackCode: 'NAVIGATION_EDGE_MISSING',
      fallbackPath: 'docs/README.md',
      run: () => verifyNavigationEdges(root),
    },
    {
      label: 'Service Markdown links',
      fallbackCode: 'SERVICE_LINK_UNRESOLVED',
      fallbackPath: SERVICE_INDEX_PATH,
      run: () => verifyServiceLinks(root),
    },
    {
      label: 'Service documentation classification',
      fallbackCode: 'SERVICE_DOC_UNCLASSIFIED',
      fallbackPath: SERVICE_INDEX_PATH,
      run: () => verifyServiceDocClassification(root),
    },
    {
      label: 'Product lifecycle claims',
      fallbackCode: 'PREMATURE_PRODUCT_CLAIM',
      fallbackPath: PRODUCT_PATH,
      run: () => verifyProductClaims(root),
    },
    {
      label: 'Module registration boundary',
      fallbackCode: 'PREMATURE_MODULE_REGISTRATION',
      fallbackPath: MODULES_PATH,
      run: () => verifyModuleRegistration(root),
    },
    {
      label: 'Service workspace manifest',
      fallbackCode: 'WORKSPACE_MANIFEST_INVALID',
      fallbackPath: SERVICE_MANIFEST_PATH,
      run: () => verifyWorkspaceManifest(root),
    },
  ];

  for (const definition of definitions) {
    try {
      definition.run();
      checks.push(definition.label);
    } catch (error) {
      const failure =
        error instanceof VerificationFailure
          ? error
          : new VerificationFailure(definition.fallbackCode, definition.fallbackPath);
      return {
        ok: false,
        checks: Object.freeze([...checks]),
        errors: Object.freeze([{ code: failure.code, path: failure.path }]),
      };
    }
  }

  return {
    ok: true,
    checks: Object.freeze([...checks]),
    errors: Object.freeze([]),
  };
}

function verifyReceipt(root: string): void {
  const receipt = readJsonObject(root, RECEIPT_PATH, 'IB6_RECEIPT_INVALID');
  if (
    receipt.$schema !== EXPECTED_RECEIPT_SCHEMA_REFERENCE ||
    receipt.schema !== EXPECTED_RECEIPT_SCHEMA
  ) {
    fail('IB6_RECEIPT_INVALID', RECEIPT_PATH);
  }
  const gate = asObject(receipt.gate);
  if (
    gate === undefined ||
    gate.name !== 'IB6-HISTORY-IMPORT' ||
    gate.status !== 'PASS' ||
    gate.closed !== true ||
    typeof gate.px2_exit !== 'string'
  ) {
    fail('IB6_RECEIPT_INVALID', RECEIPT_PATH);
  }
  if (gate.px2_exit !== EXPECTED_HISTORICAL_PX2_EXIT) {
    fail('STATUS_TRANSITION_REQUIRES_DOC_UPDATE', RECEIPT_PATH);
  }
}

function verifyPx2Receipt(root: string): void {
  const receipt = readJsonObject(root, PX2_RECEIPT_PATH, 'PX2_RECEIPT_INVALID');
  const gate = asObject(receipt.gate);
  const pullRequest = asObject(receipt.pull_request);
  const review = asObject(pullRequest?.review);
  const canonicalMain = asObject(receipt.canonical_main);
  const ruleset = asObject(receipt.ruleset);
  const conditions = asObject(ruleset?.conditions);
  const refName = asObject(conditions?.ref_name);
  const pullRequestRule = asObject(ruleset?.pull_request);
  const statusChecks = asObject(ruleset?.required_status_checks);
  if (
    receipt.$schema !==
      '../../docs/reference/schemas/integration/notification-delivery-px2-post-merge-audit.v1.schema.json' ||
    receipt.schema !== 'openslack.notification_delivery_px2_post_merge_audit.v1' ||
    gate?.name !== 'IB6-MERGE-TRAIN/PX2-EXIT' ||
    gate.status !== 'PASS' ||
    gate.effectivity !== 'EFFECTIVE_ON_GOVERNED_CANONICAL_MAIN_MERGE' ||
    pullRequest?.number !== 308 ||
    pullRequest.head !== '150475773f2edfb937b2e852d205d87ca87d3f35' ||
    pullRequest.merge_commit !== '9801d2d6c7c3368804eb0ff27c34ab4e69049722' ||
    JSON.stringify(pullRequest.merge_parents) !==
      JSON.stringify([
        '937b0566797828a9f8f0868821e21857c3345d1e',
        '150475773f2edfb937b2e852d205d87ca87d3f35',
      ]) ||
    review?.actor !== 'wsman' ||
    review.state !== 'APPROVED' ||
    review.reviewed_head !== pullRequest.head ||
    canonicalMain?.merge_commit_is_ancestor !== true ||
    typeof canonicalMain.observed_head !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(canonicalMain.observed_head) ||
    ruleset?.id !== 16756623 ||
    ruleset.name !== 'Protect main' ||
    ruleset.enforcement !== 'active' ||
    ruleset.target !== 'branch' ||
    ruleset.deletion_blocked !== true ||
    ruleset.non_fast_forward_blocked !== true ||
    JSON.stringify(refName?.include) !== JSON.stringify(['~DEFAULT_BRANCH']) ||
    JSON.stringify(refName?.exclude) !== JSON.stringify([]) ||
    pullRequestRule?.required_approving_review_count !== 1 ||
    pullRequestRule.dismiss_stale_reviews_on_push !== true ||
    pullRequestRule.require_code_owner_review !== true ||
    pullRequestRule.required_review_thread_resolution !== true ||
    statusChecks?.strict !== true ||
    JSON.stringify(statusChecks.contexts) !==
      JSON.stringify(['classify', 'validate / validate', 'canary', 'canonical-base']) ||
    receipt.authorization !== 'PX2_POST_MERGE_AUDIT_ONLY'
  ) {
    fail('PX2_RECEIPT_INVALID', PX2_RECEIPT_PATH);
  }
}

function verifyCurrentDocStatus(root: string): void {
  for (const path of CURRENT_DOC_STATUS_ALLOWLIST) {
    if (!isRegularRepoFile(root, path)) continue;
    if (readFileSync(repoPath(root, path), 'utf8').includes('PENDING_PHASE_F')) {
      fail('CURRENT_DOC_STATUS_STALE', path);
    }
  }
}

function verifyRequiredRootDocs(root: string): void {
  for (const path of REQUIRED_ROOT_DOCS) {
    if (!isRegularRepoFile(root, path)) fail('REQUIRED_DOC_MISSING', path);
  }
}

function verifyNavigationEdges(root: string): void {
  for (const edge of NAVIGATION_EDGES) {
    if (!isRegularRepoFile(root, edge.source)) {
      fail('NAVIGATION_EDGE_MISSING', edge.source);
    }
    const body = readFileSync(repoPath(root, edge.source), 'utf8');
    for (const target of edge.targets) {
      if (
        !isRegularRepoFile(root, target) ||
        !documentReferencesTarget(edge.source, body, target)
      ) {
        fail('NAVIGATION_EDGE_MISSING', edge.source);
      }
    }
  }
}

function verifyServiceLinks(root: string): void {
  for (const source of SERVICE_LINK_SOURCES) {
    if (!isRegularRepoFile(root, source)) fail('SERVICE_LINK_UNRESOLVED', source);
    const body = readFileSync(repoPath(root, source), 'utf8');
    for (const match of body.matchAll(MARKDOWN_LINK)) {
      const raw = match[1]?.trim();
      if (!raw || isExternalOrFragment(raw)) continue;
      const withoutBrackets =
        raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw;
      const encodedPath = withoutBrackets.split('#', 1)[0] ?? '';
      if (!encodedPath) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(encodedPath);
      } catch {
        fail('SERVICE_LINK_UNRESOLVED', source);
      }
      if (decoded.startsWith('/') || decoded.includes('\\')) {
        fail('SERVICE_LINK_UNRESOLVED', source);
      }
      const target = posix.normalize(posix.join(posix.dirname(source), decoded));
      if (target === '..' || target.startsWith('../')) {
        fail('SERVICE_LINK_UNRESOLVED', source);
      }
      if (!isSafeExistingRepoPath(root, target)) {
        if (isDeclaredMigratedServiceLink(root, target)) continue;
        fail('SERVICE_LINK_UNRESOLVED', source);
      }
    }
  }
}

function isDeclaredMigratedServiceLink(root: string, target: string): boolean {
  if (!isRegularRepoFile(root, DOCUMENT_MIGRATION_PATH)) return false;
  const manifest = parseYaml(
    readFileSync(repoPath(root, DOCUMENT_MIGRATION_PATH), 'utf8'),
  ) as unknown;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  const value = manifest as { phase?: unknown; entries?: unknown };
  if (value.phase !== 'migrated' || !Array.isArray(value.entries)) return false;
  for (const raw of value.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as { old_path?: unknown; new_path?: unknown };
    if (
      entry.old_path === target &&
      typeof entry.new_path === 'string' &&
      isSafeExistingRepoPath(root, entry.new_path)
    ) {
      return true;
    }
  }
  return false;
}

function verifyServiceDocClassification(root: string): void {
  if (!isRegularRepoFile(root, SERVICE_INDEX_PATH)) {
    fail('SERVICE_DOC_UNCLASSIFIED', SERVICE_INDEX_PATH);
  }
  const body = readFileSync(repoPath(root, SERVICE_INDEX_PATH), 'utf8');
  const starts = SERVICE_DOC_SECTIONS.map((section) => body.indexOf(section.heading));
  if (
    starts.some((start) => start < 0) ||
    starts.some((start, index) => index > 0 && start <= starts[index - 1]!)
  ) {
    fail('SERVICE_DOC_UNCLASSIFIED', SERVICE_INDEX_PATH);
  }
  for (let index = 0; index < SERVICE_DOC_SECTIONS.length; index += 1) {
    const section = SERVICE_DOC_SECTIONS[index]!;
    const start = starts[index]!;
    const end = starts[index + 1] ?? body.length;
    const sectionBody = body.slice(start, end);
    for (const target of section.targets) {
      if (!documentReferencesTarget(SERVICE_INDEX_PATH, sectionBody, target)) {
        fail('SERVICE_DOC_UNCLASSIFIED', SERVICE_INDEX_PATH);
      }
    }
  }
}

function verifyProductClaims(root: string): void {
  const body = readRegularText(root, PRODUCT_PATH, 'PREMATURE_PRODUCT_CLAIM');
  const rows = markdownTableRows(body);
  for (const [field, expected] of Object.entries(PRODUCT_LIFECYCLE)) {
    if (rows.get(field) !== expected) fail('PREMATURE_PRODUCT_CLAIM', PRODUCT_PATH);
  }
  for (const path of [PRODUCT_PATH, PRODUCT_INDEX_PATH]) {
    const productBody = readRegularText(root, path, 'PREMATURE_PRODUCT_CLAIM');
    if (PREMATURE_CLAIMS.some((pattern) => pattern.test(productBody))) {
      fail('PREMATURE_PRODUCT_CLAIM', path);
    }
  }
}

function verifyModuleRegistration(root: string): void {
  readRegularText(root, MODULES_PATH, 'PREMATURE_MODULE_REGISTRATION');
}

function verifyWorkspaceManifest(root: string): void {
  if (!isRegularRepoFile(root, SERVICE_MANIFEST_PATH)) {
    fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
  }
  const serviceRoot = repoPath(root, SERVICE_ROOT);
  const manifestBody = readFileSync(repoPath(root, SERVICE_MANIFEST_PATH), 'utf8');
  const lines = manifestBody.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);

  const manifestPaths = new Set<string>();
  let previous: string | undefined;
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\\]+)$/u.exec(line);
    if (!match) fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
    const expectedHash = match[1]!;
    const path = match[2]!;
    if (
      path.startsWith('/') ||
      path === '.' ||
      path.split('/').some((part) => part === '' || part === '..') ||
      path === 'docs/testing/workspace-manifest.sha256' ||
      manifestPaths.has(path) ||
      (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(path)) >= 0)
    ) {
      fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
    }
    previous = path;
    manifestPaths.add(path);
    const target = resolve(serviceRoot, ...path.split('/'));
    if (!isContained(serviceRoot, target) || !isSafeRegularPath(serviceRoot, target)) {
      fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
    }
    const actualHash = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actualHash !== expectedHash) {
      fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
    }
  }

  const expectedPaths = collectServiceManifestPaths(serviceRoot);
  if (
    expectedPaths.size !== manifestPaths.size ||
    [...expectedPaths].some((path) => !manifestPaths.has(path)) ||
    [...manifestPaths].some((path) => !expectedPaths.has(path))
  ) {
    fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
  }
}

function collectServiceManifestPaths(serviceRoot: string): Set<string> {
  const paths = new Set<string>();
  for (const entry of readdirSync(serviceRoot, { withFileTypes: true })) {
    if (!SERVICE_ALLOWED_TOP_LEVEL.has(entry.name)) continue;
    collectServiceEntry(serviceRoot, resolve(serviceRoot, entry.name), entry, paths);
  }
  return paths;
}

function collectServiceEntry(
  serviceRoot: string,
  path: string,
  entry: Dirent,
  paths: Set<string>,
): void {
  if (entry.isSymbolicLink()) fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
  if (entry.isDirectory()) {
    if (SERVICE_CACHE_DIRECTORIES.has(entry.name)) return;
    for (const child of readdirSync(path, { withFileTypes: true })) {
      collectServiceEntry(serviceRoot, resolve(path, child.name), child, paths);
    }
    return;
  }
  if (!entry.isFile()) fail('WORKSPACE_MANIFEST_INVALID', SERVICE_MANIFEST_PATH);
  const relativePath = normalizeRepoPath(relative(serviceRoot, path));
  if (relativePath !== 'docs/testing/workspace-manifest.sha256') paths.add(relativePath);
}

function documentReferencesTarget(source: string, body: string, target: string): boolean {
  const normalizedTarget = normalizeRepoPath(target);
  const sourceRelative = posix.relative(posix.dirname(source), normalizedTarget);
  if (body.includes(normalizedTarget) || body.includes(sourceRelative)) return true;
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const raw = match[1]?.trim();
    if (!raw || isExternalOrFragment(raw)) continue;
    const withoutBrackets =
      raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw;
    const encodedPath = withoutBrackets.split('#', 1)[0] ?? '';
    if (!encodedPath) continue;
    try {
      const decoded = decodeURIComponent(encodedPath);
      if (decoded.includes('\\') || decoded.startsWith('/')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(source), decoded));
      if (resolved === normalizedTarget) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function markdownTableRows(body: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim().replaceAll('`', '').replaceAll('**', ''));
    if (cells.length >= 2 && cells[0] && cells[1]) rows.set(cells[0], cells[1]);
  }
  return rows;
}

function readJsonObject(
  root: string,
  path: string,
  code: NotificationDocErrorCode,
): Record<string, unknown> {
  const text = readRegularText(root, path, code);
  try {
    const value = JSON.parse(text) as unknown;
    const object = asObject(value);
    if (object === undefined) fail(code, path);
    return object;
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    fail(code, path);
  }
}

function readRegularText(root: string, path: string, code: NotificationDocErrorCode): string {
  if (!isRegularRepoFile(root, path)) fail(code, path);
  return readFileSync(repoPath(root, path), 'utf8');
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRegularRepoFile(root: string, path: string): boolean {
  const target = repoPath(root, path);
  return isContained(root, target) && isSafeRegularPath(root, target);
}

function isSafeExistingRepoPath(root: string, path: string): boolean {
  const target = repoPath(root, path);
  if (!isContained(root, target) || !existsSync(target)) return false;
  try {
    return noSymlinkComponents(root, target);
  } catch {
    return false;
  }
}

function isSafeRegularPath(root: string, target: string): boolean {
  if (!existsSync(target)) return false;
  try {
    const stats = lstatSync(target);
    return stats.isFile() && !stats.isSymbolicLink() && noSymlinkComponents(root, target);
  } catch {
    return false;
  }
}

function noSymlinkComponents(root: string, target: string): boolean {
  const relation = relative(root, target);
  if (relation === '') return !lstatSync(root).isSymbolicLink();
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = resolve(cursor, component);
    const stats: Stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) return false;
  }
  return true;
}

function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`));
}

function repoPath(root: string, path: string): string {
  return resolve(root, ...normalizeRepoPath(path).split('/'));
}

function normalizeRepoPath(path: string): string {
  return path.split(sep).join('/');
}

function isExternalOrFragment(target: string): boolean {
  return /^(?:https?:|mailto:|#)/iu.test(target);
}

function fail(code: NotificationDocErrorCode, path: string): never {
  throw new VerificationFailure(code, path);
}
