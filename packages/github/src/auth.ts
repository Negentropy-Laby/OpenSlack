import { createSign } from 'node:crypto';
import {
  boundedJsonPost,
  BoundedJsonPostError,
} from './bounded-json-post.js';

export interface GitHubAppInstallationToken {
  token: string;
  expiresAt: string;
  tokenType: 'installation';
  appId: string;
  installationId: string;
  permissions: Record<string, string>;
}

interface TokenCache {
  identityKey: string;
  value: GitHubAppInstallationToken;
  expiresAt: Date;
}

export class GitHubAppTokenError extends Error {
  readonly code: 'APP_CONFIG_MISSING' | 'APP_TOKEN_REQUEST_FAILED' | 'APP_TOKEN_INVALID';

  constructor(code: GitHubAppTokenError['code'], message: string) {
    super(message);
    this.name = 'GitHubAppTokenError';
    this.code = code;
  }
}

let cachedToken: TokenCache | null = null;
let inFlight: { identityKey: string; promise: Promise<GitHubAppInstallationToken> } | null = null;
let cacheGeneration = 0;

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url').replace(/=+$/, '');
}

function createJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64urlEncode(
    Buffer.from(
      JSON.stringify({
        iat: now - 60, // 60s clock skew tolerance
        exp: now + 600, // 10 minute expiry (GitHub max)
        iss: appId,
      }),
    ),
  );

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = base64urlEncode(sign.sign(privateKey));

  return `${header}.${payload}.${signature}`;
}

export async function requireAppInstallationToken(): Promise<GitHubAppInstallationToken> {
  const appId = process.env.OPENSLACK_GITHUB_APP_ID;
  const installationId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
  const privateKey = process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;

  if (!appId || !installationId || !privateKey) {
    throw new GitHubAppTokenError(
      'APP_CONFIG_MISSING',
      'GitHub App installation credentials are not configured.',
    );
  }
  const identityKey = `${appId}\0${installationId}`;

  // Return cached token if still valid (with 5-minute safety margin)
  if (
    cachedToken?.identityKey === identityKey &&
    cachedToken.expiresAt > new Date(Date.now() + 300000)
  ) {
    return cachedToken.value;
  }
  if (inFlight?.identityKey === identityKey) return inFlight.promise;

  const promise = refreshInstallationToken({
    appId,
    installationId,
    privateKey,
    identityKey,
    generation: cacheGeneration,
  });
  inFlight = { identityKey, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

async function refreshInstallationToken(input: {
  appId: string;
  installationId: string;
  privateKey: string;
  identityKey: string;
  generation: number;
}): Promise<GitHubAppInstallationToken> {
  try {
    const jwt = createJwt(input.appId, input.privateKey);
    const response = await boundedJsonPost({
      url: `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
      body: '{}',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'openslack-github-provider',
      },
    });

    // The shared transport validates only a top-level object; this endpoint owns its schema.
    if (
      typeof response.token !== 'string' ||
      response.token.trim().length === 0 ||
      typeof response.expires_at !== 'string' ||
      Number.isNaN(Date.parse(response.expires_at))
    ) {
      throw new GitHubAppTokenError(
        'APP_TOKEN_INVALID',
        'GitHub App token endpoint returned an invalid response.',
      );
    }

    const expiresAt = new Date(response.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 300_000) {
      throw new GitHubAppTokenError(
        'APP_TOKEN_INVALID',
        'GitHub App token endpoint returned an invalid expiry.',
      );
    }
    const permissions = readStringRecord(response.permissions);
    const value: GitHubAppInstallationToken = {
      token: response.token,
      expiresAt: expiresAt.toISOString(),
      tokenType: 'installation',
      appId: input.appId,
      installationId: input.installationId,
      permissions,
    };
    if (input.generation === cacheGeneration) {
      cachedToken = {
        identityKey: input.identityKey,
        value,
        expiresAt,
      };
    }
    return value;
  } catch (err) {
    if (err instanceof GitHubAppTokenError) throw err;
    if (err instanceof BoundedJsonPostError) {
      throw new GitHubAppTokenError(
        err.code === 'INVALID_JSON' || err.code === 'INVALID_RESPONSE'
          ? 'APP_TOKEN_INVALID'
          : 'APP_TOKEN_REQUEST_FAILED',
        'GitHub App installation token request failed safely.',
      );
    }
    throw new GitHubAppTokenError(
      'APP_TOKEN_REQUEST_FAILED',
      'GitHub App installation token request failed.',
    );
  }
}

export async function getAppInstallationToken(): Promise<GitHubAppInstallationToken | null> {
  try {
    return await requireAppInstallationToken();
  } catch {
    return null;
  }
}

export function clearTokenCache(): void {
  cacheGeneration += 1;
  cachedToken = null;
  inFlight = null;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
