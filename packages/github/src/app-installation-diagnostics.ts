import type { CredentialStore } from '@openslack/credentials';

import {
  createGitHubAppJwtContext,
  requireAppInstallationToken,
  type GitHubAppInstallationTokenOptions,
} from './auth.js';
import { GITHUB_APP_DEFAULT_EVENTS, GITHUB_APP_DEFAULT_PERMISSIONS } from './app-manifest.js';
import {
  inspectInstallationRepositoryAccess,
  type GitHubInstallationRepositoryAccess,
} from './installation-access.js';
import { isGitHubAppSlug } from './app-slug.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const API_VERSION = '2022-11-28';

export const GITHUB_APP_INSTALLATION_DIAGNOSTIC_CODES = Object.freeze([
  'APP_REAUTHORIZATION_REQUIRED',
  'APP_EVENT_SUBSCRIPTION_MISSING',
  'APP_REPOSITORY_SCOPE_MISSING',
  'APP_INSTALLATION_READY',
] as const);

export type GitHubAppInstallationDiagnosticCode =
  (typeof GITHUB_APP_INSTALLATION_DIAGNOSTIC_CODES)[number];

export interface GitHubAppPermissionDifference {
  name: string;
  expected: string;
  actual: string | null;
}

export interface GitHubAppInstallationDiagnosticReport {
  schema: 'openslack.github_app_installation_diagnostic.v1';
  ready: boolean;
  /** Primary diagnostic code in deterministic evaluation order. */
  code: GitHubAppInstallationDiagnosticCode;
  /** Authoritative set of every readiness problem found by this diagnostic. */
  codes: readonly GitHubAppInstallationDiagnosticCode[];
  appId: string;
  installationId: string;
  appSlug: string | null;
  suspended: boolean;
  permissions: {
    expected: Readonly<Record<string, string>>;
    actual: Readonly<Record<string, string>>;
    missing: readonly GitHubAppPermissionDifference[];
  };
  events: {
    expected: readonly string[];
    actual: readonly string[];
    missing: readonly string[];
  };
  repository: {
    fullName: string;
    selection: 'all' | 'selected';
    accessible: boolean;
    complete: boolean;
    totalAccessibleRepositories: number;
    pagesScanned: number;
  };
  managementUrl: string;
  administratorAction: string | null;
}

export interface GitHubAppInstallationDiagnosticInput {
  owner: string;
  repo: string;
  env?: NodeJS.ProcessEnv;
  localStateRoot?: string;
  credentialStore?: Pick<CredentialStore, 'withSecret'>;
}

export interface GitHubAppInstallationSource {
  configuredAppId: string;
  configuredInstallationId: string;
  value: unknown;
}

