import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseSecretReference, type CredentialStore } from '@openslack/credentials';

const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export const GITHUB_APP_DEFAULT_PERMISSIONS = Object.freeze({
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  workflows: 'write',
  checks: 'read',
} as const);

export const GITHUB_APP_DEFAULT_EVENTS = Object.freeze([
  'issues',
  'pull_request',
  'pull_request_review',
  'push',
  'check_run',
  'check_suite',
] as const);

export interface GitHubAppManifestInput {
  localStateRoot: string;
  callbackUrl: string;
  appName: string;
  organization?: string;
  homepageUrl?: string;
  webhookUrl?: string;
  privateKeyRef: string;
  webhookSecretRef: string;
  clientSecretRef: string;
}

export interface GitHubAppManifestDefinition {
  name: string;
  url: string;
  hook_attributes: { url: string; active: false };
  redirect_url: string;
  description: string;
  public: false;
  default_permissions: {
    metadata: 'read';
    contents: 'write';
    issues: 'write';
    pull_requests: 'write';
    workflows: 'write';
    checks: 'read';
  };
  default_events: [
    'issues',
    'pull_request',
    'pull_request_review',
    'push',
    'check_run',
    'check_suite',
  ];
}

export interface GitHubAppManifestSession {
  actionUrl: string;
  manifest: GitHubAppManifestDefinition;
  state: string;
  expiresAt: number;
  consume(state: string, now?: number): void;
}

export interface GitHubAppManifestConversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
}

export interface GitHubAppManifestResult {
  appId: string;
  appSlug: string;
  clientId: string;
  configPath: string;
  privateKeyRef: string;
  webhookSecretRef: string;
  clientSecretRef: string;
}

export interface GitHubAppManifestDependencies {
  credentialStore: CredentialStore;
  exchangeCode?: (code: string) => Promise<unknown>;
}

export interface GitHubAppManifestExchangeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export function defaultGitHubAppManifestRefs(workspaceRoot: string): {
  privateKeyRef: string;
  webhookSecretRef: string;
  clientSecretRef: string;
} {
  const workspaceId = createHash('sha256')
    .update(resolve(workspaceRoot), 'utf-8')
    .digest('hex')
    .slice(0, 12);
  const prefix = `keychain:openslack/github-app-${workspaceId}`;
  return {
    privateKeyRef: `${prefix}-private-key`,
    webhookSecretRef: `${prefix}-webhook-secret`,
    clientSecretRef: `${prefix}-client-secret`,
  };
}

export function createGitHubAppManifestSession(
  input: GitHubAppManifestInput,
  options: { now?: number; ttlMs?: number; randomState?: () => Buffer } = {},
): GitHubAppManifestSession {
  validateManifestInput(input);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 60 * 60 * 1000) {
    throw new Error('GitHub App Manifest session TTL must be between 1 ms and 1 hour.');
  }
  const state = (options.randomState ?? (() => randomBytes(32)))().toString('base64url');
  if (state.length < 43) throw new Error('GitHub App Manifest state must contain 256 bits.');
  const expectedHash = digestState(state);
  let consumed = false;

  return {
    actionUrl: registrationActionUrl(input.organization),
    manifest: buildManifest(input),
    state,
    expiresAt: now + ttlMs,
    consume(candidate: string, at = Date.now()): void {
      if (consumed) throw new Error('GitHub App Manifest callback has already been consumed.');
      if (at > now + ttlMs) {
        consumed = true;
        throw new Error('GitHub App Manifest callback has expired.');
      }
      const candidateHash = digestState(candidate);
      if (!timingSafeEqual(expectedHash, candidateHash)) {
        throw new Error('GitHub App Manifest callback state is invalid.');
      }
      consumed = true;
    },
  };
}