export interface GitHubAppInstallationDiagnosticDependencies {
  loadInstallation?: () => Promise<GitHubAppInstallationSource>;
  inspectRepositoryAccess?: () => Promise<GitHubInstallationRepositoryAccess>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class GitHubAppInstallationDiagnosticError extends Error {
  readonly code:
    | 'APP_INSTALLATION_CONFIG_INVALID'
    | 'APP_INSTALLATION_REQUEST_FAILED'
    | 'APP_INSTALLATION_RESPONSE_INVALID'
    | 'APP_REPOSITORY_ACCESS_CHECK_FAILED';

  constructor(code: GitHubAppInstallationDiagnosticError['code'], message: string) {
    super(message);
    this.name = 'GitHubAppInstallationDiagnosticError';
    this.code = code;
  }
}

interface ParsedInstallation {
  id: string;
  appId: string;
  appSlug: string | null;
  permissions: Readonly<Record<string, string>>;
  events: readonly string[];
  repositorySelection: 'all' | 'selected';
  managementUrl: string;
  suspended: boolean;
}

export async function diagnoseGitHubAppInstallation(
  input: GitHubAppInstallationDiagnosticInput,
  dependencies: GitHubAppInstallationDiagnosticDependencies = {},
): Promise<GitHubAppInstallationDiagnosticReport> {
  validateInput(input);
  const tokenOptions: GitHubAppInstallationTokenOptions = {
    env: input.env,
    localStateRoot: input.localStateRoot,
    credentialStore: input.credentialStore,
  };
  let source: GitHubAppInstallationSource;
  try {
    source = await (dependencies.loadInstallation
      ? dependencies.loadInstallation()
      : loadInstallation(tokenOptions, dependencies));
  } catch (error) {
    if (error instanceof GitHubAppInstallationDiagnosticError) throw error;
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_REQUEST_FAILED',
      'GitHub App installation diagnostic request failed safely.',
    );
  }
  if (!/^\d+$/.test(source.configuredAppId) || !/^\d+$/.test(source.configuredInstallationId)) {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_CONFIG_INVALID',
      'GitHub App installation diagnostic configuration is invalid.',
    );
  }
  let installation: ParsedInstallation;
  try {
    installation = parseInstallation(source.value);
  } catch (error) {
    if (error instanceof GitHubAppInstallationDiagnosticError) throw error;
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_RESPONSE_INVALID',
      'GitHub App installation diagnostic response is invalid.',
    );
  }
  if (
    installation.id !== source.configuredInstallationId ||
    installation.appId !== source.configuredAppId
  ) {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_RESPONSE_INVALID',
      'GitHub App installation diagnostic identity does not match local configuration.',
    );
  }

  let repositoryAccess: GitHubInstallationRepositoryAccess;
  try {
    repositoryAccess = await (dependencies.inspectRepositoryAccess
      ? dependencies.inspectRepositoryAccess()
      : inspectRepository(input, tokenOptions));
  } catch {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_REPOSITORY_ACCESS_CHECK_FAILED',
      'GitHub App repository access diagnostic failed safely.',
    );
  }
  if (
    repositoryAccess.owner.toLowerCase() !== input.owner.toLowerCase() ||
    repositoryAccess.repo.toLowerCase() !== input.repo.toLowerCase()
  ) {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_RESPONSE_INVALID',
      'GitHub App repository access diagnostic target is invalid.',
    );
  }

  const missingPermissions = permissionDifferences(installation.permissions);
  const actualEvents = Object.freeze([...installation.events].sort());
  const missingEvents = Object.freeze(
    GITHUB_APP_DEFAULT_EVENTS.filter((event) => !actualEvents.includes(event)),
  );
  const codes: GitHubAppInstallationDiagnosticCode[] = [];
  if (missingPermissions.length > 0 || installation.suspended) {
    codes.push('APP_REAUTHORIZATION_REQUIRED');
  }
  if (missingEvents.length > 0) codes.push('APP_EVENT_SUBSCRIPTION_MISSING');
  if (!repositoryAccess.accessible || !repositoryAccess.complete) {
    codes.push('APP_REPOSITORY_SCOPE_MISSING');
  }
  if (codes.length === 0) codes.push('APP_INSTALLATION_READY');
  const ready = codes.length === 1 && codes[0] === 'APP_INSTALLATION_READY';
  const frozenCodes = Object.freeze(codes);
  const fullName = `${input.owner}/${input.repo}`;

  return Object.freeze({
    schema: 'openslack.github_app_installation_diagnostic.v1',
    ready,
    code: frozenCodes[0]!,
    codes: frozenCodes,
    appId: installation.appId,
    installationId: installation.id,
    appSlug: installation.appSlug,
    suspended: installation.suspended,
    permissions: Object.freeze({
      expected: GITHUB_APP_DEFAULT_PERMISSIONS,
      actual: installation.permissions,
      missing: missingPermissions,
    }),
    events: Object.freeze({
      expected: GITHUB_APP_DEFAULT_EVENTS,
      actual: actualEvents,
      missing: missingEvents,
    }),
    repository: Object.freeze({
      fullName,
      selection: installation.repositorySelection,
      accessible: repositoryAccess.accessible,
      complete: repositoryAccess.complete,
      totalAccessibleRepositories: repositoryAccess.totalAccessibleRepositories,
      pagesScanned: repositoryAccess.pagesScanned,
    }),
    managementUrl: installation.managementUrl,
    administratorAction: ready
      ? null
      : buildAdministratorAction({
          managementUrl: installation.managementUrl,
          fullName,
          suspended: installation.suspended,
          missingPermissions,
          missingEvents,
          repositoryScopeMissing: !repositoryAccess.accessible || !repositoryAccess.complete,
        }),
  });
}

async function loadInstallation(
  tokenOptions: GitHubAppInstallationTokenOptions,
  dependencies: GitHubAppInstallationDiagnosticDependencies,
): Promise<GitHubAppInstallationSource> {
  let context;
  try {
    context = createGitHubAppJwtContext(tokenOptions);
  } catch {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_CONFIG_INVALID',
      'GitHub App installation diagnostic configuration is invalid.',
    );
  }
  const value = await fetchInstallation(
    context.jwt,
    context.installationId,
    dependencies.fetchImpl ?? fetch,
    dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  return {
    configuredAppId: context.appId,
    configuredInstallationId: context.installationId,
    value,
  };
}

async function inspectRepository(
  input: GitHubAppInstallationDiagnosticInput,
  tokenOptions: GitHubAppInstallationTokenOptions,
): Promise<GitHubInstallationRepositoryAccess> {
  const installationToken = await requireAppInstallationToken(tokenOptions);
  return inspectInstallationRepositoryAccess({
    token: installationToken.token,
    owner: input.owner,
    repo: input.repo,
  });
}

async function fetchInstallation(
  jwt: string,
  installationId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<unknown> {
  if (
    !jwt ||
    !/^\d+$/.test(installationId) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 4 * 1024 * 1024
  ) {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_CONFIG_INVALID',
      'GitHub App installation diagnostic configuration is invalid.',
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'openslack-github-installation-diagnostic',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new GitHubAppInstallationDiagnosticError(
        'APP_INSTALLATION_REQUEST_FAILED',
        'GitHub App installation diagnostic request failed safely.',
      );
    }
    const raw = await readBoundedResponse(response, maxResponseBytes);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new GitHubAppInstallationDiagnosticError(
        'APP_INSTALLATION_RESPONSE_INVALID',
        'GitHub App installation diagnostic response is invalid.',
      );
    }
  } catch (error) {
    if (error instanceof GitHubAppInstallationDiagnosticError) throw error;
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_REQUEST_FAILED',
      'GitHub App installation diagnostic request failed safely.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = /^\d+$/.test(declaredHeader) ? Number(declaredHeader) : Number.NaN;
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new GitHubAppInstallationDiagnosticError(
        'APP_INSTALLATION_RESPONSE_INVALID',
        'GitHub App installation diagnostic response is invalid.',
      );
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new GitHubAppInstallationDiagnosticError(
        'APP_INSTALLATION_RESPONSE_INVALID',
        'GitHub App installation diagnostic response is invalid.',
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_RESPONSE_INVALID',
      'GitHub App installation diagnostic response is invalid.',
    );
  }
}