export function preflightGitHubAppManifest(
  input: GitHubAppManifestInput,
  credentialStore: CredentialStore,
): void {
  validateManifestInput(input);
  const configPath = join(resolve(input.localStateRoot), 'github-app.json');
  if (existsSync(configPath)) {
    throw new Error(
      'GitHub App Manifest local config already exists; reconcile it before creating another App.',
    );
  }
  const keychain = credentialStore.status().find((status) => status.scheme === 'keychain');
  if (!keychain?.available || !keychain.writable) {
    throw new Error('GitHub App Manifest requires an available writable keychain backend.');
  }
  for (const value of [input.privateKeyRef, input.webhookSecretRef, input.clientSecretRef]) {
    const reference = parseWritableKeychainReference(value);
    if (credentialStore.has(reference)) {
      throw new Error('GitHub App Manifest credential reference already exists.');
    }
  }
}

export async function completeGitHubAppManifest(
  input: GitHubAppManifestInput,
  code: string,
  dependencies: GitHubAppManifestDependencies,
): Promise<GitHubAppManifestResult> {
  validateManifestInput(input);
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(code)) {
    throw new Error('GitHub App Manifest callback code is invalid.');
  }
  preflightGitHubAppManifest(input, dependencies.credentialStore);
  const configPath = join(resolve(input.localStateRoot), 'github-app.json');
  let rawConversion: unknown;
  try {
    rawConversion = await (dependencies.exchangeCode ?? exchangeGitHubAppManifestCode)(code);
  } catch {
    throw new Error('GitHub App Manifest exchange failed safely.');
  }
  const conversion = parseConversion(rawConversion);
  const references = [
    parseWritableKeychainReference(input.privateKeyRef),
    parseWritableKeychainReference(input.webhookSecretRef),
    parseWritableKeychainReference(input.clientSecretRef),
  ];
  const secrets = [conversion.pem, conversion.webhook_secret, conversion.client_secret];
  const stored: typeof references = [];

  try {
    for (let index = 0; index < references.length; index += 1) {
      dependencies.credentialStore.putIfAbsent(references[index]!, secrets[index]!);
      stored.push(references[index]!);
    }
    writeConfigAtomic(configPath, {
      schema: 'openslack.github_app_local.v1',
      appId: String(conversion.id),
      appSlug: conversion.slug,
      clientId: conversion.client_id,
      privateKeyRef: references[0]!.canonical,
      webhookSecretRef: references[1]!.canonical,
      clientSecretRef: references[2]!.canonical,
      installationId: null,
    });
  } catch {
    const cleanupFailed: string[] = [];
    for (const reference of stored.reverse()) {
      try {
        dependencies.credentialStore.delete(reference);
      } catch {
        cleanupFailed.push(reference.canonical);
      }
    }
    if (cleanupFailed.length > 0) {
      writeReconcileReceipt(input.localStateRoot, cleanupFailed);
      throw new Error(
        'GitHub App Manifest commit failed and credential reconciliation is required.',
      );
    }
    throw new Error('GitHub App Manifest credentials could not be committed safely.');
  }

  return {
    appId: String(conversion.id),
    appSlug: conversion.slug,
    clientId: conversion.client_id,
    configPath,
    privateKeyRef: references[0]!.canonical,
    webhookSecretRef: references[1]!.canonical,
    clientSecretRef: references[2]!.canonical,
  };
}