function parseInstallation(value: unknown): ParsedInstallation {
  if (!isRecord(value)) return invalidResponse();
  const id = numericId(value.id);
  const appId = numericId(value.app_id);
  const appSlug = isGitHubAppSlug(value.app_slug) ? value.app_slug : null;
  const permissions = parsePermissions(value.permissions);
  const events = parseEvents(value.events);
  const repositorySelection =
    value.repository_selection === 'all' || value.repository_selection === 'selected'
      ? value.repository_selection
      : null;
  const managementUrl = parseManagementUrl(value.html_url);
  if (
    !id ||
    !appId ||
    (value.app_slug !== null && typeof value.app_slug !== 'undefined' && !appSlug) ||
    !permissions ||
    !events ||
    !repositorySelection ||
    !managementUrl ||
    !(
      value.suspended_at === null ||
      (typeof value.suspended_at === 'string' && !Number.isNaN(Date.parse(value.suspended_at)))
    )
  ) {
    return invalidResponse();
  }
  return {
    id,
    appId,
    appSlug,
    permissions,
    events,
    repositorySelection,
    managementUrl,
    suspended: value.suspended_at !== null,
  };
}

function parsePermissions(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value) || Object.keys(value).length > 128) return null;
  const entries: Array<[string, string]> = [];
  for (const [name, level] of Object.entries(value)) {
    if (
      !/^[a-z][a-z_]{0,63}$/.test(name) ||
      (level !== 'read' && level !== 'write' && level !== 'admin')
    ) {
      return null;
    }
    entries.push([name, level]);
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))),
  );
}

function parseEvents(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const events: string[] = [];
  for (const event of value) {
    if (typeof event !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(event)) return null;
    events.push(event);
  }
  if (new Set(events).size !== events.length) return null;
  return Object.freeze(events);
}

function permissionDifferences(
  actual: Readonly<Record<string, string>>,
): readonly GitHubAppPermissionDifference[] {
  const differences: GitHubAppPermissionDifference[] = [];
  for (const [name, expected] of Object.entries(GITHUB_APP_DEFAULT_PERMISSIONS)) {
    const actualLevel = actual[name] ?? null;
    if (permissionRank(actualLevel) < permissionRank(expected)) {
      differences.push(Object.freeze({ name, expected, actual: actualLevel }));
    }
  }
  return Object.freeze(differences);
}

function permissionRank(value: string | null): number {
  return value === 'admin' ? 3 : value === 'write' ? 2 : value === 'read' ? 1 : 0;
}

function buildAdministratorAction(input: {
  managementUrl: string;
  fullName: string;
  suspended: boolean;
  missingPermissions: readonly GitHubAppPermissionDifference[];
  missingEvents: readonly string[];
  repositoryScopeMissing: boolean;
}): string {
  const actions: string[] = [];
  if (input.suspended) actions.push('resume the suspended installation');
  if (input.missingPermissions.length > 0) {
    actions.push(
      `have the GitHub App owner request the missing permissions (${input.missingPermissions
        .map((permission) => `${permission.name}:${permission.expected}`)
        .join(', ')}), then have the installation owner accept the pending update`,
    );
  }
  if (input.missingEvents.length > 0) {
    actions.push(
      `have the GitHub App owner enable the missing webhook subscriptions (${input.missingEvents.join(', ')})`,
    );
  }
  if (input.repositoryScopeMissing) {
    actions.push(`include ${input.fullName} in repository access`);
  }
  return `An administrator must open ${input.managementUrl} and ${joinActions(actions)}. OpenSlack will not change the installation.`;
}

function joinActions(actions: readonly string[]): string {
  if (actions.length === 1) return actions[0]!;
  if (actions.length === 2) return `${actions[0]} and ${actions[1]}`;
  return `${actions.slice(0, -1).join(', ')}, and ${actions.at(-1)}`;
}

function parseManagementUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function numericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new GitHubAppInstallationDiagnosticError(
    'APP_INSTALLATION_RESPONSE_INVALID',
    'GitHub App installation diagnostic response is invalid.',
  );
}

function validateInput(input: GitHubAppInstallationDiagnosticInput): void {
  if (!isGitHubName(input.owner) || !isGitHubName(input.repo)) {
    throw new GitHubAppInstallationDiagnosticError(
      'APP_INSTALLATION_CONFIG_INVALID',
      'GitHub App installation diagnostic target is invalid.',
    );
  }
}

function isGitHubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value);
}