export async function exchangeGitHubAppManifestCode(
  code: string,
  options: GitHubAppManifestExchangeOptions = {},
): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(code)) {
    throw new Error('GitHub App Manifest callback code is invalid.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'OpenSlack-App-Manifest',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub App Manifest exchange failed with HTTP ${response.status}.`);
    }
    return JSON.parse(await readResponseBounded(response, maxResponseBytes)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('GitHub App Manifest exchange timed out.');
    }
    if (error instanceof SyntaxError) {
      throw new Error('GitHub App Manifest exchange returned invalid JSON.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildManifest(input: GitHubAppManifestInput): GitHubAppManifestDefinition {
  const homepageUrl = input.homepageUrl ?? defaultGitHubHomepage(input.organization);
  return {
    name: input.appName,
    url: homepageUrl,
    hook_attributes: {
      // GitHub requires a webhook URL whenever hook_attributes is present,
      // even when delivery is inactive. Use the target homepage rather than a
      // product-repository constant until the operator supplies an endpoint.
      url: input.webhookUrl ?? homepageUrl,
      active: false,
    },
    redirect_url: input.callbackUrl,
    description: 'OpenSlack agent-native GitHub work orchestration',
    public: false,
    default_permissions: { ...GITHUB_APP_DEFAULT_PERMISSIONS },
    default_events: [...GITHUB_APP_DEFAULT_EVENTS],
  };
}

function defaultGitHubHomepage(organization?: string): string {
  return organization
    ? `https://github.com/${encodeURIComponent(organization)}`
    : 'https://github.com';
}

function validateManifestInput(input: GitHubAppManifestInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(input.appName)) {
    throw new Error('GitHub App name is invalid.');
  }
  const callback = new URL(input.callbackUrl);
  if (
    callback.protocol !== 'http:' ||
    (callback.hostname !== '127.0.0.1' && callback.hostname !== '[::1]') ||
    callback.username ||
    callback.password ||
    callback.pathname !== '/callback'
  ) {
    throw new Error('GitHub App Manifest callback must be loopback HTTP on /callback.');
  }
  for (const url of [input.homepageUrl, input.webhookUrl]) {
    if (url !== undefined) validatePublicUrl(url);
  }
  if (
    input.organization &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(input.organization)
  ) {
    throw new Error('GitHub organization name is invalid.');
  }
  parseWritableKeychainReference(input.privateKeyRef);
  parseWritableKeychainReference(input.webhookSecretRef);
  parseWritableKeychainReference(input.clientSecretRef);
  if (new Set([input.privateKeyRef, input.webhookSecretRef, input.clientSecretRef]).size !== 3) {
    throw new Error('GitHub App Manifest secret references must be distinct.');
  }
}

function registrationActionUrl(organization?: string): string {
  return organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

function digestState(value: string): Buffer {
  return createHash('sha256').update(value, 'utf-8').digest();
}

function parseWritableKeychainReference(value: string) {
  const reference = parseSecretReference(value);
  if (reference.scheme !== 'keychain') {
    throw new Error('GitHub App Manifest secrets require writable keychain: references.');
  }
  return reference;
}

function parseConversion(value: unknown): GitHubAppManifestConversion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub App Manifest exchange response is invalid.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.id) ||
    (candidate.id as number) <= 0 ||
    typeof candidate.slug !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(candidate.slug) ||
    typeof candidate.client_id !== 'string' ||
    !/^[A-Za-z0-9._-]{3,128}$/.test(candidate.client_id) ||
    typeof candidate.client_secret !== 'string' ||
    !isBoundedSecret(candidate.client_secret) ||
    typeof candidate.webhook_secret !== 'string' ||
    !isBoundedSecret(candidate.webhook_secret) ||
    typeof candidate.pem !== 'string' ||
    candidate.pem.length > 65_536
  ) {
    throw new Error('GitHub App Manifest exchange response is missing required fields.');
  }
  try {
    const key = createPrivateKey(candidate.pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('unexpected key type');
  } catch {
    throw new Error('GitHub App Manifest exchange returned an invalid private key.');
  }
  return candidate as unknown as GitHubAppManifestConversion;
}

function isBoundedSecret(value: string): boolean {
  return value.length >= 16 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

function validatePublicUrl(value: string): void {
  if (value.length > 2_048) throw new Error('GitHub App Manifest public URL is too long.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('GitHub App Manifest public URLs must be credential-free HTTPS URLs.');
  }
}

async function readResponseBounded(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('GitHub App Manifest response limit is invalid.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('GitHub App Manifest exchange response exceeded the size limit.');
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
      throw new Error('GitHub App Manifest exchange response exceeded the size limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function writeConfigAtomic(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeReconcileReceipt(localStateRoot: string, failedRefs: string[]): void {
  const directory = join(resolve(localStateRoot), 'reconcile');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `github-app-manifest-${randomUUID()}.json`);
  try {
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schema: 'openslack.github_app_reconcile.v1',
          reason: 'credential_rollback_failed',
          credentialRefs: failedRefs,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
    );
  } catch {
    // The public error remains fixed and secret-free even if the local receipt cannot be written.
  }
}
